#!/usr/bin/python3 -I
"""Prepare a host runtime from a completed, verified panel update.

This module does not activate a generation, stop services or authorize itself.
The root caller must supply trusted host modules and hold both installation
and updater locks for the complete operation.
"""
import os
import pathlib
import platform
import stat
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
            db.execute("CREATE TABLE IF NOT EXISTS host_preparations (operation_id TEXT PRIMARY KEY, image_digest TEXT NOT NULL, generation TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('intent','prepared','recovery_required'))) ")
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
