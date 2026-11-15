#!/usr/bin/python3 -I
"""Authenticated host-side drain channel for a Servus installation.

This module does not capture a backup or apply an update.  Drained processes
alone do not prove that the journals and all other writers are quiescent.
The caller must verify those conditions separately before using any snapshot.
The Docker daemon, host root, installed image and protected configuration are
trusted.  This module is not an HTTP endpoint and does not authorize an admin.
"""

import hashlib
import hmac
import ipaddress
import fcntl
import json
import os
import pathlib
import re
import secrets
import selectors
import socket
import stat
import struct
import subprocess
import sys
import time
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from types import MappingProxyType

ROLES = ('api', 'worker', 'agent')


def _assert_exclusive_flock(fd):
    """Require a live exclusive flock attached to this open description."""
    info = os.fstat(fd)
    try:
        with open(f'/proc/self/fdinfo/{fd}', encoding='ascii') as stream:
            lines = stream.read(16384).splitlines()
        for line in lines:
            match = re.fullmatch(r'lock:\s*\d+: FLOCK\s+ADVISORY\s+WRITE\s+(\d+)\s+([0-9a-f]+):([0-9a-f]+):(\d+)\s+0 EOF', line)
            if (match and int(match[1]) == os.getpid() and int(match[2], 16) == os.major(info.st_dev) and
                int(match[3], 16) == os.minor(info.st_dev) and int(match[4]) == info.st_ino):
                return
    except (OSError, ValueError) as error:
        raise SupervisorError('Cannot verify exclusive lock') from error
    raise SupervisorError('Exclusive lock was lost')


MAX_LINE = 4096
HEX64 = re.compile(r'^[0-9a-f]{64}$')
CONTAINER = re.compile(r'^[0-9a-f]{64}$')
DOCKER = '/usr/bin/docker'
PROC = pathlib.Path('/proc')
CLEAN_ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'DOCKER_HOST': 'unix:///var/run/docker.sock', 'LANG': 'C'}
IMAGE_REFERENCE = re.compile(r'^ghcr\.io/raxon/servus@sha256:[0-9a-f]{64}$')
IMAGE_ID = re.compile(r'^sha256:[0-9a-f]{64}$')


class SupervisorError(Exception):
    """Do not include tokens, paths from peers, or Docker output in messages."""


def _pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise SupervisorError('Invalid control message')
        result[key] = value
    return result


def _read_message(connection, deadline):
    data = bytearray()
    try:
        while len(data) <= MAX_LINE:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise SupervisorError('Control message timed out')
            connection.settimeout(remaining)
            chunk = connection.recv(1)
            if not chunk:
                raise SupervisorError('Control connection closed')
            if chunk == b'\n':
                break
            data.extend(chunk)
        else:
            raise SupervisorError('Control message is too large')
        message = json.loads(data.decode('utf-8'), object_pairs_hook=_pairs)
        if not isinstance(message, dict):
            raise SupervisorError('Invalid control message')
        return message
    except (OSError, UnicodeError, ValueError, RecursionError) as error:
        raise SupervisorError('Invalid control message') from error


def _send_message(connection, message, deadline):
    payload = json.dumps(message, separators=(',', ':'), ensure_ascii=True).encode('ascii') + b'\n'
    remaining = deadline - time.monotonic()
    if remaining <= 0 or len(payload) > MAX_LINE + 1:
        raise SupervisorError('Control message could not be sent')
    try:
        connection.settimeout(remaining)
        connection.sendall(payload)
    except OSError as error:
        raise SupervisorError('Control message could not be sent') from error


def _proof(token, kind, role, client_challenge, server_challenge):
    text = f'servus-supervisor-{kind}-v1\0{role}\0{client_challenge}\0{server_challenge}'
    return hmac.new(bytes.fromhex(token), text.encode('utf-8'), hashlib.sha256).hexdigest()


def _cgroup(pid):
    if not isinstance(pid, int) or pid <= 1:
        raise SupervisorError('Container process identity is unavailable')
    try:
        raw = (PROC / str(pid) / 'cgroup').read_bytes()
    except OSError as error:
        raise SupervisorError('Container process identity is unavailable') from error
    if len(raw) > 16384:
        raise SupervisorError('Container process identity is unavailable')
    try:
        lines = raw.decode('ascii').splitlines()
    except UnicodeError as error:
        raise SupervisorError('Container process identity is unavailable') from error
    if len(lines) != 1 or not lines[0].startswith('0::/'):
        raise SupervisorError('Unified container cgroup is required')
    return lines[0][3:]


def _docker(*args, timeout=15):
    try:
        process = subprocess.Popen([DOCKER, *args], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                   stderr=subprocess.DEVNULL, env=CLEAN_ENV, cwd='/', close_fds=True)
    except OSError as error:
        raise SupervisorError('Docker inspection failed') from error
    selector = selectors.DefaultSelector()
    output = bytearray()
    deadline = time.monotonic() + timeout
    try:
        selector.register(process.stdout, selectors.EVENT_READ)
        while selector.get_map():
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not selector.select(remaining):
                raise SupervisorError('Docker inspection failed')
            chunk = os.read(process.stdout.fileno(), 65536)
            if not chunk:
                selector.unregister(process.stdout)
                break
            output.extend(chunk)
            if len(output) > 1024 * 1024:
                raise SupervisorError('Docker inspection failed')
        remaining = deadline - time.monotonic()
        if remaining <= 0 or process.wait(timeout=remaining) != 0:
            raise SupervisorError('Docker inspection failed')
        return bytes(output)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise SupervisorError('Docker inspection failed') from error
    finally:
        selector.close()
        if process.poll() is None:
            process.kill()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                pass
        if process.stdout:
            process.stdout.close()


