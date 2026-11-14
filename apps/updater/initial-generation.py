#!/usr/bin/python3 -I
"""Start the first approved Servus generation; interrupted starts require recovery."""
import argparse
import hashlib
import importlib.util
import os
import pathlib
import re
import select
import signal
import socket
import stat
import struct
import sys
import threading
import time

UPDATER_DIR = '/run/servus-updater/control'


class InitialGenerationError(Exception):
    pass


def check_supervisor(control_dir, supervisor):
    directory = supervisor._trusted_directory(control_dir, 0o750)
    try:
        before = os.stat('command', dir_fd=directory, follow_symlinks=False)
        if not stat.S_ISSOCK(before.st_mode) or before.st_uid != 0 or stat.S_IMODE(before.st_mode) != 0o600:
            raise InitialGenerationError('Unsafe supervisor command socket')
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as conn:
            conn.settimeout(5)
            conn.connect(control_dir + '/command')
            pid, uid, _ = struct.unpack('3i', conn.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
            after = os.stat('command', dir_fd=directory, follow_symlinks=False)
            if uid != 0 or pid <= 0 or (before.st_dev, before.st_ino) != (after.st_dev, after.st_ino):
                raise InitialGenerationError('Supervisor identity changed')
            deadline = time.monotonic() + 5
            supervisor._send_message(conn, {'version':1,'type':'status'}, deadline)
            if supervisor._read_message(conn, deadline) != {'version':1,'status':'waiting'}:
                raise InitialGenerationError('Supervisor is not awaiting the first generation')
    finally:
        os.close(directory)


def check_updater(updater_dir, supervisor):
    """Check the unprivileged API path and require an updater with apply enabled."""
    if threading.active_count() != 1:
        raise InitialGenerationError('Updater check requires a single-threaded coordinator')
    if updater_dir != UPDATER_DIR:
        raise InitialGenerationError('Updater socket directory is not approved')
    directory = supervisor._trusted_directory(updater_dir, 0o710)
    try:
        info=os.fstat(directory)
        if info.st_gid != 1000: raise InitialGenerationError('Unsafe updater socket directory')
        before=os.stat('updater.sock',dir_fd=directory,follow_symlinks=False)
        if not stat.S_ISSOCK(before.st_mode) or before.st_uid != 0 or before.st_gid != 1000 or stat.S_IMODE(before.st_mode) != 0o660:
            raise InitialGenerationError('Unsafe updater socket')
        reader,writer=os.pipe()
        try: pid=os.fork()
        except BaseException: os.close(reader);os.close(writer);raise
        if pid == 0:
            os.close(reader)
            try:
                os.setgroups([]);os.setgid(1000);os.setuid(1000)
                with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as conn:
                    conn.settimeout(5);conn.connect(updater_dir+'/updater.sock')
                    peer,uid,_=struct.unpack('3i',conn.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))
                    if uid != 0 or peer <= 0: raise InitialGenerationError('Unsafe updater peer')
                    deadline=time.monotonic()+5
                    supervisor._send_message(conn,{'version':1,'action':'apply','operationId':'invalid'},deadline)
                    response=supervisor._read_message(conn,deadline)
                    if response != {'ok':False,'error':'invalid_request'}: raise InitialGenerationError('Updater cannot apply')
                os.write(writer,b'1')
            except BaseException: pass
            finally: os.close(writer);os._exit(0)
        os.close(writer)
        try:
            ready,_,_=select.select([reader],[],[],8)
            if not ready:
                os.kill(pid,signal.SIGKILL);raise InitialGenerationError('Updater check timed out')
            if os.read(reader,2) != b'1': raise InitialGenerationError('Updater is not ready')
            after=os.stat('updater.sock',dir_fd=directory,follow_symlinks=False)
            if (before.st_dev,before.st_ino) != (after.st_dev,after.st_ino):
                raise InitialGenerationError('Updater socket changed')
        finally:
            os.close(reader);os.waitpid(pid,0)
    finally: os.close(directory)


