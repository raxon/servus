#!/usr/bin/python3 -I
"""Prepare a host runtime from a completed, verified panel update.

This module does not activate a generation, stop services or authorize itself.
The root caller must supply trusted host modules and hold both installation
and updater locks for the complete operation.
"""
import fcntl
import os
import pathlib
import platform
import stat
import subprocess
import sys


class HostPreparationError(Exception):
    pass


def _same_lock(supervisor, parent, name, held):
    supervisor._assert_exclusive_flock(held)
    fd = supervisor._open_root_file(parent, name, 0o600)
    try:
        a, b = os.fstat(fd), os.fstat(held)
        if (a.st_dev, a.st_ino) != (b.st_dev, b.st_ino):
            raise HostPreparationError('An expected lock is not held')
    finally:
        os.close(fd)


def _no_pending(db):
    checks = (
        "SELECT 1 FROM operations WHERE status IN ('accepted','verifying','recovery_required') LIMIT 1",
        "SELECT 1 FROM preparations WHERE status IN ('preparing','prepared','recovery_required') LIMIT 1",
        "SELECT 1 FROM update_transactions WHERE phase != 'completed' LIMIT 1",
        "SELECT 1 FROM apply_requests WHERE state != 'completed' LIMIT 1",
        "SELECT 1 FROM policy_approvals WHERE state IN ('candidate','activating','recovery_required') LIMIT 1",
        "SELECT 1 FROM extraction_probes WHERE status != 'removed' LIMIT 1",
        "SELECT 1 FROM policy_probes WHERE state != 'removed' LIMIT 1",
    )
    if any(db.execute(query).fetchone() for query in checks):
        raise HostPreparationError('Another update requires completion or recovery')