def _freeze_json(value):
    if isinstance(value, dict):
        return MappingProxyType({key: _freeze_json(item) for key, item in value.items()})
    if isinstance(value, list):
        return tuple(_freeze_json(item) for item in value)
    return value


def _normalize_host_config(host):
    """Normalize Docker's unordered mounts and equivalent default OOM flag."""
    if not isinstance(host, dict):
        raise SupervisorError('Runtime configuration is invalid')
    host = dict(host)
    # Docker may report the default OOM setting as either null or false after
    # a container starts. True must remain distinct and is never normalized.
    if 'OomKillDisable' in host and (host['OomKillDisable'] is None or host['OomKillDisable'] is False):
        host['OomKillDisable'] = False
    binds = host.get('Binds')
    if binds is not None:
        if not isinstance(binds, list):
            raise SupervisorError('Runtime mounts are invalid')
        targets = set()
        parsed = []
        for bind in binds:
            if not isinstance(bind, str):
                raise SupervisorError('Runtime mounts are invalid')
            parts = bind.rsplit(':', 2)
            if len(parts) != 3 or not parts[0].startswith('/') or not parts[1].startswith('/') or not parts[2] or parts[1] in targets:
                raise SupervisorError('Runtime mounts are invalid')
            targets.add(parts[1])
            parsed.append((parts[1], bind))
        host['Binds'] = [value for _, value in sorted(parsed)]
    mounts = host.get('Mounts')
    if mounts is not None:
        if not isinstance(mounts, list):
            raise SupervisorError('Runtime mounts are invalid')
        destinations = set()
        for mount in mounts:
            if not isinstance(mount, dict) or not isinstance(mount.get('Target'), str) or not mount['Target'] or mount['Target'] in destinations:
                raise SupervisorError('Runtime mounts are invalid')
            destinations.add(mount['Target'])
        host['Mounts'] = sorted(mounts, key=lambda mount: mount['Target'])
    return host


