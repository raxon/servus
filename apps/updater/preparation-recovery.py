#!/usr/bin/python3 -I
"""Root operator recovery for a verified preparation that never began extraction.

Run with /usr/bin/python3 -I. This never pulls images, creates containers, applies
an update, opens application data, or fabricates verification. A completed pull
must already be visible to the local Docker daemon at the verified identity.
The installation and recovery locks fence host changes and concurrent operators;
the old cgroup and a fresh claim identity fence the previous executor. Root and
Docker are trusted; parallel administrative Docker changes are outside the lock.
"""
import argparse
import contextlib
import datetime
import fcntl
import json
import os
import pathlib
import re
import sqlite3
import stat
import subprocess
import sys
import uuid

BASE = pathlib.Path('/usr/local/libexec/servus')
IMAGE = 'ghcr.io/raxon/servus'
ENV = {'PATH': '/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C',
       'DOCKER_HOST': 'unix:///var/run/docker.sock', 'DOCKER_CONFIG': '/dev/null'}
DIGEST = re.compile(r'sha256:[a-f0-9]{64}\Z')
MODULES = ('servus-updater.py', 'preparation-fence.py', 'prepare-verified.py',
           'extract-install.py', 'verify-release.py')


class RecoveryError(Exception):
    """Only a stable reason code is exposed to the operator."""
    def __init__(self, reason):
        self.reason = reason
        super().__init__(reason)


def identity(value):
    try:
        parsed = uuid.UUID(value)
        return parsed.version == 4 and str(parsed) == value
    except (ValueError, TypeError, AttributeError):
        return False


def trusted_directory(path, mode=None):
    path = pathlib.Path(path)
    if not path.is_absolute() or str(path) != os.path.normpath(str(path)):
        raise RecoveryError('unsafe_directory')
    current = pathlib.Path('/')
    for part in ('', *path.parts[1:]):
        if part:
            current /= part
        info = current.lstat()
        if (not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or
                info.st_mode & 0o022):
            raise RecoveryError('unsafe_directory')
    if mode is not None and stat.S_IMODE(info.st_mode) != mode:
        raise RecoveryError('unsafe_directory')
    return path


def trusted_file(path, *, private=False):
    path = pathlib.Path(path)
    trusted_directory(path.parent)
    info = path.lstat()
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1 or
            info.st_mode & 0o022 or (private and stat.S_IMODE(info.st_mode) != 0o600)):
        raise RecoveryError('unsafe_file')
    return info


def private_fd(directory, name, *, create=False, append=False):
    flags = os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK
    flags |= os.O_WRONLY | os.O_APPEND if append else os.O_RDONLY
    if create:
        flags |= os.O_CREAT
    fd = os.open(name, flags, 0o600, dir_fd=directory)
    try:
        info, named = os.fstat(fd), os.stat(name, dir_fd=directory, follow_symlinks=False)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_gid != 0 or
                info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o600 or
                (info.st_dev, info.st_ino) != (named.st_dev, named.st_ino)):
            raise RecoveryError('unsafe_private_file')
        return fd
    except BaseException:
        os.close(fd)
        raise


@contextlib.contextmanager
def locks(state, install):
    opened = []
    try:
        for directory, name, create in ((install, 'install.lock', False),
                                         (state, 'preparation-recovery.lock', True)):
            fd = private_fd(directory, name, create=create)
            opened.append(fd)
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise RecoveryError('recovery_lock_busy') from None
        os.fsync(state)
        yield
    finally:
        for fd in reversed(opened):
            os.close(fd)


def run(command):
    try:
        result = subprocess.run(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                stderr=subprocess.DEVNULL, env=ENV, cwd='/', timeout=30,
                                check=True, close_fds=True)
        if len(result.stdout) > 1024 * 1024:
            raise RecoveryError('host_output_limit')
        return result.stdout.decode('utf-8', 'strict')
    except (OSError, subprocess.SubprocessError, UnicodeError):
        raise RecoveryError('host_inspection_failed') from None


