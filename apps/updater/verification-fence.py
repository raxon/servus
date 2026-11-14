#!/usr/bin/python3 -I
"""Root-owned per-operation fencing primitives.

Callers must serialize journal transitions and cgroup recovery separately.
Changing this fence does not by itself prove a systemd cgroup has stopped.
"""

import fcntl
import os
import pathlib
import re
import secrets
import stat

UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
NONCE = re.compile(r'^[a-f0-9]{64}$')


class FenceError(Exception):
    pass


def trusted_directory(path):
    path = pathlib.Path(path)
    if not path.is_absolute(): raise FenceError('Fence root is not absolute')
    current = pathlib.Path('/')
    for part in path.parts[1:]:
        current /= part
        info = current.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise FenceError('Fence directory is not trusted')
    return os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)


def trusted_file(dirfd, name, expected_gid):
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=dirfd)
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_gid != expected_gid or stat.S_IMODE(info.st_mode) != 0o640 or info.st_nlink != 1:
        os.close(fd)
        raise FenceError('Fence file is not trusted')
    return fd


def create_operation(root, operation, expected_gid):
    if os.geteuid() != 0 or not UUID.fullmatch(operation) or not isinstance(expected_gid, int) or expected_gid <= 0: raise FenceError('Invalid fence request')
    parent = trusted_directory(root)
    try:
        os.mkdir(operation, 0o710, dir_fd=parent)
        os.fsync(parent)
        child = os.open(operation, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
        try:
            os.fchown(child, 0, expected_gid)
            os.fchmod(child, 0o710)
            for name, contents in [('lock', b''), ('state', b'revoked\n')]:
                fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o640, dir_fd=child)
                try:
                    os.fchown(fd, 0, expected_gid)
                    os.fchmod(fd, 0o640)
                    os.write(fd, contents)
                    os.fsync(fd)
                finally:
                    os.close(fd)
            os.fsync(child)
        finally:
            os.close(child)
    finally:
        os.close(parent)


class Fence:
    def __init__(self, root, operation, expected_gid):
        if os.geteuid() != 0 or not UUID.fullmatch(operation) or not isinstance(expected_gid, int) or expected_gid <= 0: raise FenceError('Invalid fence request')
        self.operation = operation
        self.expected_gid = expected_gid
        self.dir = trusted_directory(pathlib.Path(root) / operation)
        self.lock = None
        try:
            directory_info = os.fstat(self.dir)
            if directory_info.st_gid != expected_gid or stat.S_IMODE(directory_info.st_mode) != 0o710:
                raise FenceError('Fence directory is not private')
            self.lock = trusted_file(self.dir, 'lock', expected_gid)
            fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.check_lock()
        except BaseException:
            self.close()
            raise

    def check_lock(self):
        current = os.stat('lock', dir_fd=self.dir, follow_symlinks=False)
        held = os.fstat(self.lock)
        if (current.st_dev, current.st_ino, current.st_mode, current.st_uid, current.st_gid, current.st_nlink) != (held.st_dev, held.st_ino, held.st_mode, held.st_uid, held.st_gid, held.st_nlink):
            raise FenceError('Fence lock identity changed')

    def read_state(self):
        state = trusted_file(self.dir, 'state', self.expected_gid)
        try:
            value = os.read(state, 200)
            if len(value) >= 200: raise FenceError('Fence state is invalid')
            return value
        finally:
            os.close(state)

    def replace_state(self, expected, value):
        self.check_lock()
        if self.read_state() != expected: raise FenceError('Fence state changed')
        name = '.state-' + secrets.token_hex(16)
        fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o640, dir_fd=self.dir)
        try:
            os.fchown(fd, 0, self.expected_gid)
            os.fchmod(fd, 0o640)
            os.write(fd, value)
            os.fsync(fd)
            self.check_lock()
            os.rename(name, 'state', src_dir_fd=self.dir, dst_dir_fd=self.dir)
            os.fsync(self.dir)
        finally:
            os.close(fd)
            try: os.unlink(name, dir_fd=self.dir)
            except FileNotFoundError: pass

    def activate(self, attempt, nonce):
        if not UUID.fullmatch(attempt) or not NONCE.fullmatch(nonce): raise FenceError('Invalid fence request')
        self.replace_state(b'revoked\n', f'{self.operation} {attempt} {nonce}\n'.encode('ascii'))

    def revoke(self, attempt, nonce):
        if not UUID.fullmatch(attempt) or not NONCE.fullmatch(nonce): raise FenceError('Invalid fence request')
        self.replace_state(f'{self.operation} {attempt} {nonce}\n'.encode('ascii'), b'revoked\n')

    def close(self):
        if self.lock is not None: os.close(self.lock); self.lock = None
        if self.dir is not None: os.close(self.dir); self.dir = None

    def __enter__(self): return self
    def __exit__(self, *_): self.close()