@dataclass(frozen=True)
class RuntimePolicy:
    """Expected values come from protected, independently verified configuration."""

    image_reference: str
    image_id: str
    install_dir: str
    data_dir: str
    gate_dir: str
    control_dir: str
    secret_sources: dict
    config_hashes: dict
    environments: dict
    host_configs: dict
    healthchecks: dict
    updater_dir: str | None = None

    def __post_init__(self):
        # Validate detached values so later mutations of caller-owned objects are harmless.
        try:
            for name in ('secret_sources', 'config_hashes', 'environments', 'host_configs', 'healthchecks'):
                value = getattr(self, name)
                detached = json.loads(json.dumps(value, allow_nan=False))
                object.__setattr__(self, name, detached)
        except (TypeError, ValueError, RecursionError) as error:
            raise SupervisorError('Runtime policy is invalid') from error
        if (not isinstance(self.image_reference, str) or not IMAGE_REFERENCE.fullmatch(self.image_reference) or
            not isinstance(self.image_id, str) or not IMAGE_ID.fullmatch(self.image_id) or
            not isinstance(self.secret_sources, dict) or set(self.secret_sources) != set(ROLES) or
            not all(isinstance(value, str) for value in self.secret_sources.values()) or len(set(self.secret_sources.values())) != len(ROLES) or
            not isinstance(self.config_hashes, dict) or set(self.config_hashes) != set(ROLES) or
            not all(isinstance(value, str) and HEX64.fullmatch(value) for value in self.config_hashes.values()) or
            not isinstance(self.environments, dict) or set(self.environments) != set(ROLES) or
            not isinstance(self.host_configs, dict) or set(self.host_configs) != set(ROLES) or
            not isinstance(self.healthchecks, dict) or set(self.healthchecks) != set(ROLES)):
            raise SupervisorError('Runtime policy is invalid')
        for value in (self.install_dir, self.data_dir, self.gate_dir, self.control_dir, *self.secret_sources.values()):
            if (not isinstance(value, str) or not value.startswith('/') or value == '/' or
                os.path.normpath(value) != value or '\0' in value or '\n' in value):
                raise SupervisorError('Runtime policy is invalid')
        if self.updater_dir is not None:
            value = self.updater_dir
            if value != '/run/servus-updater/control' or os.path.realpath(value) != value:
                raise SupervisorError('Runtime policy is invalid')
            for protected in (self.install_dir, self.data_dir, self.gate_dir, self.control_dir, *self.secret_sources.values()):
                if value == protected or value.startswith(protected + '/') or protected.startswith(value + '/'):
                    raise SupervisorError('Runtime policy is invalid')
        # Data binds may not replace host or container critical paths, including aliases.
        critical = ('/app', '/bin', '/boot', '/dev', '/etc', '/home/node', '/lib', '/lib64', '/proc', '/root',
                    '/run', '/sbin', '/sys', '/tmp', '/usr', '/var/run', '/var/tmp', '/var/log',
                    '/var/spool', '/var/lib/docker', '/var/lib/containerd', '/var/lib/systemd',
                    self.install_dir, self.gate_dir, self.control_dir, *self.secret_sources.values(),
                    *((self.updater_dir,) if self.updater_dir is not None else ()))
        if os.path.realpath(self.data_dir) != self.data_dir:
            raise SupervisorError('Runtime policy is invalid')
        for protected in critical:
            resolved = os.path.realpath(protected)
            for candidate in (protected, resolved):
                if (self.data_dir == candidate or self.data_dir.startswith(candidate + '/') or
                    candidate.startswith(self.data_dir + '/')):
                    raise SupervisorError('Runtime policy is invalid')
        required_host_fields = {'Privileged', 'PidMode', 'IpcMode', 'NetworkMode', 'UTSMode',
                                'UsernsMode', 'CapAdd', 'CapDrop', 'SecurityOpt', 'Devices',
                                'DeviceRequests', 'PortBindings', 'PublishAllPorts', 'RestartPolicy',
                                'ReadonlyRootfs', 'Init', 'Runtime'}
        snapshots = {}
        for role in ROLES:
            host = self.host_configs[role]
            health = self.healthchecks[role]
            if not isinstance(host, dict) or not required_host_fields.issubset(host) or (health is not None and not isinstance(health, dict)):
                raise SupervisorError('Runtime policy is invalid')
            # These limits apply even when an expected configuration is supplied.
            if (host['Privileged'] is not False or host['PidMode'] != '' or host['UsernsMode'] != '' or
                host['NetworkMode'] != 'servus_default' or host['IpcMode'] != 'private' or host['UTSMode'] != '' or
                host['CapAdd'] not in (None, []) or host['SecurityOpt'] not in (None, []) or
                host['Devices'] not in (None, []) or host['DeviceRequests'] not in (None, []) or
                host['PublishAllPorts'] is not False or host['ReadonlyRootfs'] is not False or
                host['Init'] is not True or host['Runtime'] != 'runc' or host['CapDrop'] not in (None, [])):
                raise SupervisorError('Runtime policy violates isolation requirements')
            ports = host['PortBindings']
            if role != 'api':
                if ports not in (None, {}):
                    raise SupervisorError('Runtime policy violates port requirements')
            else:
                if not isinstance(ports, dict) or set(ports) != {'4180/tcp'}:
                    raise SupervisorError('Runtime policy violates port requirements')
                bindings = ports['4180/tcp']
                if not isinstance(bindings, list) or len(bindings) != 1 or not isinstance(bindings[0], dict) or set(bindings[0]) != {'HostIp', 'HostPort'}:
                    raise SupervisorError('Runtime policy violates port requirements')
                address, port = bindings[0]['HostIp'], bindings[0]['HostPort']
                try:
                    if not isinstance(address, str) or (address and not ipaddress.ip_address(address)):
                        raise ValueError('Invalid address')
                    if not isinstance(port, str) or not port.isascii() or not port.isdecimal() or not 1 <= int(port) <= 65535:
                        raise ValueError('Invalid port')
                except ValueError as error:
                    raise SupervisorError('Runtime policy violates port requirements') from error
            try:
                snapshots[role] = (json.dumps(_normalize_host_config(host), sort_keys=True, separators=(',', ':'), allow_nan=False),
                                   json.dumps(health, sort_keys=True, separators=(',', ':'), allow_nan=False))
            except (TypeError, ValueError, RecursionError) as error:
                raise SupervisorError('Runtime policy is invalid') from error
        # Snapshot nested values so a later policy mutation cannot relax checks.
        object.__setattr__(self, '_runtime_snapshots', MappingProxyType(snapshots))
        for role in ROLES:
            environment = self.environments[role]
            if (not isinstance(environment, dict) or not all(isinstance(key, str) and isinstance(value, str) for key, value in environment.items()) or
                environment.get('PANEL_DATA_DIR') != self.data_dir or any(key in environment for key in ('LD_PRELOAD', 'LD_AUDIT', 'LD_LIBRARY_PATH', 'NODE_OPTIONS'))):
                raise SupervisorError('Runtime policy is invalid')
        for role in ROLES:
            environment = self.environments[role]
            updater = {key: environment[key] for key in ('PANEL_UPDATER_SOCKET', 'PANEL_UPDATER_APPLY_ENABLED') if key in environment}
            expected = {'PANEL_UPDATER_SOCKET': '/run/servus-updater/updater.sock', 'PANEL_UPDATER_APPLY_ENABLED': 'true'} if role == 'api' and self.updater_dir is not None else {}
            if updater != expected:
                raise SupervisorError('Runtime policy has invalid updater access')
        for name in ('secret_sources', 'config_hashes', 'environments', 'host_configs', 'healthchecks'):
            object.__setattr__(self, name, _freeze_json(getattr(self, name)))

    def mounts_for(self, role):
        entries = [
            ('bind', self.data_dir, self.data_dir, True),
            ('bind', self.gate_dir, '/run/servus-lifecycle', False),
            ('bind', self.control_dir, '/run/servus-supervisor', False),
            ('bind', self.secret_sources[role], '/run/servus-control/token', False),
        ]
        if role == 'agent':
            entries.append(('bind', '/var/run/docker.sock', '/var/run/docker.sock', True))
        if role == 'api' and self.updater_dir is not None:
            entries.append(('bind', self.updater_dir, '/run/servus-updater', False))
        return set(entries)


