#!/usr/bin/python3 -I
"""Verify requested releases; applying updates requires a separate supervisor."""

import argparse
import errno
import fcntl
import grp
import hashlib
import importlib.util
import json
import os
import pathlib
import pwd
import re
import secrets
import uuid
import signal
import socket
import sqlite3
import stat
import struct
import subprocess
import sys
import threading
import time

MAX_REQUEST = 4096
EXECUTOR = pathlib.Path('/usr/local/libexec/servus/verification-executor.py')
PREPARATION_FENCE = pathlib.Path('/usr/local/libexec/servus/preparation-fence.py')
DISCOVERY_EXECUTOR = pathlib.Path('/usr/local/libexec/servus/discover-release.py')
DNS_JOURNAL_BACKUP = pathlib.Path('/usr/local/libexec/servus/backup.py')
DNS_JOURNAL_BACKUP_SHA256 = 'a5f67f984cd5fe2a9f29208858d47beb108697fc9e235f8c9b365e30ee2f3752'
FENCE_MODULE = pathlib.Path('/usr/local/libexec/servus/verification-fence.py')
FENCE_ROOT = pathlib.Path('/run/servus-updater/fences')
NSS_CONFIG = pathlib.Path('/etc/nsswitch.conf')
NSS_PASSWD = pathlib.Path('/etc/passwd')
NSS_GROUP = pathlib.Path('/etc/group')
NSS_SUBGID = pathlib.Path('/etc/subgid')
PROC_ROOT = pathlib.Path('/proc')
VERIFIER_RECORD_DIR = pathlib.Path('/var/lib/servus-updater')
USERDB_DIRS = tuple(map(pathlib.Path, ('/etc/userdb', '/run/userdb', '/run/host/userdb', '/usr/lib/userdb')))
SYSTEMD_USERDB = pathlib.Path('/run/systemd/userdb')
PYTHON = '/usr/bin/python3'
EXECUTOR_TIMEOUT = 130
EXECUTOR_OUTPUT_LIMIT = 16384
CLEAN_ENV = {'PATH': '/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C'}
UUID_PATTERN = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
COMMIT_PATTERN = re.compile(r'^[0-9a-f]{40}$')
DIGEST_PATTERN = re.compile(r'^sha256:[0-9a-f]{64}$')
TAG_PATTERN = re.compile(r'^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$')


class ProtocolError(Exception):
    def __init__(self, code):
        self.code = code


def trusted_directory(value, mode, group=None):
    path = pathlib.Path(os.path.abspath(value))
    current = pathlib.Path(path.anchor)
    for part in path.parts[1:]:
        current /= part
        info = current.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0:
            raise RuntimeError('Directories must be root-owned and must not be symbolic links')
        if info.st_mode & 0o022 and not (info.st_uid == 0 and info.st_mode & stat.S_ISVTX):
            raise RuntimeError('Directory ancestry is writable by other users')
    info = path.stat()
    if stat.S_IMODE(info.st_mode) != mode or (group is not None and info.st_gid != group):
        raise RuntimeError('Updater directory permissions are invalid')
    return path


def private_file(directory, name):
    path = directory / name
    fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o600:
        os.close(fd)
        raise RuntimeError('Updater state file is unsafe')
    return fd


def valid_uuid(value):
    return isinstance(value, str) and UUID_PATTERN.fullmatch(value) is not None


