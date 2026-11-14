#!/usr/bin/python3 -I
"""Coordinate the prepared legacy migration under one installation lock.

This internal entry point requires a verified release, provisioned and running
host supervisor, protected recovery paths and a trusted Docker client. It leaves
the durable marker in place until a separate health and recovery handoff ends.
"""
import os
import hashlib
import json
import stat
import sys
import time
from types import SimpleNamespace


MARKER='.legacy-migration-v1'


class TransitionError(Exception):
    pass


def prepare_stop(journal,operation,active_env,policy_root,source,old_image,old_image_id,old_ids,supervisor,daemon,adoption,policy,quiescence,docker,legacy,
                 *,install_lock,trusted_ingress=None):
    """Stop the legacy generation against a verified candidate before activation."""
    if sys.platform!='linux' or os.geteuid()!=0 or not sys.flags.isolated or not supervisor._uuid4(operation):
        raise TransitionError('Isolated Linux root is required')
    _,_,approved,_=adoption.prepared_binding(journal,operation,active_env,policy_root,supervisor,policy)
    install=supervisor._trusted_directory(approved.install_dir,0o700)
    try:
        expected=supervisor._open_root_file(install,'install.lock',0o600)
        try:
            held,named=os.fstat(install_lock),os.fstat(expected)
            if (held.st_dev,held.st_ino)!=(named.st_dev,named.st_ino):raise TransitionError('Installation lock does not match')
            supervisor._assert_exclusive_flock(install_lock)
        finally:os.close(expected)
        db=journal.db
        db.execute("CREATE TABLE IF NOT EXISTS legacy_transitions(operation_id TEXT PRIMARY KEY, phase TEXT NOT NULL CHECK(phase IN ('starting','stopped','recovery_saved','snapshot_verified','restored','protected','removed','adopted','started','completing','completed','recovery_required'))) ")
        if db.execute('SELECT 1 FROM legacy_transitions LIMIT 1').fetchone():raise TransitionError('Existing migration requires recovery')
        marker=('servus-legacy-migration-v1 '+operation+'\n').encode('ascii')
        fd=os.open(MARKER,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=install)
        try:
            os.fchmod(fd,0o600)
            with os.fdopen(fd,'wb',closefd=False) as output:output.write(marker);output.flush();os.fsync(fd)
        finally:os.close(fd)
        os.fsync(install)
        db.execute("INSERT INTO legacy_transitions VALUES(?,'starting')",(operation,))
        try:
            legacy.stop(journal,operation,active_env,source,old_image,old_image_id,old_ids,supervisor,daemon,adoption,quiescence,docker,
                        install_lock=install_lock,trusted_ingress=trusted_ingress,candidate_policy=(policy_root,policy))
            if db.execute("UPDATE legacy_transitions SET phase='stopped' WHERE operation_id=? AND phase='starting'",(operation,)).rowcount!=1:
                raise TransitionError('Migration state changed')
        except BaseException:
            try:db.execute("UPDATE legacy_transitions SET phase='recovery_required' WHERE operation_id=? AND phase='starting'",(operation,))
            except BaseException:pass
            raise
    finally:os.close(install)


