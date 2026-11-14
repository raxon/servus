#!/usr/bin/python3 -I
"""Fence a DynamicUser verifier before it performs network verification.

The root supervisor must provision a stable per-operation lock inode and
atomically maintain the state while holding the exclusive lock. This wrapper
alone does not authorize retry or establish cgroup termination.
"""

import argparse
import fcntl
import grp
import os
import pathlib
import re
import stat
import sys

ROOT = pathlib.Path('/run/servus-updater/fences')
PYTHON = '/usr/bin/python3'
VERIFIER = '/usr/local/libexec/servus/verify-release.py'
UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
NONCE = re.compile(r'^[a-f0-9]{64}$')
DIGEST = re.compile(r'^sha256:[a-f0-9]{64}$')
COMMIT = re.compile(r'^[a-f0-9]{40}$')
TAG = re.compile(r'^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$')


class GuardError(Exception):
    pass


def directory(path, expected_gid):
    current = pathlib.Path('/')
    for part in path.parts[1:]:
        current /= part
        info = current.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise GuardError('Fence directory is not trusted')
    info = path.lstat()
    if info.st_gid != expected_gid or stat.S_IMODE(info.st_mode) != 0o710:
        raise GuardError('Fence directory is not private')
    if not hasattr(os, 'O_PATH'):
        raise GuardError('Safe path handles are unavailable')
    return os.open(path, os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW)


def checked_file(dirfd, name, expected_gid):
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=dirfd)
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_gid != expected_gid or stat.S_IMODE(info.st_mode) != 0o640 or info.st_nlink != 1:
        os.close(fd)
        raise GuardError('Fence file is not trusted')
    return fd


def lock_fence(root, operation, attempt, nonce, expected_gid):
    if not all((UUID.fullmatch(operation), UUID.fullmatch(attempt), NONCE.fullmatch(nonce))):
        raise GuardError('Invalid identity')
    if not isinstance(expected_gid, int) or expected_gid <= 0:
        raise GuardError('Invalid verifier group')
    parent = directory(root / operation, expected_gid)
    lockfd = None
    try:
        lockfd = checked_file(parent, 'lock', expected_gid)
        fcntl.flock(lockfd, fcntl.LOCK_SH)
        current = os.stat('lock', dir_fd=parent, follow_symlinks=False)
        locked = os.fstat(lockfd)
        if (current.st_dev, current.st_ino, current.st_mode, current.st_uid, current.st_gid, current.st_nlink) != (locked.st_dev, locked.st_ino, locked.st_mode, locked.st_uid, locked.st_gid, locked.st_nlink):
            raise GuardError('Fence lock identity changed')
        statefd = checked_file(parent, 'state', expected_gid)
        try:
            expected = f'{operation} {attempt} {nonce}\n'.encode('ascii')
            if os.read(statefd, len(expected) + 1) != expected:
                raise GuardError('Verification attempt is not active')
        finally:
            os.close(statefd)
        os.set_inheritable(lockfd, True)
        result = lockfd
        lockfd = None
        return result
    finally:
        if lockfd is not None:
            os.close(lockfd)
        os.close(parent)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('operation-id', 'attempt-id', 'nonce', 'digest', 'commit', 'tag'):
        parser.add_argument('--' + name, required=True)
    args = parser.parse_args()
    try:
        if not sys.flags.isolated or not DIGEST.fullmatch(args.digest) or not COMMIT.fullmatch(args.commit) or len(args.tag) > 64 or not TAG.fullmatch(args.tag):
            raise GuardError('Invalid verifier request')
        try:
            verifier_gid = grp.getgrnam('servus-verifier').gr_gid
        except KeyError:
            raise GuardError('Verifier group is not configured') from None
        lock_fence(ROOT, args.operation_id, args.attempt_id, args.nonce, verifier_gid)
        os.execve(PYTHON, [PYTHON, '-I', VERIFIER, '--digest', args.digest, '--commit', args.commit, '--tag', args.tag, '--include-config-digest'], {'PATH':'/usr/bin:/bin','LANG':'C','LC_ALL':'C'})
    except (GuardError, OSError):
        print('Verification attempt was not authorized.', file=sys.stderr)
        return 1
    return 1


if __name__ == '__main__':
    raise SystemExit(main())