def no_duplicate_keys(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('duplicate key')
        result[key] = value
    return result


class Journal:
    def __init__(self, state_dir):
        database = state_dir / 'journal.sqlite'
        fd = private_file(state_dir, 'journal.sqlite')
        os.close(fd)
        self.db = sqlite3.connect(database, isolation_level=None, timeout=2)
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.execute('PRAGMA synchronous=FULL')
        self.db.execute('PRAGMA busy_timeout=2000')
        self.db.execute('BEGIN IMMEDIATE')
        try:
            table = self.db.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='operations'").fetchone()
            version = self.db.execute('PRAGMA user_version').fetchone()[0]
            if table and version == 0:
                columns = {row[1] for row in self.db.execute('PRAGMA table_info(operations)')}
                if not {'id', 'commit_sha', 'digest', 'tag', 'status', 'created_at'}.issubset(columns):
                    raise RuntimeError('Existing journal lacks release tags; manual recovery is required')
                if self.db.execute("SELECT 1 FROM operations WHERE status != 'awaiting_executor' LIMIT 1").fetchone():
                    raise RuntimeError('Existing journal has unknown operations')
                self.db.execute('DROP INDEX IF EXISTS one_active_operation')
                self.db.execute('ALTER TABLE operations RENAME TO operations_old')
            elif table and version not in (2, 3, 4, 5, 6, 7, 8):
                raise RuntimeError('Unsupported updater journal version')
            elif not table and version != 0:
                raise RuntimeError('Invalid updater journal')
            self.db.execute("CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, commit_sha TEXT NOT NULL, digest TEXT NOT NULL, tag TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('accepted','verifying','verified','verification_failed','recovery_required')), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, attempt_id TEXT, attempt_nonce TEXT, config_digest TEXT)")
            if table and version == 2:
                self.db.execute('ALTER TABLE operations ADD COLUMN attempt_id TEXT')
                self.db.execute('ALTER TABLE operations ADD COLUMN attempt_nonce TEXT')
            if table and version in (2, 3):
                self.db.execute('ALTER TABLE operations ADD COLUMN config_digest TEXT')
                # Older verified records lack an authenticated config digest.
                self.db.execute("UPDATE operations SET status='verification_failed' WHERE status='verified'")
            if table and version == 0:
                self.db.execute("INSERT INTO operations(id,commit_sha,digest,tag,status,created_at) SELECT id,commit_sha,digest,tag,'accepted',created_at FROM operations_old")
                self.db.execute('DROP TABLE operations_old')
            self.db.execute("CREATE UNIQUE INDEX IF NOT EXISTS one_active_operation ON operations ((1)) WHERE status IN ('accepted','verifying','recovery_required')")
            if table and version == 5:
                self.db.execute('DROP INDEX IF EXISTS one_active_preparation')
                self.db.execute('ALTER TABLE preparations RENAME TO preparations_v5')
            self.db.execute("CREATE TABLE IF NOT EXISTS preparations (operation_id TEXT PRIMARY KEY REFERENCES operations(id), attempt_id TEXT NOT NULL, attempt_nonce TEXT NOT NULL, preparation_id TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('preparing','prepared','completed','recovery_required')), staging_path TEXT)")
            if table and version == 5:
                self.db.execute('INSERT INTO preparations SELECT * FROM preparations_v5')
                self.db.execute('DROP TABLE preparations_v5')
            self.db.execute("CREATE UNIQUE INDEX IF NOT EXISTS one_active_preparation ON preparations ((1)) WHERE status IN ('preparing','prepared','recovery_required')")
            self.db.execute("CREATE TABLE IF NOT EXISTS extraction_probes (name TEXT PRIMARY KEY, operation_id TEXT NOT NULL REFERENCES operations(id), attempt_id TEXT NOT NULL, attempt_nonce TEXT NOT NULL, preparation_id TEXT NOT NULL, purpose TEXT NOT NULL CHECK(purpose IN ('prepare','policy')), status TEXT NOT NULL CHECK(status IN ('intent','removed')))")
            self.db.execute("CREATE UNIQUE INDEX IF NOT EXISTS one_active_extraction_probe ON extraction_probes ((1)) WHERE status='intent'")
            self.db.execute("CREATE TABLE IF NOT EXISTS update_transactions (operation_id TEXT PRIMARY KEY REFERENCES operations(id), preparation_id TEXT NOT NULL, attempt_id TEXT NOT NULL, attempt_nonce TEXT NOT NULL, root_digest TEXT NOT NULL, backup_path TEXT, backup_manifest_digest TEXT, phase TEXT NOT NULL CHECK(phase IN ('intent','snapshotting','snapshot_verified','switching','starting','completed','recovery_required')))")
            self.db.execute("CREATE UNIQUE INDEX IF NOT EXISTS one_active_update ON update_transactions ((1)) WHERE phase != 'completed'")
            self.db.execute("CREATE TABLE IF NOT EXISTS apply_requests (operation_id TEXT PRIMARY KEY REFERENCES operations(id), state TEXT NOT NULL CHECK(state IN ('requested','dispatching','awaiting_completion','completed','recovery_required')))")
            self.db.execute("CREATE UNIQUE INDEX IF NOT EXISTS one_active_apply_request ON apply_requests ((1)) WHERE state != 'completed'")
            self.db.execute('PRAGMA user_version=8')
            self.db.execute('COMMIT')
        except BaseException:
            self.db.execute('ROLLBACK')
            self.db.close()
            raise
        directory_fd = os.open(state_dir, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)

    def close(self):
        self.db.close()

    def recover(self):
        # Verification is read-only, but a prior executor may still be alive.
        self.db.execute("UPDATE operations SET status='recovery_required' WHERE status='verifying'")
        # An interrupted Docker operation cannot be proven stopped by this journal.
        self.db.execute("UPDATE preparations SET status='recovery_required' WHERE status='preparing'")
        self.db.execute("UPDATE update_transactions SET phase='recovery_required' WHERE phase NOT IN ('completed','recovery_required')")
        self.db.execute("UPDATE apply_requests SET state='completed' WHERE state IN ('dispatching','awaiting_completion') AND EXISTS (SELECT 1 FROM update_transactions t WHERE t.operation_id=apply_requests.operation_id AND t.phase='completed')")
        self.db.execute("UPDATE apply_requests SET state='recovery_required' WHERE state IN ('dispatching','awaiting_completion')")

    def host_update_pending(self):
        """Block new update work while a host runtime exchange needs recovery."""
        checks = (
            ('host_stops', "status != 'completed'"),
            ('host_preparations', "status NOT IN ('completed','abandoned')"),
            ('host_switches', "phase NOT IN ('completed','rolled_back')"),
            ('host_unit_masks', "phase != 'restored'"),
        )
        for table, condition in checks:
            exists = self.db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone()
            if exists and self.db.execute('SELECT 1 FROM ' + table + ' WHERE ' + condition + ' LIMIT 1').fetchone():
                return True
        return False

    def request_apply(self, operation_id):
        """Queue one previously verified, fully prepared update exactly once."""
        if not valid_uuid(operation_id): raise ProtocolError('invalid_request')
        self.db.execute('BEGIN IMMEDIATE')
        try:
            if self.host_update_pending(): raise ProtocolError('recovery_required')
            existing = self.db.execute('SELECT state FROM apply_requests WHERE operation_id=?', (operation_id,)).fetchone()
            if existing:
                self.db.execute('COMMIT')
                return {'operationId': operation_id, 'status': existing[0]}
            row = self.db.execute("SELECT 1 FROM operations o JOIN preparations p ON p.operation_id=o.id WHERE o.id=? AND o.status='verified' AND p.status='prepared' AND o.attempt_id=p.attempt_id AND o.attempt_nonce=p.attempt_nonce", (operation_id,)).fetchone()
            if not row: raise ProtocolError('not_found')
            if self.db.execute("SELECT 1 FROM apply_requests WHERE state != 'completed' LIMIT 1").fetchone() or self.db.execute("SELECT 1 FROM update_transactions WHERE phase != 'completed' LIMIT 1").fetchone():
                raise ProtocolError('operation_in_progress')
            self.db.execute("INSERT INTO apply_requests(operation_id,state) VALUES(?,'requested')", (operation_id,))
            self.db.execute('COMMIT')
            return {'operationId': operation_id, 'status': 'requested'}
        except BaseException:
            if self.db.in_transaction: self.db.execute('ROLLBACK')
            raise

    def apply_status(self, operation_id):
        if not valid_uuid(operation_id): raise ProtocolError('invalid_request')
        row = self.db.execute('SELECT state FROM apply_requests WHERE operation_id=?', (operation_id,)).fetchone()
        if not row: raise ProtocolError('not_found')
        return {'operationId': operation_id, 'status': row[0]}

    def claim_apply_request(self):
        self.db.execute('BEGIN IMMEDIATE')
        try:
            if self.host_update_pending():
                self.db.execute('COMMIT')
                return None
            row = self.db.execute("SELECT operation_id FROM apply_requests WHERE state='requested'").fetchone()
            if row:
                cursor = self.db.execute("UPDATE apply_requests SET state='dispatching' WHERE operation_id=? AND state='requested'", row)
                if cursor.rowcount != 1: raise RuntimeError('Apply request changed')
            self.db.execute('COMMIT')
            return row[0] if row else None
        except BaseException:
            if self.db.in_transaction: self.db.execute('ROLLBACK')
            raise

    def claim_update(self, operation_id):
        """Persist update intent for one verified, prepared release."""
        if not valid_uuid(operation_id): raise ProtocolError('invalid_request')
        self.db.execute('BEGIN IMMEDIATE')
        try:
            if self.host_update_pending(): raise ProtocolError('recovery_required')
            row = self.db.execute("SELECT p.preparation_id,p.attempt_id,p.attempt_nonce,o.digest FROM preparations p JOIN operations o ON o.id=p.operation_id WHERE p.operation_id=? AND p.status='prepared' AND o.status='verified' AND o.attempt_id=p.attempt_id AND o.attempt_nonce=p.attempt_nonce", (operation_id,)).fetchone()
            if not row or not valid_uuid(row[0]) or not valid_uuid(row[1]) or not re.fullmatch(r'[a-f0-9]{64}', row[2] or '') or not DIGEST_PATTERN.fullmatch(row[3] or ''):
                raise ProtocolError('not_found')
            if self.db.execute("SELECT 1 FROM update_transactions WHERE phase != 'completed' LIMIT 1").fetchone():
                raise ProtocolError('recovery_required')
            if self.db.execute('SELECT 1 FROM update_transactions WHERE operation_id=?', (operation_id,)).fetchone():
                raise ProtocolError('idempotency_conflict')
            self.db.execute("INSERT INTO update_transactions(operation_id,preparation_id,attempt_id,attempt_nonce,root_digest,phase) VALUES(?,?,?,?,?,'intent')", (operation_id,*row))
            self.db.execute('COMMIT')
        except BaseException:
            if self.db.in_transaction: self.db.execute('ROLLBACK')
            raise

    def claim_preparation(self, operation_id):
        """Record intent before any Docker call, bound to the verified attempt."""
        if not valid_uuid(operation_id): raise ProtocolError('invalid_request')
        self.db.execute('BEGIN IMMEDIATE')
        try:
            if self.host_update_pending(): raise ProtocolError('recovery_required')
            row = self.db.execute("SELECT commit_sha,digest,tag,attempt_id,attempt_nonce,config_digest FROM operations WHERE id=? AND status='verified'", (operation_id,)).fetchone()
            if not row or not valid_uuid(row[3]) or not isinstance(row[4], str) or not re.fullmatch(r'[a-f0-9]{64}', row[4]) or not isinstance(row[5], str) or not DIGEST_PATTERN.fullmatch(row[5]):
                raise ProtocolError('not_found')
            if self.db.execute("SELECT 1 FROM operations WHERE status IN ('accepted','verifying','recovery_required') LIMIT 1").fetchone():
                raise ProtocolError('operation_in_progress')
            if self.db.execute("SELECT 1 FROM preparations WHERE status IN ('preparing','prepared','recovery_required') LIMIT 1").fetchone():
                raise ProtocolError('recovery_required')
            if self.db.execute('SELECT 1 FROM preparations WHERE operation_id=?', (operation_id,)).fetchone():
                raise ProtocolError('idempotency_conflict')
            preparation_id = str(uuid.uuid4())
            self.db.execute("INSERT INTO preparations(operation_id,attempt_id,attempt_nonce,preparation_id,status) VALUES(?,?,?,?,'preparing')", (operation_id, row[3], row[4], preparation_id))
            self.db.execute('COMMIT')
            return {'operationId':operation_id, 'commit':row[0], 'digest':row[1], 'tag':row[2], 'attemptId':row[3], 'attemptNonce':row[4], 'configDigest':row[5], 'preparationId':preparation_id}
        except BaseException:
            if self.db.in_transaction: self.db.execute('ROLLBACK')
            raise

    def finish_preparation(self, operation, staging_path=None):
        if staging_path is not None and (not isinstance(staging_path, str) or not staging_path.startswith('/') or os.path.normpath(staging_path) != staging_path or not re.fullmatch(r'servus-install-[a-f0-9]{32}', os.path.basename(staging_path))):
            raise ValueError('Invalid installation staging path')
        status = 'prepared' if staging_path is not None else 'recovery_required'
        cursor = self.db.execute("UPDATE preparations SET status=?,staging_path=CASE WHEN ?='prepared' THEN ? ELSE staging_path END WHERE operation_id=? AND status='preparing' AND attempt_id=? AND attempt_nonce=? AND preparation_id=? AND EXISTS (SELECT 1 FROM operations WHERE id=? AND status='verified' AND attempt_id=? AND attempt_nonce=? AND config_digest=?) AND (? != 'prepared' OR (NOT EXISTS (SELECT 1 FROM extraction_probes WHERE status='intent') AND EXISTS (SELECT 1 FROM extraction_probes WHERE operation_id=? AND attempt_id=? AND attempt_nonce=? AND preparation_id=? AND purpose='prepare' AND status='removed')))", (status, status, staging_path, operation['operationId'], operation['attemptId'], operation['attemptNonce'], operation['preparationId'], operation['operationId'], operation['attemptId'], operation['attemptNonce'], operation['configDigest'], status, operation['operationId'], operation['attemptId'], operation['attemptNonce'], operation['preparationId']))
        if cursor.rowcount != 1: raise RuntimeError('Unexpected preparation state')

    def preparing(self, operation_id=None, preparation_id=None, *, unstaged_only=False):
        """Return a pending claim only while its verified attempt still matches."""
        if operation_id is not None and not valid_uuid(operation_id):
            raise ValueError('Invalid operation identity')
        if preparation_id is not None and not valid_uuid(preparation_id):
            raise ValueError('Invalid preparation identity')
        query = ("SELECT o.id,o.commit_sha,o.digest,o.tag,o.attempt_id,o.attempt_nonce,o.config_digest,p.preparation_id "
                 "FROM preparations p JOIN operations o ON o.id=p.operation_id "
                 "WHERE p.status='preparing' AND o.status='verified' AND p.attempt_id=o.attempt_id "
                 "AND p.attempt_nonce=o.attempt_nonce AND o.config_digest IS NOT NULL")
        params = []
        if unstaged_only:
            query += ' AND p.staging_path IS NULL'
        if operation_id is not None:
            query += ' AND o.id=?'; params.append(operation_id)
        if preparation_id is not None:
            query += ' AND p.preparation_id=?'; params.append(preparation_id)
        rows = self.db.execute(query, params).fetchall()
        if len(rows) > 1: raise RuntimeError('Multiple preparation claims')
        if not rows: return None
        return dict(zip(('operationId','commit','digest','tag','attemptId','attemptNonce','configDigest','preparationId'), rows[0]))

    def assert_preparation(self, operation):
        if not isinstance(operation, dict): raise RuntimeError('Unexpected preparation state')
        actual = self.preparing(operation.get('operationId'), operation.get('preparationId'))
        if actual is None or actual != operation: raise RuntimeError('Unexpected preparation state')

    def stage_preparation(self, operation, staging_path):
        if (not isinstance(staging_path, str) or not staging_path.startswith('/') or
            os.path.normpath(staging_path) != staging_path or
            not re.fullmatch(r'servus-install-[a-f0-9]{32}', os.path.basename(staging_path))):
            raise ValueError('Invalid installation staging path')
        cursor = self.db.execute("UPDATE preparations SET staging_path=? WHERE operation_id=? AND status='preparing' AND staging_path IS NULL AND attempt_id=? AND attempt_nonce=? AND preparation_id=? AND EXISTS (SELECT 1 FROM operations WHERE id=? AND status='verified' AND attempt_id=? AND attempt_nonce=? AND config_digest=?) AND NOT EXISTS (SELECT 1 FROM extraction_probes WHERE status='intent') AND EXISTS (SELECT 1 FROM extraction_probes WHERE operation_id=? AND attempt_id=? AND attempt_nonce=? AND preparation_id=? AND purpose='prepare' AND status='removed')", (staging_path, operation['operationId'], operation['attemptId'], operation['attemptNonce'], operation['preparationId'], operation['operationId'], operation['attemptId'], operation['attemptNonce'], operation['configDigest'], operation['operationId'], operation['attemptId'], operation['attemptNonce'], operation['preparationId']))
        if cursor.rowcount != 1: raise RuntimeError('Unexpected preparation state')

    def staged_preparation(self, operation):
        self.assert_preparation(operation)
        row = self.db.execute("SELECT staging_path FROM preparations WHERE operation_id=? AND preparation_id=? AND status='preparing'", (operation['operationId'], operation['preparationId'])).fetchone()
        return row[0] if row else None

    def preparation_status(self, operation_id):
        row = self.db.execute('SELECT preparation_id,status FROM preparations WHERE operation_id=?', (operation_id,)).fetchone()
        return {'operationId': operation_id, 'preparationId': row[0], 'status': row[1]} if row else None

    def record_extraction_probe(self, operation, purpose):
        if purpose not in ('prepare', 'policy'):
            raise ValueError('Invalid extraction purpose')
        name = 'servus-extract-' + secrets.token_hex(16)
        self.db.execute('BEGIN IMMEDIATE')
        try:
            row = self.db.execute("SELECT 1 FROM preparations p JOIN operations o ON o.id=p.operation_id WHERE p.operation_id=? AND p.attempt_id=? AND p.attempt_nonce=? AND p.preparation_id=? AND p.status='preparing' AND o.status='verified' AND o.attempt_id=p.attempt_id AND o.attempt_nonce=p.attempt_nonce AND o.config_digest=?", (operation['operationId'], operation['attemptId'], operation['attemptNonce'], operation['preparationId'], operation['configDigest'])).fetchone()
            if row is None: raise RuntimeError('Unexpected extraction state')
            self.db.execute("INSERT INTO extraction_probes VALUES (?,?,?,?,?,?,'intent')", (name, operation['operationId'], operation['attemptId'], operation['attemptNonce'], operation['preparationId'], purpose))
            self.db.execute('COMMIT')
            return name
        except BaseException:
            if self.db.in_transaction: self.db.execute('ROLLBACK')
            raise

    def complete_extraction_probe(self, operation, name):
        cursor = self.db.execute("UPDATE extraction_probes SET status='removed' WHERE name=? AND operation_id=? AND attempt_id=? AND attempt_nonce=? AND preparation_id=? AND status='intent' AND EXISTS (SELECT 1 FROM preparations WHERE operation_id=? AND status='preparing' AND preparation_id=?)", (name, operation['operationId'], operation['attemptId'], operation['attemptNonce'], operation['preparationId'], operation['operationId'], operation['preparationId']))
        if cursor.rowcount != 1: raise RuntimeError('Unexpected extraction state')

    def pending_recoveries(self):
        rows = self.db.execute("SELECT id,attempt_id,attempt_nonce FROM operations WHERE status='recovery_required' AND attempt_id IS NOT NULL AND attempt_nonce IS NOT NULL").fetchall()
        return [{'operationId': row[0], 'attemptId': row[1], 'attemptNonce': row[2]} for row in rows]

    def submit(self, operation_id, commit, digest, tag):
        self.db.execute('BEGIN IMMEDIATE')
        try:
            if self.host_update_pending(): raise ProtocolError('recovery_required')
            row = self.db.execute('SELECT id,commit_sha,digest,tag,status,created_at FROM operations WHERE id=?', (operation_id,)).fetchone()
            if row:
                if row[1] != commit or row[2] != digest or row[3] != tag:
                    raise ProtocolError('idempotency_conflict')
            else:
                if self.db.execute("SELECT 1 FROM operations WHERE status IN ('accepted','verifying','recovery_required')").fetchone() or self.db.execute("SELECT 1 FROM preparations WHERE status IN ('preparing','prepared','recovery_required')").fetchone():
                    raise ProtocolError('operation_in_progress')
                self.db.execute("INSERT INTO operations(id,commit_sha,digest,tag,status) VALUES(?,?,?,?,'accepted')", (operation_id, commit, digest, tag))
            self.db.execute('COMMIT')
            return self.status(operation_id)
        except BaseException:
            if self.db.in_transaction: self.db.execute('ROLLBACK')
            raise

    def retry(self, operation_id):
        self.db.execute('BEGIN IMMEDIATE')
        try:
            if self.host_update_pending(): raise ProtocolError('recovery_required')
            row = self.db.execute('SELECT status FROM operations WHERE id=?', (operation_id,)).fetchone()
            if not row: raise ProtocolError('not_found')
            if row[0] == 'recovery_required':
                raise ProtocolError('recovery_required')
            if row[0] == 'verification_failed':
                if self.db.execute("SELECT 1 FROM operations WHERE id != ? AND status IN ('accepted','verifying','recovery_required')", (operation_id,)).fetchone() or self.db.execute("SELECT 1 FROM preparations WHERE status IN ('preparing','prepared','recovery_required')").fetchone():
                    raise ProtocolError('operation_in_progress')
                self.db.execute("UPDATE operations SET status='accepted' WHERE id=?", (operation_id,))
            self.db.execute('COMMIT')
            return self.status(operation_id)
        except BaseException:
            if self.db.in_transaction: self.db.execute('ROLLBACK')
            raise

    def claim(self):
        self.db.execute('BEGIN IMMEDIATE')
        try:
            if self.host_update_pending():
                self.db.execute('COMMIT')
                return None
            row = self.db.execute("SELECT id,commit_sha,digest,tag,status,created_at FROM operations WHERE status='accepted'").fetchone()
            if row:
                attempt_id, attempt_nonce = str(uuid.uuid4()), secrets.token_hex(32)
                self.db.execute("UPDATE operations SET status='verifying',attempt_id=?,attempt_nonce=? WHERE id=? AND status='accepted'", (attempt_id, attempt_nonce, row[0]))
            self.db.execute('COMMIT')
            return {**self.as_dict(row), 'attemptId':attempt_id, 'attemptNonce':attempt_nonce} if row else None
        except BaseException:
            if self.db.in_transaction: self.db.execute('ROLLBACK')
            raise

    def finish(self, operation, status, config_digest=None):
        if status not in ('verified','verification_failed','recovery_required'): raise ValueError('Invalid verification result')
        if status == 'verified':
            if not isinstance(config_digest, str) or not DIGEST_PATTERN.fullmatch(config_digest):
                raise ValueError('Invalid verified configuration digest')
        elif config_digest is not None:
            raise ValueError('Unexpected configuration digest')
        cursor = self.db.execute("UPDATE operations SET status=?,config_digest=? WHERE id=? AND status='verifying' AND attempt_id=? AND attempt_nonce=?",
                                 (status, config_digest, operation['operationId'], operation['attemptId'], operation['attemptNonce']))
        if cursor.rowcount != 1: raise RuntimeError('Unexpected verification state')

    def verified_config_digest(self, operation_id):
        row = self.db.execute("SELECT config_digest FROM operations WHERE id=? AND status='verified'", (operation_id,)).fetchone()
        if not row or not isinstance(row[0], str) or not DIGEST_PATTERN.fullmatch(row[0]):
            raise ProtocolError('not_found')
        return row[0]

    def status(self, operation_id):
        row = self.db.execute('SELECT id,commit_sha,digest,tag,status,created_at FROM operations WHERE id=?', (operation_id,)).fetchone()
        if row is None: raise ProtocolError('not_found')
        return self.as_dict(row)

    @staticmethod
    def as_dict(row):
        return dict(zip(('operationId', 'commit', 'digest', 'tag', 'status', 'createdAt'), row))


def trusted_root_file(path):
    current = pathlib.Path('/')
    for part in path.parts[1:]:
        current /= part
        info = current.lstat()
        if info.st_uid != 0 or info.st_mode & 0o022 or stat.S_ISLNK(info.st_mode):
            raise RuntimeError('Executor path is not trusted')
        if current != path and not stat.S_ISDIR(info.st_mode):
            raise RuntimeError('Executor path is not trusted')
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise RuntimeError('Executor path is not trusted')




def read_trusted_nss_file(path):
    trusted_root_file(path)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022 or info.st_nlink != 1 or info.st_size > 65536:
            raise RuntimeError('NSS configuration is not trusted')
        with os.fdopen(fd, 'rb', closefd=False) as stream:
            data = stream.read(65537)
        if len(data) > 65536:
            raise RuntimeError('NSS configuration is too large')
        try: return data.decode('utf-8')
        except UnicodeError: raise RuntimeError('NSS configuration is not supported') from None
    finally:
        os.close(fd)


def nss_sources(text):
    entries = {}
    for line in text.splitlines():
        line = line.partition('#')[0].strip()
        if not line: continue
        name, separator, value = line.partition(':')
        name = name.strip()
        if name not in ('passwd','group','initgroups','subid'): continue
        if not separator or name in entries:
            raise RuntimeError('NSS configuration is ambiguous')
        entries[name] = tuple(value.split())
    if entries.get('passwd') not in (('files',), ('files','systemd')) or entries.get('group') not in (('files',), ('files','systemd')):
        raise RuntimeError('NSS sources cannot be fully verified')
    if 'initgroups' in entries and entries['initgroups'] not in (('files',), ('files','systemd')):
        raise RuntimeError('NSS group membership source cannot be fully verified')
    if 'subid' in entries and entries['subid'] != ('files',):
        raise RuntimeError('Subordinate ID delegation source is not supported')
    return any('systemd' in value for value in entries.values())


def optional_empty_root_directory(path):
    current = pathlib.Path('/')
    for part in path.parts[1:]:
        current /= part
        try: info = current.lstat()
        except FileNotFoundError: return
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise RuntimeError('User database directory is not trusted')
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        if os.listdir(fd): raise RuntimeError('External user database records are not supported')
    finally: os.close(fd)


def assert_systemd_userdb_is_dynamic_only():
    # nss-systemd also consults drop-ins and arbitrary Varlink services. Only
    # PID 1's DynamicUser service is supported for this narrowly scoped check.
    for path in USERDB_DIRS: optional_empty_root_directory(path)
    path = SYSTEMD_USERDB
    trusted_directory(path, 0o755)
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        if os.listdir(fd) != ['io.systemd.DynamicUser']:
            raise RuntimeError('Unsupported user database services')
        info = os.stat('io.systemd.DynamicUser', dir_fd=fd, follow_symlinks=False)
        if not stat.S_ISSOCK(info.st_mode) or info.st_uid != 0:
            raise RuntimeError('DynamicUser service is not trusted')
    finally: os.close(fd)


def assert_supported_nss():
    systemd = nss_sources(read_trusted_nss_file(NSS_CONFIG))
    passwd_text = read_trusted_nss_file(NSS_PASSWD)
    group_text = read_trusted_nss_file(NSS_GROUP)
    if systemd: assert_systemd_userdb_is_dynamic_only()
    return passwd_text, group_text


def validate_local_group(gid, passwd_text, group_text):
    groups = []
    target_names = 0
    for line in group_text.splitlines():
        if not line or line.startswith('#'): continue
        fields = line.split(':')
        if len(fields) != 4 or not fields[0] or not fields[2].isdigit():
            raise RuntimeError('Local group database is malformed')
        name, _, group_id, members = fields
        if name == 'servus-verifier': target_names += 1
        if int(group_id) == gid: groups.append((name, members))
    if target_names != 1 or groups != [('servus-verifier','')]:
        raise RuntimeError('Verifier group is not unique')
    for line in passwd_text.splitlines():
        if not line or line.startswith('#'): continue
        fields = line.split(':')
        if len(fields) != 7 or not fields[0] or not fields[2].isdigit() or not fields[3].isdigit():
            raise RuntimeError('Local user database is malformed')
        if int(fields[3]) == gid:
            raise RuntimeError('Verifier group has unexpected members')


def validate_subgid_ranges(gid, text):
    for line in text.splitlines():
        if not line or line.startswith('#'): continue
        fields = line.split(':')
        if len(fields) != 3 or not fields[0] or not fields[1].isdigit() or not fields[2].isdigit():
            raise RuntimeError('Subordinate group database is malformed')
        start, count = int(fields[1]), int(fields[2])
        if count < 1 or start > 0xffffffff or count > 0x100000000 or start + count > 0x100000000:
            raise RuntimeError('Subordinate group range is invalid')
        if start <= gid < start + count:
            raise RuntimeError('Verifier group is delegated to a user namespace')


def assert_no_subgid_delegation(gid):
    try: text = read_trusted_nss_file(NSS_SUBGID)
    except FileNotFoundError:
        # The parent is checked separately; a missing file in trusted /etc is
        # acceptable only with the files backend and a trusted root operator.
        trusted_directory(NSS_SUBGID.parent, 0o755)
        return
    validate_subgid_ranges(gid, text)



def assert_host_mount_namespace():
    own_mount = os.stat('/proc/self/ns/mnt')
    init_mount = os.stat('/proc/1/ns/mnt')
    if (own_mount.st_dev, own_mount.st_ino) != (init_mount.st_dev, init_mount.st_ino):
        raise RuntimeError('Host mount namespace is required')


def assert_host_systemd():
    # A trusted root operator controls the host and its proc mount. The scan
    # establishes present observations, not a claim that a GID was never used.
    try:
        if sys.platform != 'linux' or os.geteuid() != 0:
            raise RuntimeError('Host root on Linux is required')
        for namespace, initial in (('pid', 0xEFFFFFFC), ('user', 0xEFFFFFFD)):
            for process in ('self', '1'):
                if os.stat(f'/proc/{process}/ns/{namespace}').st_ino != initial:
                    raise RuntimeError('Initial host namespaces are required')
        assert_host_mount_namespace()
        if pathlib.Path('/proc/1/comm').read_text().strip() != 'systemd':
            raise RuntimeError('Host systemd is required')
        info = pathlib.Path('/run/systemd/system').stat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise RuntimeError('Host systemd runtime is untrusted')
        mounts = []
        for line in pathlib.Path('/proc/self/mountinfo').read_text().splitlines():
            left, sep, right = line.partition(' - ')
            fields, details = left.split(), right.split()
            if sep and len(fields) >= 6 and len(details) >= 3 and fields[4] == '/proc':
                mounts.append((fields[5], details[0], details[2]))
        if len(mounts) != 1 or mounts[0][1] != 'proc' or any(
            option.startswith('hidepid=') and option != 'hidepid=0'
            for options in (mounts[0][0], mounts[0][2]) for option in options.split(',')
        ):
            raise RuntimeError('Host proc mount is unavailable or restricted')
    except OSError:
        raise RuntimeError('Cannot establish host systemd environment') from None


def scan_live_group_holders(gid, proc=PROC_ROOT):
    # Safety assumes a trusted administrator and no hostile local users.
    # An adversary intentionally racing fork/exit cannot be excluded by /proc.
    try: names = {name for name in os.listdir(proc) if name.isascii() and name.isdecimal()}
    except OSError: raise RuntimeError('Cannot enumerate processes') from None
    identities = {}
    def gone(path):
        try: os.stat(path)
        except OSError as error:
            if error.errno in (errno.ENOENT, errno.ESRCH): return True
            raise RuntimeError('Cannot inspect process task') from None
        return False

    def enumerate_ids(path, owner):
        for _ in range(3):
            try: return {name for name in os.listdir(path) if name.isascii() and name.isdecimal()}
            except OSError as error:
                if error.errno not in (errno.ENOENT, errno.ESRCH):
                    raise RuntimeError('Cannot enumerate process tasks') from None
                if gone(owner): return None
        raise RuntimeError('Process task table is incomplete')

    for name in sorted(names):
        task_dir = proc / name / 'task'
        for _ in range(10):
            tasks = enumerate_ids(task_dir, proc / name)
            if tasks is None or (tasks and name in tasks): break
            # A dying task can briefly leave an empty task directory before
            # its process entry disappears; do not accept a persistent gap.
            time.sleep(0.001)
        else: raise RuntimeError('Process task table is incomplete')
        if tasks is None: continue
        for tid in sorted(tasks):
            task_path = task_dir / tid
            disappeared = False
            for _ in range(3):
                try:
                    with open(task_path / 'status', 'rb') as stream: data = stream.read(65537)
                    with open(task_path / 'stat', 'rb') as stream: stat_data = stream.read(8193)
                    break
                except OSError as error:
                    if error.errno not in (errno.ENOENT, errno.ESRCH):
                        raise RuntimeError('Cannot read process task') from None
                    if gone(task_path):
                        disappeared = True
                        break
            else: raise RuntimeError('Process task status is incomplete')
            if disappeared:
                if not gone(task_path): raise RuntimeError('Process task identity changed during scan')
                continue
            if gone(task_path): continue
            if len(data) > 65536 or len(stat_data) > 8192: raise RuntimeError('Process status is too large')
            fields = {}
            for line in data.splitlines():
                if line.startswith((b'Gid:', b'Groups:')):
                    key, _, value = line.partition(b':')
                    if key in fields: raise RuntimeError('Process status is ambiguous')
                    tokens = value.split()
                    if any(not token.isdigit() for token in tokens): raise RuntimeError('Process status is invalid')
                    fields[key] = [int(token) for token in tokens]
            if b'Gid' not in fields or len(fields[b'Gid']) != 4 or b'Groups' not in fields:
                raise RuntimeError('Process group status is incomplete')
            if gid in fields[b'Gid'] or gid in fields[b'Groups']:
                raise RuntimeError('Verifier group is held by a live process')
            before, separator, after = stat_data.rpartition(b')')
            values = after.split()
            if not separator or not before.startswith(tid.encode() + b' (') or len(values) < 20 or not values[19].isdigit():
                raise RuntimeError('Process identity is invalid')
            identities[(name, tid)] = int(values[19])
    return identities


def assert_stable_processes_without_gid(gid):
    # A finite snapshot tolerates ordinary process exit under the trusted-host
    # boundary; it is not an atomic proof against hostile credential races.
    scan_live_group_holders(gid)

def assert_fresh_gid_provenance(gid=None):
    # Trust boundary: a trusted root supervisor controls provisioning and
    # other root processes do not race allocation. /proc cannot defeat a
    # hostile process intentionally racing fork and exit.
    directory = trusted_directory(VERIFIER_RECORD_DIR, 0o700)
    path = directory / 'verifier-group.json'
    trusted_root_file(path)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1 or info.st_size > 1024:
            raise RuntimeError('Verifier group provenance is not trusted')
        raw = os.read(fd, 1025)
        if len(raw) > 1024: raise RuntimeError('Verifier group provenance is not trusted')
        try: value = json.loads(raw.decode('utf-8'), object_pairs_hook=no_duplicate_keys)
        except (UnicodeError, ValueError): raise RuntimeError('Verifier group provenance is not trusted') from None
        if (not isinstance(value, dict) or set(value) != {'version','name','gid','nonce','state'} or
            type(value.get('version')) is not int or value['version'] != 1 or value['name'] != 'servus-verifier' or
            type(value.get('gid')) is not int or value['gid'] <= 0 or value['gid'] >= 0xffffffff or (gid is not None and value['gid'] != gid) or value['state'] != 'ready' or
            not isinstance(value.get('nonce'), str) or not re.fullmatch(r'[a-f0-9]{64}', value['nonce'])):
            raise RuntimeError('Verifier group provenance is not established')
        os.fsync(fd)
        dirfd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try: os.fsync(dirfd)
        finally: os.close(dirfd)
        return value['gid']
    finally: os.close(fd)

def fence_context():
    # The root supervisor provisions this group and directory. IPC cannot set them.
    assert_host_systemd()
    trusted_root_file(FENCE_MODULE)
    trusted_directory(FENCE_ROOT, 0o755)
    passwd_text, group_text = assert_supported_nss()
    try: group = grp.getgrnam('servus-verifier')
    except KeyError: raise RuntimeError('Verifier group is unavailable') from None
    gid = group.gr_gid
    validate_local_group(gid, passwd_text, group_text)
    # DynamicUser allocates within 61184..65519; nobody is 65534. The
    # reserved range cannot be used as a shared verifier group.
    groups = [item for item in grp.getgrall() if item.gr_gid == gid]
    if gid <= 0 or gid >= 0xffffffff or 61184 <= gid <= 65519 or gid == 65534 or len(groups) != 1 or groups[0].gr_name != 'servus-verifier' or groups[0].gr_mem or group.gr_mem or any(item.pw_gid == gid for item in pwd.getpwall()):
        raise RuntimeError('Verifier group has unexpected members')
    assert_no_subgid_delegation(gid)
    assert_stable_processes_without_gid(gid)
    assert_fresh_gid_provenance(gid)
    current = pathlib.Path('/')
    for part in FENCE_ROOT.parts[1:]:
        current /= part
        info = current.lstat()
        if not (info.st_mode & stat.S_IXOTH or (info.st_gid == gid and info.st_mode & stat.S_IXGRP)):
            raise RuntimeError('Verifier cannot traverse fence ancestry')
    spec = importlib.util.spec_from_file_location('servus_verification_fence', FENCE_MODULE)
    if spec is None or spec.loader is None: raise RuntimeError('Fence is unavailable')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module, gid


class FencePreparationRejected(RuntimeError):
    pass


def prepare_fence(operation):
    try: module, gid = fence_context()
    except (OSError, RuntimeError) as error:
        raise FencePreparationRejected('Fence was not created') from error
    try:
        module.create_operation(FENCE_ROOT, operation['operationId'], gid)
        with module.Fence(FENCE_ROOT, operation['operationId'], gid) as fence:
            fence.activate(operation['attemptId'], operation['attemptNonce'])
    except (OSError, module.FenceError) as error:
        raise RuntimeError('Fence could not be activated') from error


def revoke_fence(operation):
    assert_host_systemd()
    trusted_root_file(FENCE_MODULE)
    trusted_directory(FENCE_ROOT, 0o755)
    gid = assert_fresh_gid_provenance()
    spec = importlib.util.spec_from_file_location('servus_verification_fence', FENCE_MODULE)
    if spec is None or spec.loader is None: raise RuntimeError('Fence is unavailable')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    try:
        with module.Fence(FENCE_ROOT, operation['operationId'], gid) as fence:
            fence.revoke(operation['attemptId'], operation['attemptNonce'])
    except (OSError, module.FenceError) as error:
        raise RuntimeError('Fence could not be revoked') from error


class VerificationWorker:
    def __init__(self, journal, launcher=None, fence_prepare=None, fence_revoke=None):
        self.journal, self.launcher = journal, launcher or self.start_executor
        self.fence_prepare = fence_prepare or prepare_fence
        self.fence_revoke = fence_revoke or revoke_fence
        self.process = None
        self.output = bytearray()
        self.operation = None
        self.started = None
        self.eof = False

    @staticmethod
    def start_executor(operation, output):
        trusted_root_file(EXECUTOR)
        return subprocess.Popen([PYTHON, '-I', str(EXECUTOR), '--digest', operation['digest'], '--commit', operation['commit'], '--tag', operation['tag'], '--operation-id', operation['operationId'], '--attempt-id', operation['attemptId'], '--nonce', operation['attemptNonce']],
                                stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.DEVNULL, cwd='/', env=CLEAN_ENV, close_fds=True, start_new_session=True)

    def clear_process(self, kill=False):
        if self.process is not None:
            if kill and self.process.poll() is None:
                self.process.kill()
                try: self.process.wait(timeout=3)
                except subprocess.TimeoutExpired: pass
            if self.process.stdout is not None:
                self.process.stdout.close()
        self.process = self.operation = self.started = None
        self.output.clear()
        self.eof = False

    def finish(self, operation, status, config_digest=None):
        try:
            self.fence_revoke(operation)
        except (OSError, RuntimeError):
            status = 'recovery_required'
            config_digest = None
        self.journal.finish(operation, status, config_digest)

    def tick(self):
        if self.process is None:
            operation = self.journal.claim()
            if not operation: return
            self.operation = operation
            try:
                self.fence_prepare(operation)
                self.process = self.launcher(operation, subprocess.PIPE)
                if self.process.stdout is None: raise RuntimeError('Missing executor output')
                os.set_blocking(self.process.stdout.fileno(), False)
                self.started = time.monotonic()
            except FencePreparationRejected:
                self.clear_process()
                self.journal.finish(operation, 'verification_failed')
            except (OSError, RuntimeError):
                # A launcher exception after a process exists has an uncertain outcome.
                # Fence activation may have committed even if launch failed.
                status = 'recovery_required'
                self.clear_process(kill=True)
                self.finish(operation, status)
            return
        operation = self.operation
        try:
            if not self.eof:
                while len(self.output) <= EXECUTOR_OUTPUT_LIMIT:
                    try:
                        chunk = os.read(self.process.stdout.fileno(), min(4096, EXECUTOR_OUTPUT_LIMIT + 1 - len(self.output)))
                    except BlockingIOError:
                        break
                    if not chunk:
                        self.eof = True
                        break
                    self.output.extend(chunk)
            if len(self.output) > EXECUTOR_OUTPUT_LIMIT:
                self.clear_process(kill=True)
                self.finish(operation, 'recovery_required')
                return
            result = self.process.poll()
            if time.monotonic() - self.started >= EXECUTOR_TIMEOUT:
                self.clear_process(kill=True)
                self.finish(operation, 'recovery_required')
                return
            if result is None or not self.eof: return
            status = 'recovery_required'
            config_digest = None
            if result == 0:
                try:
                    value = json.loads(self.output.decode('utf-8'), object_pairs_hook=no_duplicate_keys)
                    candidate = value.get('configDigest') if isinstance(value, dict) else None
                    if (isinstance(candidate, str) and DIGEST_PATTERN.fullmatch(candidate) and
                        value == {'image': 'ghcr.io/raxon/servus', 'commit': operation['commit'], 'digest': operation['digest'], 'tag': operation['tag'], 'verified': True, 'configDigest': candidate} and type(value.get('verified')) is bool):
                        status = 'verified'
                        config_digest = candidate
                except (UnicodeError, ValueError, RecursionError, AttributeError): pass
            self.clear_process()
            self.finish(operation, status, config_digest)
        except OSError:
            self.clear_process(kill=True)
            self.finish(operation, 'recovery_required')

    def close(self):
        if self.process is not None:
            self.clear_process(kill=True)
            # Leave verifying durable; recovery will not infer a result.


class PreparationWorker:
    """Run a durably claimed preparation in its own systemd cgroup."""
    def __init__(self, journal, state, launcher=None, stopper=None):
        self.journal, self.state = journal, state
        self.launcher = launcher or self.start_executor
        self.stopper = stopper or (self.stop_executor if launcher is None else lambda _: None)
        self.process = self.operation = self.started = None

    def start_executor(self, operation):
        assert_host_systemd()
        trusted_root_file(PREPARATION_FENCE)
        trusted_root_file(EXECUTOR)
        spec = importlib.util.spec_from_file_location('servus_preparation_fence', PREPARATION_FENCE)
        if not spec or not spec.loader: raise RuntimeError('Preparation fence is unavailable')
        fence = importlib.util.module_from_spec(spec); spec.loader.exec_module(fence)
        executor_spec = importlib.util.spec_from_file_location('servus_preparation_environment', EXECUTOR)
        if not executor_spec or not executor_spec.loader: raise RuntimeError('Preparation environment check is unavailable')
        executor = importlib.util.module_from_spec(executor_spec); executor_spec.loader.exec_module(executor)
        if not executor.trusted_path(fence.PYTHON, executable=True, final_symlink=True) or not executor.trusted_path(fence.SYSTEMD_RUN, executable=True, final_symlink=True):
            raise RuntimeError('Preparation executables are not trusted')
        try:
            executor.check_manager_environment()
        except executor.ExecutorError as error:
            raise RuntimeError('Preparation environment is not trusted') from error
        trusted_directory(self.state / 'staging', 0o700)
        return subprocess.Popen(fence.command(self.state, operation['operationId'], operation['preparationId']),
                                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                cwd='/', env=CLEAN_ENV, close_fds=True, start_new_session=True)

    def stop_executor(self, operation):
        """Request cgroup stop; this does not reconcile daemon-side work."""
        assert_host_systemd()
        trusted_root_file(PREPARATION_FENCE)
        spec = importlib.util.spec_from_file_location('servus_preparation_fence_stop', PREPARATION_FENCE)
        if not spec or not spec.loader: raise RuntimeError('Preparation fence is unavailable')
        fence = importlib.util.module_from_spec(spec); spec.loader.exec_module(fence)
        trusted_root_file(pathlib.Path('/usr/bin/systemctl'))
        subprocess.run(['/usr/bin/systemctl', 'stop', fence.unit_name(operation['preparationId'])],
                       stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                       cwd='/', env=CLEAN_ENV, timeout=10, check=False)

    def fail(self):
        operation = self.operation
        if operation and self.journal.preparing(operation['operationId'], operation['preparationId']) == operation:
            self.journal.finish_preparation(operation)
        if operation:
            try: self.stopper(operation)
            except (OSError, RuntimeError, ValueError, subprocess.TimeoutExpired): pass
        if self.process and self.process.poll() is None:
            self.process.kill()
            try: self.process.wait(timeout=3)
            except subprocess.TimeoutExpired: pass
        self.process = self.operation = self.started = None

    def tick(self):
        if self.process is None:
            operation = self.journal.preparing(unstaged_only=True)
            if operation is None: return
            self.operation = operation
            try:
                self.process = self.launcher(operation)
                self.started = time.monotonic()
            except (OSError, RuntimeError, ValueError):
                self.fail()
            return
        result = self.process.poll()
        if result is None and time.monotonic() - self.started < 1010: return
        operation = self.operation
        # No failed or interrupted Docker request is considered reconciled.
        if result != 0:
            self.fail()
            return
        try:
            stage = self.journal.staged_preparation(operation)
            if not stage: raise RuntimeError('Preparation did not produce a stage')
            self.journal.finish_preparation(operation, stage)
        except (OSError, RuntimeError, ValueError, sqlite3.Error):
            self.fail()
            return
        self.process = self.operation = self.started = None

    def close(self):
        if self.operation is not None: self.fail()


def dispatch_apply(socket_path, operation_id):
    """Send only an operation identity to the protected root supervisor."""
    if not valid_uuid(operation_id) or not isinstance(socket_path, str) or not os.path.isabs(socket_path) or os.path.normpath(socket_path) != socket_path:
        raise RuntimeError('Invalid supervisor command')
    path = pathlib.Path(socket_path)
    trusted_directory(path.parent, 0o750)
    def request(message, timeout):
        before = path.lstat()
        if not stat.S_ISSOCK(before.st_mode) or before.st_uid != 0 or before.st_gid != 0 or stat.S_IMODE(before.st_mode) != 0o600:
            raise RuntimeError('Supervisor command socket is not trusted')
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as peer:
            peer.settimeout(timeout)
            peer.connect(socket_path)
            _pid, uid, _gid = struct.unpack('3i', peer.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize('3i')))
            after = path.lstat()
            if uid != 0 or (before.st_dev, before.st_ino) != (after.st_dev, after.st_ino):
                raise RuntimeError('Supervisor command peer is not trusted')
            peer.sendall(json.dumps(message, separators=(',', ':')).encode() + b'\n')
            return receive(peer, time.monotonic() + timeout)

    # Readiness checks are side-effect free; never retry an apply command.
    deadline = time.monotonic() + 60
    while True:
        try:
            status = request({'version': 1, 'type': 'status'}, 5)
        except (FileNotFoundError, ConnectionRefusedError, TimeoutError):
            status = {'version': 1, 'status': 'waiting'}
        if status == {'version': 1, 'status': 'ready'}:
            break
        if status != {'version': 1, 'status': 'waiting'} or time.monotonic() >= deadline:
            raise RuntimeError('Supervisor is not ready')
        time.sleep(min(0.5, max(0, deadline - time.monotonic())))
    if request({'version': 1, 'type': 'apply', 'operationId': operation_id}, 1800) != {'version': 1, 'status': 'starting'}:
        raise RuntimeError('Supervisor did not confirm startup')


