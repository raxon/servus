#!/usr/bin/python3 -I
"""Recover only an unchanged generation after a verified pre-snapshot failure.

Run independently of the panel. No application data or schema is restored.
An interrupted recovery requires operator inspection and is never retried.
"""
import argparse
from contextlib import ExitStack
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import time

STATE = Path('/var/lib/servus-updater')
JOURNAL = str(STATE / 'journal.sqlite')
ENV = '/etc/servus/servus.env'


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def run(*args):
    return subprocess.run(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                          stderr=subprocess.DEVNULL, check=True, timeout=120).stdout


def prove(db, operation, journal):
    """Exercise every retirement invariant without modifying the live journal."""
    for table, condition in (
        ('host_stops', "status != 'completed'"),
        ('host_preparations', "status NOT IN ('completed','abandoned')"),
        ('host_switches', "phase NOT IN ('completed','rolled_back')"),
        ('host_unit_masks', "phase != 'restored'"),
    ):
        if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone():
            if db.execute('SELECT 1 FROM ' + table + ' WHERE ' + condition + ' LIMIT 1').fetchone():
                raise RuntimeError('Host update requires separate recovery')
    check = sqlite3.connect(':memory:', isolation_level=None)
    try:
        db.backup(check)
        journal.archive_failed_before_snapshot(check, operation)
    finally:
        check.close()


