#!/usr/bin/python3 -I
"""Operator entry point for a stopped pre-switch policy recovery."""
import argparse
import hashlib
import importlib.util
import os
import pathlib
import re
import sqlite3
import stat
import sys


def trusted_directory(path, mode=None):
    path = pathlib.Path(path)
    if not path.is_absolute() or '..' in path.parts:
        raise RuntimeError('Invalid protected directory')
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in path.parts[1:]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd); fd = child
            info = os.fstat(fd)
            if info.st_uid != 0 or info.st_mode & 0o022:
                raise RuntimeError('Untrusted directory')
        if mode is not None and stat.S_IMODE(os.fstat(fd).st_mode) != mode:
            raise RuntimeError('Unexpected protected directory mode')
        return fd
    except BaseException:
        os.close(fd)
        raise


def trusted_file(parent, name, mode):
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
    info = os.fstat(fd)
    named = os.stat(name, dir_fd=parent, follow_symlinks=False)
    if (not stat.S_ISREG(info.st_mode) or (info.st_uid, info.st_gid, info.st_nlink, stat.S_IMODE(info.st_mode)) != (0, 0, 1, mode) or
            (info.st_dev, info.st_ino) != (named.st_dev, named.st_ino)):
        os.close(fd)
        raise RuntimeError('Untrusted recovery file')
    return fd


def load_module(directory, name):
    fd = trusted_file(directory, name, 0o644)
    try:
        path = '/proc/self/fd/' + str(fd)
        spec = importlib.util.spec_from_file_location(name.replace('-', '_').replace('.', '_'), path)
        # The descriptor path has no .py extension, so explicitly choose a loader.
        if spec is None:
            from importlib.machinery import SourceFileLoader
            loader = SourceFileLoader(name.replace('-', '_').replace('.', '_'), path)
            spec = importlib.util.spec_from_loader(loader.name, loader)
        if spec is None or spec.loader is None:
            raise RuntimeError('Recovery module is unavailable')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    finally:
        os.close(fd)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--operation', required=True)
    parser.add_argument('--fixed-updater-sha256', required=True)
    args = parser.parse_args()
    if sys.platform != 'linux' or os.geteuid() != 0 or not sys.flags.isolated:
        raise RuntimeError('Isolated Linux root is required')
    if not re.fullmatch(r'[a-f0-9]{64}', args.fixed_updater_sha256):
        raise RuntimeError('Invalid updater checksum')
    base = state = install = policies = binary_dir = None
    try:
        base = trusted_directory(str(pathlib.Path(__file__).resolve().parent), 0o700)
        journal = load_module(base, 'reconcile-policy-journal.py')
        fence = load_module(base, 'reconcile-policy-fence.py')
        state = trusted_directory('/var/lib/servus-updater', 0o700)
        install = trusted_directory('/opt/servus', 0o700)
        policies = trusted_directory('/var/lib/servus-updater/policies', 0o700)
        binary_dir = trusted_directory('/usr/local/libexec/servus', 0o755)
        def verify_fixed_updater():
            binary = trusted_file(binary_dir, 'servus-updater.py', 0o755)
            try:
                with os.fdopen(os.dup(binary), 'rb') as stream:
                    digest = hashlib.file_digest(stream, 'sha256').hexdigest()
            finally:
                os.close(binary)
            if digest != args.fixed_updater_sha256:
                raise RuntimeError('Corrected updater is not installed')
        db_fd = trusted_file(state, 'journal.sqlite', 0o600)
        os.close(db_fd)
        db = sqlite3.connect('/proc/self/fd/' + str(state) + '/journal.sqlite', isolation_level=None, timeout=2)
        try:
            fence.fenced_reconcile(db, args.operation, state, install, policies, state, journal, preflight=verify_fixed_updater)
        finally:
            db.close()
    finally:
        for fd in (binary_dir, policies, install, state, base):
            if fd is not None: os.close(fd)
    print('Policy recovery was queued; start the supervisor before the updater.')


if __name__ == '__main__':
    try:
        main()
    except (OSError, sqlite3.Error, RuntimeError, ValueError) as error:
        print('Policy recovery failed: ' + type(error).__name__, file=sys.stderr)
        sys.exit(1)