class ApplyWorker:
    """Dispatch a durable request once; uncertain outcomes require recovery."""

    def __init__(self, journal, socket_path, sender=dispatch_apply):
        self.journal, self.socket_path, self.sender = journal, socket_path, sender
        self.thread = self.operation = None
        self.failure = None

    def _dispatch(self, operation_id):
        try:
            self.sender(self.socket_path, operation_id)
        except Exception:
            self.failure = True

    def tick(self):
        self.journal.db.execute("UPDATE apply_requests SET state='completed' WHERE state IN ('dispatching','awaiting_completion','recovery_required') AND EXISTS (SELECT 1 FROM update_transactions t WHERE t.operation_id=apply_requests.operation_id AND t.phase='completed')")
        self.journal.db.execute("UPDATE apply_requests SET state='recovery_required' WHERE state='awaiting_completion' AND EXISTS (SELECT 1 FROM update_transactions t WHERE t.operation_id=apply_requests.operation_id AND t.phase='recovery_required')")
        if self.thread is not None:
            if self.thread.is_alive(): return
            state = 'recovery_required' if self.failure else 'awaiting_completion'
            self.journal.db.execute("UPDATE apply_requests SET state=? WHERE operation_id=? AND state='dispatching'", (state, self.operation))
            self.thread = self.operation = None
        operation = self.journal.claim_apply_request()
        if operation is not None:
            self.operation, self.failure = operation, None
            self.thread = threading.Thread(target=self._dispatch, args=(operation,), daemon=True)
            try:
                self.thread.start()
            except RuntimeError:
                self.journal.db.execute("UPDATE apply_requests SET state='recovery_required' WHERE operation_id=? AND state='dispatching'", (operation,))
                self.thread = self.operation = None

    def close(self):
        if self.operation is not None:
            self.journal.db.execute("UPDATE apply_requests SET state='recovery_required' WHERE operation_id=? AND state='dispatching'", (self.operation,))