def inspect_servus(policy, *, created=False):
    """Inspect exactly one approved running or never-started container per role."""
    if not isinstance(policy, RuntimePolicy) or type(created) is not bool:
        raise SupervisorError('Verified runtime policy is required')
    _verify_data_directory(policy.data_dir)
    try:
        ids = _docker('ps', '-a', '--filter', 'label=com.docker.compose.project=servus', '--no-trunc', '--format', '{{.ID}}').decode('ascii').splitlines()
        if len(ids) != 3 or len(set(ids)) != 3 or not all(CONTAINER.fullmatch(item) for item in ids):
            raise SupervisorError('Unexpected Servus container set')
        records = json.loads(_docker('inspect', *ids), object_pairs_hook=_pairs)
    except (UnicodeError, ValueError, RecursionError) as error:
        raise SupervisorError('Docker inspection failed') from error
    if not isinstance(records, list) or len(records) != 3:
        raise SupervisorError('Unexpected Servus container set')
    output = {}
    for item in records:
        if not isinstance(item, dict):
            raise SupervisorError('Unexpected Servus container set')
        config, state, mounts = item.get('Config'), item.get('State'), item.get('Mounts')
        if not isinstance(config, dict) or not isinstance(state, dict) or not isinstance(mounts, list):
            raise SupervisorError('Unexpected Servus container set')
        labels = config.get('Labels') or {}
        role, cid, pid = labels.get('com.docker.compose.service'), item.get('Id'), state.get('Pid')
        if (labels.get('com.docker.compose.project') != 'servus' or labels.get('com.docker.compose.oneoff') != 'False' or
            labels.get('com.docker.compose.container-number') != '1' or role not in ROLES or role in output or
            cid not in ids):
            raise SupervisorError('Unexpected Servus container set')
        if created:
            if (state.get('Status') != 'created' or state.get('Running') is not False or
                state.get('Paused') is not False or state.get('Restarting') is not False or
                state.get('Dead') is not False or type(pid) is not int or pid != 0 or
                state.get('StartedAt') != '0001-01-01T00:00:00Z'):
                raise SupervisorError('A candidate container has already started')
        elif state.get('Running') is not True or type(pid) is not int or pid <= 1:
            raise SupervisorError('Unexpected Servus container set')
        expected_command = ['dist/' + ('server' if role == 'api' else role) + '/index.js']
        if (item.get('Image') != policy.image_id or config.get('Image') != policy.image_reference or
            config.get('Entrypoint') != ['/bin/sh', '/app/lifecycle-gate.sh'] or config.get('Cmd') != expected_command or
            config.get('User') != 'node' or config.get('WorkingDir') != '/app' or
            labels.get('com.docker.compose.config-hash') != policy.config_hashes[role]):
            raise SupervisorError('Servus runtime configuration is not trusted')
        host = item.get('HostConfig')
        if not isinstance(host, dict):
            raise SupervisorError('Servus runtime configuration is not trusted')
        try:
            actual_runtime = (json.dumps(_normalize_host_config(host), sort_keys=True, separators=(',', ':'), allow_nan=False),
                              json.dumps(config.get('Healthcheck'), sort_keys=True, separators=(',', ':'), allow_nan=False))
        except (TypeError, ValueError, RecursionError) as error:
            raise SupervisorError('Servus runtime configuration is not trusted') from error
        if actual_runtime != policy._runtime_snapshots[role]:
            raise SupervisorError('Servus runtime configuration is not trusted')
        env = config.get('Env')
        if not isinstance(env, list) or not all(isinstance(value, str) and '=' in value for value in env):
            raise SupervisorError('Servus runtime configuration is not trusted')
        pairs = [value.split('=', 1) for value in env]
        if len({key for key, _ in pairs}) != len(pairs) or dict(pairs) != policy.environments[role]:
            raise SupervisorError('Servus runtime configuration is not trusted')
        actual = []
        for mount in mounts:
            if not isinstance(mount, dict) or type(mount.get('RW')) is not bool:
                raise SupervisorError('Servus runtime mounts are not trusted')
            actual.append((mount.get('Type'), mount.get('Source'), mount.get('Destination'), mount['RW']))
        if len(actual) != len(policy.mounts_for(role)) or set(actual) != policy.mounts_for(role):
            raise SupervisorError('Servus runtime mounts are not trusted')
        if created:
            output[role] = {'id': cid}
        else:
            cgroup = _cgroup(pid)
            if cid not in cgroup:
                raise SupervisorError('Container cgroup cannot be identified')
            output[role] = {'id': cid, 'pid': pid, 'cgroup': cgroup}
    if set(output) != set(ROLES):
        raise SupervisorError('Unexpected Servus container set')
    return output


