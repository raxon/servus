"""Private primitives for a fail-closed update coordinator."""

import hashlib
from contextlib import closing
import json
import os
import re
import sqlite3


class UpdateError(Exception):
    pass


def _pairs(items):
    result = {}
    for key, value in items:
        if key in result:
            raise UpdateError('Duplicate manifest entry')
        result[key] = value
    return result


def verify_snapshot(path, digest, backup_module, node_fd, supervisor):
    """Verify a protected snapshot before allowing activation.

    The caller must hold the maintenance and installation locks throughout.
    This function does not itself establish writer quiescence.
    """
    if not isinstance(digest, str) or not re.fullmatch(r'sha256:[a-f0-9]{64}', digest):
        raise UpdateError('Invalid snapshot digest')
    digest = digest[7:]
    directory = supervisor._trusted_directory(path, 0o700)
    try:
        dev = os.fstat(directory).st_dev
        manifest_fd, _ = backup_module._file(directory, 'manifest.json', 0, dev)
        try:
            raw = backup_module._read(manifest_fd)
        finally:
            os.close(manifest_fd)
        if hashlib.sha256(raw).hexdigest() != digest:
            raise UpdateError('Snapshot manifest digest mismatch')
        manifest = json.loads(raw, object_pairs_hook=_pairs)
        if not isinstance(manifest, dict) or set(manifest) != {'format', 'files'} or type(manifest['format']) is not int or manifest['format'] != 1 or not isinstance(manifest['files'], dict):
            raise UpdateError('Invalid snapshot manifest')
        files = manifest['files']
        base = {'panel.sqlite', 'agent.sqlite', 'secret-key', 'agent-token'}
        if not base.issubset(files):
            raise UpdateError('Incomplete snapshot')
        for name, checksum in files.items():
            parts = name.split('/')
            if (not isinstance(checksum, str) or not re.fullmatch(r'[a-f0-9]{64}', checksum) or
                not (name in base or len(parts) == 2 and parts[0] in ('secrets', 'database-roots') and backup_module.UUID.fullmatch(parts[1]))):
                raise UpdateError('Invalid snapshot inventory')

        def check_inventory():
            if set(os.listdir(directory)) != base | {'manifest.json', 'secrets', 'database-roots'}:
                raise UpdateError('Unexpected snapshot contents')
            for folder in ('secrets', 'database-roots'):
                child = backup_module._child_dir(directory, folder, 0, dev)
                try:
                    if set(os.listdir(child)) != {key.split('/')[1] for key in files if key.startswith(folder + '/')}:
                        raise UpdateError('Snapshot inventory mismatch')
                finally:
                    os.close(child)
            for name, checksum in files.items():
                parts = name.split('/')
                child = backup_module._child_dir(directory, parts[0], 0, dev) if len(parts) == 2 else None
                try:
                    fd, _ = backup_module._file(child if child is not None else directory, parts[-1], 0, dev,
                                                backup_module.MAX_DATABASE if name.endswith('.sqlite') else backup_module.MAX_FILE)
                    try:
                        hasher = hashlib.sha256()
                        while chunk := os.read(fd, 65536):
                            hasher.update(chunk)
                    finally:
                        os.close(fd)
                finally:
                    if child is not None:
                        os.close(child)
                if hasher.hexdigest() != checksum:
                    raise UpdateError('Snapshot file digest mismatch')

        check_inventory()
        for name in ('panel.sqlite', 'agent.sqlite'):
            with closing(sqlite3.connect(f'file:/proc/self/fd/{directory}/{name}?mode=ro&immutable=1', uri=True)) as db:
                if db.execute('PRAGMA integrity_check').fetchall() != [('ok',)] or db.execute('PRAGMA foreign_key_check').fetchone() is not None:
                    raise UpdateError('Snapshot database integrity check failed')
        backup_module._validate_staging(directory, node_fd)
        check_inventory()
        manifest_fd, _ = backup_module._file(directory, 'manifest.json', 0, dev)
        try:
            if hashlib.sha256(backup_module._read(manifest_fd)).hexdigest() != digest:
                raise UpdateError('Snapshot manifest changed')
        finally:
            os.close(manifest_fd)
    finally:
        os.close(directory)


