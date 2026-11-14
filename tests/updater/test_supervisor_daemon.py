import fcntl
import signal
import threading
import time
from types import SimpleNamespace
from unittest import mock
import importlib.util
import os
from pathlib import Path
import socket
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'apps/updater'))
import supervisor
spec = importlib.util.spec_from_file_location('supervisor_daemon', ROOT / 'apps/updater/supervisor-daemon.py')
daemon = importlib.util.module_from_spec(spec)
spec.loader.exec_module(daemon)


@unittest.skipUnless(sys.platform == 'linux' and os.geteuid() == 0, 'Requires isolated Linux root')
class DaemonTest(unittest.TestCase):
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
                                   gate_dir='/gate', journal_dir=str(journal), secret_dir='/secrets', socket_dir=str(control))
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
            def target():
                try:
                    daemon.run(args)
                except StopIteration:
                    pass
                except BaseException as error:
                    errors.append(error)
            with mock.patch.object(daemon, 'load_policy', return_value=policy), \
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