class DrainHub:
    """Authenticate long-lived component channels and request a single drain."""

    def __init__(self, listener, tokens, expected_uid, policy, identities=None):
        if set(tokens) != set(ROLES) or any(not isinstance(value, str) or not HEX64.fullmatch(value) for value in tokens.values()) or len(set(tokens.values())) != 3:
            raise SupervisorError('Distinct component credentials are required')
        if type(expected_uid) is not int or expected_uid <= 0:
            raise SupervisorError('Invalid component identity')
        self.listener = listener
        self.tokens = dict(tokens)
        self.expected_uid = expected_uid
        if not isinstance(policy, RuntimePolicy):
            raise SupervisorError('Verified runtime policy is required')
        self.policy = policy
        self.identities = identities if identities is not None else inspect_servus(policy)
        self.connections = {}
        self.used = False

    def accept(self, timeout=5):
        """Accept one component connection; caller controls listener lifetime."""
        if timeout <= 0 or timeout > 60 or self.used:
            raise SupervisorError('Control registration is closed')
        try:
            self.listener.settimeout(timeout)
            connection, _ = self.listener.accept()
        except OSError as error:
            raise SupervisorError('Control registration failed') from error
        try:
            deadline = time.monotonic() + min(timeout, 5)
            pid, uid, _ = struct.unpack('3i', connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize('3i')))
            if uid != self.expected_uid:
                raise SupervisorError('Control peer was rejected')
            hello = _read_message(connection, deadline)
            role = hello.get('role')
            challenge = hello.get('challenge')
            if (set(hello) != {'version', 'type', 'role', 'challenge'} or type(hello.get('version')) is not int or hello['version'] != 1 or
                hello.get('type') != 'hello' or role not in ROLES or role in self.connections or
                not isinstance(challenge, str) or not HEX64.fullmatch(challenge)):
                raise SupervisorError('Control peer was rejected')
            expected = self.identities.get(role)
            if not isinstance(expected, dict) or _cgroup(pid) != expected.get('cgroup') or expected.get('id') not in expected['cgroup']:
                raise SupervisorError('Control peer was rejected')
            fresh = secrets.token_hex(32)
            proof = _proof(self.tokens[role], 'server', role, challenge, fresh)
            _send_message(connection, {'version': 1, 'type': 'hello_ack', 'role': role, 'challenge': fresh, 'proof': proof}, deadline)
            confirm = _read_message(connection, deadline)
            given = confirm.get('proof')
            if (set(confirm) != {'version', 'type', 'proof'} or type(confirm.get('version')) is not int or confirm['version'] != 1 or
                confirm.get('type') != 'hello_confirm' or not isinstance(given, str) or not HEX64.fullmatch(given) or
                not hmac.compare_digest(given, _proof(self.tokens[role], 'client', role, challenge, fresh))):
                raise SupervisorError('Control peer was rejected')
            _send_message(connection, {'version': 1, 'type': 'ready', 'role': role}, deadline)
            self.connections[role] = connection
            return role
        except BaseException:
            connection.close()
            raise

    def drain(self, timeout_ms, request_ids, *, legacy_upload_id=None):
        """Drain API, worker, agent in that order; uncertainty is never success."""
        if (self.used or set(self.connections) != set(ROLES) or type(timeout_ms) is not int or not 1 <= timeout_ms <= 60000 or
            not isinstance(request_ids, dict) or set(request_ids) != set(ROLES) or
            not all(_uuid4(value) for value in request_ids.values()) or len(set(request_ids.values())) != len(ROLES) or
            (legacy_upload_id is not None and (not isinstance(legacy_upload_id,str) or not re.fullmatch(r'[a-f0-9]{32}',legacy_upload_id)))):
            raise SupervisorError('Control channels are not ready')
        # A restart between authentication and drain invalidates all channels.
        if inspect_servus(self.policy) != self.identities:
            raise SupervisorError('Container identity changed')
        self.used = True
        for role in ROLES:
            request_id = request_ids[role]
            deadline = time.monotonic() + timeout_ms / 1000
            try:
                command={'version': 1, 'type': 'drain', 'requestId': request_id, 'timeoutMs': timeout_ms}
                if role=='agent' and legacy_upload_id is not None:command['legacyUploadId']=legacy_upload_id
                _send_message(self.connections[role], command, deadline)
                result = _read_message(self.connections[role], deadline)
            except (OSError, SupervisorError):
                print('servus drain failure role=' + role + ' outcome=channel_error', file=sys.stderr, flush=True)
                raise
            if (set(result) != {'version', 'type', 'requestId', 'status'} or type(result.get('version')) is not int or result['version'] != 1 or
                result.get('type') != 'drain_result' or result.get('requestId') != request_id or result.get('status') != 'drained'):
                status = result.get('status')
                outcome = status if status in ('uncertain', 'timeout', 'stopped') else 'invalid_response'
                print('servus drain failure role=' + role + ' outcome=' + outcome, file=sys.stderr, flush=True)
                raise SupervisorError('A component could not be drained')
        return None

    def close(self):
        for connection in self.connections.values():
            connection.close()
        self.connections.clear()


def _trusted_directory(path, mode=None):
    path = pathlib.Path(path)
    if not path.is_absolute() or '..' in path.parts:
        raise SupervisorError('A protected directory is invalid')
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in path.parts[1:]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
            info = os.fstat(fd)
            if info.st_uid != 0 or info.st_mode & 0o022:
                raise SupervisorError('A protected directory is unsafe')
        info = os.fstat(fd)
        if mode is not None and stat.S_IMODE(info.st_mode) != mode:
            raise SupervisorError('A protected directory is unsafe')
        return fd
    except BaseException:
        os.close(fd)
        raise


def _verify_data_directory(path):
    """Require stable root-owned ancestors and the installer's unprivileged data owner."""
    parts = pathlib.Path(path).parts
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for index, part in enumerate(parts[1:]):
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
            info = os.fstat(fd)
            expected_uid = 1000 if index == len(parts) - 2 else 0
            if info.st_uid != expected_uid or info.st_mode & 0o022:
                raise SupervisorError('Data directory ownership is unsafe')
    except OSError as error:
        raise SupervisorError('Data directory is unavailable or unsafe') from error
    finally:
        os.close(fd)


