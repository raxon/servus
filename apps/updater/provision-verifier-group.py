#!/usr/bin/python3 -I
"""Provision a non-reused verifier GID under the trusted-root host model.

This does not defend against hostile root or a local user intentionally racing
fork/exit. The host operator must serialize other root group administration.
An interrupted or ambiguous provisioning is never adopted automatically.
"""

import fcntl
import grp
import importlib.util
import json
import os
import pathlib
import pwd
import secrets
import stat
import subprocess
import sys

HELPER = pathlib.Path('/usr/local/libexec/servus/servus-updater.py')
RECORD_DIR = pathlib.Path('/var/lib/servus-updater')
INSTALL_DIR = pathlib.Path('/opt/servus')
GROUPADD = pathlib.Path('/usr/sbin/groupadd')
NAME = 'servus-verifier'
CLEAN_ENV = {'PATH':'/usr/sbin:/usr/bin:/sbin:/bin', 'LANG':'C', 'LC_ALL':'C'}


class ProvisionError(Exception):
    pass


def trusted_file(path, mode=None, executable=False):
    path = pathlib.Path(path)
    if not path.is_absolute(): raise ProvisionError('A required file is not trusted')
    current = pathlib.Path('/')
    for part in path.parts[1:]:
        current /= part
        info = current.lstat()
        if info.st_uid != 0 or info.st_mode & 0o022 or stat.S_ISLNK(info.st_mode):
            raise ProvisionError('A required file is not trusted')
        if current != path and not stat.S_ISDIR(info.st_mode): raise ProvisionError('A required directory is not trusted')
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or (mode is not None and stat.S_IMODE(info.st_mode) != mode) or (executable and not info.st_mode & 0o100):
        raise ProvisionError('A required file is not trusted')


def trusted_directory(path, mode):
    path = pathlib.Path(path)
    if not path.is_absolute(): raise ProvisionError('A required directory is not trusted')
    current = pathlib.Path('/')
    for part in path.parts[1:]:
        current /= part
        info = current.lstat()
        if info.st_uid != 0 or info.st_mode & 0o022 or not stat.S_ISDIR(info.st_mode):
            raise ProvisionError('A required directory is not trusted')
    if stat.S_IMODE(path.lstat().st_mode) != mode: raise ProvisionError('A required directory has unsafe permissions')
    return os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)


def write_all(fd, data):
    view = memoryview(data)
    while view:
        written = os.write(fd, view)
        if written <= 0: raise OSError('Cannot write provisioning record')
        view = view[written:]


def save_initial(dirfd, value):
    fd = os.open('verifier-group.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=dirfd)
    try:
        os.fchmod(fd, 0o600)
        write_all(fd, json.dumps(value, separators=(',', ':')).encode() + b'\n')
        os.fsync(fd)
    finally: os.close(fd)
    os.fsync(dirfd)


def mark_ready(dirfd, intent):
    fd = os.open('verifier-group.json', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=dirfd)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1 or info.st_size > 1024:
            raise ProvisionError('Provisioning record is not trusted')
        raw = os.read(fd, 1025)
        try: value = json.loads(raw)
        except (ValueError, UnicodeError): raise ProvisionError('Provisioning record is invalid') from None
        if value != intent: raise ProvisionError('Provisioning intent changed')
        current = os.stat('verifier-group.json', dir_fd=dirfd, follow_symlinks=False)
        if (current.st_dev,current.st_ino) != (info.st_dev,info.st_ino): raise ProvisionError('Provisioning record changed')
    finally: os.close(fd)
    temp = '.verifier-group-' + secrets.token_hex(16)
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=dirfd)
    try:
        os.fchmod(fd, 0o600)
        write_all(fd, json.dumps({**intent, 'state':'ready'}, separators=(',', ':')).encode() + b'\n')
        os.fsync(fd)
        os.rename(temp, 'verifier-group.json', src_dir_fd=dirfd, dst_dir_fd=dirfd)
        os.fsync(dirfd)
    finally:
        os.close(fd)
        try: os.unlink(temp, dir_fd=dirfd)
        except FileNotFoundError: pass


