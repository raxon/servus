#!/usr/bin/python3 -I
"""Journal an atomic host runtime exchange for an independently fenced caller.

This module does not stop services, authorize a release, or restart anything.
The root caller must verify the completed release and live generation, fence
all host code consumers, and provide the current trusted release bytes.
"""
import os
import sys


class HostSwitchError(Exception):
    pass


def _guard(db, state_fd, install_fd, service_lock, install_lock, supervisor, coordinator, fence):
    if (sys.platform != 'linux' or os.geteuid() != 0 or not sys.flags.isolated or
        db.in_transaction or db.isolation_level is not None or not callable(fence)):
        raise HostSwitchError('An isolated, fenced root coordinator is required')
    if db.execute('PRAGMA synchronous').fetchone()[0] < 2:
        raise HostSwitchError('The journal must use durable synchronization')
    coordinator._same_lock(supervisor, state_fd, 'service.lock', service_lock)
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
    if not row or not isinstance(row[0], str) or not bundle.DIGEST.fullmatch(row[0]) or row[5] not in ('intent', 'exchanged', 'rolled_back'):
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
        db.execute("CREATE TABLE IF NOT EXISTS host_switches (operation_id TEXT PRIMARY KEY, image_digest TEXT NOT NULL, old_dev INTEGER NOT NULL, old_ino INTEGER NOT NULL, new_dev INTEGER NOT NULL, new_ino INTEGER NOT NULL, phase TEXT NOT NULL CHECK(phase IN ('intent','exchanged','rolled_back'))) ")
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
