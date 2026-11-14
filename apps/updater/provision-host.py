#!/usr/bin/python3 -I
"""Prepare private host state for initial release verification.

Existing files and directories are verified, never silently replaced. Service
installation, policy activation, and live panel changes are separate steps.
"""
import os
import re
import secrets
import stat
import sys


class ProvisionError(Exception):
    pass


def directory(path, mode=None):
    if not isinstance(path, str) or not path.startswith('/') or os.path.normpath(path) != path:
        raise ProvisionError('Invalid directory path')
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for name in path.split('/')[1:]:
            if not name: continue
            child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd); fd = child
            info = os.fstat(fd)
            if info.st_uid != 0 or info.st_mode & 0o022: raise ProvisionError('Untrusted directory ancestry')
        info = os.fstat(fd)
        if info.st_gid != 0 or (mode is not None and stat.S_IMODE(info.st_mode) != mode):
            raise ProvisionError('Unexpected directory ownership or mode')
        return fd
    except BaseException:
        os.close(fd); raise


def child_directory(parent, name):
    if not name or name in ('.', '..') or '/' in name: raise ProvisionError('Invalid directory name')
    try: os.mkdir(name, 0o700, dir_fd=parent)
    except FileExistsError: created = False
    else: created = True
    child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
    try:
        if created:
            os.fchown(child, 0, 0); os.fchmod(child, 0o700); os.fsync(child); os.fsync(parent)
        info = os.fstat(child); named = os.stat(name, dir_fd=parent, follow_symlinks=False)
        if (info.st_uid != 0 or info.st_gid != 0 or stat.S_IMODE(info.st_mode) != 0o700 or
            (info.st_dev, info.st_ino) != (named.st_dev, named.st_ino)):
            raise ProvisionError('Unsafe private directory')
        return child
    except BaseException:
        os.close(child); raise


def publish_once(parent, name, content):
    def verify_existing():
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        try:
            info = os.fstat(fd); named = os.stat(name, dir_fd=parent, follow_symlinks=False)
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_gid != 0 or info.st_nlink != 1 or
                stat.S_IMODE(info.st_mode) != 0o600 or info.st_size != len(content) or
                (info.st_dev, info.st_ino) != (named.st_dev, named.st_ino) or os.read(fd, len(content) + 1) != content):
                raise ProvisionError('Existing configuration differs')
        finally: os.close(fd)
    temporary = '.servus-config-' + secrets.token_hex(16)
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'wb', closefd=False) as stream:
            stream.write(content); stream.flush(); os.fsync(stream.fileno())
        try: os.link(temporary, name, src_dir_fd=parent, dst_dir_fd=parent, follow_symlinks=False)
        except FileExistsError: verify_existing()
        else: os.fsync(parent)
    finally:
        os.close(fd)
        os.unlink(temporary, dir_fd=parent)
        os.fsync(parent)


def prepare(config_dir, state_dir):
    if os.geteuid() != 0: raise ProvisionError('Root is required')
    if any(not isinstance(value, str) or not value.startswith('/') or value == '/' or
           os.path.normpath(value) != value or re.fullmatch(r'/[a-zA-Z0-9._/-]+', value) is None for value in (config_dir, state_dir)):
        raise ProvisionError('Invalid configuration path')
    if state_dir == config_dir or state_dir.startswith(config_dir + '/') or config_dir.startswith(state_dir + '/'):
        raise ProvisionError('State and configuration paths overlap')
    parent_path, state_name = os.path.split(state_dir)
    config = directory(config_dir, 0o700); parent = state = None
    try:
        parent = directory(parent_path)
        state = child_directory(parent, state_name)
        for name in ('staging', 'maintenance', 'backups', 'policies', 'docker-config'):
            fd = child_directory(state, name)
            try:
                if name == 'docker-config' and os.listdir(fd):
                    raise ProvisionError('Docker configuration must be empty')
            finally: os.close(fd)
        values = {'SERVUS_UPDATER_STATE_DIR': state_dir, 'SERVUS_UPDATER_SOCKET_DIR': '/run/servus-updater/control',
                  'SERVUS_COMPONENT_UID': '1000', 'SERVUS_UPDATER_SOCKET_GID': '1000',
                  'SERVUS_SUPERVISOR_COMMAND_SOCKET': config_dir + '/supervisor-control/command'}
        content = ''.join(key + '=' + value + '\n' for key, value in values.items()).encode('ascii')
        publish_once(config, 'updater.env', content)
    finally:
        if state is not None: os.close(state)
        if parent is not None: os.close(parent)
        os.close(config)


def main():
    if sys.platform != 'linux' or os.geteuid() != 0 or not sys.flags.isolated:
        print('Host preparation requires isolated Linux root.', file=sys.stderr); return 1
    os.umask(0o077)
    try:
        prepare('/etc/servus', '/var/lib/servus-updater')
        return 0
    except (OSError, UnicodeError, ProvisionError):
        print('Updater host state could not be prepared safely.', file=sys.stderr); return 1


if __name__ == '__main__': raise SystemExit(main())