def assert_empty_cgroup(directory):
    """cgroup v2 populated is hierarchical, including descendant processes."""
    directory = pathlib.Path(directory)
    try:
        directory.lstat()
    except FileNotFoundError:
        return
    trusted_directory(directory)
    values = {}
    for line in (directory / 'cgroup.events').read_text().splitlines():
        pair = line.split()
        if len(pair) != 2 or pair[0] in values:
            raise RecoveryError('invalid_old_cgroup')
        values[pair[0]] = pair[1]
    if values.get('populated') != '0' or (directory / 'cgroup.procs').read_text().strip():
        raise RecoveryError('old_executor_not_fenced')


def assert_stopped(preparation, execute):
    unit = 'servus-prepare-' + uuid.UUID(preparation).hex + '.service'
    output = execute(['/usr/bin/systemctl', 'show', unit, '--property=LoadState',
                      '--property=ActiveState', '--property=ControlGroup'])
    properties = {}
    for line in output.splitlines():
        key, separator, value = line.partition('=')
        if not separator or key in properties:
            raise RecoveryError('invalid_unit_state')
        properties[key] = value
    if (set(properties) != {'LoadState', 'ActiveState', 'ControlGroup'} or
            properties['LoadState'] not in ('loaded', 'not-found') or
            properties['ActiveState'] not in ('inactive', 'failed') or properties['ControlGroup'] or
            (properties['LoadState'] == 'not-found' and properties['ActiveState'] != 'inactive')):
        raise RecoveryError('old_executor_not_fenced')
    assert_empty_cgroup(pathlib.Path('/sys/fs/cgroup/system.slice') / unit)


def assert_image(record, execute):
    reference = IMAGE + '@' + record['rootDigest']
    inspected = []
    for platform in ([], ['--platform=linux/amd64']):
        try:
            value = json.loads(execute(['/usr/bin/docker', 'image', 'inspect', *platform,
                                        '--format', '{{json .}}', reference]))
        except (ValueError, TypeError, RecursionError):
            raise RecoveryError('invalid_image_inspection') from None
        # Docker 29 containerd may expose the immutable manifest as Id; older
        # engines expose the config. Both must be recorded verified identities.
        if (not isinstance(value, dict) or value.get('Id') not in (record['rootDigest'], record['configDigest']) or
                value.get('Os') != 'linux' or value.get('Architecture') != 'amd64' or
                not isinstance(value.get('RepoDigests'), list) or reference not in value['RepoDigests'] or
                not isinstance(value.get('RootFS'), dict) or value['RootFS'].get('Type') != 'layers' or
                not isinstance(value['RootFS'].get('Layers'), list) or
                not all(isinstance(layer, str) and DIGEST.fullmatch(layer) for layer in value['RootFS']['Layers'])):
            raise RecoveryError('cached_image_identity_mismatch')
        inspected.append(value['Id'])
    return inspected


def assert_no_maintenance(state):
    maintenance = os.open('maintenance', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=state)
    try:
        info = os.fstat(maintenance)
        if info.st_uid != 0 or info.st_gid != 0 or stat.S_IMODE(info.st_mode) != 0o700:
            raise RecoveryError('unsafe_maintenance_directory')
        try:
            os.stat('maintenance.json', dir_fd=maintenance, follow_symlinks=False)
        except FileNotFoundError:
            return
        raise RecoveryError('host_maintenance_pending')
    finally:
        os.close(maintenance)


