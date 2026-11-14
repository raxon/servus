#!/usr/bin/python3
"""Verify an unchanged running generation before retiring a failed update."""
import json
import os
import re
import sqlite3


class RetirementError(RuntimeError):
    pass


def assert_restored(db, operation_id, state_fd, gate_fd, journal_path, active_env,
                    expected_image, fence, supervisor, daemon, *, execute=None):
    """Check host state while the caller holds updater and installation locks."""
    execute = execute or fence.run
    if not re.fullmatch(r'ghcr\.io/raxon/servus@sha256:[a-f0-9]{64}', expected_image):
        raise RetirementError('Invalid expected image')
    row = db.execute('SELECT preparation_id,status FROM preparations WHERE operation_id=?', (operation_id,)).fetchone()
    if not row or not isinstance(row[0], str) or not fence.UUID.fullmatch(row[0]) or row[1] != 'prepared':
        raise RetirementError('Failed preparation is unavailable')
    fence._unit_inactive('servus-updater.service', execute)
    fence._unit_inactive('servus-prepare-' + row[0].replace('-', '') + '.service', execute, allow_missing=True)
    execute(['/usr/bin/systemctl', 'is-active', '--quiet', 'servus-supervisor.service'])
    fence.assert_no_maintenance(state_fd)
    state = supervisor._open_root_file(gate_fd, 'state', 0o644)
    try:
        if os.read(state, 64) != b'servus-lifecycle-v1 normal\n':
            raise RetirementError('Lifecycle gate is not open')
    finally:
        os.close(state)
    fence.assert_no_probe_resources(db, operation_id, execute=execute)
    policy_path, accepted_env, policy = daemon.resolve_active_policy(journal_path, active_env)
    if policy.image_reference != expected_image:
        raise RetirementError('Running image differs from the expected generation')
    identities = supervisor.inspect_servus(policy)
    ids = [identities[role]['id'] for role in supervisor.ROLES]
    records = json.loads(supervisor._docker('inspect', *ids), object_pairs_hook=supervisor._pairs)
    if not isinstance(records, list) or len(records) != len(ids):
        raise RetirementError('Container health is unavailable')
    by_id = {item.get('Id'): item for item in records if isinstance(item, dict)}
    if set(by_id) != set(ids):
        raise RetirementError('Container identity changed')
    for role in supervisor.ROLES:
        state = by_id[identities[role]['id']].get('State')
        if (not isinstance(state, dict) or state.get('Running') is not True or
                (role in ('api', 'agent') and (not isinstance(state.get('Health'), dict) or state['Health'].get('Status') != 'healthy'))):
            raise RetirementError('Previous generation is not healthy')
    if supervisor.inspect_servus(policy) != identities or daemon.resolve_active_policy(journal_path, active_env) != (policy_path, accepted_env, policy):
        raise RetirementError('Running generation changed')


def archive_restored(db, operation_id, state_fd, install_fd, gate_fd, journal_path,
                     active_env, expected_image, fence, journal, supervisor, daemon, *, execute=None, preflight=None):
    """Back up and retire the failed transaction only under host fences."""
    with fence.hold_locks(state_fd, install_fd):
        # Check database invariants without changing either durable state or files.
        check = sqlite3.connect(':memory:', isolation_level=None)
        try:
            db.backup(check)
            journal.archive_failed_before_snapshot(check, operation_id)
        finally:
            check.close()
        assert_restored(db, operation_id, state_fd, gate_fd, journal_path, active_env,
                        expected_image, fence, supervisor, daemon, execute=execute)
        if preflight is not None:
            preflight()
        archive_name = 'retired-update-' + operation_id
        os.mkdir(archive_name, 0o700, dir_fd=state_fd)
        os.fsync(state_fd)
        archive = os.open(archive_name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=state_fd)
        try:
            journal._private_directory(archive)
            path = '/proc/self/fd/' + str(archive) + '/journal.sqlite'
            backup = sqlite3.connect(path)
            try:
                os.chmod(path, 0o600)
                db.backup(backup)
            finally:
                backup.close()
            fd = os.open('journal.sqlite', os.O_RDONLY | os.O_NOFOLLOW, dir_fd=archive)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
            os.fsync(archive)
            assert_restored(db, operation_id, state_fd, gate_fd, journal_path, active_env,
                            expected_image, fence, supervisor, daemon, execute=execute)
            journal.archive_failed_before_snapshot(db, operation_id)
        finally:
            os.close(archive)