def begin_snapshot(journal, operation_id, lease, supervisor):
    """Record capture intent while the authenticated maintenance gate is held.

    A drained lease does not prove every writer is stopped. The caller must
    establish that independently before creating a snapshot.
    """
    if not supervisor._uuid4(operation_id) or not isinstance(lease, supervisor.DrainLease):
        raise UpdateError('Invalid snapshot operation')
    lease.assert_locked(operation_id, 'stopped_unverified')
    db = journal.db
    db.execute('BEGIN IMMEDIATE')
    try:
        result = db.execute("UPDATE update_transactions SET phase='snapshotting' "
            "WHERE operation_id=? AND phase='intent' AND backup_path IS NULL AND backup_manifest_digest IS NULL "
            "AND EXISTS (SELECT 1 FROM operations o JOIN preparations p ON p.operation_id=o.id "
            "WHERE o.id=update_transactions.operation_id AND o.status='verified' AND p.status='prepared' "
            "AND o.digest=update_transactions.root_digest AND o.attempt_id=update_transactions.attempt_id "
            "AND o.attempt_nonce=update_transactions.attempt_nonce AND p.attempt_id=update_transactions.attempt_id "
            "AND p.attempt_nonce=update_transactions.attempt_nonce AND p.preparation_id=update_transactions.preparation_id)",
            (operation_id,))
        if result.rowcount != 1:
            raise UpdateError('Snapshot does not match the active update')
        lease.assert_locked(operation_id, 'stopped_unverified')
        db.execute('COMMIT')
    except BaseException:
        if db.in_transaction:
            db.execute('ROLLBACK')
        raise
    try:
        lease.record('snapshotting')
    except BaseException:
        db.execute("UPDATE update_transactions SET phase='recovery_required' WHERE operation_id=? AND phase='snapshotting'", (operation_id,))
        raise


def record_verified_snapshot(journal, operation_id, path, digest, lease, backup_module, node_fd, supervisor):
    """Bind a validated snapshot to the exact prepared release under the drain lease.

    The caller must have independently established writer quiescence and marked
    both journals as snapshotting before capture. An interrupted handoff leaves
    the operation requiring recovery instead of authorizing activation.
    """
    if (not supervisor._uuid4(operation_id) or not isinstance(lease, supervisor.DrainLease) or
        not isinstance(path, str) or not path.startswith('/') or os.path.normpath(path) != path or
        not isinstance(digest, str) or not re.fullmatch(r'sha256:[a-f0-9]{64}', digest)):
        raise UpdateError('Invalid snapshot proof')
    lease.assert_locked(operation_id, 'snapshotting')
    verify_snapshot(path, digest, backup_module, node_fd, supervisor)
    db = journal.db
    db.execute('BEGIN IMMEDIATE')
    try:
        lease.assert_locked(operation_id, 'snapshotting')
        verify_snapshot(path, digest, backup_module, node_fd, supervisor)
        result = db.execute("UPDATE update_transactions SET backup_path=?,backup_manifest_digest=?,phase='snapshot_verified' "
            "WHERE operation_id=? AND phase='snapshotting' AND backup_path IS NULL AND backup_manifest_digest IS NULL "
            "AND EXISTS (SELECT 1 FROM operations o JOIN preparations p ON p.operation_id=o.id "
            "WHERE o.id=update_transactions.operation_id AND o.status='verified' AND p.status='prepared' "
            "AND o.digest=update_transactions.root_digest AND o.attempt_id=update_transactions.attempt_id "
            "AND o.attempt_nonce=update_transactions.attempt_nonce AND p.attempt_id=update_transactions.attempt_id "
            "AND p.attempt_nonce=update_transactions.attempt_nonce AND p.preparation_id=update_transactions.preparation_id)",
            (path, digest, operation_id))
        if result.rowcount != 1:
            raise UpdateError('Snapshot does not match the active update')
        lease.assert_locked(operation_id, 'snapshotting')
        db.execute('COMMIT')
    except BaseException:
        if db.in_transaction:
            db.execute('ROLLBACK')
        raise
    try:
        lease.record('snapshot_verified')
    except BaseException:
        db.execute("UPDATE update_transactions SET phase='recovery_required' WHERE operation_id=? AND phase='snapshot_verified'", (operation_id,))
        raise