def launch(journal, operation, active_env, docker_config, supervisor, daemon, extractor, backup, policy, *, inherited_lock=None, check=check_supervisor, updater_check=check_updater, migration=None):
    """Start the approved image; a migration caller must hold its durable fence.

    Migration is an internal interface, not exposed by the first-install CLI.
    Its coordinator must exclude legacy and external writers across the entire
    verification and startup, including after a reboot or interrupted start.
    """
    if sys.platform != 'linux' or os.geteuid() != 0 or not sys.flags.isolated or not supervisor._uuid4(operation):
        raise InitialGenerationError('A valid isolated root operation is required')
    database = journal.db.execute('PRAGMA database_list').fetchone()
    if not database or not database[2]: raise InitialGenerationError('Persistent journal is required')
    approval_journal = os.path.abspath(database[2])
    path, snapshot, approved = daemon.resolve_active_policy(approval_journal, active_env)
    if not isinstance(approved, supervisor.RuntimePolicy): raise InitialGenerationError('Invalid active policy')
    directory = supervisor._trusted_directory(approved.install_dir)
    lock = stage_fd = deployment_fd = None
    intent = False
    try:
        lock = policy._installation_lock(directory, supervisor, inherited_lock)
        if daemon.resolve_active_policy(approval_journal, active_env) != (path, snapshot, approved):
            raise InitialGenerationError('Active policy changed')
        marker_name='.legacy-migration-v1'
        try:os.stat(marker_name,dir_fd=directory,follow_symlinks=False);marker_exists=True
        except FileNotFoundError:marker_exists=False
        if marker_exists and migration is None:raise InitialGenerationError('Existing migration requires recovery')
        if migration is not None:
            if not marker_exists:raise InitialGenerationError('Migration marker is unavailable')
            marker=supervisor._open_root_file(directory,marker_name,0o600)
            try:
                expected=('servus-legacy-migration-v1 '+operation+'\n').encode('ascii')
                if os.read(marker,len(expected)+1)!=expected:raise InitialGenerationError('Migration marker does not match')
            finally:os.close(marker)
        row = journal.db.execute("SELECT p.staging_path,o.digest FROM preparations p JOIN operations o ON o.id=p.operation_id JOIN policy_approvals a ON a.operation_id=o.id WHERE o.id=? AND o.status='verified' AND p.status='prepared' AND a.state='active' AND a.policy_path=? AND a.accepted_env_path=? AND a.source_env_path=? AND p.attempt_id=o.attempt_id AND p.attempt_nonce=o.attempt_nonce AND a.attempt_id=o.attempt_id AND a.attempt_nonce=o.attempt_nonce AND a.preparation_id=p.preparation_id AND a.root_digest=o.digest AND a.image_config_digest=o.config_digest AND NOT EXISTS(SELECT 1 FROM update_transactions)", (operation,path,snapshot,active_env)).fetchone()
        if (not row or not isinstance(row[0],str) or not os.path.isabs(row[0]) or os.path.normpath(row[0]) != row[0] or
            not re.fullmatch(r'servus-install-[a-f0-9]{32}',os.path.basename(row[0])) or
            approved.image_reference != 'ghcr.io/raxon/servus@' + row[1]):
            raise InitialGenerationError('Initial generation is not approved')
        stage_fd=supervisor._trusted_directory(row[0],0o700)
        manifest_fd=supervisor._open_root_file(stage_fd,'manifest.json',0o644)
        try: manifest=extractor._manifest_files(backup._read(manifest_fd,extractor.MANIFEST_LIMIT))
        finally: os.close(manifest_fd)
        deployment_fd=supervisor._trusted_directory(os.path.join(row[0],'deployment'))
        compose_fd=supervisor._open_root_file(deployment_fd,'compose-supervised.yaml',0o644)
        try: content=backup._read(compose_fd,extractor.MAX_FILE)
        finally: os.close(compose_fd)
        if manifest.get('deployment/compose-supervised.yaml') != (0o644,len(content),hashlib.sha256(content).hexdigest()):
            raise InitialGenerationError('Prepared Compose file changed')
        supervisor._verify_data_directory(approved.data_dir)
        adoption_exists=(journal.db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='initial_adoptions'").fetchone() and
                         journal.db.execute('SELECT 1 FROM initial_adoptions LIMIT 1').fetchone())
        # A fresh install may never bypass even partially completed migration.
        if adoption_exists and migration is None:
            raise InitialGenerationError('Existing migration requires recovery')
        if migration is not None and not adoption_exists:
            raise InitialGenerationError('Verified migration is unavailable')
        data = os.open(approved.data_dir,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
        try:
            contents=os.listdir(data)
            if contents and migration is None: raise InitialGenerationError('Existing data requires a verified migration')
            if not contents and migration is not None: raise InitialGenerationError('Migration data is missing')
        finally: os.close(data)
        fd=supervisor._trusted_directory(docker_config,0o700)
        try:
            if os.listdir(fd): raise InitialGenerationError('Docker configuration is not empty')
        finally: os.close(fd)
        gate=supervisor._trusted_directory(approved.gate_dir,0o755)
        try:
            state=supervisor._open_root_file(gate,'state',0o644)
            try:
                if os.read(state,64) != b'servus-lifecycle-v1 normal\n': raise InitialGenerationError('Startup gate is not normal')
            finally: os.close(state)
        finally: os.close(gate)
        check(approved.control_dir,supervisor)
        updater_check(approved.updater_dir,supervisor)
        if policy._docker(docker_config,'ps','-aq','--filter','label=com.docker.compose.project=servus','--no-trunc').strip():
            raise InitialGenerationError('Existing Servus containers require recovery')
        if migration is not None:
            migration.fence.assert_locked(operation,lock)
            migration.adoption.claim(journal,operation,active_env,backup,migration.node_fd,supervisor,daemon,
                                     migration.coordinator,migration.restore,migration.quiescence,install_lock=lock)
            intent=True
            migration.fence.assert_locked(operation,lock)
        else:
            journal.db.execute("CREATE TABLE IF NOT EXISTS initial_generations (operation_id TEXT PRIMARY KEY, phase TEXT NOT NULL CHECK(phase IN ('starting','started','recovery_required')))")
            journal.db.execute('BEGIN IMMEDIATE')
            try:
                if journal.db.execute('SELECT 1 FROM initial_generations LIMIT 1').fetchone():
                    raise InitialGenerationError('Initial generation requires recovery')
                journal.db.execute("INSERT INTO initial_generations VALUES (?,'starting')",(operation,))
                journal.db.execute('COMMIT');intent=True
            except BaseException:
                if journal.db.in_transaction: journal.db.execute('ROLLBACK')
                raise
        compose=os.path.join(row[0],'deployment','compose-supervised.yaml')
        if migration is not None:migration.fence.assert_locked(operation,lock)
        policy._docker(docker_config,'compose','--env-file',active_env,'-f',compose,'-p','servus','create','--no-build','--pull','never',timeout=180)
        candidates=supervisor.inspect_servus(approved,created=True)
        if not isinstance(candidates,dict) or set(candidates) != set(supervisor.ROLES):
            raise InitialGenerationError('Created generation is incomplete')
        ids=[]
        for role in ('agent','api','worker'):
            ident=candidates[role].get('id') if isinstance(candidates[role],dict) else None
            if not isinstance(ident,str) or not supervisor.CONTAINER.fullmatch(ident) or ident in ids:
                raise InitialGenerationError('Created container identity is invalid')
            ids.append(ident)
        for ident in ids:
            if migration is not None:migration.fence.assert_locked(operation,lock)
            supervisor._docker('start',ident,timeout=30)
        if journal.db.execute("UPDATE initial_generations SET phase='started' WHERE operation_id=? AND phase='starting'",(operation,)).rowcount != 1:
            raise InitialGenerationError('Initial generation state changed')
        intent=False
        return candidates
    except BaseException:
        if intent:
            try:
                journal.db.execute('BEGIN IMMEDIATE')
                journal.db.execute("UPDATE initial_generations SET phase='recovery_required' WHERE operation_id=? AND phase='starting'",(operation,))
                if migration is not None:
                    journal.db.execute("UPDATE initial_adoptions SET state='recovery_required' WHERE operation_id=? AND state='consumed'",(operation,))
                journal.db.execute('COMMIT')
            except BaseException:
                if journal.db.in_transaction:
                    try:journal.db.execute('ROLLBACK')
                    except BaseException:pass
        raise
    finally:
        for fd in (deployment_fd,stage_fd,lock,directory):
            if fd is not None: os.close(fd)


def trusted_modules():
    directory=pathlib.Path(os.path.realpath(__file__)).parent
    current=pathlib.Path('/')
    for part in directory.parts[1:]:
        current /= part; info=current.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise InitialGenerationError('Untrusted updater directory')
    def load(name,filename,mode=0o644):
        path=directory/filename
        fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
        try:
            info=os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_gid != 0 or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != mode:
                raise InitialGenerationError('Untrusted updater module')
        finally: os.close(fd)
        spec=importlib.util.spec_from_file_location(name,path)
        if not spec or not spec.loader: raise InitialGenerationError('Updater module unavailable')
        module=importlib.util.module_from_spec(spec);sys.modules[name]=module;spec.loader.exec_module(module)
        return module
    supervisor=load('supervisor','supervisor.py')
    return (supervisor,load('initial_daemon','supervisor-daemon.py'),load('initial_extractor','extract-install.py'),
            load('initial_backup','backup.py'),load('initial_policy','runtime-policy.py'),
            load('initial_journal','servus-updater.py',0o755))


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--operation',required=True)
    parser.add_argument('--install-lock-fd',type=int)
    args=parser.parse_args()
    if sys.platform != 'linux' or os.geteuid() != 0 or not sys.flags.isolated:
        print('Initial start requires isolated Linux root.',file=sys.stderr);return 1
    os.umask(0o077);journal=None
    try:
        supervisor,daemon,extractor,backup,policy,updater=trusted_modules()
        state=updater.trusted_directory('/var/lib/servus-updater',0o700)
        journal=updater.Journal(state)
        launch(journal,args.operation,'/etc/servus/servus.env',str(state/'docker-config'),
               supervisor,daemon,extractor,backup,policy,inherited_lock=args.install_lock_fd)
        return 0
    except Exception:
        print('Initial start failed or requires recovery.',file=sys.stderr);return 1
    finally:
        if journal is not None: journal.close()


if __name__ == '__main__': raise SystemExit(main())