class DiscoveryWorker:
    """Run bounded release discovery without blocking updater requests."""

    def __init__(self, launcher=None):
        self.launcher = launcher or self._launch
        self.process = None
        self.current = None
        self.started = 0.0
        self.result = None
        self.finished = 0.0

    @staticmethod
    def _launch(current):
        trusted_root_file(DISCOVERY_EXECUTOR)
        python = pathlib.Path(PYTHON).resolve(strict=True)
        trusted_root_file(python)
        return subprocess.Popen([str(python), '-I', '-B', str(DISCOVERY_EXECUTOR), '--current', current],
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, cwd='/', env=CLEAN_ENV, close_fds=True)

    def request(self, current):
        if not isinstance(current, str) or len(current) > 64 or not TAG_PATTERN.fullmatch(current):
            raise ProtocolError('invalid_request')
        if self.process is not None:
            return {'status': 'checking'}
        if self.current == current and self.result is not None and time.monotonic() - self.finished < 30:
            return self.result
        self.current, self.result, self.started = current, None, time.monotonic()
        try:
            self.process = self.launcher(current)
        except (OSError, RuntimeError, ValueError):
            self.result, self.finished = {'status': 'unavailable'}, time.monotonic()
            return self.result
        return {'status': 'checking'}

    def tick(self):
        if self.process is None:
            return
        if self.process.poll() is None and time.monotonic() - self.started < 50:
            return
        try:
            if self.process.poll() is None:
                self.process.kill()
            output, _ = self.process.communicate(timeout=3)
            value = json.loads(output, object_pairs_hook=no_duplicate_keys) if self.process.returncode == 0 and len(output) <= 8192 else None
            if not isinstance(value, dict):
                raise ValueError()
            kind = value.get('status')
            valid_tag = lambda tag: isinstance(tag, str) and len(tag) <= 64 and TAG_PATTERN.fullmatch(tag) is not None
            if kind in ('no_newer_version', 'ahead'):
                valid = set(value) == {'status', 'current', 'latest'} and value['current'] == self.current and valid_tag(value['latest'])
            elif kind == 'release_pending':
                valid = (set(value) == {'status', 'verified', 'tag', 'commit', 'reason'} and value['verified'] is False and
                         valid_tag(value['tag']) and isinstance(value['commit'], str) and COMMIT_PATTERN.fullmatch(value['commit']) is not None and value['reason'] == 'manifest_not_available')
            elif kind == 'candidate':
                valid = (set(value) == {'status', 'verified', 'tag', 'commit', 'digest'} and value['verified'] is False and
                         valid_tag(value['tag']) and isinstance(value['commit'], str) and COMMIT_PATTERN.fullmatch(value['commit']) is not None and
                         isinstance(value['digest'], str) and DIGEST_PATTERN.fullmatch(value['digest']) is not None)
            else:
                valid = False
            self.result = value if valid else {'status': 'unavailable'}
        except (OSError, ValueError, TypeError, subprocess.SubprocessError):
            self.result = {'status': 'unavailable'}
        finally:
            self.process = None
            self.finished = time.monotonic()

    def close(self):
        if self.process is not None:
            self.process.kill()
            try: self.process.communicate(timeout=3)
            except subprocess.SubprocessError: pass
            self.process = None


