#!/usr/bin/python3 -I
"""Journal an atomic host runtime exchange for an independently fenced caller.

This module does not stop services or authorize a release.
The root caller must verify the completed release and live generation, fence
all host code consumers, and provide the current trusted release bytes.
"""
import fcntl
import os
import socket
import stat
import struct
import subprocess
import sys
import time


class HostSwitchError(RuntimeError):
    pass



def _assert_supervisor_status(socket_path, message, *, supervisor):
    """Query the root supervisor on an authenticated, protected Unix socket."""
    if (sys.platform != 'linux' or os.geteuid() != 0 or not sys.flags.isolated or
        not isinstance(socket_path, str) or not os.path.isabs(socket_path) or
        os.path.normpath(socket_path) != socket_path):
        raise HostSwitchError('Invalid supervisor readiness context')
    parent, name = os.path.split(socket_path)
    directory = supervisor._trusted_directory(parent, 0o750)
    try:
        before = os.stat(name, dir_fd=directory, follow_symlinks=False)
        if (not stat.S_ISSOCK(before.st_mode) or before.st_uid != 0 or before.st_gid != 0 or
            stat.S_IMODE(before.st_mode) != 0o600):
            raise HostSwitchError('Supervisor readiness socket is not trusted')
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as peer:
            peer.settimeout(5)
            peer.connect(socket_path)
            _, uid, _ = struct.unpack('3i', peer.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize('3i')))
            after = os.stat(name, dir_fd=directory, follow_symlinks=False)
            if uid != 0 or (before.st_dev, before.st_ino) != (after.st_dev, after.st_ino):
                raise HostSwitchError('Supervisor readiness peer is not trusted')
            deadline = time.monotonic() + 5
            supervisor._send_message(peer, message, deadline)
            if supervisor._read_message(peer, deadline) != {'version': 1, 'status': 'ready'}:
                raise HostSwitchError('Supervisor is not ready')
    except (OSError, ValueError, supervisor.SupervisorError) as error:
        raise HostSwitchError('Supervisor readiness is unavailable') from error
    finally:
        os.close(directory)


def assert_supervisor_ready(socket_path, operation_id, *, supervisor, bundle):
    if not isinstance(operation_id,str) or not bundle.OPERATION.fullmatch(operation_id):
        raise HostSwitchError('Invalid host operation identity')
    return _assert_supervisor_status(socket_path,{'version':1,'type':'host_status','operationId':operation_id},supervisor=supervisor)


def assert_supervisor_normal_ready(socket_path, *, supervisor):
    """Verify the normal root-only control channel after a rollback."""
    return _assert_supervisor_status(socket_path,{'version':1,'type':'status'},supervisor=supervisor)

def _guard(db, state_fd, install_fd, service_lock, install_lock, supervisor, coordinator, fence, *, lock_name='service.lock'):
    if (sys.platform != 'linux' or os.geteuid() != 0 or not sys.flags.isolated or
        db.in_transaction or db.isolation_level is not None or not callable(fence)):
        raise HostSwitchError('An isolated, fenced root coordinator is required')
    if db.execute('PRAGMA synchronous').fetchone()[0] < 2:
        raise HostSwitchError('The journal must use durable synchronization')
    coordinator._same_lock(supervisor, state_fd, lock_name, service_lock)
    coordinator._same_lock(supervisor, install_fd, 'install.lock', install_lock)
    fd = supervisor._open_root_file(state_fd, 'journal.sqlite', 0o600)
    try:
        db_path = db.execute('PRAGMA database_list').fetchone()[2]
        named = os.stat(db_path, follow_symlinks=False)
        opened = os.fstat(fd)
        if (named.st_dev, named.st_ino) != (opened.st_dev, opened.st_ino):
            raise HostSwitchError('The journal identity differs')
    finally:
        os.close(fd)
    if fence() is not None:
        raise HostSwitchError('Host process fence returned an invalid result')


def inspect_exchange(db, operation_id, active_parent, candidate_parent, exchange, bundle):
    """Classify the two names against the journalled inodes, without modifying either."""
    if not isinstance(operation_id, str) or not bundle.OPERATION.fullmatch(operation_id):
        raise HostSwitchError('Invalid operation identity')
    row = db.execute('SELECT image_digest,old_dev,old_ino,new_dev,new_ino,phase FROM host_switches WHERE operation_id=?', (operation_id,)).fetchone()
    if not row or not isinstance(row[0], str) or not bundle.DIGEST.fullmatch(row[0]) or row[5] not in ('intent', 'exchanged', 'rolled_back', 'completed'):
        raise HostSwitchError('Host exchange journal is unavailable')
    old, new = (row[1], row[2]), (row[3], row[4])
    if any(type(value) is not int or value <= 0 for value in old + new) or old == new:
        raise HostSwitchError('Host exchange identities are invalid')
    active = exchange.identity(active_parent, 'servus')
    candidate = exchange.identity(candidate_parent, 'runtime-' + operation_id)
    if (active, candidate) == (old, new): return 'original'
    if (active, candidate) == (new, old): return 'exchanged'
    raise HostSwitchError('Host runtime identity requires recovery')


