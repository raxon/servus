#!/usr/bin/python3 -I
"""Verify requested releases; applying updates requires a separate supervisor."""

import argparse
import errno
import fcntl
import grp
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
import time

MAX_REQUEST = 4096
EXECUTOR = pathlib.Path('/usr/local/libexec/servus/verification-executor.py')
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
            elif table and version not in (2, 3, 4):
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
            self.db.execute('PRAGMA user_version=4')
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

    def pending_recoveries(self):
        rows = self.db.execute("SELECT id,attempt_id,attempt_nonce FROM operations WHERE status='recovery_required' AND attempt_id IS NOT NULL AND attempt_nonce IS NOT NULL").fetchall()
        return [{'operationId': row[0], 'attemptId': row[1], 'attemptNonce': row[2]} for row in rows]

    def submit(self, operation_id, commit, digest, tag):
        self.db.execute('BEGIN IMMEDIATE')
        try:
            row = self.db.execute('SELECT id,commit_sha,digest,tag,status,created_at FROM operations WHERE id=?', (operation_id,)).fetchone()
            if row:
                if row[1] != commit or row[2] != digest or row[3] != tag:
                    raise ProtocolError('idempotency_conflict')
            else:
                if self.db.execute("SELECT 1 FROM operations WHERE status IN ('accepted','verifying','recovery_required')").fetchone():
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
            row = self.db.execute('SELECT status FROM operations WHERE id=?', (operation_id,)).fetchone()
            if not row: raise ProtocolError('not_found')
            if row[0] == 'recovery_required':
                raise ProtocolError('recovery_required')
            if row[0] == 'verification_failed':
                if self.db.execute("SELECT 1 FROM operations WHERE id != ? AND status IN ('accepted','verifying','recovery_required')", (operation_id,)).fetchone():
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


def process(journal, request):
    if not isinstance(request, dict) or request.get('version') != 1 or type(request.get('version')) is not int:
        raise ProtocolError('invalid_request')
    action = request.get('action')
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


def run(state_dir, socket_dir, allowed_uid, socket_gid, launcher=None):
    if sys.platform != 'linux' or not hasattr(socket, 'SO_PEERCRED') or os.geteuid() != 0 or not sys.flags.isolated:
        raise RuntimeError('Linux with isolated root-owned updater is required')
    if allowed_uid <= 0 or socket_gid < 0:
        raise RuntimeError('An unprivileged peer UID and valid socket group are required')
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
                        value = process(journal, receive(client, deadline))
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
    args = parser.parse_args()
    os.umask(0o077)
    try:
        run(args.state_dir, args.socket_dir, args.peer_uid, args.socket_gid)
    except (OSError, RuntimeError, sqlite3.Error):
        print('Updater could not start with the supplied protected configuration.', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
