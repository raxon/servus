#!/usr/bin/python3 -I
"""Durably stop a validated legacy control plane before snapshot capture.

This module neither creates a snapshot nor permits starting a new generation.
The coordinator must protect the original data and implement explicit recovery.
"""
import hashlib
import json
import os
import re
import stat
import sys


class LegacyStopError(Exception):
    pass


def stop(journal,operation,active_env,source,old_image,old_image_id,old_ids,supervisor,daemon,adoption,quiescence,docker,
         *,install_lock,trusted_ingress=None,candidate_policy=None):
    """Stop only the recorded legacy containers, leaving durable recovery state."""
    if sys.platform!='linux' or os.geteuid()!=0 or not sys.flags.isolated:raise LegacyStopError('Isolated Linux root is required')
    if (not supervisor._uuid4(operation) or not isinstance(source,str) or not source.startswith('/') or source=='/' or os.path.normpath(source)!=source or
        not isinstance(old_image,str) or not re.fullmatch(r'ghcr\.io/raxon/servus@sha256:[a-f0-9]{64}',old_image) or
        not isinstance(old_image_id,str) or not re.fullmatch(r'sha256:[a-f0-9]{64}',old_image_id) or
        not isinstance(old_ids,dict) or set(old_ids)!={'api','worker','agent'} or
        any(not isinstance(value,str) or not re.fullmatch(r'[a-f0-9]{64}',value) for value in old_ids.values()) or len(set(old_ids.values()))!=3):
        raise LegacyStopError('Invalid legacy installation identity')
    if candidate_policy is None:
        def resolve():return adoption._binding(journal,operation,active_env,supervisor,daemon)
    else:
        if not isinstance(candidate_policy,tuple) or len(candidate_policy)!=2:raise LegacyStopError('Invalid candidate policy')
        def resolve():return adoption.prepared_binding(journal,operation,active_env,candidate_policy[0],supervisor,candidate_policy[1])
    policy_path,accepted,approved,binding=resolve()
    if source==approved.data_dir or source.startswith(approved.data_dir+'/') or approved.data_dir.startswith(source+'/'):
        raise LegacyStopError('Migration data paths overlap')
    install=supervisor._trusted_directory(approved.install_dir,0o700)
    try:
        expected=supervisor._open_root_file(install,'install.lock',0o600)
        try:
            held,named=os.fstat(install_lock),os.fstat(expected)
            if (held.st_dev,held.st_ino)!=(named.st_dev,named.st_ino):raise LegacyStopError('Installation lock does not match')
            supervisor._assert_exclusive_flock(install_lock)
        finally:os.close(expected)
        if candidate_policy is not None:
            marker=supervisor._open_root_file(install,'.legacy-migration-v1',0o600)
            try:
                value=('servus-legacy-migration-v1 '+operation+'\n').encode('ascii')
                if os.read(marker,len(value)+1)!=value:raise LegacyStopError('Migration marker does not match')
            finally:os.close(marker)
    finally:os.close(install)
    quiescence.ensure_host_namespaces()
    supervisor._verify_data_directory(source)
    source_fd=os.open(source,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:
        info=os.fstat(source_fd)
        if (info.st_uid,info.st_gid,stat.S_IMODE(info.st_mode))!=(1000,1000,0o700):raise LegacyStopError('Legacy data permissions are invalid')
        identity=(info.st_dev,info.st_ino)
        def inspect(*,initial=False):
            try:ids=docker.call('ps','-aq','--no-trunc','--filter','label=com.docker.compose.project=servus').decode('ascii').splitlines()
            except (UnicodeError,ValueError):raise LegacyStopError('Container inventory is invalid') from None
            if len(ids)!=3 or len(set(ids))!=3 or set(ids)!=set(old_ids.values()):raise LegacyStopError('Legacy container inventory changed')
            records=docker.inspect(*sorted(ids))
            if not isinstance(records,list) or len(records)!=3 or any(not isinstance(item,dict) for item in records) or {item.get('Id') for item in records}!=set(ids):
                raise LegacyStopError('Legacy container inspection failed')
            for item in records:
                config,state,host,mounts=item.get('Config'),item.get('State'),item.get('HostConfig'),item.get('Mounts')
                if not all(isinstance(value,dict) for value in (config,state,host)) or not isinstance(mounts,list):raise LegacyStopError('Legacy container inspection failed')
                labels=config.get('Labels') or {};role=labels.get('com.docker.compose.service') if isinstance(labels,dict) else None
                if (role not in old_ids or old_ids[role]!=item['Id'] or labels.get('com.docker.compose.project')!='servus' or
                    any(key.startswith('com.docker.swarm.') for key in labels) or item.get('Image')!=old_image_id or
                    config.get('Image')!=old_image or config.get('User')!='node' or
                    config.get('Cmd')!=['node','dist/'+('server' if role=='api' else role)+'/index.js'] or
                    host.get('Privileged') is not False or host.get('PidMode')!='' or host.get('AutoRemove') is not False or
                    not isinstance(host.get('RestartPolicy'),dict) or host['RestartPolicy'].get('Name') not in ('unless-stopped','no') or
                    state.get('Paused') is not False or state.get('Restarting') is not False or type(state.get('Running')) is not bool):
                    raise LegacyStopError('Legacy container identity changed')
                if initial and (state.get('Running') is not True or host['RestartPolicy']['Name']!='unless-stopped'):
                    raise LegacyStopError('Legacy control plane is not running normally')
                expected_mounts={(source,source,True)}
                if role=='agent':expected_mounts.add(('/var/run/docker.sock','/var/run/docker.sock',True))
                if (any(not isinstance(mount,dict) or mount.get('Type')!='bind' for mount in mounts) or len(mounts)!=len(expected_mounts) or
                    {(mount.get('Source'),mount.get('Destination'),mount.get('RW')) for mount in mounts}!=expected_mounts):
                    raise LegacyStopError('Legacy container mounts changed')
            named=os.stat(source,follow_symlinks=False);current=os.fstat(source_fd)
            if (named.st_dev,named.st_ino)!=(current.st_dev,current.st_ino) or (current.st_dev,current.st_ino)!=identity or (current.st_uid,current.st_gid,stat.S_IMODE(current.st_mode))!=(1000,1000,0o700):
                raise LegacyStopError('Legacy data directory changed')
            if resolve()!=(policy_path,accepted,approved,binding):raise LegacyStopError('Approved release changed')
            return {item['Id']:item for item in records}
        inspect(initial=True)
        db=journal.db;db.execute('BEGIN IMMEDIATE')
        try:
            inspect(initial=True)
            db.execute("CREATE TABLE IF NOT EXISTS legacy_stop_operations (operation_id TEXT PRIMARY KEY, preparation_id TEXT NOT NULL, attempt_id TEXT NOT NULL, nonce TEXT NOT NULL, root_digest TEXT NOT NULL, config_digest TEXT NOT NULL, policy_path TEXT NOT NULL, accepted_env TEXT NOT NULL, active_env TEXT NOT NULL, source TEXT NOT NULL, source_dev INTEGER NOT NULL, source_ino INTEGER NOT NULL, old_image TEXT NOT NULL, old_image_id TEXT NOT NULL, old_ids TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('stopping','stopped','recovery_required'))) ")
            if db.execute('SELECT 1 FROM legacy_stop_operations LIMIT 1').fetchone():raise LegacyStopError('Existing legacy stop requires recovery')
            db.execute("INSERT INTO legacy_stop_operations VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'stopping')",(operation,*binding,policy_path,accepted,active_env,source,*identity,old_image,old_image_id,json.dumps(old_ids,sort_keys=True,separators=(',',':'))))
            db.execute('COMMIT')
        except BaseException:
            if db.in_transaction:db.execute('ROLLBACK')
            raise
        try:
            for role in ('api','worker','agent'):
                inspect();docker.call('update','--restart=no',old_ids[role],timeout=30)
            for role in ('api','worker','agent'):
                inspect();docker.call('stop','--time','180',old_ids[role],timeout=200)
                state=inspect()[old_ids[role]]['State']
                if state.get('Running') is not False or state.get('ExitCode') not in ((0,143) if role=='worker' else (0,)):
                    raise LegacyStopError('Legacy component did not stop cleanly')
            inspect();quiescence.ensure_restart_fenced(docker,set(old_ids.values()))
            quiescence.ensure_no_other_data_mounts(docker,set(old_ids.values()),source,trusted_ingress=trusted_ingress)
            quiescence.ensure_no_mount_aliases(docker,source)
            quiescence.ensure_no_open_data(source)
            quiescence.ensure_no_uid_writers(1000)
            inspect();quiescence.ensure_restart_fenced(docker,set(old_ids.values()))
            if db.execute("UPDATE legacy_stop_operations SET state='stopped' WHERE operation_id=? AND state='stopping'",(operation,)).rowcount!=1:
                raise LegacyStopError('Legacy stop state changed')
        except BaseException:
            try:db.execute("UPDATE legacy_stop_operations SET state='recovery_required' WHERE operation_id=? AND state='stopping'",(operation,))
            except BaseException:pass
            raise
        return identity
    finally:os.close(source_fd)


def capture(journal,operation,active_env,destination,node_fd,supervisor,daemon,adoption,quiescence,docker,backup,coordinator,
            *,install_lock,trusted_ingress=None):
    """Capture a stopped installation under the same installation lock.

    The caller must maintain the independent startup and writer fence throughout
    capture and restore. A recorded snapshot does not authorize a start.
    """
    if sys.platform!='linux' or os.geteuid()!=0 or not sys.flags.isolated or not supervisor._uuid4(operation):
        raise LegacyStopError('Isolated Linux root is required')
    policy_path,accepted,approved,binding=adoption._binding(journal,operation,active_env,supervisor,daemon)
    directory=supervisor._trusted_directory(approved.install_dir,0o700)
    try:
        expected=supervisor._open_root_file(directory,'install.lock',0o600)
        try:
            held,named=os.fstat(install_lock),os.fstat(expected)
            if (held.st_dev,held.st_ino)!=(named.st_dev,named.st_ino):raise LegacyStopError('Installation lock does not match')
            supervisor._assert_exclusive_flock(install_lock)
        finally:os.close(expected)
    finally:os.close(directory)
    row=journal.db.execute('SELECT preparation_id,attempt_id,nonce,root_digest,config_digest,policy_path,accepted_env,active_env,source,source_dev,source_ino,old_image,old_image_id,old_ids,state FROM legacy_stop_operations WHERE operation_id=?',(operation,)).fetchone()
    if not row or row[:8]!=(*binding,policy_path,accepted,active_env) or row[-1]!='stopped':raise LegacyStopError('Stopped installation does not match')
    source,dev,ino=row[8:11]
    try:old_ids=json.loads(row[13],object_pairs_hook=coordinator._pairs)
    except (ValueError,TypeError,UnicodeError) as error:raise LegacyStopError('Legacy container identity is invalid') from error
    if (not isinstance(old_ids,dict) or set(old_ids)!={'api','worker','agent'} or
        any(not isinstance(value,str) or not re.fullmatch(r'[a-f0-9]{64}',value) for value in old_ids.values()) or len(set(old_ids.values()))!=3 or
        not isinstance(destination,str) or not destination.startswith('/') or os.path.normpath(destination)!=destination or destination=='/' or
        destination==source or destination.startswith(source+'/') or source.startswith(destination+'/') or
        destination==approved.data_dir or destination.startswith(approved.data_dir+'/') or approved.data_dir.startswith(destination+'/')):
        raise LegacyStopError('Snapshot identity or destination is invalid')
    supervisor._verify_data_directory(source)
    source_fd=os.open(source,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC)
    destination_fd=None
    try:
        destination_fd=supervisor._trusted_directory(destination,0o700)
        if os.fstat(destination_fd).st_gid!=0 or os.listdir(destination_fd):raise LegacyStopError('Snapshot destination is not empty and protected')
        def check():
            supervisor._assert_exclusive_flock(install_lock)
            current=os.fstat(source_fd);named=os.stat(source,follow_symlinks=False)
            if ((current.st_dev,current.st_ino)!=(dev,ino) or (named.st_dev,named.st_ino)!=(dev,ino) or
                (current.st_uid,current.st_gid,stat.S_IMODE(current.st_mode))!=(1000,1000,0o700)):
                raise LegacyStopError('Legacy data directory changed')
            if adoption._binding(journal,operation,active_env,supervisor,daemon)!=(policy_path,accepted,approved,binding):raise LegacyStopError('Approved release changed')
            current_row=journal.db.execute('SELECT preparation_id,attempt_id,nonce,root_digest,config_digest,policy_path,accepted_env,active_env,source,source_dev,source_ino,old_image,old_image_id,old_ids,state FROM legacy_stop_operations WHERE operation_id=?',(operation,)).fetchone()
            if current_row!=row:raise LegacyStopError('Legacy stop state changed')
            quiescence.ensure_host_namespaces()
            quiescence.ensure_restart_fenced(docker,set(old_ids.values()))
            quiescence.ensure_no_other_data_mounts(docker,set(old_ids.values()),source,trusted_ingress=trusted_ingress)
            quiescence.ensure_no_mount_aliases(docker,source)
            quiescence.ensure_no_open_data(source)
            quiescence.ensure_no_uid_writers(1000)
        check()
        db=journal.db;db.execute('BEGIN IMMEDIATE')
        try:
            check()
            db.execute("CREATE TABLE IF NOT EXISTS legacy_snapshots(operation_id TEXT PRIMARY KEY, path TEXT NOT NULL, digest TEXT, state TEXT NOT NULL CHECK(state IN ('capturing','verified','recovery_required'))) ")
            if db.execute('SELECT 1 FROM legacy_snapshots LIMIT 1').fetchone():raise LegacyStopError('Existing snapshot requires recovery')
            db.execute("INSERT INTO legacy_snapshots VALUES(?,?,NULL,'capturing')",(operation,destination))
            db.execute('COMMIT')
        except BaseException:
            if db.in_transaction:db.execute('ROLLBACK')
            raise
        try:
            check()
            backup._capture_quiescent(source_fd,destination_fd,node_fd,source_uid=1000,reader_gid=65534)
            check()
            manifest,_=backup._file(destination_fd,'manifest.json',0,os.fstat(destination_fd).st_dev)
            try:digest='sha256:'+hashlib.sha256(backup._read(manifest)).hexdigest()
            finally:os.close(manifest)
            coordinator.verify_snapshot(destination,digest,backup,node_fd,supervisor)
            check()
            if db.execute("UPDATE legacy_snapshots SET digest=?,state='verified' WHERE operation_id=? AND path=? AND state='capturing' AND digest IS NULL",(digest,operation,destination)).rowcount!=1:
                raise LegacyStopError('Snapshot state changed')
            return digest
        except BaseException:
            try:
                db.execute('BEGIN IMMEDIATE')
                db.execute("UPDATE legacy_snapshots SET state='recovery_required' WHERE operation_id=? AND state='capturing'",(operation,))
                db.execute("UPDATE legacy_stop_operations SET state='recovery_required' WHERE operation_id=? AND state='stopped'",(operation,))
                db.execute('COMMIT')
            except BaseException:
                if db.in_transaction:
                    try:db.execute('ROLLBACK')
                    except BaseException:pass
            raise
    finally:
        if destination_fd is not None:os.close(destination_fd)
        os.close(source_fd)


def protect(journal,operation,active_env,parent,node_fd,supervisor,daemon,adoption,quiescence,docker,backup,coordinator,restore,
            *,install_lock,trusted_ingress=None):
    """Protect original data only after its snapshot and staged copy validate.

    The old containers remain stopped and present. A caller must retain its
    startup fence and implement recovery before attempting the next step.
    """
    if sys.platform!='linux' or os.geteuid()!=0 or not sys.flags.isolated or not supervisor._uuid4(operation):
        raise LegacyStopError('Isolated Linux root is required')
    policy_path,accepted,approved,binding=adoption._binding(journal,operation,active_env,supervisor,daemon)
    directory=supervisor._trusted_directory(approved.install_dir,0o700)
    try:
        expected=supervisor._open_root_file(directory,'install.lock',0o600)
        try:
            held,named=os.fstat(install_lock),os.fstat(expected)
            if (held.st_dev,held.st_ino)!=(named.st_dev,named.st_ino):raise LegacyStopError('Installation lock does not match')
            supervisor._assert_exclusive_flock(install_lock)
        finally:os.close(expected)
    finally:os.close(directory)
    db=journal.db
    row=db.execute('SELECT preparation_id,attempt_id,nonce,root_digest,config_digest,policy_path,accepted_env,active_env,source,source_dev,source_ino,old_image,old_image_id,old_ids,state FROM legacy_stop_operations WHERE operation_id=?',(operation,)).fetchone()
    snapshot=db.execute('SELECT path,digest,state FROM legacy_snapshots WHERE operation_id=?',(operation,)).fetchone()
    if not row or row[:8]!=(*binding,policy_path,accepted,active_env) or row[-1]!='stopped' or not snapshot or snapshot[2]!='verified':
        raise LegacyStopError('Verified stopped installation is unavailable')
    source,dev,ino=row[8:11];path,digest,_=snapshot
    adoption._check_paths(path,digest,parent,operation,approved)
    try:old_ids=json.loads(row[13],object_pairs_hook=coordinator._pairs)
    except (ValueError,TypeError,UnicodeError) as error:raise LegacyStopError('Legacy container identity is invalid') from error
    if (not isinstance(old_ids,dict) or set(old_ids)!={'api','worker','agent'} or
        any(not isinstance(value,str) or not re.fullmatch(r'[a-f0-9]{64}',value) for value in old_ids.values()) or len(set(old_ids.values()))!=3):
        raise LegacyStopError('Legacy container identity is invalid')
    supervisor._verify_data_directory(source)
    source_fd=os.open(source,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC)
    try:
        def check(owner):
            supervisor._assert_exclusive_flock(install_lock)
            current=os.fstat(source_fd);named=os.stat(source,follow_symlinks=False)
            if ((current.st_dev,current.st_ino)!=(dev,ino) or (named.st_dev,named.st_ino)!=(dev,ino) or
                (current.st_uid,current.st_gid,stat.S_IMODE(current.st_mode))!=(owner,owner,0o700)):
                raise LegacyStopError('Legacy data directory changed')
            if adoption._binding(journal,operation,active_env,supervisor,daemon)!=(policy_path,accepted,approved,binding):raise LegacyStopError('Approved release changed')
            current_row=db.execute('SELECT preparation_id,attempt_id,nonce,root_digest,config_digest,policy_path,accepted_env,active_env,source,source_dev,source_ino,old_image,old_image_id,old_ids,state FROM legacy_stop_operations WHERE operation_id=?',(operation,)).fetchone()
            if current_row!=row or db.execute('SELECT path,digest,state FROM legacy_snapshots WHERE operation_id=?',(operation,)).fetchone()!=snapshot:
                raise LegacyStopError('Migration evidence changed')
            quiescence.ensure_host_namespaces()
            quiescence.ensure_restart_fenced(docker,set(old_ids.values()))
            quiescence.ensure_no_other_data_mounts(docker,set(old_ids.values()),source,trusted_ingress=trusted_ingress)
            quiescence.ensure_no_mount_aliases(docker,source)
            quiescence.ensure_no_open_data(source)
            quiescence.ensure_no_uid_writers(1000)
        check(1000)
        target=restore.verify_staged(path,digest,parent,operation,backup,node_fd,supervisor,coordinator)
        check(1000)
        db.execute('BEGIN IMMEDIATE')
        try:
            check(1000)
            db.execute("CREATE TABLE IF NOT EXISTS legacy_protections(operation_id TEXT PRIMARY KEY,source TEXT NOT NULL,source_dev INTEGER NOT NULL,source_ino INTEGER NOT NULL,snapshot_digest TEXT NOT NULL,target_dev INTEGER NOT NULL,target_ino INTEGER NOT NULL,state TEXT NOT NULL CHECK(state IN ('protecting','protected','recovery_required'))) ")
            if db.execute('SELECT 1 FROM legacy_protections LIMIT 1').fetchone():raise LegacyStopError('Existing protection requires recovery')
            db.execute("INSERT INTO legacy_protections VALUES(?,?,?,?,?,?,?,'protecting')",(operation,source,dev,ino,digest,*target))
            db.execute('COMMIT')
        except BaseException:
            if db.in_transaction:db.execute('ROLLBACK')
            raise
        try:
            check(1000)
            os.fchown(source_fd,0,0);os.fsync(source_fd)
            check(0)
            if restore.verify_staged(path,digest,parent,operation,backup,node_fd,supervisor,coordinator)!=target:
                raise LegacyStopError('Staged data changed')
            check(0)
            if db.execute("UPDATE legacy_protections SET state='protected' WHERE operation_id=? AND state='protecting'",(operation,)).rowcount!=1:
                raise LegacyStopError('Protection state changed')
            return target
        except BaseException:
            try:db.execute("UPDATE legacy_protections SET state='recovery_required' WHERE operation_id=? AND state='protecting'",(operation,))
            except BaseException:pass
            raise
    finally:os.close(source_fd)


def remove(journal,operation,active_env,parent,node_fd,supervisor,daemon,adoption,policy,quiescence,docker,backup,coordinator,restore,recovery,fence,
           *,install_lock,trusted_ingress=None):
    """Remove stopped legacy containers only after verified recovery preparation.

    The original data remains protected. Interrupted removal requires recovery;
    this routine never recreates containers or starts a new generation.
    """
    if sys.platform!='linux' or os.geteuid()!=0 or not sys.flags.isolated or not supervisor._uuid4(operation):
        raise LegacyStopError('Isolated Linux root is required')
    policy_path,accepted,approved,binding=adoption._binding(journal,operation,active_env,supervisor,daemon)
    db=journal.db
    row=db.execute('SELECT preparation_id,attempt_id,nonce,root_digest,config_digest,policy_path,accepted_env,active_env,source,source_dev,source_ino,old_image,old_image_id,old_ids,state FROM legacy_stop_operations WHERE operation_id=?',(operation,)).fetchone()
    snapshot=db.execute('SELECT path,digest,state FROM legacy_snapshots WHERE operation_id=?',(operation,)).fetchone()
    protection=db.execute('SELECT source,source_dev,source_ino,snapshot_digest,target_dev,target_ino,state FROM legacy_protections WHERE operation_id=?',(operation,)).fetchone()
    if not row or row[:8]!=(*binding,policy_path,accepted,active_env) or row[-1]!='stopped' or not snapshot or snapshot[-1]!='verified' or not protection or protection[-1]!='protected':
        raise LegacyStopError('Protected legacy installation is unavailable')
    source,dev,ino,old_image,old_image_id=row[8:13];path,digest,_=snapshot
    if protection[:4]!=(source,dev,ino,digest):raise LegacyStopError('Protection does not match the snapshot')
    adoption._check_paths(path,digest,parent,operation,approved)
    try:old_ids=json.loads(row[13],object_pairs_hook=coordinator._pairs)
    except (ValueError,TypeError,UnicodeError) as error:raise LegacyStopError('Legacy container identity is invalid') from error
    if (not isinstance(old_ids,dict) or set(old_ids)!={'api','worker','agent'} or
        any(not isinstance(value,str) or not re.fullmatch(r'[a-f0-9]{64}',value) for value in old_ids.values()) or len(set(old_ids.values()))!=3):
        raise LegacyStopError('Legacy container identity is invalid')
    if (fence.journal is not journal or fence.operation!=operation or fence.active_env!=active_env or
        fence.source!=source or fence.old_ids!=old_ids):raise LegacyStopError('Migration fence identity differs')
    recover=recovery.verify(journal,operation,active_env,supervisor,daemon,adoption,policy,backup,install_lock=install_lock)
    if restore.verify_staged(path,digest,parent,operation,backup,node_fd,supervisor,coordinator)!=tuple(protection[4:6]):
        raise LegacyStopError('Staged data changed')
    original=supervisor._trusted_directory(source,0o700)
    try:
        def check(remaining):
            supervisor._assert_exclusive_flock(install_lock)
            current=os.fstat(original);named=os.stat(source,follow_symlinks=False)
            if ((current.st_dev,current.st_ino)!=(dev,ino) or (named.st_dev,named.st_ino)!=(dev,ino) or
                (current.st_uid,current.st_gid,stat.S_IMODE(current.st_mode))!=(0,0,0o700)):
                raise LegacyStopError('Original data protection changed')
            if adoption._binding(journal,operation,active_env,supervisor,daemon)!=(policy_path,accepted,approved,binding):raise LegacyStopError('Approved release changed')
            if (db.execute('SELECT preparation_id,attempt_id,nonce,root_digest,config_digest,policy_path,accepted_env,active_env,source,source_dev,source_ino,old_image,old_image_id,old_ids,state FROM legacy_stop_operations WHERE operation_id=?',(operation,)).fetchone()!=row or
                db.execute('SELECT path,digest,state FROM legacy_snapshots WHERE operation_id=?',(operation,)).fetchone()!=snapshot or
                db.execute('SELECT source,source_dev,source_ino,snapshot_digest,target_dev,target_ino,state FROM legacy_protections WHERE operation_id=?',(operation,)).fetchone()!=protection):
                raise LegacyStopError('Migration evidence changed')
            if recovery.verify(journal,operation,active_env,supervisor,daemon,adoption,policy,backup,install_lock=install_lock)!=recover:
                raise LegacyStopError('Recovery evidence changed')
            quiescence.ensure_host_namespaces();quiescence.ensure_no_mount_aliases(docker,source)
            quiescence.ensure_no_open_data(source);quiescence.ensure_no_uid_writers(1000)
            try:ids=docker.call('ps','-aq','--no-trunc').decode('ascii').splitlines()
            except (UnicodeError,ValueError):raise LegacyStopError('Container inventory is invalid') from None
            if len(ids)!=len(set(ids)) or not all(re.fullmatch(r'[a-f0-9]{64}',item) for item in ids) or not remaining.issubset(ids):
                raise LegacyStopError('Container inventory changed')
            items=docker.inspect(*ids) if ids else []
            if not isinstance(items,list) or len(items)!=len(ids) or any(not isinstance(item,dict) for item in items) or {item.get('Id') for item in items}!=set(ids):
                raise LegacyStopError('Container inspection is invalid')
            socket=os.path.realpath('/var/run/docker.sock')
            for item in items:
                cid=item['Id'];config=item.get('Config');host=item.get('HostConfig');state=item.get('State');mounts=item.get('Mounts')
                if not all(isinstance(value,dict) for value in (config,host,state)) or not isinstance(mounts,list):raise LegacyStopError('Container inspection is invalid')
                labels=config.get('Labels') or {}
                if not isinstance(labels,dict):raise LegacyStopError('Container labels are invalid')
                role=labels.get('com.docker.compose.service')
                if cid in remaining:
                    if (role not in old_ids or old_ids[role]!=cid or labels.get('com.docker.compose.project')!='servus' or
                        item.get('Image')!=old_image_id or config.get('Image')!=old_image or state.get('Running') is not False or
                        state.get('Paused') is not False or state.get('Restarting') is not False or host.get('AutoRemove') is not False or
                        not isinstance(host.get('RestartPolicy'),dict) or host['RestartPolicy'].get('Name')!='no'):
                        raise LegacyStopError('Stopped container identity changed')
                elif labels.get('com.docker.compose.project')=='servus':raise LegacyStopError('Unexpected Servus container')
                elif (host.get('Privileged') is not False or host.get('PidMode')=='host' or host.get('CapAdd') not in (None,[]) or
                      host.get('Devices') not in (None,[]) or host.get('DeviceRequests') not in (None,[])):
                    raise LegacyStopError('External container privileges are unsupported')
                expected_mounts={(source,source,True)}
                if cid in remaining and role=='agent':expected_mounts.add(('/var/run/docker.sock','/var/run/docker.sock',True))
                if cid in remaining and (len(mounts)!=len(expected_mounts) or any(not isinstance(m,dict) or m.get('Type')!='bind' for m in mounts) or
                    {(m.get('Source'),m.get('Destination'),m.get('RW')) for m in mounts}!=expected_mounts):
                    raise LegacyStopError('Stopped container mounts changed')
                for mount in mounts:
                    if not isinstance(mount,dict) or not isinstance(mount.get('Source'),str) or not mount['Source'].startswith('/'):
                        raise LegacyStopError('Container mounts are invalid')
                    mpath=os.path.realpath(mount['Source'])
                    if cid not in remaining and (mpath==source or mpath.startswith(source+'/') or source.startswith(mpath.rstrip('/')+'/')):
                        raise LegacyStopError('Another container can access original data')
                    if cid not in remaining and (socket==mpath or socket.startswith(mpath.rstrip('/')+'/')):
                        identity=(cid,labels.get('com.docker.swarm.service.name'),config.get('Image'),item.get('Image'))
                        if not (trusted_ingress is not None and identity==trusted_ingress and mpath==socket and mount.get('RW') is False):
                            raise LegacyStopError('Another container can access Docker')
        remaining=set(old_ids.values());check(remaining)
        db.execute('BEGIN IMMEDIATE')
        try:
            check(remaining)
            db.execute("CREATE TABLE IF NOT EXISTS legacy_removals(operation_id TEXT PRIMARY KEY, state TEXT NOT NULL CHECK(state IN ('removing','removed','recovery_required'))) ")
            if db.execute('SELECT 1 FROM legacy_removals LIMIT 1').fetchone():raise LegacyStopError('Existing removal requires recovery')
            db.execute("INSERT INTO legacy_removals VALUES(?,'removing')",(operation,));db.execute('COMMIT')
        except BaseException:
            if db.in_transaction:db.execute('ROLLBACK')
            raise
        try:
            for role in ('api','worker','agent'):
                check(remaining);docker.call('rm',old_ids[role],timeout=30);remaining.remove(old_ids[role]);check(remaining)
            if restore.verify_staged(path,digest,parent,operation,backup,node_fd,supervisor,coordinator)!=tuple(protection[4:6]):
                raise LegacyStopError('Staged data changed')
            fence.record(operation,install_lock)
            if db.execute("UPDATE legacy_removals SET state='removed' WHERE operation_id=? AND state='removing'",(operation,)).rowcount!=1:
                raise LegacyStopError('Removal state changed')
        except BaseException:
            try:db.execute("UPDATE legacy_removals SET state='recovery_required' WHERE operation_id=? AND state='removing'",(operation,))
            except BaseException:pass
            raise
    finally:os.close(original)