def complete(journal,operation,active_env,node_fd,supervisor,daemon,policy,initial,backup,coordinator,*,service,timeout=180):
    """Finish a healthy migration and enable host services before clearing its marker.

    The installation lock is released while the supervisor answers readiness
    checks. A failure or interruption retains the marker for reconciliation.
    """
    if sys.platform!='linux' or os.geteuid()!=0 or not sys.flags.isolated or not supervisor._uuid4(operation) or type(timeout) is not int or not 1<=timeout<=300:
        raise TransitionError('Invalid completion request')
    database=journal.db.execute('PRAGMA database_list').fetchone()
    if not database or not database[2] or not os.path.isabs(database[2]):raise TransitionError('Persistent journal is required')
    path,accepted,approved=daemon.resolve_active_policy(database[2],active_env)
    if not isinstance(approved,supervisor.RuntimePolicy):raise TransitionError('Invalid active policy')
    install=supervisor._trusted_directory(approved.install_dir,0o700);lock=None;identity=None
    marker=('servus-legacy-migration-v1 '+operation+'\n').encode('ascii');deadline=time.monotonic()+timeout
    def acquire():
        end=min(deadline,time.monotonic()+30)
        while True:
            try:return policy._installation_lock(install,supervisor)
            except BlockingIOError:
                if time.monotonic()>=end:raise TransitionError('Installation lock is unavailable')
                time.sleep(.1)
    def check_marker():
        fd=supervisor._open_root_file(install,MARKER,0o600)
        try:
            opened=os.fstat(fd);named=os.stat(MARKER,dir_fd=install,follow_symlinks=False)
            if ((opened.st_dev,opened.st_ino)!=identity or (named.st_dev,named.st_ino)!=identity or
                os.read(fd,len(marker)+1)!=marker):raise TransitionError('Migration marker changed')
        finally:os.close(fd)
    def check_evidence(phase):
        check_marker()
        if daemon.resolve_active_policy(database[2],active_env)!=(path,accepted,approved):raise TransitionError('Active policy changed')
        db=journal.db
        if (db.execute('SELECT phase FROM legacy_transitions WHERE operation_id=?',(operation,)).fetchone()!=(phase,) or
            db.execute('SELECT phase FROM initial_generations WHERE operation_id=?',(operation,)).fetchone()!=('started',) or
            db.execute('SELECT status FROM preparations WHERE operation_id=?',(operation,)).fetchone()!=('completed',) or
            db.execute('SELECT state FROM legacy_removals WHERE operation_id=?',(operation,)).fetchone()!=('removed',) or
            db.execute("SELECT 1 FROM update_transactions WHERE phase!='completed' OR phase IS NULL LIMIT 1").fetchone()):
            raise TransitionError('Migration is not ready to finish')
        snapshot=db.execute('SELECT path,digest,state FROM legacy_snapshots WHERE operation_id=?',(operation,)).fetchone()
        protection=db.execute('SELECT source,source_dev,source_ino,snapshot_digest,target_dev,target_ino,state FROM legacy_protections WHERE operation_id=?',(operation,)).fetchone()
        adoption=db.execute('SELECT snapshot_path,snapshot_digest,data_parent,data_dev,data_ino,state FROM initial_adoptions WHERE operation_id=?',(operation,)).fetchone()
        fence=db.execute('SELECT source,source_dev,source_ino,old_ids,state FROM legacy_migration_fences WHERE operation_id=?',(operation,)).fetchone()
        stopped=db.execute('SELECT source,source_dev,source_ino,old_ids,state FROM legacy_stop_operations WHERE operation_id=?',(operation,)).fetchone()
        recovery=db.execute('SELECT path,env_digest,compose_digest,state FROM legacy_recovery WHERE operation_id=?',(operation,)).fetchone()
        if (not snapshot or snapshot[-1]!='verified' or not protection or protection[-1]!='protected' or
            not adoption or adoption[-1]!='consumed' or not fence or fence[-1]!='fenced' or not stopped or stopped[-1]!='stopped' or not recovery or recovery[-1]!='verified' or
            snapshot[:2]!=adoption[:2] or protection[3]!=snapshot[1] or tuple(protection[4:6])!=tuple(adoption[3:5]) or
            tuple(protection[:3])!=tuple(fence[:3]) or stopped[:4]!=fence[:4] or approved.data_dir!=os.path.join(adoption[2],'restore-'+operation)):
            raise TransitionError('Migration evidence does not match')
        original=supervisor._trusted_directory(protection[0],0o700)
        try:
            info=os.fstat(original)
            if (info.st_dev,info.st_ino,info.st_uid,info.st_gid,stat.S_IMODE(info.st_mode))!=(protection[1],protection[2],0,0,0o700):
                raise TransitionError('Original data protection changed')
        finally:os.close(original)
        supervisor._verify_data_directory(approved.data_dir)
        current=os.stat(approved.data_dir,follow_symlinks=False)
        if ((current.st_dev,current.st_ino)!=(adoption[3],adoption[4]) or not stat.S_ISDIR(current.st_mode) or
            (current.st_uid,current.st_gid,stat.S_IMODE(current.st_mode))!=(1000,1000,0o700)):
            raise TransitionError('Active data identity changed')
        saved=supervisor._trusted_directory(recovery[0],0o700)
        try:
            if os.fstat(saved).st_gid!=0 or set(os.listdir(saved))!={'legacy.env','compose.yaml'}:raise TransitionError('Recovery inventory changed')
            for name,digest in (('legacy.env',recovery[1]),('compose.yaml',recovery[2])):
                fd=supervisor._open_root_file(saved,name,0o600)
                try:
                    before=os.fstat(fd);value=backup._read(fd,1024*1024);after=os.fstat(fd);named=os.stat(name,dir_fd=saved,follow_symlinks=False)
                    if ((before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns,before.st_ctime_ns)!=
                        (after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns) or
                        (before.st_dev,before.st_ino)!=(named.st_dev,named.st_ino) or 'sha256:'+hashlib.sha256(value).hexdigest()!=digest):
                        raise TransitionError('Recovery file changed')
                finally:os.close(fd)
        finally:os.close(saved)
        coordinator.verify_snapshot(snapshot[0],snapshot[1],backup,node_fd,supervisor)
        identities=supervisor.inspect_servus(approved)
        if not isinstance(identities,dict) or set(identities)!=set(supervisor.ROLES):raise TransitionError('Active generation is unavailable')
        try:old_ids=json.loads(fence[3],object_pairs_hook=coordinator._pairs)
        except (ValueError,TypeError,UnicodeError) as error:raise TransitionError('Legacy identity is invalid') from error
        if (not isinstance(old_ids,dict) or set(old_ids)!=set(supervisor.ROLES) or
            any(not isinstance(value,str) or not supervisor.CONTAINER.fullmatch(value) for value in old_ids.values()) or
            len(set(old_ids.values()))!=len(supervisor.ROLES) or
            any(not isinstance(identities[role],dict) or not isinstance(identities[role].get('id'),str) or
                not supervisor.CONTAINER.fullmatch(identities[role]['id']) or identities[role]['id'] in old_ids.values() for role in supervisor.ROLES) or
            len({identities[role]['id'] for role in supervisor.ROLES})!=len(supervisor.ROLES)):
            raise TransitionError('Active generation identity is invalid')
    try:
        lock=acquire()
        fd=supervisor._open_root_file(install,MARKER,0o600)
        try:info=os.fstat(fd);identity=(info.st_dev,info.st_ino)
        finally:os.close(fd)
        check_evidence('started')
        if journal.db.execute("UPDATE legacy_transitions SET phase='completing' WHERE operation_id=? AND phase='started'",(operation,)).rowcount!=1:
            raise TransitionError('Migration state changed')
        os.close(lock);lock=None
        initial.check_supervisor(approved.control_dir,supervisor,expected='ready')
        initial.check_updater(approved.updater_dir,supervisor)
        for unit in ('servus-supervisor.service','servus-updater.service','servus-updater-socket.service'):
            if service('is-active',unit)!=(0,'active'):raise TransitionError('Host service is not active')
        if service('enable','servus-supervisor.service','servus-updater.service','servus-updater-socket.service',timeout=45)[0]!=0:
            raise TransitionError('Host services could not be enabled')
        initial.check_supervisor(approved.control_dir,supervisor,expected='ready')
        lock=acquire();check_evidence('completing')
        if journal.db.execute("UPDATE legacy_transitions SET phase='completed' WHERE operation_id=? AND phase='completing'",(operation,)).rowcount!=1:
            raise TransitionError('Migration state changed')
        os.unlink(MARKER,dir_fd=install);os.fsync(install)
    finally:
        if lock is not None:os.close(lock)
        os.close(install)


