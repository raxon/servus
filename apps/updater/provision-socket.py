#!/usr/bin/python3 -I
"""Create the root-owned updater socket directory without replacing an existing inode."""
import argparse
import os
import stat
import sys


class ProvisionError(Exception):
    pass


def prepare(run_dir, group):
    if os.geteuid() != 0 or type(group) is not int or not 0 < group < 0xffffffff:
        raise ProvisionError('Invalid socket provisioning request')
    if not isinstance(run_dir, str) or not run_dir.startswith('/') or os.path.normpath(run_dir) != run_dir:
        raise ProvisionError('Invalid runtime path')
    parent = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for name in run_dir.split('/')[1:]:
            if not name: continue
            child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
            os.close(parent); parent = child
            info = os.fstat(parent)
            if info.st_uid != 0 or info.st_mode & 0o022:
                raise ProvisionError('Untrusted runtime ancestor')
        for name, mode, gid in (('servus-updater', 0o755, 0), ('control', 0o710, group)):
            try:
                os.mkdir(name, mode, dir_fd=parent)
            except FileExistsError:
                created = False
            else:
                created = True
            child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
            try:
                if created:
                    os.fchown(child, 0, gid); os.fchmod(child, mode); os.fsync(child); os.fsync(parent)
                info = os.fstat(child)
                named = os.stat(name, dir_fd=parent, follow_symlinks=False)
                if (not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_gid != gid or
                    stat.S_IMODE(info.st_mode) != mode or (info.st_dev, info.st_ino) != (named.st_dev, named.st_ino)):
                    raise ProvisionError('Unsafe updater socket directory')
            except BaseException:
                os.close(child); raise
            os.close(parent); parent = child
    finally:
        os.close(parent)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--socket-gid', required=True, type=int)
    args = parser.parse_args()
    os.umask(0o077)
    try:
        prepare('/run', args.socket_gid)
    except (OSError, ProvisionError):
        print('Updater socket directory could not be prepared safely.', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