def dns_journal_backup_supported():
    """Only advertise the exact reviewed snapshot reader installed on this host.

    This is an observation, not a lease across host replacement. A later host
    without the table support still fails closed when validating a snapshot.
    """
    fd = None
    try:
        trusted_root_file(DNS_JOURNAL_BACKUP)
        fd = os.open(DNS_JOURNAL_BACKUP, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
        info = os.fstat(fd); named = DNS_JOURNAL_BACKUP.lstat()
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022 or info.st_nlink != 1 or
            (info.st_dev,info.st_ino)!=(named.st_dev,named.st_ino) or info.st_size > 1048576): return False
        with os.fdopen(fd, 'rb', closefd=False) as stream: data=stream.read(1048577)
        after=os.fstat(fd); named_after=DNS_JOURNAL_BACKUP.lstat()
        if (len(data)!=info.st_size or len(data)>1048576 or
            (info.st_dev,info.st_ino,info.st_size,info.st_mtime_ns,info.st_ctime_ns)!=
            (after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns) or
            (after.st_dev,after.st_ino)!=(named_after.st_dev,named_after.st_ino)):
            return False
        return hashlib.sha256(data).hexdigest()==DNS_JOURNAL_BACKUP_SHA256
    except (OSError, RuntimeError):
        return False
    finally:
        if fd is not None: os.close(fd)


