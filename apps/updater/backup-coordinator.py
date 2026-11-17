#!/usr/bin/env python3
"""Fixture-only backup coordinator simulation; never performs or authorizes a backup."""

import fcntl
import os
import pathlib
import re
import sqlite3
import stat
import sys

ID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
FIXTURE = re.compile(r'^servus-backup-fixture-[0-9a-f]{32}$')
MARKER = b'servus-backup-coordinator-fixture-v1\n'


class CoordinatorError(Exception):
    pass


def private_file(directory_fd, name, create=False):
    flags = os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK
    if create:
        flags |= os.O_CREAT
    fd = os.open(name, flags, 0o600, dir_fd=directory_fd)
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o600:
        os.close(fd)
        raise CoordinatorError('Unsafe fixture file')
    return fd


def open_fixture(path):
    if sys.platform != 'linux' or os.geteuid() != 0:
        raise CoordinatorError('An isolated root Linux fixture is required')
    value = pathlib.PurePosixPath(path)
    if not value.is_absolute() or value.parent != pathlib.PurePosixPath('/tmp') or not FIXTURE.fullmatch(value.name) or str(value) != str(path):
        raise CoordinatorError('Only a named /tmp fixture is supported')
    tmp = os.open('/tmp', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        info = os.fstat(tmp)
        if info.st_uid != 0 or not info.st_mode & stat.S_ISVTX:
            raise CoordinatorError('Unsafe temporary directory')
        fd = os.open(value.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=tmp)
    finally:
        os.close(tmp)
    try:
        info = os.fstat(fd)
        if info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o700:
            raise CoordinatorError('Unsafe fixture directory')
        marker = private_file(fd, '.fixture')
        try:
            if os.read(marker, len(MARKER) + 1) != MARKER:
                raise CoordinatorError('Invalid fixture marker')
        finally:
            os.close(marker)
        return fd
    except BaseException:
        os.close(fd)
        raise


class Coordinator:
    def __init__(self, fixture):
        self.directory = open_fixture(fixture)
        self.lock = None
        self.db = None
        try:
            self.lock = private_file(self.directory, 'coordinator.lock', True)
            try:
                fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise CoordinatorError('Another fixture coordinator is running') from None
            db_fd = private_file(self.directory, 'journal.sqlite', True)
            os.close(db_fd)
            # The root-owned 0700 directory excludes untrusted path replacement.
            self.db = sqlite3.connect(f'/proc/self/fd/{self.directory}/journal.sqlite', isolation_level=None, timeout=2)
            self.db.execute('PRAGMA journal_mode=WAL')
            self.db.execute('PRAGMA synchronous=FULL')
            self.db.execute("CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, state TEXT NOT NULL CHECK(state IN ('requested','awaiting_quiescence','blocked')), reason TEXT NOT NULL CHECK(reason IN ('none','quiescence_unverified')), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)")
            self.db.execute("CREATE UNIQUE INDEX IF NOT EXISTS one_pending ON operations ((1)) WHERE state IN ('requested','awaiting_quiescence')")
            os.fsync(self.directory)
        except BaseException:
            self.close()
            raise

    def close(self):
        if self.db is not None:
            self.db.close()
            self.db = None
        if self.lock is not None:
            os.close(self.lock)
            self.lock = None
        if self.directory is not None:
            os.close(self.directory)
            self.directory = None

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()

    def submit(self, operation_id):
        if not isinstance(operation_id, str) or not ID.fullmatch(operation_id):
            raise CoordinatorError('Invalid operation identity')
        self.db.execute('BEGIN IMMEDIATE')
        try:
            row = self.db.execute('SELECT id,state,reason FROM operations WHERE id=?', (operation_id,)).fetchone()
            if row is None:
                if self.db.execute("SELECT 1 FROM operations WHERE state IN ('requested','awaiting_quiescence')").fetchone():
                    raise CoordinatorError('Another operation is active')
                self.db.execute("INSERT INTO operations(id,state,reason) VALUES(?,'requested','none')", (operation_id,))
                row = (operation_id, 'requested', 'none')
            self.db.execute('COMMIT')
            return dict(zip(('operationId', 'state', 'reason'), row))
        except BaseException:
            self.db.execute('ROLLBACK')
            raise

    def advance(self, operation_id):
        if not isinstance(operation_id, str) or not ID.fullmatch(operation_id):
            raise CoordinatorError('Invalid operation identity')
        self.db.execute('BEGIN IMMEDIATE')
        try:
            row = self.db.execute('SELECT state FROM operations WHERE id=?', (operation_id,)).fetchone()
            if row is None:
                raise CoordinatorError('Unknown operation')
            if row[0] == 'requested':
                self.db.execute("UPDATE operations SET state='awaiting_quiescence' WHERE id=?", (operation_id,))
            elif row[0] == 'awaiting_quiescence':
                # No production verifier exists; external claims cannot authorize capture.
                self.db.execute("UPDATE operations SET state='blocked',reason='quiescence_unverified' WHERE id=?", (operation_id,))
            self.db.execute('COMMIT')
        except BaseException:
            self.db.execute('ROLLBACK')
            raise
        return self.status(operation_id)

    def status(self, operation_id):
        if not isinstance(operation_id, str) or not ID.fullmatch(operation_id):
            raise CoordinatorError('Invalid operation identity')
        row = self.db.execute('SELECT id,state,reason FROM operations WHERE id=?', (operation_id,)).fetchone()
        if row is None:
            raise CoordinatorError('Unknown operation')
        return dict(zip(('operationId', 'state', 'reason'), row))