def inspect_journal(db, operation):
    if db.execute('PRAGMA user_version').fetchone() != (8,):
        raise RecoveryError('unsupported_journal')
    if db.execute("SELECT 1 FROM sqlite_master WHERE type='trigger' LIMIT 1").fetchone():
        raise RecoveryError('unexpected_journal_trigger')
    row = db.execute('SELECT commit_sha,digest,tag,status,attempt_id,attempt_nonce,config_digest FROM operations WHERE id=?', (operation,)).fetchone()
    prep = db.execute('SELECT attempt_id,attempt_nonce,preparation_id,status,staging_path FROM preparations WHERE operation_id=?', (operation,)).fetchone()
    if (not row or row[3] != 'verified' or not identity(row[4]) or
            not isinstance(row[5], str) or not re.fullmatch('[a-f0-9]{64}', row[5]) or
            not isinstance(row[0], str) or not re.fullmatch('[a-f0-9]{40}', row[0]) or
            not isinstance(row[2], str) or not re.fullmatch(r'v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)', row[2]) or
            not all(isinstance(value, str) and DIGEST.fullmatch(value) for value in (row[1], row[6]))):
        raise RecoveryError('verified_identity_unavailable')
    if not prep or prep[3] != 'recovery_required' or not identity(prep[2]) or tuple(prep[:2]) != tuple(row[4:6]):
        raise RecoveryError('preparation_binding_mismatch')
    if prep[4] is not None:
        raise RecoveryError('staging_already_recorded')
    for table in ('extraction_probes', 'apply_requests', 'update_transactions'):
        if db.execute('SELECT 1 FROM ' + table + ' WHERE operation_id=? LIMIT 1', (operation,)).fetchone():
            raise RecoveryError('operation_already_progressed')
    if db.execute("SELECT 1 FROM operations WHERE id<>? AND status NOT IN ('verified','verification_failed') LIMIT 1", (operation,)).fetchone():
        raise RecoveryError('other_active_operation')
    if db.execute("SELECT 1 FROM preparations WHERE operation_id<>? AND status<>'completed' LIMIT 1", (operation,)).fetchone():
        raise RecoveryError('other_active_preparation')
    checks = (
        ('extraction_probes', 'status', ('removed',)),
        ('apply_requests', 'state', ('completed',)),
        ('update_transactions', 'phase', ('completed',)),
        ('policy_approvals', 'state', ('active', 'superseded')),
        ('policy_probes', 'state', ('removed',)),
        ('initial_generations', 'phase', ('started',)),
        ('host_stops', 'status', ('completed',)),
        ('host_preparations', 'status', ('completed', 'abandoned')),
        ('host_recovery_snapshots', 'status', ('completed', 'abandoned')),
        ('host_switches', 'phase', ('completed', 'rolled_back')),
        ('host_unit_masks', 'phase', ('restored',)),
        ('legacy_transitions', 'phase', ('completed',)),
        ('legacy_rollbacks', 'phase', ('healthy',)),
        ('legacy_early_rollbacks', 'phase', ('healthy',)),
    )
    for table, column, finished in checks:
        if not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone():
            continue
        if table in ('policy_approvals', 'policy_probes', 'initial_generations') and db.execute('SELECT 1 FROM ' + table + ' WHERE operation_id=? LIMIT 1', (operation,)).fetchone():
            raise RecoveryError('operation_already_progressed')
        marks = ','.join('?' for _ in finished)
        if db.execute('SELECT 1 FROM ' + table + ' WHERE ' + column + ' IS NULL OR ' + column + ' NOT IN (' + marks + ') LIMIT 1', finished).fetchone():
            raise RecoveryError('other_work_or_maintenance_pending')
    return dict(operationId=operation, commit=row[0], rootDigest=row[1], tag=row[2],
                attemptId=row[4], attemptNonce=row[5], configDigest=row[6], oldPreparationId=prep[2])


def validate_database_files(state):
    fd = private_fd(state, 'journal.sqlite')
    info = os.fstat(fd)
    os.close(fd)
    for name in ('journal.sqlite-wal', 'journal.sqlite-shm', 'journal.sqlite-journal'):
        try:
            sidecar = private_fd(state, name)
        except FileNotFoundError:
            continue
        os.close(sidecar)
    return info.st_dev, info.st_ino


