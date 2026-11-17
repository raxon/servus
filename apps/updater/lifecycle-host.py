#!/usr/bin/python3 -I
"""Fixture-only host lifecycle state; no production recovery is authorized.

The lock inode is never replaced. Transition back to normal is intentionally
unavailable until a supervisor can prove drain, exclusive ownership and recovery.
"""

import fcntl
import os
import re
import stat
import sys

NAME = re.compile(r'^servus-lifecycle-fixture-[a-f0-9]{32}$')
NORMAL = b'servus-lifecycle-v1 normal\n'
MAINTENANCE = b'servus-lifecycle-v1 maintenance\n'


class LifecycleError(Exception):
    pass


def _regular(fd, mode):
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_gid != 0 or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != mode:
        raise LifecycleError('Unsafe lifecycle file')
    return info


def _open_file(directory, name, mode):
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=directory)
    try:
        info = _regular(fd, mode)
        current = os.stat(name, dir_fd=directory, follow_symlinks=False)
        if (info.st_dev, info.st_ino) != (current.st_dev, current.st_ino):
            raise LifecycleError('Lifecycle file changed')
        return fd
    except BaseException:
        os.close(fd)
        raise


def _create_file(directory, name, value, mode):
    fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, mode, dir_fd=directory)
    try:
        os.fchmod(fd, mode)
        _regular(fd, mode)
        with os.fdopen(fd, 'wb', closefd=False) as stream:
            stream.write(value)
            stream.flush()
            os.fsync(fd)
    finally:
        os.close(fd)


def _tmp_directory():
    if sys.platform != 'linux' or os.geteuid() != 0:
        raise LifecycleError('A root Linux fixture is required')
    fd = os.open('/tmp', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    info = os.fstat(fd)
    if info.st_uid != 0 or not info.st_mode & stat.S_ISVTX:
        os.close(fd)
        raise LifecycleError('Unsafe fixture parent')
    return fd


def _name(name):
    if not isinstance(name, str) or not NAME.fullmatch(name):
        raise LifecycleError('Only an isolated fixture is supported')


def initialize(name):
    """Create a new fixture only; an existing directory is never adopted."""
    _name(name)
    parent = _tmp_directory()
    try:
        os.mkdir(name, 0o755, dir_fd=parent)
        os.fsync(parent)
        directory = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent)
        try:
            os.fchmod(directory, 0o755)
            _create_file(directory, 'lock', b'', 0o644)
            _create_file(directory, 'state', NORMAL, 0o644)
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        os.close(parent)


class FixtureGate:
    def __init__(self, name):
        _name(name)
        parent = _tmp_directory()
        try:
            self.directory = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent)
        finally:
            os.close(parent)
        self.lock = None
        try:
            info = os.fstat(self.directory)
            if info.st_uid != 0 or info.st_gid != 0 or stat.S_IMODE(info.st_mode) != 0o755:
                raise LifecycleError('Unsafe fixture directory')
            self.lock = _open_file(self.directory, 'lock', 0o644)
            self.read_state()
        except BaseException:
            if self.lock is not None:
                os.close(self.lock)
            os.close(self.directory)
            raise

    def close(self):
        os.close(self.lock)
        os.close(self.directory)

    def read_state(self):
        fd = _open_file(self.directory, 'state', 0o644)
        try:
            value = os.read(fd, 128)
            if value not in (NORMAL, MAINTENANCE):
                raise LifecycleError('Unknown lifecycle state')
            return value
        finally:
            os.close(fd)

    def enter_maintenance(self):
        """Stop new cooperating starts; this does not establish quiescence."""
        # The root supervisor is trusted and must serialize all state writers.
        state_fd = _open_file(self.directory, 'state', 0o644)
        try:
            state = os.read(state_fd, 128)
            if state not in (NORMAL, MAINTENANCE):
                raise LifecycleError('Unknown lifecycle state')
            if state == MAINTENANCE:
                # An earlier process may have died after rename but before
                # syncing the directory. Make the observed transition durable.
                os.fsync(state_fd)
                held = os.fstat(state_fd)
                current = os.stat('state', dir_fd=self.directory, follow_symlinks=False)
                if (held.st_dev, held.st_ino) != (current.st_dev, current.st_ino):
                    raise LifecycleError('Lifecycle state changed')
                os.fsync(self.directory)
                current = os.stat('state', dir_fd=self.directory, follow_symlinks=False)
                if (held.st_dev, held.st_ino) != (current.st_dev, current.st_ino):
                    raise LifecycleError('Lifecycle state changed')
                return
        finally:
            os.close(state_fd)
        candidate = '.state-' + os.urandom(16).hex()
        try:
            _create_file(self.directory, candidate, MAINTENANCE, 0o644)
            os.replace(candidate, 'state', src_dir_fd=self.directory, dst_dir_fd=self.directory)
            os.fsync(self.directory)
        finally:
            try:
                os.unlink(candidate, dir_fd=self.directory)
            except FileNotFoundError:
                pass

    def exclusive_available(self):
        """Report only this lock's availability, not a proof of safe backup."""
        try:
            fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return False
        try:
            held = os.fstat(self.lock)
            current = os.stat('lock', dir_fd=self.directory, follow_symlinks=False)
            if (held.st_dev, held.st_ino) != (current.st_dev, current.st_ino):
                raise LifecycleError('Lifecycle lock changed')
            _regular(self.lock, 0o644)
            return True
        finally:
            fcntl.flock(self.lock, fcntl.LOCK_UN)