def exchange_prepared(db, operation_id, image_digest, modules, cli, pin, *,
                      state_fd, install_fd, service_lock, install_lock, active_parent,
                      candidate_parent, supervisor, coordinator, bundle, exchange, fence):
    """Record intent before exchanging a revalidated, already prepared tree."""
    _guard(db, state_fd, install_fd, service_lock, install_lock, supervisor, coordinator, fence)
    if not isinstance(operation_id, str) or not bundle.OPERATION.fullmatch(operation_id) or not isinstance(image_digest, str) or not bundle.DIGEST.fullmatch(image_digest):
        raise HostSwitchError('Invalid host update identity')
    name = 'runtime-' + operation_id
    row = db.execute('SELECT image_digest,generation,status FROM host_preparations WHERE operation_id=?', (operation_id,)).fetchone()
    if row != (image_digest, name, 'prepared'):
        raise HostSwitchError('Prepared host generation is unavailable')
    bundle.verify_runtime_tree(candidate_parent, operation_id, image_digest, modules, cli, pin)
    old = exchange.identity(active_parent, 'servus')
    new = exchange.identity(candidate_parent, name)
    if old == new or old[0] != new[0]:
        raise HostSwitchError('Host runtime identities are incompatible')
    _guard(db, state_fd, install_fd, service_lock, install_lock, supervisor, coordinator, fence)
    db.execute('BEGIN IMMEDIATE')
    try:
        db.execute("CREATE TABLE IF NOT EXISTS host_switches (operation_id TEXT PRIMARY KEY, image_digest TEXT NOT NULL, old_dev INTEGER NOT NULL, old_ino INTEGER NOT NULL, new_dev INTEGER NOT NULL, new_ino INTEGER NOT NULL, phase TEXT NOT NULL CHECK(phase IN ('intent','exchanged','rolled_back','completed'))) ")
        db.execute("CREATE UNIQUE INDEX IF NOT EXISTS one_active_host_switch ON host_switches ((1)) WHERE phase IN ('intent','exchanged')")
        db.execute("INSERT INTO host_switches VALUES(?,?,?,?,?,?,'intent')", (operation_id, image_digest, *old, *new))
        db.execute('COMMIT')
    except BaseException:
        if db.in_transaction: db.execute('ROLLBACK')
        raise
    _guard(db, state_fd, install_fd, service_lock, install_lock, supervisor, coordinator, fence)
    bundle.verify_runtime_tree(candidate_parent, operation_id, image_digest, modules, cli, pin)
    exchange.exchange(active_parent, 'servus', candidate_parent, name, old, new)
    if inspect_exchange(db, operation_id, active_parent, candidate_parent, exchange, bundle) != 'exchanged':
        raise HostSwitchError('Host exchange outcome requires recovery')
    _guard(db, state_fd, install_fd, service_lock, install_lock, supervisor, coordinator, fence)
    if db.execute("UPDATE host_switches SET phase='exchanged' WHERE operation_id=? AND phase='intent'", (operation_id,)).rowcount != 1:
        raise HostSwitchError('Host exchange journal changed')


def rollback_exchanged(db, operation_id, *, state_fd, install_fd, service_lock, install_lock,
                       active_parent, candidate_parent, supervisor, coordinator, bundle, exchange, fence):
    """Restore the exact previous inode; leave subsequent authorization to the caller."""
    _guard(db, state_fd, install_fd, service_lock, install_lock, supervisor, coordinator, fence)
    if inspect_exchange(db, operation_id, active_parent, candidate_parent, exchange, bundle) != 'exchanged':
        raise HostSwitchError('The exchanged runtime is not present')
    row = db.execute('SELECT old_dev,old_ino,new_dev,new_ino,phase FROM host_switches WHERE operation_id=?', (operation_id,)).fetchone()
    if not row or row[4] not in ('intent', 'exchanged'):
        raise HostSwitchError('The exchange is not eligible for rollback')
    old, new = (row[0], row[1]), (row[2], row[3])
    exchange.exchange(active_parent, 'servus', candidate_parent, 'runtime-' + operation_id, new, old)
    if inspect_exchange(db, operation_id, active_parent, candidate_parent, exchange, bundle) != 'original':
        raise HostSwitchError('Host rollback outcome requires recovery')
    _guard(db, state_fd, install_fd, service_lock, install_lock, supervisor, coordinator, fence)
    db.execute('BEGIN IMMEDIATE')
    try:
        if db.execute("UPDATE host_switches SET phase='rolled_back' WHERE operation_id=? AND phase IN ('intent','exchanged')", (operation_id,)).rowcount != 1:
            raise HostSwitchError('Host rollback journal changed')
        if db.execute("UPDATE host_preparations SET status='recovery_required' WHERE operation_id=? AND status='prepared'", (operation_id,)).rowcount != 1:
            raise HostSwitchError('Host preparation journal changed')
        db.execute('COMMIT')
    except BaseException:
        if db.in_transaction: db.execute('ROLLBACK')
        raise