def process(journal, request, *, allow_apply=False, discovery=None):
    if not isinstance(request, dict) or request.get('version') != 1 or type(request.get('version')) is not int:
        raise ProtocolError('invalid_request')
    action = request.get('action')
    if action == 'backup_schema' and set(request) == {'version', 'action'}:
        return {'backupFileDnsJournalVersion': 1 if allow_apply and dns_journal_backup_supported() else 0}
    if action == 'discover' and set(request) == {'version', 'action', 'current'}:
        if discovery is None: raise ProtocolError('unavailable')
        return discovery.request(request['current'])
    if action == 'submit' and set(request) == {'version', 'action', 'operationId', 'commit', 'digest', 'tag'}:
        operation_id, commit, digest, tag = request['operationId'], request['commit'], request['digest'], request['tag']
        if not valid_uuid(operation_id) or not isinstance(commit, str) or not COMMIT_PATTERN.fullmatch(commit) or not isinstance(digest, str) or not DIGEST_PATTERN.fullmatch(digest) or not isinstance(tag, str) or len(tag) > 64 or not TAG_PATTERN.fullmatch(tag):
            raise ProtocolError('invalid_request')
        return journal.submit(operation_id, commit, digest, tag)
    if action == 'retry' and set(request) == {'version', 'action', 'operationId'}:
        if not valid_uuid(request['operationId']):
            raise ProtocolError('invalid_request')
        return journal.retry(request['operationId'])
    if action == 'status' and set(request) == {'version', 'action', 'operationId'}:
        if not valid_uuid(request['operationId']):
            raise ProtocolError('invalid_request')
        return journal.status(request['operationId'])
    if action == 'prepare' and set(request) == {'version', 'action', 'operationId'}:
        operation_id = request['operationId']
        if not valid_uuid(operation_id): raise ProtocolError('invalid_request')
        status = journal.preparation_status(operation_id)
        if status is None:
            journal.claim_preparation(operation_id)
            status = journal.preparation_status(operation_id)
        return status
    if action == 'apply' and set(request) == {'version', 'action', 'operationId'}:
        if not allow_apply: raise ProtocolError('unavailable')
        return journal.request_apply(request['operationId'])
    if action == 'apply_status' and set(request) == {'version', 'action', 'operationId'}:
        return journal.apply_status(request['operationId'])
    raise ProtocolError('invalid_request')


