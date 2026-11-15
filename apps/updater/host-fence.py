#!/usr/bin/python3 -I
"""Fail closed unless host updater processes are fenced before an exchange.

The caller must own the service and installation locks, arrange and later
restore runtime systemd masks, and exclude all other trusted root operators.
This check does not stop, mask, start or unmask any service.
"""
import os
import pathlib
import re
import subprocess
import sys

UNITS = ('servus-updater.service', 'servus-supervisor.service',
         'servus-updater-socket.service', 'servus-updater-bootstrap.service')
TRANSIENT = re.compile(r'^servus-(?:verify|prepare)-[a-z0-9-]+\.service$')
ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C', 'LC_ALL': 'C'}


class HostFenceError(Exception):
    pass


def _systemctl(unit):
    try:
        result = subprocess.run(['/usr/bin/systemctl', 'show', unit, '--property=LoadState',
                                 '--property=ActiveState', '--property=ControlGroup', '--property=UnitFileState'],
                                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                cwd='/', env=ENV, timeout=10, check=True)
        if len(result.stdout) > 16384:
            raise HostFenceError('Systemd unit state is too large')
        return result.stdout.decode('utf-8', 'strict')
    except (OSError, UnicodeError, subprocess.SubprocessError) as error:
        raise HostFenceError('Systemd unit state is unavailable') from error


def _masked_units(execute):
    for unit in UNITS:
        properties = {}
        for line in execute(unit).splitlines():
            key, separator, value = line.partition('=')
            if not separator or key in properties:
                raise HostFenceError('Systemd unit state is invalid')
            properties[key] = value
        if (set(properties) != {'LoadState', 'ActiveState', 'ControlGroup', 'UnitFileState'} or
            properties['LoadState'] != 'masked' or properties['UnitFileState'] != 'masked-runtime' or
            properties['ActiveState'] != 'inactive' or properties['ControlGroup']):
            raise HostFenceError('A host unit is not stopped and runtime-masked')


def _transient_cgroups(root):
    try:
        entries = list(root.iterdir())
        for path in entries:
            if not path.name.startswith(('servus-verify-', 'servus-prepare-')):
                continue
            if not TRANSIENT.fullmatch(path.name) or path.is_symlink() or not path.is_dir():
                raise HostFenceError('Transient cgroup identity is invalid')
            fd = os.open(path / 'cgroup.events', os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
            try: data = os.read(fd, 1025)
            finally: os.close(fd)
            if len(data) > 1024:
                raise HostFenceError('Transient cgroup state is invalid')
            values = [line.split() for line in data.decode('ascii', 'strict').splitlines()]
            matches = [line for line in values if line and line[0] == 'populated']
            if matches != [['populated', '0']]:
                raise HostFenceError('A transient updater cgroup is populated')
    except (OSError, UnicodeError) as error:
        raise HostFenceError('Transient cgroup inventory is unavailable') from error


def _host_processes(proc, host_dir, own_pid):
    needle = os.fsencode(host_dir.rstrip('/'))
    try:
        processes = list(proc.iterdir())
        for process in processes:
            if not process.name.isdecimal() or int(process.name) == own_pid:
                continue
            try:
                with (process / 'cmdline').open('rb') as source:
                    command = source.read(1048577)
            except FileNotFoundError:
                continue
            except OSError as error:
                raise HostFenceError('Host process inventory is unavailable') from error
            if len(command) > 1048576:
                raise HostFenceError('Host process command is too large')
            if any(needle in argument and (argument.endswith(needle) or needle + b'/' in argument)
                   for argument in command.split(b'\0')):
                raise HostFenceError('A process still references host runtime files')
    except OSError as error:
        raise HostFenceError('Host process inventory is unavailable') from error


def assert_fenced(host_dir, quiescence, *, execute=_systemctl, proc=pathlib.Path('/proc'),
                  cgroup=pathlib.Path('/sys/fs/cgroup/system.slice'), own_pid=None):
    """Check masked units, transient cgroups and visible host file users."""
    if (sys.platform != 'linux' or os.geteuid() != 0 or not sys.flags.isolated or
        not isinstance(host_dir, str) or not os.path.isabs(host_dir) or os.path.normpath(host_dir) != host_dir or host_dir == '/'):
        raise HostFenceError('Invalid host fence context')
    quiescence.ensure_host_namespaces()
    _masked_units(execute)
    _transient_cgroups(cgroup)
    quiescence.ensure_no_open_data(host_dir)
    _host_processes(proc, host_dir, os.getpid() if own_pid is None else own_pid)
    _transient_cgroups(cgroup)
    _masked_units(execute)