def reconcile_original(db, operation_id, *, state_fd, install_fd, service_lock, install_lock,
                       active_parent, candidate_parent, supervisor, coordinator, bundle, exchange, fence):
    """Retire an interrupted exchange only when the original inodes are present.

    The caller must continue recovery of unit masks and service state. A fenced
    host and both named inode identities are checked before changing the journal.
    """
    _guard(db, state_fd, install_fd, service_lock, install_lock, supervisor, coordinator, fence)
    if inspect_exchange(db, operation_id, active_parent, candidate_parent, exchange, bundle) != 'original':
        raise HostSwitchError('The original host runtime is not present')
    _guard(db, state_fd, install_fd, service_lock, install_lock, supervisor, coordinator, fence)
    db.execute('BEGIN IMMEDIATE')
    try:
        if inspect_exchange(db, operation_id, active_parent, candidate_parent, exchange, bundle) != 'original':
            raise HostSwitchError('The host runtime changed during recovery')
        if db.execute("UPDATE host_switches SET phase='rolled_back' WHERE operation_id=? AND phase IN ('intent','exchanged')", (operation_id,)).rowcount != 1:
            raise HostSwitchError('Host exchange journal changed')
        if db.execute("UPDATE host_preparations SET status='recovery_required' WHERE operation_id=? AND status='prepared'", (operation_id,)).rowcount != 1:
            raise HostSwitchError('Host preparation journal changed')
        db.execute('COMMIT')
    except BaseException:
        if db.in_transaction: db.execute('ROLLBACK')
        raise



def start_restored(db, operation_id, *, state_fd, install_fd, host_lock, active_parent,
                   candidate_parent, units_fd, supervisor, coordinator, bundle, exchange, unit_mask,
                   run=subprocess.run):
    """Start the previously active units while retaining the host operation lock.

    The caller must release the installation lock before startup and relinquish
    the updater service lock if the service is not already running. Reacquire
    the installation lock before completing the exchange. Repeating
    this operation after interruption is safe because systemd start is idempotent.
    """
    if (sys.platform != 'linux' or os.geteuid() != 0 or not sys.flags.isolated or
        db.in_transaction or db.isolation_level is not None or db.execute('PRAGMA synchronous').fetchone()[0] < 2):
        raise HostSwitchError('An isolated root coordinator is required')
    coordinator._same_lock(supervisor, state_fd, 'host.lock', host_lock)
    fd = supervisor._open_root_file(state_fd, 'journal.sqlite', 0o600)
    try:
        named = os.stat(db.execute('PRAGMA database_list').fetchone()[2], follow_symlinks=False)
        opened = os.fstat(fd)
        if (named.st_dev, named.st_ino) != (opened.st_dev, opened.st_ino):
            raise HostSwitchError('The journal identity differs')
    finally: os.close(fd)
    for parent, name in ((install_fd, 'install.lock'),):
        fd = supervisor._open_root_file(parent, name, 0o600)
        try:
            try: fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as error: raise HostSwitchError('A service startup lock is still held') from error
            fcntl.flock(fd, fcntl.LOCK_UN)
        finally: os.close(fd)
    if inspect_exchange(db, operation_id, active_parent, candidate_parent, exchange, bundle) != 'exchanged':
        raise HostSwitchError('The new host runtime is not present')
    row = db.execute('SELECT image_digest,phase FROM host_switches WHERE operation_id=?', (operation_id,)).fetchone()
    if (not row or row[1] != 'exchanged' or
        db.execute("SELECT 1 FROM host_preparations p JOIN host_unit_masks m ON m.operation_id=p.operation_id AND m.image_digest=p.image_digest WHERE p.operation_id=? AND p.image_digest=? AND p.status='prepared' AND m.phase='restored'", (operation_id, row[0])).fetchone() is None):
        raise HostSwitchError('Host restoration is not ready for startup')
    unit_mask._directory(units_fd, 0o755)
    originals, states = unit_mask.load_verified_backup(db, operation_id, row[0], state_fd)
    for unit in unit_mask.UNITS: unit_mask._read(units_fd, unit, 0o644, originals[unit])
    if any(states[unit] != 'active' for unit in ('servus-updater-socket.service', 'servus-supervisor.service', 'servus-updater.service')):
        raise HostSwitchError('The host services were not all active before the exchange')
    try:
        for command in (['/usr/bin/systemctl', 'daemon-reload'],
                        ['/usr/bin/systemctl', 'start', 'servus-updater-socket.service'],
                        ['/usr/bin/systemctl', 'start', 'servus-supervisor.service'],
                        ['/usr/bin/systemctl', 'start', 'servus-updater.service']):
            coordinator._same_lock(supervisor, state_fd, 'host.lock', host_lock)
            run(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                cwd='/', env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C', 'LC_ALL': 'C'},
                timeout=60, check=True)
    except (OSError, subprocess.SubprocessError) as error:
        raise HostSwitchError('Host service startup requires recovery') from error