def receive(client, deadline):
    parts = bytearray()
    while len(parts) <= MAX_REQUEST:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise ProtocolError('invalid_request')
        client.settimeout(remaining)
        chunk = client.recv(min(1024, MAX_REQUEST + 1 - len(parts)))
        if not chunk:
            break
        parts.extend(chunk)
        if b'\n' in chunk:
            break
    if len(parts) > MAX_REQUEST or not parts.endswith(b'\n') or parts.count(b'\n') != 1:
        raise ProtocolError('invalid_request')
    try:
        return json.loads(parts.decode('utf-8'), object_pairs_hook=no_duplicate_keys)
    except (UnicodeError, ValueError, RecursionError):
        raise ProtocolError('invalid_request') from None


def run(state_dir, socket_dir, allowed_uid, socket_gid, launcher=None, *, supervisor_socket=None):
    if sys.platform != 'linux' or not hasattr(socket, 'SO_PEERCRED') or os.geteuid() != 0 or not sys.flags.isolated:
        raise RuntimeError('Linux with isolated root-owned updater is required')
    if allowed_uid <= 0 or socket_gid < 0:
        raise RuntimeError('An unprivileged peer UID and valid socket group are required')
    if supervisor_socket is not None and (not isinstance(supervisor_socket, str) or not os.path.isabs(supervisor_socket) or os.path.normpath(supervisor_socket) != supervisor_socket):
        raise RuntimeError('Supervisor socket path is invalid')
    state = trusted_directory(state_dir, 0o700)
    directory = trusted_directory(socket_dir, 0o710, socket_gid)
    if state == directory:
        raise RuntimeError('State and socket directories must differ')
    lock_fd = private_file(state, 'service.lock')
    try:
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('Updater is already running') from None
        journal = Journal(state)
        journal.recover()
        if not launcher:
            # Revocation can prevent a delayed unit from starting. It does not
            # prove cgroup termination; retry remains disabled on every outcome.
            for pending in journal.pending_recoveries():
                try: revoke_fence(pending)
                except (OSError, RuntimeError): pass
        worker = VerificationWorker(journal, launcher, (lambda _: None) if launcher else None, (lambda _: None) if launcher else None)
        preparation_worker = PreparationWorker(journal, state)
        apply_worker = ApplyWorker(journal, supervisor_socket) if supervisor_socket is not None else None
        discovery_worker = DiscoveryWorker() if supervisor_socket is not None else None
        socket_path = directory / 'updater.sock'
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        bound_inode = None
        try:
            try:
                info = socket_path.lstat()
            except FileNotFoundError:
                pass
            else:
                if not stat.S_ISSOCK(info.st_mode) or info.st_uid != 0:
                    raise RuntimeError('Updater socket path is unsafe')
                probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                try:
                    probe.settimeout(1)
                    probe.connect(str(socket_path))
                except ConnectionRefusedError:
                    pass
                except OSError:
                    raise RuntimeError('Cannot verify the existing updater socket') from None
                else:
                    raise RuntimeError('Updater socket is already active')
                finally:
                    probe.close()
                socket_path.unlink()
            server.bind(str(socket_path))
            bound_inode = socket_path.lstat().st_ino
            os.chown(socket_path, 0, socket_gid)
            os.chmod(socket_path, 0o660)
            server.listen(32)
            server.settimeout(0.5)
            stopping = False
            def stop(_signum, _frame):
                nonlocal stopping
                stopping = True
            signal.signal(signal.SIGTERM, stop)
            signal.signal(signal.SIGINT, stop)
            while not stopping:
                worker.tick()
                preparation_worker.tick()
                if apply_worker is not None: apply_worker.tick()
                if discovery_worker is not None: discovery_worker.tick()
                try:
                    client, _ = server.accept()
                except TimeoutError:
                    continue
                with client:
                    deadline = time.monotonic() + 2
                    try:
                        _pid, uid, _gid = struct.unpack('3i', client.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize('3i')))
                        if uid != allowed_uid:
                            raise ProtocolError('unauthorized')
                        value = process(journal, receive(client, deadline), allow_apply=apply_worker is not None, discovery=discovery_worker)
                        response = {'ok': True, 'operation': value}
                    except ProtocolError as error:
                        response = {'ok': False, 'error': error.code}
                    except (OSError, sqlite3.Error):
                        response = {'ok': False, 'error': 'unavailable'}
                    try:
                        client.sendall(json.dumps(response, separators=(',', ':')).encode() + b'\n')
                    except OSError:
                        pass
        finally:
            worker.close()
            preparation_worker.close()
            if apply_worker is not None: apply_worker.close()
            if discovery_worker is not None: discovery_worker.close()
            server.close()
            try:
                info = socket_path.lstat()
                if bound_inode is not None and stat.S_ISSOCK(info.st_mode) and info.st_ino == bound_inode:
                    socket_path.unlink()
            except FileNotFoundError:
                pass
            journal.close()
    finally:
        os.close(lock_fd)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--state-dir', required=True)
    parser.add_argument('--socket-dir', required=True)
    parser.add_argument('--peer-uid', required=True, type=int)
    parser.add_argument('--socket-gid', required=True, type=int)
    parser.add_argument('--supervisor-socket')
    args = parser.parse_args()
    os.umask(0o077)
    try:
        run(args.state_dir, args.socket_dir, args.peer_uid, args.socket_gid, supervisor_socket=args.supervisor_socket)
    except (OSError, RuntimeError, sqlite3.Error):
        print('Updater could not start with the supplied protected configuration.', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