def load_helper():
    trusted_file(HELPER)
    spec = importlib.util.spec_from_file_location('servus_updater_provision', HELPER)
    if spec is None or spec.loader is None: raise ProvisionError('Updater helper is unavailable')
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


def provision(helper, record_dir=RECORD_DIR, install_dir=INSTALL_DIR, groupadd=GROUPADD):
    if sys.platform != 'linux' or os.geteuid() != 0 or not sys.flags.isolated:
        raise ProvisionError('Isolated root on Linux is required')
    helper.assert_host_systemd()
    trusted_file(groupadd, executable=True)
    installfd = trusted_directory(install_dir, 0o755)
    statefd = None
    lockfd = None
    try:
        lockfd = os.open('install.lock', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=installfd)
        info = os.fstat(lockfd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1:
            raise ProvisionError('Installer lock is unsafe')
        fcntl.flock(lockfd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        current = os.stat('install.lock', dir_fd=installfd, follow_symlinks=False)
        if (current.st_dev,current.st_ino) != (info.st_dev,info.st_ino): raise ProvisionError('Installer lock changed')
        statefd = trusted_directory(record_dir, 0o700)
        try: os.stat('verifier-group.json', dir_fd=statefd, follow_symlinks=False)
        except FileNotFoundError: pass
        else: raise ProvisionError('Existing provisioning record requires manual review')
        passwd_text, group_text = helper.assert_supported_nss()
        try: grp.getgrnam(NAME)
        except KeyError: pass
        else: raise ProvisionError('Verifier group already exists')
        existing_gids = {item.gr_gid for item in grp.getgrall()} | {item.pw_gid for item in pwd.getpwall()}
        group_lines = [line.split(':') for line in group_text.splitlines() if line and not line.startswith('#')]
        passwd_lines = [line.split(':') for line in passwd_text.splitlines() if line and not line.startswith('#')]
        if any(len(line) != 4 or not line[2].isdigit() for line in group_lines) or any(len(line) != 7 or not line[3].isdigit() for line in passwd_lines):
            raise ProvisionError('Local identity databases are malformed')
        existing_gids.update(int(line[2]) for line in group_lines)
        existing_gids.update(int(line[3]) for line in passwd_lines)
        if any(line[0] == NAME for line in group_lines): raise ProvisionError('Verifier group already exists')
        selected = None
        for _ in range(32):
            candidate = (1 << 30) + secrets.randbelow((1 << 30) - 1)
            if candidate in existing_gids: continue
            try:
                helper.assert_no_subgid_delegation(candidate)
                helper.assert_stable_processes_without_gid(candidate)
            except RuntimeError:
                continue
            selected = candidate
            break
        if selected is None: raise ProvisionError('No verifiably unused verifier group was found')
        intent = {'version':1,'name':NAME,'gid':selected,'nonce':secrets.token_hex(32),'state':'intent'}
        save_initial(statefd, intent)
        try:
            subprocess.run([str(groupadd), '--gid', str(selected), NAME], check=True, timeout=15,
                           stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                           cwd='/', env=CLEAN_ENV, close_fds=True)
        except (OSError, subprocess.SubprocessError): raise ProvisionError('Verifier group could not be created') from None
        passwd_text, group_text = helper.assert_supported_nss()
        helper.validate_local_group(selected, passwd_text, group_text)
        group = grp.getgrnam(NAME)
        matches = [item for item in grp.getgrall() if item.gr_gid == selected]
        if group.gr_gid != selected or group.gr_mem or len(matches) != 1 or matches[0].gr_name != NAME or matches[0].gr_mem or any(item.pw_gid == selected for item in pwd.getpwall()):
            raise ProvisionError('Verifier group validation failed')
        helper.assert_no_subgid_delegation(selected)
        helper.assert_stable_processes_without_gid(selected)
        mark_ready(statefd, intent)
        return selected
    finally:
        if lockfd is not None: os.close(lockfd)
        if statefd is not None: os.close(statefd)
        os.close(installfd)


def main():
    try:
        gid = provision(load_helper())
    except (OSError, RuntimeError, ProvisionError):
        print('Verifier group provisioning failed or requires manual recovery.', file=sys.stderr)
        return 1
    print(f'Verifier group provisioned with GID {gid}.')
    return 0


if __name__ == '__main__': raise SystemExit(main())