def complete_exchange(db, operation_id, *, state_fd, install_fd, host_lock, install_lock,
                      active_parent, candidate_parent, supervisor, coordinator, bundle, exchange, unit_mask, units_fd, supervisor_socket):
    """Record a healthy exchange only after the caller verifies restored services.

    The caller holds a separate host operation lock across the exchange and
    restart. The authenticated supervisor verifies control-plane readiness without
    acquiring the already-held installation lock.
    """
    ready = lambda: assert_supervisor_ready(supervisor_socket, operation_id, supervisor=supervisor, bundle=bundle)
    _guard(db, state_fd, install_fd, host_lock, install_lock, supervisor, coordinator, ready, lock_name='host.lock')
    if inspect_exchange(db, operation_id, active_parent, candidate_parent, exchange, bundle) != 'exchanged':
        raise HostSwitchError('The new host runtime is not present')
    row = db.execute('SELECT image_digest,phase FROM host_unit_masks WHERE operation_id=?', (operation_id,)).fetchone()
    switch = db.execute('SELECT image_digest,phase FROM host_switches WHERE operation_id=?', (operation_id,)).fetchone()
    preparation = db.execute('SELECT image_digest,status FROM host_preparations WHERE operation_id=?', (operation_id,)).fetchone()
    if not switch or row != (switch[0], 'restored') or switch[1] != 'exchanged' or preparation != (switch[0], 'prepared'):
        raise HostSwitchError('Host recovery state is not ready for completion')
    unit_mask.assert_restored(db, operation_id, switch[0], state=state_fd, units=units_fd)
    _guard(db, state_fd, install_fd, host_lock, install_lock, supervisor, coordinator, ready, lock_name='host.lock')
    unit_mask.assert_restored(db, operation_id, switch[0], state=state_fd, units=units_fd)
    db.execute('BEGIN IMMEDIATE')
    try:
        if inspect_exchange(db, operation_id, active_parent, candidate_parent, exchange, bundle) != 'exchanged':
            raise HostSwitchError('The host runtime changed during completion')
        if db.execute("UPDATE host_switches SET phase='completed' WHERE operation_id=? AND image_digest=? AND phase='exchanged'", (operation_id, switch[0])).rowcount != 1:
            raise HostSwitchError('Host exchange journal changed')
        if db.execute("UPDATE host_preparations SET status='completed' WHERE operation_id=? AND image_digest=? AND status='prepared'", (operation_id, switch[0])).rowcount != 1:
            raise HostSwitchError('Host preparation journal changed')
        if db.execute("SELECT 1 FROM host_unit_masks WHERE operation_id=? AND image_digest=? AND phase='restored'", (operation_id, switch[0])).fetchone() is None:
            raise HostSwitchError('Host unit recovery journal changed')
        if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='host_recovery_snapshots'").fetchone():
            if db.execute("UPDATE host_recovery_snapshots SET status='completed' WHERE operation_id=? AND image_digest=? AND status='prepared'",(operation_id,switch[0])).rowcount!=1:
                raise HostSwitchError('Host recovery snapshot journal changed')
        if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='host_stops'").fetchone():
            if db.execute("UPDATE host_stops SET status='completed' WHERE operation_id=? AND image_digest=? AND status='starting'", (operation_id, switch[0])).rowcount != 1:
                raise HostSwitchError('Updater stop journal changed')
        db.execute('COMMIT')
    except BaseException:
        if db.in_transaction: db.execute('ROLLBACK')
        raise