def recover(args):
    if sys.platform != 'linux' or os.geteuid() != 0 or not sys.flags.isolated:
        raise RuntimeError('Isolated Linux root is required')
    base = Path(__file__).resolve().parent
    # The installer places this directory under root ownership, mode 0700.
    for path in (base, *base.parents):
        info = path.lstat()
        if info.st_uid != 0 or info.st_mode & 0o022 or path.is_symlink():
            raise RuntimeError('Recovery tools are not protected')
    sys.path.insert(0, '/usr/local/libexec/servus')
    sys.path.insert(0, str(base))
    import supervisor as sup
    daemon = load('recovery_daemon', '/usr/local/libexec/servus/supervisor-daemon.py')
    journal = load('recovery_journal', base / 'reconcile-policy-journal.py')
    fence = load('recovery_fence', base / 'reconcile-policy-fence.py')
    state_lock_dir = sup._trusted_directory(str(STATE), 0o700)
    try:
        lock_fd = os.open('recovery.lock', os.O_RDONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=state_lock_dir)
        os.fchmod(lock_fd, 0o600)
    except FileExistsError:
        lock_fd = sup._open_root_file(state_lock_dir, 'recovery.lock', 0o600)
    finally:
        os.close(state_lock_dir)
    # This descriptor intentionally holds the coordinator lock until process exit.
    fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    marker_path = STATE / 'maintenance/maintenance.json'
    if not marker_path.exists():
        return
    raw = daemon._private_file(str(marker_path), 4096)
    marker = json.loads(raw, object_pairs_hook=sup._pairs)
    operation = marker.get('operationId')
    if not sup._uuid4(operation) or marker.get('state') != 'recovery_required':
        raise RuntimeError('Maintenance is not an eligible failed operation')
    if args.operation and operation != args.operation:
        raise RuntimeError('Operation changed')
    receipt_name = 'recovery-' + operation
    if (STATE / receipt_name).exists():
        raise RuntimeError('Recovery was already attempted; inspect its receipt')
    with sqlite3.connect('file:' + JOURNAL + '?mode=ro', uri=True) as db:
        prove(db, operation, journal)
    if args.check:
        print(json.dumps({'operationId': operation, 'preSnapshotChecks': 'passed', 'hostRecoveryNotYetPerformed': True}))
        return
    updater_active = subprocess.run(['systemctl', 'is-active', '--quiet', 'servus-updater.service']).returncode == 0
    timer_active = subprocess.run(['systemctl', 'is-active', '--quiet', 'servus-host-update.timer']).returncode == 0
    run('systemctl', 'stop', 'servus-host-update.timer', 'servus-updater.service', 'servus-supervisor.service')
    started = False
    ids = None
    gate = maintenance = receipt = None
    try:
        with ExitStack() as stack:
            def directory(path, mode):
                fd = sup._trusted_directory(str(path), mode)
                stack.callback(os.close, fd)
                return fd
            state = directory(STATE, 0o700)
            install = directory('/opt/servus', 0o700)
            gate = directory('/etc/servus/lifecycle', 0o755)
            maintenance = directory(STATE / 'maintenance', 0o700)
            with fence.hold_locks(state, install):
                db = sqlite3.connect('file:' + JOURNAL + '?mode=rw', uri=True, isolation_level=None)
                stack.callback(db.close)
                prove(db, operation, journal)
                prep = db.execute('SELECT preparation_id FROM preparations WHERE operation_id=?', (operation,)).fetchone()[0]
                fence._unit_inactive('servus-updater.service', fence.run)
                fence._unit_inactive('servus-supervisor.service', fence.run)
                fence._unit_inactive('servus-prepare-' + prep.replace('-', '') + '.service', fence.run, allow_missing=True)
                fence.assert_no_probe_resources(db, operation)
                binding = daemon.resolve_active_policy(JOURNAL, ENV)
                policy = binding[2]
                try:
                    identities = sup.inspect_servus(policy)
                except sup.SupervisorError:
                    identities = sup.inspect_servus(policy, stopped=True)
                ids = [identities[role]['id'] for role in sup.ROLES]
                if daemon._private_file(str(marker_path), 4096) != raw:
                    raise RuntimeError('Maintenance evidence changed')
                os.mkdir(receipt_name, 0o700, dir_fd=state)
                os.fsync(state)
                receipt = directory(STATE / receipt_name, 0o700)
                sup._atomic_file(receipt, 'maintenance.json', raw, 0o600)
                backup_path = str(STATE / receipt_name / 'journal.sqlite')
                backup = sqlite3.connect(backup_path)
                os.chmod(backup_path, 0o600)
                db.backup(backup)
                backup.close()
                fd = os.open(backup_path, os.O_RDONLY | os.O_NOFOLLOW)
                os.fsync(fd)
                os.close(fd)
                def record(status):
                    sup._atomic_file(receipt, 'result.json', json.dumps({'operationId': operation, 'status': status,
                        'reason': 'update_failed_before_snapshot', 'image': policy.image_reference,
                        'containers': ids}, separators=(',', ':')).encode() + b'\n', 0o600)
                record('stopping_previous_generation')
                started = True
                # Graceful shutdown lets durable workers persist their normal restart state.
                for cid in ids:
                    sup._docker('stop', '--time', '30', cid, timeout=45)
                records = json.loads(sup._docker('inspect', *ids))
                if {r['Id'] for r in records} != set(ids) or any(r['State']['Running'] for r in records):
                    raise RuntimeError('Previous containers did not stop')
                lock = sup._open_root_file(gate, 'lock', 0o644)
                stack.callback(os.close, lock)
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                if daemon.resolve_active_policy(JOURNAL, ENV) != binding:
                    raise RuntimeError('Previous generation changed')
                prove(db, operation, journal)
                record('restarting_previous_generation')
                # No candidate container or migration ran: reopen the same generation.
                os.unlink('maintenance.json', dir_fd=maintenance)
                os.fsync(maintenance)
                sup._atomic_file(gate, 'state', b'servus-lifecycle-v1 normal\n', 0o644)
                fcntl.flock(lock, fcntl.LOCK_UN)
            run('systemctl', 'start', 'servus-supervisor.service')
            for cid in reversed(ids):
                sup._docker('start', cid, timeout=45)
            deadline = time.monotonic() + 120
            while True:
                try:
                    current = sup.inspect_servus(policy)
                    if {v['id'] for v in current.values()} != set(ids):
                        raise RuntimeError('Container identity changed')
                    records = json.loads(sup._docker('inspect', *ids))
                    if all(r['State']['Running'] and (r['Config']['Labels']['com.docker.compose.service'] == 'worker' or
                            r['State'].get('Health', {}).get('Status') == 'healthy') for r in records):
                        break
                except sup.SupervisorError:
                    pass
                if time.monotonic() >= deadline:
                    raise RuntimeError('Previous generation did not become healthy')
                time.sleep(2)
            # Verify the admission barrier as well as the independent health endpoint.
            api = current['api']['id']
            sup._docker('exec', api, 'node', '-e',
                "fetch('http://127.0.0.1:'+(process.env.PANEL_PORT||4180)+'/api/v1/projects').then(r=>process.exit(r.status===401?0:1)).catch(()=>process.exit(1))", timeout=15)
            with fence.hold_locks(state, install):
                if daemon.resolve_active_policy(JOURNAL, ENV) != binding:
                    raise RuntimeError('Previous policy changed')
                if {v['id'] for v in sup.inspect_servus(policy).values()} != set(ids):
                    raise RuntimeError('Previous generation changed')
                prove(db, operation, journal)
                fence.assert_no_probe_resources(db, operation)
                journal.archive_failed_before_snapshot(db, operation)
                record('recovered')
        if updater_active:
            run('systemctl', 'start', 'servus-updater.service')
        if timer_active:
            run('systemctl', 'start', 'servus-host-update.timer')
        print(json.dumps({'operationId': operation, 'status': 'recovered'}))
    except BaseException:
        # An interrupted recovery is never automatically tried a second time.
        # The receipt and original journal remain available for diagnosis.
        if started and ids:
            # Close admission again on any failed health check before leaving recovery.
            failure_gate = sup._trusted_directory('/etc/servus/lifecycle', 0o755)
            failure_marker = sup._trusted_directory(str(STATE / 'maintenance'), 0o700)
            try:
                sup._atomic_file(failure_gate, 'state', b'servus-lifecycle-v1 maintenance\n', 0o644)
                sup._atomic_file(failure_marker, 'maintenance.json', raw, 0o600)
            finally:
                os.close(failure_gate)
                os.close(failure_marker)
            run('systemctl', 'stop', 'servus-supervisor.service')
            for cid in ids:
                sup._docker('stop', '--time', '30', cid, timeout=45)
        if not started:
            run('systemctl', 'start', 'servus-supervisor.service')
            if updater_active:
                run('systemctl', 'start', 'servus-updater.service')
            if timer_active:
                run('systemctl', 'start', 'servus-host-update.timer')
        raise


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--check', action='store_true')
    parser.add_argument('--operation')
    args = parser.parse_args()
    try:
        recover(args)
    except Exception as error:
        # Exception values may contain protected data; emit only their class.
        print('Pre-switch recovery requires inspection: ' + type(error).__name__, file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
