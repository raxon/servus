#!/usr/bin/python3 -I
"""Atomically exchange two root-owned host runtime directories on Linux.

The caller must independently authorize the exact inodes, hold installation
and updater locks, fence all users of both trees, and journal recovery before
calling. This primitive neither stops services nor decides whether to roll back.
"""
import ctypes
import os
import re
import stat
import sys

NAME = re.compile(r'^[a-z0-9][a-z0-9-]{0,127}$')
RENAME_EXCHANGE = 2


class HostExchangeError(Exception):
    pass


def _parent(fd):
    info = os.fstat(fd)
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_gid != 0 or
        stat.S_IMODE(info.st_mode) not in (0o700, 0o755)):
        raise HostExchangeError('Unsafe exchange parent')
    return info


def identity(parent_fd, name):
    """Read a root-owned runtime directory identity without following links."""
    parent = _parent(parent_fd)
    if not isinstance(name, str) or not NAME.fullmatch(name):
        raise HostExchangeError('Invalid runtime directory name')
    fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent_fd)
    try:
        info = os.fstat(fd)
        named = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
        if (not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_gid != 0 or
            stat.S_IMODE(info.st_mode) != 0o755 or info.st_dev != parent.st_dev or
            (info.st_dev, info.st_ino) != (named.st_dev, named.st_ino)):
            raise HostExchangeError('Unsafe runtime directory')
        return info.st_dev, info.st_ino
    finally:
        os.close(fd)


def exchange(active_parent, active_name, candidate_parent, candidate_name, expected_active, expected_candidate):
    """Swap exactly the supplied identities; an interrupted caller must reconcile."""
    if sys.platform != 'linux' or os.geteuid() != 0 or not sys.flags.isolated:
        raise HostExchangeError('An isolated Linux root coordinator is required')
    if (not isinstance(expected_active, tuple) or not isinstance(expected_candidate, tuple) or
        len(expected_active) != 2 or len(expected_candidate) != 2 or
        any(type(value) is not int or value <= 0 for value in expected_active + expected_candidate) or
        expected_active == expected_candidate):
        raise HostExchangeError('Invalid runtime identities')
    left, right = _parent(active_parent), _parent(candidate_parent)
    if left.st_dev != right.st_dev:
        raise HostExchangeError('Runtime directories must share a filesystem')
    if identity(active_parent, active_name) != expected_active or identity(candidate_parent, candidate_name) != expected_candidate:
        raise HostExchangeError('Runtime directory identity changed')
    libc = ctypes.CDLL(None, use_errno=True)
    rename = getattr(libc, 'renameat2', None)
    if rename is None:
        raise HostExchangeError('Atomic exchange is unavailable')
    rename.argtypes = (ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint)
    rename.restype = ctypes.c_int
    if rename(active_parent, os.fsencode(active_name), candidate_parent, os.fsencode(candidate_name), RENAME_EXCHANGE) != 0:
        number = ctypes.get_errno()
        raise OSError(number, os.strerror(number))
    os.fsync(active_parent)
    if (left.st_dev, left.st_ino) != (right.st_dev, right.st_ino):
        os.fsync(candidate_parent)
    if identity(active_parent, active_name) != expected_candidate or identity(candidate_parent, candidate_name) != expected_active:
        raise HostExchangeError('Runtime exchange outcome requires recovery')
