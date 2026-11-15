#!/usr/bin/python3 -I
"""Read host modules from a previously verified private release tree.

This is an integrity primitive, not an authorization or installation step.
The root coordinator must bind the supplied manifest and directory to the
verified image and the active update journal before using the returned bytes.
"""
import hashlib
import os
import re
import stat

NAME = re.compile(r'^[a-z0-9][a-z0-9-]{0,63}\.py$')
MAX_MODULE = 4 * 1024 * 1024
MAX_TOTAL = 16 * 1024 * 1024
MAX_MODULES = 128


class HostBundleError(Exception):
    pass


def _directory(parent, name, device):
    fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent)
    try:
        current = os.stat(name, dir_fd=parent, follow_symlinks=False)
        info = os.fstat(fd)
        if (not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_gid != 0 or
            stat.S_IMODE(info.st_mode) != 0o755 or info.st_dev != device or
            (info.st_dev, info.st_ino) != (current.st_dev, current.st_ino)):
            raise HostBundleError('Unsafe module directory')
        return fd
    except BaseException:
        os.close(fd)
        raise


def _read_module(directory, name, expected, device):
    mode, size, digest = expected
    if (type(mode) is not int or mode not in (0o644, 0o755) or type(size) is not int or
        not 0 <= size <= MAX_MODULE or not isinstance(digest, str) or not re.fullmatch(r'[a-f0-9]{64}', digest)):
        raise HostBundleError('Invalid module manifest')
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=directory)
    try:
        before = os.fstat(fd)
        named = os.stat(name, dir_fd=directory, follow_symlinks=False)
        if (not stat.S_ISREG(before.st_mode) or before.st_uid != 0 or before.st_gid != 0 or
            before.st_dev != device or before.st_nlink != 1 or stat.S_IMODE(before.st_mode) != mode or
            before.st_size != size or (before.st_dev, before.st_ino) != (named.st_dev, named.st_ino)):
            raise HostBundleError('Unsafe module file')
        chunks = bytearray()
        while len(chunks) <= size:
            chunk = os.read(fd, min(65536, size + 1 - len(chunks)))
            if not chunk:
                break
            chunks.extend(chunk)
        after = os.fstat(fd)
        named = os.stat(name, dir_fd=directory, follow_symlinks=False)
        identity = lambda value: (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns)
        if (len(chunks) != size or identity(before) != identity(after) or
            (named.st_dev, named.st_ino) != (before.st_dev, before.st_ino) or
            hashlib.sha256(chunks).hexdigest() != digest):
            raise HostBundleError('Module changed or differs from its manifest')
        return mode, bytes(chunks)
    finally:
        os.close(fd)


def collect(stage_fd, manifest, required):
    """Return validated module bytes without executing or installing them."""
    info = os.fstat(stage_fd)
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_gid != 0 or
        stat.S_IMODE(info.st_mode) != 0o700 or not isinstance(manifest, dict) or
        not isinstance(required, (tuple, list)) or not required or
        any(not isinstance(name, str) or not NAME.fullmatch(name) for name in required) or
        len(set(required)) != len(required)):
        raise HostBundleError('Invalid host bundle input')
    prefix = 'apps/updater/'
    selected = {path[len(prefix):]: value for path, value in manifest.items()
                if isinstance(path, str) and path.startswith(prefix)}
    if (not 1 <= len(selected) <= MAX_MODULES or
        any(not NAME.fullmatch(name) for name in selected) or not set(required).issubset(selected)):
        raise HostBundleError('Incomplete or invalid host bundle')
    apps = updater = None
    try:
        apps = _directory(stage_fd, 'apps', info.st_dev)
        updater = _directory(apps, 'updater', info.st_dev)
        result = {}
        total = 0
        for name in sorted(selected):
            expected = selected[name]
            if not isinstance(expected, tuple) or len(expected) != 3:
                raise HostBundleError('Invalid module manifest')
            mode, content = _read_module(updater, name, expected, info.st_dev)
            total += len(content)
            if total > MAX_TOTAL:
                raise HostBundleError('Host bundle is too large')
            result[name] = (mode, content)
        return result
    finally:
        if updater is not None:
            os.close(updater)
        if apps is not None:
            os.close(apps)