def capture_stopped_snapshot(journal, operation_id, lease, destination, node_fd,
                             supervisor, quiescence, backup_module, *, trusted_ingress=None):
    """Capture and verify a snapshot during a held, authenticated drain.

    The root caller must supply the verified release's Node executable and an
    ingress identity from protected installation policy, never from a request.
    Root, Docker and any explicitly trusted ingress are inside the trust boundary.
    This operation does not start containers or apply the new release.
    """
    if not isinstance(lease, supervisor.DrainLease):
        raise UpdateError('A current maintenance lease is required')
    lease.assert_locked(operation_id, 'stopped_unverified')
    hub = lease._hub
    if (not isinstance(hub, supervisor.DrainHub) or hub.used is not True or
        lease._policy_binding is None or hub.expected_uid != 1000 or
        not isinstance(hub.policy, supervisor.RuntimePolicy) or set(hub.identities) != set(supervisor.ROLES)):
        raise UpdateError('Authenticated drain identity is unavailable')
    try:
        expected = {hub.identities[role]['id'] for role in supervisor.ROLES}
    except (KeyError, TypeError):
        raise UpdateError('Authenticated drain identity is unavailable') from None
    data_dir = hub.policy.data_dir
    supervisor._verify_data_directory(data_dir)

    class DockerInspection:
        @staticmethod
        def call(*args):
            return supervisor._docker(*args)

        @staticmethod
        def inspect(*ids):
            try:
                return json.loads(supervisor._docker('inspect', *ids), object_pairs_hook=_pairs)
            except (ValueError, UnicodeError, RecursionError):
                raise UpdateError('Docker inspection is unavailable') from None

    docker = DockerInspection()
    def check():
        lease.assert_locked(operation_id, 'snapshotting')
        quiescence.ensure_host_namespaces()
        quiescence.ensure_no_other_data_mounts(docker, expected, data_dir, trusted_ingress=trusted_ingress)
        quiescence.ensure_no_mount_aliases(docker, data_dir)
        quiescence.ensure_no_open_data(data_dir)
        quiescence.ensure_no_uid_writers(hub.expected_uid)
        lease.assert_locked(operation_id, 'snapshotting')

    source_fd = destination_fd = None
    try:
        destination_fd = supervisor._trusted_directory(destination, 0o700)
        source_fd = os.open(data_dir, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
        begin_snapshot(journal, operation_id, lease, supervisor)
        check()
        backup_module._capture_quiescent(source_fd, destination_fd, node_fd, source_uid=hub.expected_uid, reader_gid=65534)
        check()
        manifest_fd, _ = backup_module._file(destination_fd, 'manifest.json', 0, os.fstat(destination_fd).st_dev)
        try:
            digest = 'sha256:' + hashlib.sha256(backup_module._read(manifest_fd)).hexdigest()
        finally:
            os.close(manifest_fd)
        record_verified_snapshot(journal, operation_id, destination, digest, lease, backup_module, node_fd, supervisor)
        return digest
    except BaseException:
        journal.db.execute("UPDATE update_transactions SET phase='recovery_required' WHERE operation_id=? AND phase IN ('snapshotting','snapshot_verified')", (operation_id,))
        raise
    finally:
        if source_fd is not None:
            os.close(source_fd)
        if destination_fd is not None:
            os.close(destination_fd)


def create_generation(journal, operation_id, lease, daemon_ownership, approval_journal,
                      active_env, docker_config, supervisor, daemon, extractor,
                      runtime_policy, backup_module, node_fd):
    """Create and inspect a candidate generation while the startup gate is closed.

    This trusted host operation does not start the containers. Any uncertain
    Docker result leaves both the gate and the transaction in recovery state.
    """
    if not isinstance(lease, supervisor.DrainLease) or not supervisor._uuid4(operation_id):
        raise UpdateError('A current maintenance lease is required')
    lease.assert_snapshot_verified(operation_id)
    control_dir = os.readlink('/proc/self/fd/' + str(daemon_ownership.directory))
    daemon_ownership.assert_held(control_dir)
    database = journal.db.execute('PRAGMA database_list').fetchone()
    if not database or os.path.realpath(database[2]) != os.path.realpath(approval_journal):
        raise UpdateError('Approval journal does not match update journal')
    config_fd = supervisor._trusted_directory(docker_config, 0o700)
    try:
        if os.listdir(config_fd):
            raise UpdateError('Docker configuration must be empty')
    finally:
        os.close(config_fd)
    policy_path, accepted_env, policy = daemon.resolve_active_policy(approval_journal, active_env)
    if not isinstance(policy, supervisor.RuntimePolicy) or policy.control_dir != control_dir:
        raise UpdateError('Active policy identity changed')
    row = journal.db.execute("SELECT p.staging_path,t.backup_path,t.backup_manifest_digest,t.root_digest "
        "FROM update_transactions t JOIN operations o ON o.id=t.operation_id "
        "JOIN preparations p ON p.operation_id=t.operation_id JOIN policy_approvals a ON a.operation_id=t.operation_id "
        "WHERE t.operation_id=? AND t.phase='snapshot_verified' AND o.status='verified' AND p.status='prepared' "
        "AND a.state='active' AND a.policy_path=? AND a.accepted_env_path=? AND a.source_env_path=? "
        "AND t.preparation_id=p.preparation_id AND t.attempt_id=p.attempt_id AND t.attempt_nonce=p.attempt_nonce "
        "AND t.attempt_id=o.attempt_id AND t.attempt_nonce=o.attempt_nonce AND t.root_digest=o.digest "
        "AND a.attempt_id=t.attempt_id AND a.attempt_nonce=t.attempt_nonce AND a.preparation_id=t.preparation_id "
        "AND a.root_digest=t.root_digest AND a.image_config_digest=o.config_digest",
        (operation_id, policy_path, accepted_env, active_env)).fetchone()
    if (not row or not isinstance(row[0], str) or not os.path.isabs(row[0]) or os.path.normpath(row[0]) != row[0] or
        not re.fullmatch(r'servus-install-[a-f0-9]{32}', os.path.basename(row[0])) or
        policy.image_reference != 'ghcr.io/raxon/servus@' + row[3]):
        raise UpdateError('Active generation does not match the verified update')
    stage = row[0]
    stage_fd = supervisor._trusted_directory(stage, 0o700)
    deployment_fd = None
    try:
        manifest_fd = supervisor._open_root_file(stage_fd, 'manifest.json', 0o644)
        try:
            manifest = extractor._manifest_files(backup_module._read(manifest_fd, extractor.MANIFEST_LIMIT))
        finally:
            os.close(manifest_fd)
        deployment_fd = supervisor._trusted_directory(os.path.join(stage, 'deployment'))
        compose_fd = supervisor._open_root_file(deployment_fd, 'compose.yaml', 0o644)
        try:
            content = backup_module._read(compose_fd, extractor.MAX_FILE)
        finally:
            os.close(compose_fd)
        expected = manifest.get('deployment/compose.yaml')
        if expected != (0o644, len(content), hashlib.sha256(content).hexdigest()):
            raise UpdateError('Prepared Compose file changed')
        compose = os.path.join(stage, 'deployment', 'compose.yaml')
        verify_snapshot(row[1], row[2], backup_module, node_fd, supervisor)
        lease.assert_snapshot_verified(operation_id)
        daemon_ownership.assert_held(control_dir)
        result = journal.db.execute("UPDATE update_transactions SET phase='switching' WHERE operation_id=? AND phase='snapshot_verified' AND backup_path=? AND backup_manifest_digest=? AND root_digest=?",
                                    (operation_id, row[1], row[2], row[3]))
        if result.rowcount != 1:
            raise UpdateError('Update transaction changed')
        try:
            lease.record('switching')
            runtime_policy._docker(docker_config, 'compose', '--env-file', active_env, '-f', compose,
                                   '-p', 'servus', 'create', '--no-build', '--pull', 'never', '--force-recreate', timeout=180)
            lease.assert_locked(operation_id, 'switching')
            daemon_ownership.assert_held(control_dir)
            path, accepted, current = daemon.resolve_active_policy(approval_journal, active_env)
            if (path, accepted, current) != (policy_path, accepted_env, policy):
                raise UpdateError('Active policy changed during creation')
            return supervisor.inspect_servus(policy, created=True)
        except BaseException:
            journal.db.execute("UPDATE update_transactions SET phase='recovery_required' WHERE operation_id=? AND phase='switching'", (operation_id,))
            raise
    finally:
        if deployment_fd is not None:
            os.close(deployment_fd)
        os.close(stage_fd)