def _open_root_file(parent, name, mode, *, path_only=False):
    flags = (os.O_PATH if path_only else os.O_RDONLY | os.O_NONBLOCK) | os.O_NOFOLLOW
    fd = os.open(name, flags, dir_fd=parent)
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_gid != 0 or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != mode:
        os.close(fd)
        raise SupervisorError('A protected file is unsafe')
    return fd


def _atomic_file(parent, name, content, mode):
    temporary = '.servus-' + secrets.token_hex(16)
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode, dir_fd=parent)
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, 'wb', closefd=False) as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.rename(temporary, name, src_dir_fd=parent, dst_dir_fd=parent)
        os.fsync(parent)
    finally:
        os.close(fd)
        try:
            os.unlink(temporary, dir_fd=parent)
        except FileNotFoundError:
            pass


def _uuid4(value):
    try:
        parsed = uuid.UUID(value)
        return parsed.version == 4 and str(parsed) == value
    except (AttributeError, TypeError, ValueError):
        return False


class ComponentEndpoint:
    """Own component credentials and a listener without acquiring the install lock."""

    def __init__(self):
        if os.geteuid() != 0 or not hasattr(socket, 'SO_PEERCRED'):
            raise SupervisorError('A Linux root supervisor is required')
        self.listener = self.socket_dir = self.socket_identity = None

    def close(self):
        if self.listener is not None:
            self.listener.close()
            self.listener = None
        if self.socket_dir is not None:
            try:
                entry = os.stat('socket', dir_fd=self.socket_dir, follow_symlinks=False)
                if self.socket_identity == (entry.st_dev, entry.st_ino) and stat.S_ISSOCK(entry.st_mode) and entry.st_uid == 0:
                    os.unlink('socket', dir_fd=self.socket_dir)
            except FileNotFoundError:
                pass
            os.close(self.socket_dir)
            self.socket_dir = None

    def read_component_tokens(self, secret_dir, gid):
        """Read three separately mounted host credentials without logging them."""
        if type(gid) is not int or gid <= 0:
            raise SupervisorError('Invalid control group')
        directory = _trusted_directory(secret_dir, 0o700)
        values = {}
        try:
            for role in ROLES:
                fd = os.open(role, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
                try:
                    info = os.fstat(fd)
                    if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_gid != gid or
                        info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o640 or not 64 <= info.st_size <= 65):
                        raise SupervisorError('A component credential is unsafe')
                    raw = os.read(fd, 66)
                    value = raw.decode('ascii').removesuffix('\n')
                    if not HEX64.fullmatch(value) or len(raw) not in (64, 65):
                        raise SupervisorError('A component credential is unsafe')
                    values[role] = value
                finally:
                    os.close(fd)
            if len(set(values.values())) != len(ROLES):
                raise SupervisorError('Distinct component credentials are required')
            return values
        except (OSError, UnicodeError) as error:
            raise SupervisorError('A component credential is unsafe') from error
        finally:
            os.close(directory)

    def listen(self, socket_dir, gid):
        """Bind only a new socket in a root-owned, non-writable directory."""
        if self.listener is not None or self.socket_dir is not None or type(gid) is not int or gid <= 0:
            raise SupervisorError('Invalid control socket configuration')
        directory = _trusted_directory(socket_dir, 0o750)
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            info = os.fstat(directory)
            if info.st_gid != gid:
                raise SupervisorError('Control directory group is invalid')
            try:
                os.stat('socket', dir_fd=directory, follow_symlinks=False)
            except FileNotFoundError:
                pass
            else:
                raise SupervisorError('Existing control socket requires reconciliation')
            listener.bind(f'/proc/self/fd/{directory}/socket')
            entry = os.stat('socket', dir_fd=directory, follow_symlinks=False)
            identity = (entry.st_dev, entry.st_ino)
            self.socket_dir, self.socket_identity = directory, identity
            if not stat.S_ISSOCK(entry.st_mode) or entry.st_uid != 0:
                raise SupervisorError('Control socket is unsafe')
            os.chown('socket', 0, gid, dir_fd=directory, follow_symlinks=False)
            os.chmod('socket', 0o660, dir_fd=directory, follow_symlinks=False)
            final = os.stat('socket', dir_fd=directory, follow_symlinks=False)
            if ((final.st_dev, final.st_ino) != identity or not stat.S_ISSOCK(final.st_mode) or
                final.st_uid != 0 or final.st_gid != gid or stat.S_IMODE(final.st_mode) != 0o660):
                raise SupervisorError('Control socket is unsafe')
            listener.listen(8)
            self.listener = listener
            return listener
        except BaseException:
            listener.close()
            if self.socket_dir is not None:
                try:
                    entry = os.stat('socket', dir_fd=self.socket_dir, follow_symlinks=False)
                    if (entry.st_dev, entry.st_ino) == self.socket_identity and stat.S_ISSOCK(entry.st_mode) and entry.st_uid == 0:
                        os.unlink('socket', dir_fd=self.socket_dir)
                except FileNotFoundError:
                    pass
                os.close(self.socket_dir)
                self.socket_dir = None
            else:
                os.close(directory)
            raise

