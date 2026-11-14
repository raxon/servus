import fcntl
import json
import signal
import threading
import time
from types import SimpleNamespace
from unittest import mock
import importlib.util
import os
from pathlib import Path
import socket
import sqlite3
import sys
import tempfile
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'apps/updater'))
import supervisor
spec = importlib.util.spec_from_file_location('supervisor_daemon', ROOT / 'apps/updater/supervisor-daemon.py')
daemon = importlib.util.module_from_spec(spec)
spec.loader.exec_module(daemon)


@unittest.skipUnless(sys.platform == 'linux' and os.geteuid() == 0, 'Requires isolated Linux root')
class DaemonTest(unittest.TestCase):
    def test_host_apply_requires_protected_config_and_pinned_node(self):
        with tempfile.TemporaryDirectory(dir='/root') as temporary:
            root = Path(temporary)
            for name in ('backup', 'policy', 'docker'):
                (root / name).mkdir(mode=0o700)
            node = Path(os.path.realpath(sys.executable))
            node_hash = daemon.hashlib.sha256(node.read_bytes()).hexdigest()
            config = {'backupRoot': str(root / 'backup'), 'policyRoot': str(root / 'policy'),
                      'dockerConfig': str(root / 'docker'), 'nodePath': str(node),
                      'nodeSha256': node_hash, 'trustedIngress': None}
            path = root / 'apply.json'; path.write_text(json.dumps(config)); path.chmod(0o600)
            runner = daemon.HostApply(str(path), str(root / 'journal.sqlite'), '/root/active', object())
            fd = runner._node(); os.close(fd)
            runner.config['nodeSha256'] = 'a' * 64
            with self.assertRaises(supervisor.SupervisorError): runner._node()
            path.chmod(0o644)
            with self.assertRaises(supervisor.SupervisorError):
                daemon.HostApply(str(path), str(root / 'journal.sqlite'), '/root/active', object())

    def test_host_apply_uses_only_host_configuration_and_closes_resources(self):
        with tempfile.TemporaryDirectory(dir='/root') as temporary:
            root = Path(temporary)
            for name in ('backup', 'policy', 'docker'):
                (root / name).mkdir(mode=0o700)
            node = Path(os.path.realpath(sys.executable))
            config = {'backupRoot': str(root / 'backup'), 'policyRoot': str(root / 'policy'),
                      'dockerConfig': str(root / 'docker'), 'nodePath': str(node),
                      'nodeSha256': daemon.hashlib.sha256(node.read_bytes()).hexdigest(), 'trustedIngress': None}
            path = root / 'apply.json'; path.write_text(json.dumps(config)); path.chmod(0o600)
            runner = daemon.HostApply(str(path), str(root / 'journal.sqlite'), '/root/active', object())
            journal = mock.Mock()
            updater_module = SimpleNamespace(Journal=mock.Mock(return_value=journal))
            apply = mock.Mock(return_value={'fixture': True})
            modules = {'servus-updater': updater_module, 'update-coordinator': SimpleNamespace(apply_prepared_update=apply),
                       'runtime-policy': object(), 'extract-install': object(), 'quiescence': object(), 'backup': object(), 'verify-release': object()}
            def load(_module_name, filename, mode):
                return modules[filename.removesuffix('.py')]
            operation = str(uuid.uuid4()); hub = object(); maintenance = object()
            with mock.patch.object(runner, '_load', side_effect=load):
                self.assertEqual(runner(operation, hub, maintenance), {'fixture': True})
            self.assertEqual(apply.call_args.args[1:4], (operation, hub, maintenance))
            self.assertEqual(apply.call_args.args[5:10], (str(root / 'journal.sqlite'), '/root/active', str(root / 'backup'), str(root / 'policy'), str(root / 'docker')))
            journal.close.assert_called_once()
            with self.assertRaises(OSError): os.fstat(apply.call_args.args[10])

    def test_apply_command_requires_enabled_handler_exact_fields_and_approved_hub(self):
        operation_id = str(uuid.uuid4())
        policy = object()
        for scenario in ('allowed', 'disabled', 'extra', 'changed_policy'):
            with self.subTest(scenario=scenario):
                server, client = socket.socketpair()
                listener = SimpleNamespace(accept=lambda: (server, None))
                hub = SimpleNamespace(used=False, connections={role: object() for role in supervisor.ROLES}, policy=policy)
                state = {'locked': False}
                class Operation:
                    def __enter__(self): state['locked'] = True; return self
                    def __exit__(self, *_): state['locked'] = False
                def run_update(value, passed_hub, _operation):
                    self.assertTrue(state['locked'])
                    self.assertEqual(value, operation_id)
                    self.assertIs(passed_hub, hub)
                apply = mock.Mock(side_effect=run_update)
                request = {'version': 1, 'type': 'apply', 'operationId': operation_id}
                if scenario == 'extra': request['image'] = 'untrusted'
                client.sendall(json.dumps(request).encode() + b'\n')
                try:
                    approved = object() if scenario == 'changed_policy' else policy
                    with mock.patch.object(supervisor, 'MaintenanceSupervisor', return_value=Operation()), mock.patch.object(daemon, 'load_approved_policy', return_value=approved):
                        daemon.handle_command(listener, hub, '/install', '/gate', '/journal', '/policy', '/approval', '/env', apply=None if scenario == 'disabled' else apply)
                    self.assertEqual(json.loads(client.recv(4096))['status'], 'starting' if scenario == 'allowed' else 'failed')
                    self.assertEqual(apply.call_count, 1 if scenario == 'allowed' else 0)
                finally:
                    client.close()

    def test_resolves_current_policy_generation_and_rejects_drift(self):
        with tempfile.TemporaryDirectory(dir='/root') as temporary:
            path = Path(temporary) / 'journal.sqlite'
            with sqlite3.connect(path) as db:
                db.execute('CREATE TABLE policy_approvals(policy_path TEXT,accepted_env_path TEXT,source_env_path TEXT,state TEXT)')
                db.execute('INSERT INTO policy_approvals VALUES(?,?,?,?)', ('/root/new-policy', '/root/new-env', '/root/active-env', 'active'))
            os.chmod(path, 0o600)
            policy = object()
            with mock.patch.object(daemon, 'load_approved_policy', return_value=policy) as load:
                self.assertEqual(daemon.resolve_active_policy(str(path), '/root/active-env'), ('/root/new-policy', '/root/new-env', policy))
                load.assert_called_once_with('/root/new-policy', str(path), '/root/new-env')
                with self.assertRaises(supervisor.SupervisorError):
                    daemon.resolve_active_policy(str(path), '/root/other-env')
            def change(*_):
                with sqlite3.connect(path) as db:
                    db.execute("UPDATE policy_approvals SET policy_path='/root/different-policy'")
                return policy
            with mock.patch.object(daemon, 'load_approved_policy', side_effect=change):
                with self.assertRaises(supervisor.SupervisorError):
                    daemon.resolve_active_policy(str(path), '/root/active-env')

    def test_binding_uses_approved_policy_matching_hub(self):
        hub = SimpleNamespace(policy=object())
        def read(path, maximum):
            return b'policy' if path == '/root/policy' else b'environment'
        with mock.patch.object(daemon, 'load_approved_policy', return_value=hub.policy), mock.patch.object(daemon, '_private_file', side_effect=read):
            binding = daemon.approved_policy_binding(hub, '/root/policy', '/root/journal', '/root/environment')
            self.assertEqual(binding[0], '/root/policy')
            self.assertEqual(binding[1], 'sha256:' + daemon.hashlib.sha256(b'environment').hexdigest())
            self.assertEqual(binding[2], 'sha256:' + daemon.hashlib.sha256(b'policy').hexdigest())
            self.assertIs(binding[3], hub.policy)
        with mock.patch.object(daemon, 'load_approved_policy', return_value=object()):
            with self.assertRaises(supervisor.SupervisorError):
                daemon.approved_policy_binding(hub, '/root/policy', '/root/journal', '/root/environment')

    def test_ownership_rejects_lost_lock_and_closed_handle(self):
        with tempfile.TemporaryDirectory(dir='/root') as temporary:
            root = Path(temporary)
            control, journal = root / 'control', root / 'journal'
            control.mkdir(mode=0o750); journal.mkdir(mode=0o700)
            os.chown(control, 0, 1000)
            ownership = daemon.DaemonOwnership(str(control), str(journal), 1000)
            try:
                ownership.assert_held(str(control))
                fcntl.flock(ownership.lock, fcntl.LOCK_UN)
                with self.assertRaises(supervisor.SupervisorError):
                    ownership.assert_held(str(control))
            finally:
                ownership.close()
            with self.assertRaises(supervisor.SupervisorError):
                ownership.assert_held(str(control))

    def test_status_rechecks_approval_with_lock_before_reporting_ready(self):
        for scenario in ('valid', 'changed_env', 'recovery_required'):
            with self.subTest(scenario=scenario):
                command, client = socket.socketpair()
                pairs = [socket.socketpair() for _ in supervisor.ROLES]
                marker = object()
                hub = SimpleNamespace(used=False, policy=marker,
                                      connections=dict(zip(supervisor.ROLES, [pair[0] for pair in pairs])))
                listener = SimpleNamespace(accept=lambda: (command, None))
                state = {'locked': False}
                class Operation:
                    def __enter__(self): state['locked'] = True; return self
                    def __exit__(self, *_): state['locked'] = False
                def recheck(*_, **__):
                    self.assertTrue(state['locked'])
                    if scenario != 'valid': raise supervisor.SupervisorError('Approval invalid')
                    return marker
                client.sendall(b'{"version":1,"type":"status"}\n')
                try:
                    with mock.patch.object(supervisor, 'MaintenanceSupervisor', return_value=Operation()), \
                         mock.patch.object(daemon, 'load_approved_policy', side_effect=recheck):
                        daemon.handle_command(listener, hub, '/install', '/gate', '/journal', '/policy', '/approval', '/env')
                    result = json.loads(client.recv(4096))
                    self.assertEqual(result['status'], 'ready' if scenario == 'valid' else 'waiting')
                finally:
                    client.close()
                    for first, second in pairs: first.close(); second.close()

    def test_stop_rechecks_approval_while_installation_lock_is_held(self):
        original = object()
        for scenario in ('valid', 'changed_policy', 'changed_env', 'recovery_required'):
            with self.subTest(scenario=scenario):
                server, client = socket.socketpair()
                listener = SimpleNamespace(accept=lambda: (server, None))
                hub = SimpleNamespace(used=False, connections={role: object() for role in supervisor.ROLES}, policy=original)
                state = {'locked': False, 'stopped': False, 'checked': False}
                class Operation:
                    def __enter__(self): state['locked'] = True; return self
                    def __exit__(self, *_): state['locked'] = False
                    def stop_after_drain(self, *_):
                        self_assert(state['locked'] and state['checked'])
                        state['stopped'] = True
                        return 'stopped_unverified'
                def self_assert(condition):
                    self.assertTrue(condition)
                def recheck(*_, **__):
                    self.assertTrue(state['locked'])
                    state['checked'] = True
                    if scenario in ('changed_env', 'recovery_required'):
                        raise supervisor.SupervisorError('Approval no longer valid')
                    return object() if scenario == 'changed_policy' else original
                message = {'version':1, 'type':'stop', 'operationId':str(uuid.uuid4()), 'timeoutMs':5000}
                client.sendall(json.dumps(message).encode() + b'\n')
                with mock.patch.object(supervisor, 'MaintenanceSupervisor', return_value=Operation()), \
                     mock.patch.object(daemon, 'load_approved_policy', side_effect=recheck):
                    daemon.handle_command(listener, hub, '/install', '/gate', '/journal', '/policy', '/approval', '/env')
                result = json.loads(client.recv(4096))
                client.close()
                self.assertTrue(state['checked'])
                self.assertEqual(state['stopped'], scenario == 'valid')
                self.assertEqual(result['status'], 'stopped_unverified' if scenario == 'valid' else 'failed')

    def test_sigkill_abandoned_sockets_restarted_and_journal_blocks_recovery(self):
        with tempfile.TemporaryDirectory(dir='/root') as temporary:
            root = Path(temporary)
            control, journal = root / 'control', root / 'journal'
            control.mkdir(mode=0o750)
            journal.mkdir(mode=0o700)
            os.chown(control, 0, 1000)
            read_fd, write_fd = os.pipe()
            pid = os.fork()
            if pid == 0:
                os.close(read_fd)
                try:
                    ownership = daemon.DaemonOwnership(str(control), str(journal), 1000)
                    endpoint = supervisor.ComponentEndpoint()
                    endpoint.listen(str(control), 1000)
                    command, command_fd, _ = daemon.command_listener(str(control))
                    os.write(write_fd, b'1')
                    signal.pause()
                finally:
                    os._exit(0)
            os.close(write_fd)
            try:
                self.assertEqual(os.read(read_fd, 1), b'1')
                with self.assertRaises(OSError):
                    daemon.DaemonOwnership(str(control), str(journal), 1000)
                os.kill(pid, signal.SIGKILL)
                os.waitpid(pid, 0)
                pid = None
                (journal / 'maintenance.json').write_text('{}')
                with self.assertRaises(supervisor.SupervisorError):
                    daemon.DaemonOwnership(str(control), str(journal), 1000)
                self.assertTrue((control / 'socket').is_socket())
                self.assertTrue((control / 'command').is_socket())
                (journal / 'maintenance.json').unlink()
                ownership = daemon.DaemonOwnership(str(control), str(journal), 1000)
                try:
                    self.assertFalse((control / 'socket').exists())
                    self.assertFalse((control / 'command').exists())
                    endpoint = supervisor.ComponentEndpoint()
                    try:
                        endpoint.listen(str(control), 1000)
                        command, fd, _ = daemon.command_listener(str(control))
                        command.close()
                        os.unlink('command', dir_fd=fd)
                        os.close(fd)
                    finally:
                        endpoint.close()
                finally:
                    ownership.close()
            finally:
                os.close(read_fd)
                if pid is not None:
                    os.kill(pid, signal.SIGKILL)
                    os.waitpid(pid, 0)

    def test_sigkill_during_socket_initialization_can_restart(self):
        for stage in ('component_before_chown', 'component_before_chmod', 'command_before_chmod'):
            with self.subTest(stage=stage), tempfile.TemporaryDirectory(dir='/root') as temporary:
                root = Path(temporary)
                control, journal = root / 'control', root / 'journal'
                control.mkdir(mode=0o750)
                journal.mkdir(mode=0o700)
                os.chown(control, 0, 1000)
                read_fd, write_fd = os.pipe()
                pid = os.fork()
                if pid == 0:
                    os.close(read_fd)
                    os.umask(0o077)
                    try:
                        ownership = daemon.DaemonOwnership(str(control), str(journal), 1000)
                        def pause(*_args, **_kwargs):
                            os.write(write_fd, b'1')
                            signal.pause()
                        target = 'chown' if stage == 'component_before_chown' else 'chmod'
                        with mock.patch.object(os, target, side_effect=pause):
                            if stage.startswith('component'):
                                supervisor.ComponentEndpoint().listen(str(control), 1000)
                            else:
                                daemon.command_listener(str(control))
                    finally:
                        os._exit(0)
                os.close(write_fd)
                try:
                    self.assertEqual(os.read(read_fd, 1), b'1')
                    os.kill(pid, signal.SIGKILL)
                    os.waitpid(pid, 0)
                    pid = None
                    name = 'socket' if stage.startswith('component') else 'command'
                    self.assertEqual((control / name).stat().st_mode & 0o777, 0o700)
                    ownership = daemon.DaemonOwnership(str(control), str(journal), 1000)
                    try:
                        self.assertFalse((control / name).exists())
                    finally:
                        ownership.close()
                finally:
                    os.close(read_fd)
                    if pid is not None:
                        os.kill(pid, signal.SIGKILL)
                        os.waitpid(pid, 0)

    def test_active_or_unsafe_socket_is_never_removed(self):
        with tempfile.TemporaryDirectory(dir='/root') as temporary:
            root = Path(temporary)
            control, journal = root / 'control', root / 'journal'
            control.mkdir(mode=0o750)
            journal.mkdir(mode=0o700)
            os.chown(control, 0, 1000)
            endpoint = supervisor.ComponentEndpoint()
            try:
                endpoint.listen(str(control), 1000)
                with self.assertRaises(supervisor.SupervisorError):
                    daemon.DaemonOwnership(str(control), str(journal), 1000)
                self.assertTrue((control / 'socket').is_socket())
            finally:
                endpoint.close()
            (control / 'socket').write_text('not a socket')
            with self.assertRaises(supervisor.SupervisorError):
                daemon.DaemonOwnership(str(control), str(journal), 1000)
            self.assertTrue((control / 'socket').is_file())

    def test_failed_component_registration_refreshes_hub_in_real_run(self):
        with tempfile.TemporaryDirectory(dir='/root') as temporary:
            root = Path(temporary)
            control, journal = root / 'control', root / 'journal'
            control.mkdir(mode=0o750)
            journal.mkdir(mode=0o700)
            os.chown(control, 0, 1000)
            args = SimpleNamespace(uid=1000, gid=1000, policy='unused', install_dir='/install',
                                   gate_dir='/gate', journal_dir=str(journal), secret_dir='/secrets', socket_dir=str(control),
                                   approval_journal='/approval', accepted_env='/env')
            policy = SimpleNamespace(install_dir='/install', gate_dir='/gate', control_dir=str(control))
            created = []
            first_inspection = threading.Event()
            listener_ready = threading.Event()
            real_listen = supervisor.ComponentEndpoint.listen
            def listen(endpoint, *arguments):
                result = real_listen(endpoint, *arguments)
                listener_ready.set()
                return result
            def inspect(_policy):
                if not first_inspection.is_set():
                    first_inspection.set()
                    return {'previous': True}
                return {'new': True}
            class FakeHub:
                used = False
                connections = {}
                identities = {'previous': True}
                def __init__(self, listener, *_):
                    created.append(self)
                    if len(created) == 2:
                        raise StopIteration()
                    self.listener = listener
                def accept(self, timeout):
                    conn, _ = self.listener.accept()
                    conn.close()
                    raise supervisor.SupervisorError('Container identity changed')
                def close(self):
                    pass
            errors = []
            startup = {'locked': False, 'validated': False}
            class StartupLock:
                def __enter__(self): startup['locked'] = True; return self
                def __exit__(self, *_): startup['locked'] = False
            def load_under_lock(*_):
                self.assertTrue(startup['locked'])
                startup['validated'] = True
                return policy
            def target():
                try:
                    daemon.run(args)
                except StopIteration:
                    pass
                except BaseException as error:
                    errors.append(error)
            with mock.patch.object(daemon, 'load_approved_policy', side_effect=load_under_lock), \
                    mock.patch.object(supervisor, 'MaintenanceSupervisor', side_effect=lambda *_: StartupLock()), \
                    mock.patch.object(daemon.signal, 'signal'), \
                    mock.patch.object(supervisor.ComponentEndpoint, 'read_component_tokens', return_value={}), \
                    mock.patch.object(supervisor.ComponentEndpoint, 'listen', autospec=True, side_effect=listen), \
                    mock.patch.object(supervisor, 'DrainHub', FakeHub), \
                    mock.patch.object(supervisor, 'inspect_servus', side_effect=inspect):
                thread = threading.Thread(target=target, daemon=True)
                thread.start()
                self.assertTrue(listener_ready.wait(5))
                with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
                    client.connect(str(control / 'socket'))
                self.assertTrue(first_inspection.wait(5))
                self.assertEqual(len(created), 1)
                with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
                    client.connect(str(control / 'socket'))
                thread.join(5)
            self.assertFalse(thread.is_alive())
            self.assertTrue(startup['validated'])
            self.assertEqual(errors, [])
            self.assertEqual(len(created), 2)

    def test_command_socket_failure_cleans_its_own_inode(self):
        with tempfile.TemporaryDirectory(dir='/root') as temporary:
            path = Path(temporary) / 'control'
            path.mkdir(mode=0o750)
            with mock.patch.object(daemon.os, 'chmod', side_effect=PermissionError):
                with self.assertRaises(PermissionError):
                    daemon.command_listener(str(path))
            self.assertFalse((path / 'command').exists())

    def test_host_mount_order_is_ignored_but_duplicate_targets_are_rejected(self):
        first = {'Type': 'bind', 'Source': '/one', 'Target': '/one', 'ReadOnly': True}
        second = {'Type': 'bind', 'Source': '/two', 'Target': '/two', 'ReadOnly': False}
        left = supervisor._normalize_host_config({'Mounts': [first, second]})
        right = supervisor._normalize_host_config({'Mounts': [second, first]})
        self.assertEqual(left, right)
        with self.assertRaises(supervisor.SupervisorError):
            supervisor._normalize_host_config({'Mounts': [first, dict(first)]})
        with self.assertRaises(supervisor.SupervisorError):
            supervisor._normalize_host_config({'Mounts': [first, {**second, 'Target': '/one'}]})
        changed = supervisor._normalize_host_config({'Mounts': [first, {**second, 'ReadOnly': True}]})
        self.assertNotEqual(left, changed)

    def test_endpoint_does_not_acquire_installer_lock(self):
        with tempfile.TemporaryDirectory(dir='/root') as temporary:
            root = Path(temporary)
            control = root / 'control'
            control.mkdir(mode=0o750)
            os.chown(control, 0, 1000)
            lock_path = root / 'install.lock'
            fd = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600)
            endpoint = supervisor.ComponentEndpoint()
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                endpoint.listen(str(control), 1000)
                self.assertTrue((control / 'socket').is_socket())
            finally:
                endpoint.close()
                os.close(fd)
            self.assertFalse((control / 'socket').exists())

    def test_policy_must_be_root_owned_private_regular_file(self):
        with tempfile.TemporaryDirectory(dir='/root') as temporary:
            path = Path(temporary) / 'policy.json'
            path.write_text('{}')
            path.chmod(0o644)
            with self.assertRaises(supervisor.SupervisorError):
                daemon.load_policy(str(path))
            path.chmod(0o600)
            with self.assertRaises(supervisor.SupervisorError):
                daemon.load_policy(str(path))
            path.unlink()
            path.symlink_to('/etc/passwd')
            with self.assertRaises(OSError):
                daemon.load_policy(str(path))

    def test_command_socket_is_private_and_not_replaced(self):
        with tempfile.TemporaryDirectory(dir='/root') as temporary:
            path = Path(temporary) / 'control'
            path.mkdir(mode=0o750)
            server, fd, identity = daemon.command_listener(str(path))
            try:
                self.assertEqual((path / 'command').stat().st_mode & 0o777, 0o600)
                with self.assertRaises(supervisor.SupervisorError):
                    daemon.command_listener(str(path))
            finally:
                server.close()
                os.unlink('command', dir_fd=fd)
                os.close(fd)