def stop_updater(db, operation_id, image_digest, *, state_fd, install_fd, host_lock, install_lock,
                 supervisor, unit_mask, bundle, authorize, run=subprocess.run):
    """Journal and stop the updater before taking its service lock.

    The caller holds host and installation locks and authorizes the completed
    signed update. The returned service lock remains held by the caller.
    """
    if (sys.platform != 'linux' or os.geteuid() != 0 or not sys.flags.isolated or
        db.in_transaction or db.isolation_level is not None or db.execute('PRAGMA synchronous').fetchone()[0] < 2 or
        not isinstance(operation_id, str) or not bundle.OPERATION.fullmatch(operation_id) or
        not isinstance(image_digest, str) or not bundle.DIGEST.fullmatch(image_digest) or not callable(authorize)):
        raise HostPreparationError('Invalid updater stop context')
    _same_lock(supervisor, state_fd, 'host.lock', host_lock)
    _same_lock(supervisor, install_fd, 'install.lock', install_lock)
    fd = supervisor._open_root_file(state_fd, 'journal.sqlite', 0o600)
    try:
        named = os.stat(db.execute('PRAGMA database_list').fetchone()[2], follow_symlinks=False)
        opened = os.fstat(fd)
        if (named.st_dev, named.st_ino) != (opened.st_dev, opened.st_ino):
            raise HostPreparationError('The journal identity differs')
    finally: os.close(fd)
    states = unit_mask.capture_service_states()
    if any(states[name] != 'active' for name in unit_mask.UNITS[:-1]):
        raise HostPreparationError('Host services are not ready for update')
    if authorize() is not None: raise HostPreparationError('Update authorization failed')
    db.execute('BEGIN IMMEDIATE')
    try:
        _no_pending(db)
        db.execute("CREATE TABLE IF NOT EXISTS host_stops (operation_id TEXT PRIMARY KEY,image_digest TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('stopping','stopped','completed','recovery_required'))) ")
        db.execute("CREATE UNIQUE INDEX IF NOT EXISTS one_active_host_stop ON host_stops ((1)) WHERE status != 'completed'")
        db.execute("INSERT INTO host_stops VALUES(?,?,'stopping')", (operation_id,image_digest))
        db.execute('COMMIT')
    except BaseException:
        if db.in_transaction: db.execute('ROLLBACK')
        raise
    _same_lock(supervisor, state_fd, 'host.lock', host_lock)
    _same_lock(supervisor, install_fd, 'install.lock', install_lock)
    if authorize() is not None: raise HostPreparationError('Update authorization failed')
    try:
        run(['/usr/bin/systemctl','stop','servus-updater.service'], stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, cwd='/',
            env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LANG':'C','LC_ALL':'C'},timeout=60,check=True)
    except (OSError, subprocess.SubprocessError) as error:
        raise HostPreparationError('Updater stop requires recovery') from error
    lock = supervisor._open_root_file(state_fd, 'service.lock', 0o600)
    try:
        try: fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error: raise HostPreparationError('Updater service lock remains held') from error
        expected = dict(states);expected['servus-updater.service'] = 'inactive'
        if unit_mask.capture_service_states() != expected: raise HostPreparationError('Host service states changed during stop')
        _same_lock(supervisor, state_fd, 'host.lock', host_lock)
        _same_lock(supervisor, install_fd, 'install.lock', install_lock)
        if db.execute("UPDATE host_stops SET status='stopped' WHERE operation_id=? AND image_digest=? AND status='stopping'", (operation_id,image_digest)).rowcount != 1:
            raise HostPreparationError('Updater stop journal changed')
        return lock, states
    except BaseException:
        os.close(lock)
        raise


def recover_stopped_updater(db, operation_id, image_digest, originals, *, state_fd, install_fd, units_fd,
                            host_lock, supervisor, unit_mask, bundle, ready, run=subprocess.run):
    """Recover only a journaled stop that never reached host preparation.

    The caller holds the host operation lock, supplies independently verified
    original unit bytes, and checks the authenticated control-plane readiness.
    The installation lock must be released so the supervisor can start.
    """
    if (sys.platform != 'linux' or os.geteuid() != 0 or not sys.flags.isolated or
        db.in_transaction or db.isolation_level is not None or db.execute('PRAGMA synchronous').fetchone()[0] < 2 or
        not isinstance(operation_id,str) or not bundle.OPERATION.fullmatch(operation_id) or
        not isinstance(image_digest,str) or not bundle.DIGEST.fullmatch(image_digest) or not callable(ready)):
        raise HostPreparationError('Invalid updater recovery context')
    _same_lock(supervisor, state_fd, 'host.lock', host_lock)
    fd = supervisor._open_root_file(state_fd, 'journal.sqlite', 0o600)
    try:
        named=os.stat(db.execute('PRAGMA database_list').fetchone()[2],follow_symlinks=False);opened=os.fstat(fd)
        if (named.st_dev,named.st_ino)!=(opened.st_dev,opened.st_ino):
            raise HostPreparationError('The journal identity differs')
    finally: os.close(fd)
    unit_mask._directory(units_fd,0o755)
    expected={name:('inactive' if name=='servus-updater-bootstrap.service' else 'active') for name in unit_mask.UNITS}
    unit_mask._metadata(operation_id,image_digest,originals,expected)
    def verify():
        _same_lock(supervisor,state_fd,'host.lock',host_lock)
        row=db.execute('SELECT image_digest,status FROM host_stops WHERE operation_id=?',(operation_id,)).fetchone()
        if not row or row[0]!=image_digest or row[1] not in ('stopping','stopped'):
            raise HostPreparationError('Updater stop is not eligible for recovery')
        for table in ('host_preparations','host_switches','host_unit_masks'):
            if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",(table,)).fetchone():
                if db.execute('SELECT 1 FROM '+table+' WHERE operation_id=?',(operation_id,)).fetchone():
                    raise HostPreparationError('Host exchange has already begun')
        for name in unit_mask.UNITS: unit_mask._read(units_fd,name,0o644,originals[name])
    verify()
    fd=supervisor._open_root_file(install_fd,'install.lock',0o600)
    try:
        try:fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError as error:raise HostPreparationError('Installation lock is still held') from error
        fcntl.flock(fd,fcntl.LOCK_UN)
    finally:os.close(fd)
    states=unit_mask.capture_service_states()
    for name in unit_mask.UNITS:
        if name!='servus-updater.service' and states[name]!=expected[name]:
            raise HostPreparationError('Host service state changed during recovery')
    try:
        run(['/usr/bin/systemctl','start','servus-updater.service'],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,cwd='/',env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LANG':'C','LC_ALL':'C'},timeout=60,check=True)
    except (OSError,subprocess.SubprocessError) as error:
        raise HostPreparationError('Updater restart requires recovery') from error
    verify()
    if unit_mask.capture_service_states()!=expected or ready() is not None:
        raise HostPreparationError('Control plane is not ready')
    db.execute('BEGIN IMMEDIATE')
    try:
        verify()
        if db.execute("UPDATE host_stops SET status='completed' WHERE operation_id=? AND image_digest=? AND status IN ('stopping','stopped')",(operation_id,image_digest)).rowcount!=1:
            raise HostPreparationError('Updater stop journal changed')
        db.execute('COMMIT')
    except BaseException:
        if db.in_transaction:db.execute('ROLLBACK')
        raise

def prepare_completed(db, operation_id, *, state_dir, install_dir, gate_dir,
                      candidate_parent, host_dir, active_env, service_lock, install_lock,
                      supervisor, daemon, extractor, backup, bundle, install_host, install_gh):
    """Stage a candidate and record durable intent before writing its files."""
    if sys.platform != 'linux' or os.geteuid() != 0 or not sys.flags.isolated:
        raise HostPreparationError('An isolated Linux root coordinator is required')
    if db.in_transaction or db.isolation_level is not None:
        raise HostPreparationError('An autocommit journal connection is required')
    paths = (state_dir, install_dir, gate_dir, candidate_parent, host_dir, active_env)
    if any(not isinstance(path, str) or not os.path.isabs(path) or os.path.normpath(path) != path for path in paths):
        raise HostPreparationError('A protected path is invalid')
    state = install = gate = candidates = host = staging = None
    inserted = False
    try:
        state = supervisor._trusted_directory(state_dir, 0o700)
        install = supervisor._trusted_directory(install_dir, 0o700)
        gate = supervisor._trusted_directory(gate_dir, 0o755)
        candidates = supervisor._trusted_directory(candidate_parent, 0o700)
        host = supervisor._trusted_directory(host_dir, 0o755)
        if os.fstat(candidates).st_dev != os.fstat(host).st_dev:
            raise HostPreparationError('Host generations must share a filesystem')
        _same_lock(supervisor, state, 'service.lock', service_lock)
        _same_lock(supervisor, install, 'install.lock', install_lock)
        database = db.execute('PRAGMA database_list').fetchone()
        journal_path = os.path.join(state_dir, 'journal.sqlite')
        if not database or os.path.realpath(database[2]) != os.path.realpath(journal_path):
            raise HostPreparationError('The journal identity differs')
        fd = supervisor._open_root_file(state, 'journal.sqlite', 0o600)
        os.close(fd)
        maintenance = supervisor._trusted_directory(os.path.join(state_dir, 'maintenance'), 0o700)
        try:
            try: os.stat('maintenance.json', dir_fd=maintenance, follow_symlinks=False)
            except FileNotFoundError: pass
            else: raise HostPreparationError('Maintenance requires recovery')
        finally: os.close(maintenance)
        fd = supervisor._open_root_file(gate, 'state', 0o644)
        try:
            if os.read(fd, 64) != b'servus-lifecycle-v1 normal\n':
                raise HostPreparationError('Lifecycle gate is not open')
        finally: os.close(fd)
        _no_pending(db)
        policy_path, accepted_env, policy = daemon.resolve_active_policy(journal_path, active_env)
        identities = supervisor.inspect_servus(policy)
        digest, stage_path = bundle.completed_update(db, operation_id, os.path.join(state_dir, 'staging'),
                                                     policy_path, active_env, policy.image_reference)
        staging = supervisor._trusted_directory(stage_path, 0o700)
        fd = supervisor._open_root_file(staging, 'manifest.json', 0o644)
        try:
            before = os.fstat(fd)
            raw = backup._read(fd, extractor.MANIFEST_LIMIT)
            after = os.fstat(fd)
            named = os.stat('manifest.json', dir_fd=staging, follow_symlinks=False)
            identity = lambda item: (item.st_dev, item.st_ino, item.st_size, item.st_mtime_ns, item.st_ctime_ns)
            if identity(before) != identity(after) or (named.st_dev, named.st_ino) != (before.st_dev, before.st_ino):
                raise HostPreparationError('Release manifest changed')
        finally: os.close(fd)
        manifest = extractor._manifest_files(raw)
        modules = bundle.collect(staging, manifest, install_host.MODULES)
        arch = {'x86_64': 'amd64', 'aarch64': 'arm64'}.get(platform.machine())
        if arch not in install_gh.PINNED:
            raise HostPreparationError('Host architecture is unsupported')
        pin = install_gh.PINNED[arch]
        bundle.check_cli_compatibility(modules, arch, pin)
        cli = bundle.read_pinned_cli(host, pin)
        _same_lock(supervisor, state, 'service.lock', service_lock)
        _same_lock(supervisor, install, 'install.lock', install_lock)
        if (daemon.resolve_active_policy(journal_path, active_env) != (policy_path, accepted_env, policy) or
            supervisor.inspect_servus(policy) != identities or
            bundle.completed_update(db, operation_id, os.path.join(state_dir, 'staging'),
                                    policy_path, active_env, policy.image_reference) != (digest, stage_path)):
            raise HostPreparationError('Active update changed during preparation')
        _no_pending(db)
        db.execute('BEGIN IMMEDIATE')
        try:
            db.execute("CREATE TABLE IF NOT EXISTS host_preparations (operation_id TEXT PRIMARY KEY, image_digest TEXT NOT NULL, generation TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('intent','prepared','recovery_required','completed'))) ")
            db.execute("CREATE UNIQUE INDEX IF NOT EXISTS one_active_host_preparation ON host_preparations ((1)) WHERE status IN ('intent','prepared','recovery_required')")
            db.execute("INSERT INTO host_preparations VALUES(?,?,?,'intent')", (operation_id, digest, 'runtime-' + operation_id))
            db.execute('COMMIT'); inserted = True
        except BaseException:
            if db.in_transaction: db.execute('ROLLBACK')
            raise
        generation = bundle.stage_runtime_tree(candidates, operation_id, digest, modules, cli, pin)
        _same_lock(supervisor, state, 'service.lock', service_lock)
        _same_lock(supervisor, install, 'install.lock', install_lock)
        if (daemon.resolve_active_policy(journal_path, active_env) != (policy_path, accepted_env, policy) or
            supervisor.inspect_servus(policy) != identities or
            bundle.completed_update(db, operation_id, os.path.join(state_dir, 'staging'),
                                    policy_path, active_env, policy.image_reference) != (digest, stage_path)):
            raise HostPreparationError('Active update changed during preparation')
        bundle.verify_runtime_tree(candidates, operation_id, digest, modules, cli, pin)
        if db.execute("UPDATE host_preparations SET status='prepared' WHERE operation_id=? AND image_digest=? AND generation=? AND status='intent'",
                      (operation_id, digest, generation)).rowcount != 1:
            raise HostPreparationError('Host preparation journal changed')
        return generation
    except BaseException:
        if inserted:
            try: db.execute("UPDATE host_preparations SET status='recovery_required' WHERE operation_id=? AND status='intent'", (operation_id,))
            except BaseException: pass
        raise
    finally:
        for fd in (staging, host, candidates, gate, install, state):
            if fd is not None: os.close(fd)