class MaintenanceSupervisor(ComponentEndpoint):
    """Stop only verified Servus containers after authenticated component drain.

    This is intentionally not a backup or update executor.  Any interruption
    after intent is durable requires explicit local reconciliation.  The old
    installer and unrelated root/Docker operators are outside the lock model.
    """

    def __init__(self, install_dir, gate_dir, journal_dir):
        if os.geteuid() != 0 or not hasattr(socket, 'SO_PEERCRED'):
            raise SupervisorError('A Linux root supervisor is required')
        self.install = self.gate = self.journal = self.install_lock = self.gate_lock = None
        super().__init__()
        try:
            self.install = _trusted_directory(install_dir)
            self.gate = _trusted_directory(gate_dir, 0o755)
            self.journal = _trusted_directory(journal_dir, 0o700)
            self.install_lock = _open_root_file(self.install, 'install.lock', 0o600)
            fcntl.flock(self.install_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.gate_lock = _open_root_file(self.gate, 'lock', 0o644)
        except BaseException:
            self.close()
            raise

    def close(self):
        super().close()
        for attribute in ('gate_lock', 'install_lock', 'journal', 'gate', 'install'):
            fd = getattr(self, attribute, None)
            if fd is not None:
                os.close(fd)
                setattr(self, attribute, None)

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.close()

    def _record(self, request_id, state, request_ids, timeout_ms):
        if not _uuid4(request_id) or state not in ('intent', 'maintenance', 'drained', 'stopping', 'stopped_unverified', 'snapshotting', 'snapshot_verified', 'switching', 'starting', 'recovery_required'):
            raise SupervisorError('Invalid supervisor state')
        if (not isinstance(request_ids, dict) or set(request_ids) != set(ROLES) or
            not all(_uuid4(value) for value in request_ids.values()) or len(set(request_ids.values())) != len(ROLES) or
            type(timeout_ms) is not int or not 1 <= timeout_ms <= 60000):
            raise SupervisorError('Invalid supervisor state')
        payload = json.dumps({'version': 1, 'operationId': request_id, 'state': state, 'requestIds': request_ids, 'timeoutMs': timeout_ms}, separators=(',', ':')).encode('ascii') + b'\n'
        _atomic_file(self.journal, 'maintenance.json', payload, 0o600)

    def _verify_no_previous_operation(self):
        for name in ('maintenance.json','legacy-upload-recovery.json'):
            try:
                os.stat(name, dir_fd=self.journal, follow_symlinks=False)
            except FileNotFoundError:
                continue
            raise SupervisorError('Previous maintenance requires local reconciliation')

    def _start_maintenance(self):
        fcntl.flock(self.gate_lock, fcntl.LOCK_SH | fcntl.LOCK_NB)
        try:
            by_name = os.stat('lock', dir_fd=self.gate, follow_symlinks=False)
            by_fd = os.fstat(self.gate_lock)
            if (by_name.st_dev, by_name.st_ino) != (by_fd.st_dev, by_fd.st_ino):
                raise SupervisorError('Lifecycle lock changed')
            state_fd = _open_root_file(self.gate, 'state', 0o644)
            try:
                if os.read(state_fd, 64) != b'servus-lifecycle-v1 normal\n':
                    raise SupervisorError('Lifecycle is not in normal state')
            finally:
                os.close(state_fd)
            _atomic_file(self.gate, 'state', b'servus-lifecycle-v1 maintenance\n', 0o644)
        finally:
            fcntl.flock(self.gate_lock, fcntl.LOCK_UN)

    @contextmanager
    def drained_window(self, hub, request_id, timeout_ms=60000, *, policy_binding=None, legacy_upload_id=None):
        """Hold the exclusive startup gate after stopping authenticated roles.

        Callers must independently prove that every other writer and daemon-side
        operation is quiescent. A held gate alone does not authorize a backup.
        Any exception or uncommitted exit preserves a recovery-required marker.
        """
        if (not isinstance(hub, DrainHub) or not _uuid4(request_id) or type(timeout_ms) is not int or not 1 <= timeout_ms <= 60000 or
            (legacy_upload_id is not None and (not isinstance(legacy_upload_id,str) or not re.fullmatch(r'[a-f0-9]{32}',legacy_upload_id)))):
            raise SupervisorError('Invalid maintenance request')
        if policy_binding is not None:
            if (not isinstance(policy_binding, tuple) or len(policy_binding) != 4 or
                not isinstance(policy_binding[0], str) or not os.path.isabs(policy_binding[0]) or
                any(not isinstance(value, str) or not re.fullmatch(r'sha256:[a-f0-9]{64}', value) for value in policy_binding[1:3]) or
                policy_binding[3] != hub.policy):
                raise SupervisorError('Active policy does not match the drained hub')
        self._verify_no_previous_operation()
        request_ids = {role: str(uuid.uuid4()) for role in ROLES}
        # Capture intent before either maintenance state or container changes.
        self._record(request_id, 'intent', request_ids, timeout_ms)
        exclusive = False
        completed = False
        lease = None
        phase = 'maintenance_gate'
        try:
            self._start_maintenance()
            self._record(request_id, 'maintenance', request_ids, timeout_ms)
            phase = 'drain'
            if legacy_upload_id is None: hub.drain(timeout_ms, request_ids)
            else: hub.drain(timeout_ms, request_ids, legacy_upload_id=legacy_upload_id)
            self._record(request_id, 'drained', request_ids, timeout_ms)
            phase = 'identity'
            if inspect_servus(hub.policy) != hub.identities:
                raise SupervisorError('Container identity changed')
            self._record(request_id, 'stopping', request_ids, timeout_ms)
            phase = 'stop'
            for role in ROLES:
                _docker('stop', '--time', '30', hub.identities[role]['id'], timeout=45)
            for role in ROLES:
                result = json.loads(_docker('inspect', hub.identities[role]['id']), object_pairs_hook=_pairs)
                if (not isinstance(result, list) or len(result) != 1 or result[0].get('Id') != hub.identities[role]['id'] or
                    result[0].get('State', {}).get('Running') is not False):
                    raise SupervisorError('A container could not be confirmed stopped')
            phase = 'exclusive_gate'
            fcntl.flock(self.gate_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            exclusive = True
            by_name = os.stat('lock', dir_fd=self.gate, follow_symlinks=False)
            by_fd = os.fstat(self.gate_lock)
            if (by_name.st_dev, by_name.st_ino) != (by_fd.st_dev, by_fd.st_ino):
                raise SupervisorError('Lifecycle lock changed')
            self._record(request_id, 'stopped_unverified', request_ids, timeout_ms)
            lease = DrainLease(self, request_id, request_ids, timeout_ms, policy_binding, hub=hub, legacy_upload_id=legacy_upload_id)
            phase = 'update'
            yield lease
            completed = lease._settled
        except BaseException:
            print('servus maintenance failure phase=' + phase, file=sys.stderr, flush=True)
            try:
                self._record(request_id, 'recovery_required', request_ids, timeout_ms)
            except BaseException:
                pass
            raise
        finally:
            if lease is not None:
                lease._active = False
            if not completed:
                try:
                    self._record(request_id, 'recovery_required', request_ids, timeout_ms)
                except BaseException:
                    pass
            if exclusive:
                fcntl.flock(self.gate_lock, fcntl.LOCK_UN)

    def stop_after_drain(self, hub, request_id, timeout_ms=60000):
        """Stop the three authenticated containers; never starts or updates them."""
        with self.drained_window(hub, request_id, timeout_ms) as lease:
            lease.retain_maintenance()
        return 'stopped_unverified'


class DrainLease:
    """An exclusive gate lease scoped to one durable maintenance intent."""

    def __init__(self, owner, operation_id, request_ids, timeout_ms, policy_binding=None, *, hub=None, legacy_upload_id=None):
        self._owner = owner
        self._operation_id = operation_id
        self._request_ids = request_ids
        self._timeout_ms = timeout_ms
        self._settled = False
        self._state = 'stopped_unverified'
        self._active = True
        self._policy_binding = policy_binding[:3] if policy_binding is not None else None
        self._hub = hub
        self._legacy_upload_id = legacy_upload_id

    def assert_locked(self, operation_id, state):
        """Recheck the host lock identities and the still-closed startup gate."""
        owner = self._owner
        if not self._active or self._settled or operation_id != self._operation_id or state != self._state:
            raise SupervisorError('Maintenance lease is not current')
        try:
            for directory, name, fd, mode in ((owner.install, 'install.lock', owner.install_lock, 0o600),
                                               (owner.gate, 'lock', owner.gate_lock, 0o644)):
                opened = os.fstat(fd)
                named = os.stat(name, dir_fd=directory, follow_symlinks=False)
                if (not stat.S_ISREG(opened.st_mode) or opened.st_uid != 0 or opened.st_nlink != 1 or
                    stat.S_IMODE(opened.st_mode) != mode or
                    (opened.st_dev, opened.st_ino) != (named.st_dev, named.st_ino)):
                    raise SupervisorError('Maintenance lock changed')
                _assert_exclusive_flock(fd)
            state_fd = _open_root_file(owner.gate, 'state', 0o644)
            try:
                if os.read(state_fd, 64) != b'servus-lifecycle-v1 maintenance\n':
                    raise SupervisorError('Lifecycle gate changed')
            finally:
                os.close(state_fd)
        except (OSError, TypeError) as error:
            raise SupervisorError('Maintenance lease is unavailable') from error

    def assert_snapshot_verified(self, operation_id):
        self.assert_locked(operation_id, 'snapshot_verified')

    def assert_active_policy(self, policy_path, env_digest, policy_digest):
        self.assert_snapshot_verified(self._operation_id)
        if self._policy_binding is None or self._policy_binding != (policy_path, env_digest, policy_digest):
            raise SupervisorError('Active policy is not bound to this drain')

    def record(self, state):
        transitions = {'stopped_unverified': 'snapshotting', 'snapshotting': 'snapshot_verified',
                       'snapshot_verified': 'switching', 'switching': 'starting'}
        if self._settled or getattr(self,'_legacy_upload_id',None) is not None or transitions.get(self._state) != state:
            raise SupervisorError('Invalid maintenance transition')
        self.assert_locked(self._operation_id, self._state)
        self._owner._record(self._operation_id, state, self._request_ids, self._timeout_ms)
        self._state = state

    def retain_maintenance(self):
        """Leave the startup gate closed for later recovery or integration."""
        if self._settled:
            raise SupervisorError('Maintenance window is already settled')
        self.assert_locked(self._operation_id, self._state)
        self._settled = True

    def release_for_start(self):
        """Open the gate only after a durable starting marker has been recorded."""
        self.assert_locked(self._operation_id, 'starting')
        _atomic_file(self._owner.gate, 'state', b'servus-lifecycle-v1 normal\n', 0o644)
        fcntl.flock(self._owner.gate_lock, fcntl.LOCK_UN)
        self._settled = True