def recover(operation, state_dir='/var/lib/servus-updater', install_dir='/opt/servus', *,
            dry_run=False, execute=run, module_dir=BASE):
    if sys.platform != 'linux' or os.geteuid() != 0 or not sys.flags.isolated:
        raise RecoveryError('isolated_linux_root_required')
    if not identity(operation):
        raise RecoveryError('invalid_operation')
    for name in MODULES:
        trusted_file(pathlib.Path(module_dir) / name)
    trusted_directory(state_dir, 0o700)
    trusted_directory(install_dir, 0o700)
    trusted_directory(pathlib.Path(state_dir) / 'staging', 0o700)
    # No modules or executables from the caller's environment are executed.
    for executable in ('/usr/bin/docker', '/usr/bin/systemctl'):
        trusted_file(pathlib.Path(executable).resolve(strict=True))
    state = os.open(state_dir, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    install = os.open(install_dir, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        with locks(state, install):
            original_inode = validate_database_files(state)
            uri = 'file:/proc/self/fd/' + str(state) + '/journal.sqlite'
            # Read-only preflight cannot initialize/migrate the live journal.
            db = sqlite3.connect(uri + '?mode=ro', uri=True, isolation_level=None, timeout=2)
            try:
                db.execute('PRAGMA trusted_schema=OFF')
                expected = inspect_journal(db, operation)
            finally:
                db.close()
            assert_no_maintenance(state)
            assert_stopped(expected['oldPreparationId'], execute)
            assert_image(expected, execute)
            if dry_run:
                return {'ok': True, 'action': 'eligible', 'operationId': operation,
                        'oldPreparationId': expected['oldPreparationId']}
            db = sqlite3.connect(uri + '?mode=rw', uri=True, isolation_level=None, timeout=2)
            try:
                db.execute('PRAGMA trusted_schema=OFF')
                db.execute('PRAGMA synchronous=FULL')
                db.execute('BEGIN IMMEDIATE')
                try:
                    if validate_database_files(state) != original_inode or inspect_journal(db, operation) != expected:
                        raise RecoveryError('journal_changed')
                    assert_no_maintenance(state)
                    assert_stopped(expected['oldPreparationId'], execute)
                    assert_image(expected, execute)
                    new_preparation = str(uuid.uuid4())
                    audit = dict(expected, version=1, action='authorize_pre_extraction_retry',
                                 newPreparationId=new_preparation, uid=os.geteuid(),
                                 recordedAt=datetime.datetime.now(datetime.timezone.utc).isoformat())
                    audit_fd = private_fd(state, 'preparation-recovery-audit.jsonl', create=True, append=True)
                    try:
                        data = (json.dumps(audit, sort_keys=True, separators=(',', ':')) + '\n').encode()
                        if os.write(audit_fd, data) != len(data):
                            raise RecoveryError('audit_write_failed')
                        os.fsync(audit_fd)
                        os.fsync(state)
                    finally:
                        os.close(audit_fd)
                    changed = db.execute("UPDATE preparations SET preparation_id=?,status='preparing' WHERE operation_id=? AND preparation_id=? AND status='recovery_required' AND staging_path IS NULL AND attempt_id=? AND attempt_nonce=?", (new_preparation, operation, expected['oldPreparationId'], expected['attemptId'], expected['attemptNonce']))
                    if changed.rowcount != 1:
                        raise RecoveryError('claim_changed')
                    db.execute('COMMIT')
                except BaseException:
                    if db.in_transaction:
                        db.execute('ROLLBACK')
                    raise
            finally:
                db.close()
            return {'ok': True, 'action': 'requeued', 'operationId': operation,
                    'oldPreparationId': expected['oldPreparationId'], 'preparationId': new_preparation}
    finally:
        os.close(install)
        os.close(state)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--operation', required=True)
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    try:
        result = recover(args.operation, dry_run=args.dry_run)
    except RecoveryError as error:
        result = {'ok': False, 'error': 'preparation_recovery_refused', 'reason': error.reason}
    except (OSError, sqlite3.Error, ValueError):
        result = {'ok': False, 'error': 'preparation_recovery_refused', 'reason': 'trusted_host_state_unavailable'}
    print(json.dumps(result, sort_keys=True))
    return 0 if result['ok'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