def transition(journal,operation,active_env,source,old_image,old_image_id,old_ids,old_env,old_compose,
               recovery_dir,snapshot_dir,restore_parent,node_fd,docker_config,supervisor,daemon,adoption,policy,
               quiescence,docker,backup,coordinator,restore,recovery,legacy,initial,extractor,fence,
               *,install_lock,trusted_ingress=None,check=None,updater_check=None):
    """Run the migration steps; any interruption leaves recovery evidence."""
    if sys.platform!='linux' or os.geteuid()!=0 or not sys.flags.isolated or not supervisor._uuid4(operation):
        raise TransitionError('Isolated Linux root is required')
    policy_path,accepted,approved,binding=adoption._binding(journal,operation,active_env,supervisor,daemon)
    if (fence.journal is not journal or fence.operation!=operation or fence.active_env!=active_env or
        fence.source!=source or fence.old_ids!=old_ids):raise TransitionError('Migration fence identity differs')
    install=supervisor._trusted_directory(approved.install_dir,0o700);marker_identity=None
    marker=('servus-legacy-migration-v1 '+operation+'\n').encode('ascii')
    try:
        expected=supervisor._open_root_file(install,'install.lock',0o600)
        try:
            held,named=os.fstat(install_lock),os.fstat(expected)
            if (held.st_dev,held.st_ino)!=(named.st_dev,named.st_ino):raise TransitionError('Installation lock does not match')
            supervisor._assert_exclusive_flock(install_lock)
        finally:os.close(expected)
        docker_dir=supervisor._trusted_directory(docker_config,0o700)
        try:
            if os.listdir(docker_dir):raise TransitionError('Docker configuration is not empty')
        finally:os.close(docker_dir)
        (check or initial.check_supervisor)(approved.control_dir,supervisor)
        (updater_check or initial.check_updater)(approved.updater_dir,supervisor)
        if approved.data_dir!=os.path.join(restore_parent,'restore-'+operation):raise TransitionError('Restored path does not match policy')
        if adoption._binding(journal,operation,active_env,supervisor,daemon)!=(policy_path,accepted,approved,binding):raise TransitionError('Approved release changed')
        db=journal.db
        db.execute("CREATE TABLE IF NOT EXISTS legacy_transitions(operation_id TEXT PRIMARY KEY, phase TEXT NOT NULL CHECK(phase IN ('starting','stopped','recovery_saved','snapshot_verified','restored','protected','removed','adopted','started','completing','completed','recovery_required'))) ")
        existing=db.execute('SELECT operation_id,phase FROM legacy_transitions').fetchall()
        resumed=existing==[(operation,'stopped')]
        if existing and not resumed:raise TransitionError('Existing migration requires recovery')
        if resumed:
            stopped=db.execute('SELECT preparation_id,attempt_id,nonce,root_digest,config_digest,policy_path,accepted_env,active_env,source,old_image,old_image_id,old_ids,state FROM legacy_stop_operations WHERE operation_id=?',(operation,)).fetchone()
            if (not stopped or stopped[:9]!=(*binding,policy_path,accepted,active_env,source) or
                stopped[9:12]!=(old_image,old_image_id,json.dumps(old_ids,sort_keys=True,separators=(',',':'))) or stopped[-1]!='stopped'):
                raise TransitionError('Stopped legacy installation does not match')
            fd=supervisor._open_root_file(install,MARKER,0o600)
            try:
                info=os.fstat(fd);marker_identity=(info.st_dev,info.st_ino)
                if os.read(fd,len(marker)+1)!=marker:raise TransitionError('Migration marker changed')
            finally:os.close(fd)
        else:
            fd=os.open(MARKER,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=install)
            try:
                os.fchmod(fd,0o600)
                with os.fdopen(fd,'wb',closefd=False) as output:output.write(marker);output.flush();os.fsync(fd)
                info=os.fstat(fd);marker_identity=(info.st_dev,info.st_ino)
            finally:os.close(fd)
            os.fsync(install)
        def verify_marker():
            supervisor._assert_exclusive_flock(install_lock)
            fd=supervisor._open_root_file(install,MARKER,0o600)
            try:
                opened=os.fstat(fd);named=os.stat(MARKER,dir_fd=install,follow_symlinks=False)
                if ((opened.st_dev,opened.st_ino)!=marker_identity or (named.st_dev,named.st_ino)!=marker_identity or
                    os.read(fd,len(marker)+1)!=marker):raise TransitionError('Migration marker changed')
            finally:os.close(fd)
        if not resumed:
            db.execute('BEGIN IMMEDIATE')
            try:
                verify_marker()
                if db.execute('SELECT 1 FROM legacy_transitions LIMIT 1').fetchone():raise TransitionError('Existing migration requires recovery')
                db.execute("INSERT INTO legacy_transitions VALUES(?,'starting')",(operation,));db.execute('COMMIT')
            except BaseException:
                if db.in_transaction:db.execute('ROLLBACK')
                raise
        phase='stopped' if resumed else 'starting'
        def advance(next_phase):
            nonlocal phase
            verify_marker()
            if db.execute('UPDATE legacy_transitions SET phase=? WHERE operation_id=? AND phase=?',(next_phase,operation,phase)).rowcount!=1:
                raise TransitionError('Migration state changed')
            phase=next_phase
        try:
            if not resumed:
                legacy.stop(journal,operation,active_env,source,old_image,old_image_id,old_ids,supervisor,daemon,adoption,quiescence,docker,
                            install_lock=install_lock,trusted_ingress=trusted_ingress)
                advance('stopped')
            recovery.capture(journal,operation,active_env,old_env,old_compose,recovery_dir,supervisor,daemon,adoption,policy,backup,quiescence,docker,
                             install_lock=install_lock,trusted_ingress=trusted_ingress)
            advance('recovery_saved')
            digest=legacy.capture(journal,operation,active_env,snapshot_dir,node_fd,supervisor,daemon,adoption,quiescence,docker,backup,coordinator,
                                  install_lock=install_lock,trusted_ingress=trusted_ingress)
            advance('snapshot_verified')
            quiescence.ensure_host_namespaces()
            quiescence.ensure_no_data_mounts(docker,approved.data_dir)
            quiescence.ensure_no_mount_aliases(docker,approved.data_dir)
            quiescence.ensure_no_open_data(approved.data_dir)
            quiescence.ensure_no_uid_writers(1000)
            restored=restore.stage(snapshot_dir,digest,restore_parent,operation,backup,node_fd,supervisor,coordinator,reuse_empty=True)
            if restored!=approved.data_dir:raise TransitionError('Restored path changed')
            quiescence.ensure_no_data_mounts(docker,approved.data_dir)
            quiescence.ensure_no_open_data(approved.data_dir)
            quiescence.ensure_no_uid_writers(1000)
            advance('restored')
            legacy.protect(journal,operation,active_env,restore_parent,node_fd,supervisor,daemon,adoption,quiescence,docker,backup,coordinator,restore,
                           install_lock=install_lock,trusted_ingress=trusted_ingress)
            advance('protected')
            legacy.remove(journal,operation,active_env,restore_parent,node_fd,supervisor,daemon,adoption,policy,quiescence,docker,backup,coordinator,restore,recovery,fence,
                          install_lock=install_lock,trusted_ingress=trusted_ingress)
            advance('removed')
            adoption.record(journal,operation,active_env,snapshot_dir,digest,restore_parent,backup,node_fd,supervisor,daemon,policy,coordinator,restore,quiescence,
                            inherited_lock=install_lock)
            advance('adopted')
            migration=SimpleNamespace(fence=fence,adoption=adoption,node_fd=node_fd,coordinator=coordinator,restore=restore,quiescence=quiescence)
            kwargs={'inherited_lock':install_lock,'migration':migration}
            if check is not None:kwargs['check']=check
            if updater_check is not None:kwargs['updater_check']=updater_check
            result=initial.launch(journal,operation,active_env,docker_config,supervisor,daemon,extractor,backup,policy,**kwargs)
            advance('started')
            return result
        except BaseException:
            try:db.execute("UPDATE legacy_transitions SET phase='recovery_required' WHERE operation_id=? AND phase=?",(operation,phase))
            except BaseException:pass
            raise
    finally:os.close(install)
