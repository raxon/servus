#!/usr/bin/python3
"""Check host-side evidence before an operator reconciles update policy state."""
import fcntl
import os
import re
import stat
import subprocess
from contextlib import contextmanager

ENV = {'PATH': '/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C',
       'DOCKER_HOST': 'unix:///var/run/docker.sock', 'DOCKER_CONFIG': '/var/empty'}
UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
PROBE = re.compile(r'^servus-extract-[a-f0-9]{32}$')
PROJECT = re.compile(r'^servusprobe[a-f0-9]{32}$')


class FenceError(RuntimeError):
    pass


@contextmanager
def hold_locks(state_fd, install_fd):
    """Hold the same exclusive locks used by the updater and supervisor."""
    locks = []
    try:
        for parent in (state_fd, install_fd):
            info = os.fstat(parent)
            if (not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_gid != 0 or
                    stat.S_IMODE(info.st_mode) != 0o700):
                raise FenceError('Lock directory is unsafe')
        for parent, name in ((state_fd, 'service.lock'), (install_fd, 'install.lock')):
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
            locks.append(fd)
            info = os.fstat(fd)
            named = os.stat(name, dir_fd=parent, follow_symlinks=False)
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_gid != 0 or
                    info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o600 or
                    (info.st_dev, info.st_ino) != (named.st_dev, named.st_ino)):
                raise FenceError('Recovery lock is unsafe')
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as error:
                raise FenceError('A recovery lock is held') from error
        yield
    finally:
        for fd in reversed(locks):
            os.close(fd)


def assert_no_maintenance(state_fd):
    """Do not reconcile an attempt while a maintenance marker exists."""
    directory = os.open('maintenance', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=state_fd)
    try:
        info = os.fstat(directory)
        if (info.st_uid != 0 or info.st_gid != 0 or stat.S_IMODE(info.st_mode) != 0o700):
            raise FenceError('Maintenance directory is unsafe')
        try:
            os.stat('maintenance.json', dir_fd=directory, follow_symlinks=False)
        except FileNotFoundError:
            return
        raise FenceError('Maintenance requires separate recovery')
    finally:
        os.close(directory)


def fenced_reconcile(db, operation_id, state_fd, install_fd, policy_fd, recovery_fd, journal_module, *, execute=None, preflight=None):
    """Apply the journal primitive while its host-side fences remain held."""
    with hold_locks(state_fd, install_fd):
        assert_no_maintenance(state_fd)
        assert_stopped(db, operation_id, execute=execute or run)
        if preflight is not None:
            preflight()
        journal_module.archive_and_reconcile(db, operation_id, policy_fd, recovery_fd)


def run(command):
    try:
        result = subprocess.run(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                stderr=subprocess.DEVNULL, cwd='/', env=ENV, timeout=20, check=True)
    except (OSError, subprocess.SubprocessError) as error:
        raise FenceError('Cannot establish host state') from error
    if len(result.stdout) > 65536:
        raise FenceError('Host state output is too large')
    try:
        return result.stdout.decode('utf-8', 'strict')
    except UnicodeError as error:
        raise FenceError('Host state output is invalid') from error


def _unit_inactive(unit, execute, *, allow_missing=False):
    output = execute(['/usr/bin/systemctl', 'show', unit,
                      '--property=LoadState', '--property=ActiveState', '--property=ControlGroup'])
    properties = {}
    for line in output.splitlines():
        key, separator, value = line.partition('=')
        if not separator or key in properties:
            raise FenceError('Unit state is invalid')
        properties[key] = value
    if (set(properties) != {'LoadState', 'ActiveState', 'ControlGroup'} or
            properties['LoadState'] not in (('loaded', 'not-found') if allow_missing else ('loaded',)) or
            properties['ActiveState'] != 'inactive' or properties['ControlGroup']):
        raise FenceError('A recovery unit is still active')


def assert_stopped(db, operation_id, *, execute=run):
    """Reject live units and recorded Docker probes; caller must hold locks."""
    if not isinstance(operation_id, str) or not UUID.fullmatch(operation_id):
        raise FenceError('Invalid operation identity')
    row = db.execute('SELECT preparation_id,status FROM preparations WHERE operation_id=?', (operation_id,)).fetchone()
    if not row or not isinstance(row[0], str) or not UUID.fullmatch(row[0]) or row[1] != 'recovery_required':
        raise FenceError('Recovery preparation is unavailable')
    prep = row[0]
    for unit in ('servus-updater.service', 'servus-supervisor.service'):
        _unit_inactive(unit, execute)
    _unit_inactive('servus-prepare-' + prep.replace('-', '') + '.service', execute, allow_missing=True)
    assert_no_probe_resources(db, operation_id, execute=execute)


def assert_no_probe_resources(db, operation_id, *, execute=run):
    """Require recorded extraction and policy probes to be absent from Docker."""
    if not isinstance(operation_id, str) or not UUID.fullmatch(operation_id):
        raise FenceError('Invalid operation identity')
    rows = db.execute('SELECT name,status FROM extraction_probes WHERE operation_id=?', (operation_id,)).fetchall()
    if not rows or any(not isinstance(name, str) or not PROBE.fullmatch(name) or status != 'removed' for name, status in rows):
        raise FenceError('Extraction evidence is incomplete')
    probe = db.execute('SELECT project,state FROM policy_probes WHERE operation_id=?', (operation_id,)).fetchone()
    if not probe or not isinstance(probe[0], str) or not PROJECT.fullmatch(probe[0]) or probe[1] != 'removed':
        raise FenceError('Policy evidence is incomplete')
    for name, _ in rows:
        output = execute(['/usr/bin/docker', 'container', 'ls', '--all', '--filter', 'name=^/' + name + '$', '--format', '{{.ID}}'])
        if output.strip():
            raise FenceError('An extraction container remains')
    if execute(['/usr/bin/docker', 'network', 'ls', '--filter', 'name=^' + probe[0] + '_default$', '--format', '{{.ID}}']).strip():
        raise FenceError('A policy probe network remains')
    label = 'label=com.docker.compose.project=' + probe[0]
    for resource in ('container', 'network', 'volume'):
        command = ['/usr/bin/docker', resource, 'ls']
        if resource == 'container':
            command.append('--all')
        command.extend(['--filter', label, '--format', '{{.ID}}' if resource != 'volume' else '{{.Name}}'])
        if execute(command).strip():
            raise FenceError('A policy probe resource remains')
