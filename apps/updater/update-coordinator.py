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
