import fcntl
import importlib.util
import os
import pathlib
import shutil
import signal
import stat
import sys
import time
import unittest
import uuid

PATH = pathlib.Path(__file__).resolve().parents[2] / 'apps/updater/lifecycle-host.py'
spec = importlib.util.spec_from_file_location('lifecycle_host', PATH)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


@unittest.skipUnless(sys.platform == 'linux' and os.geteuid() == 0, 'requires isolated root Linux')
class LifecycleHostTest(unittest.TestCase):
    def setUp(self):
        self.name = 'servus-lifecycle-fixture-' + uuid.uuid4().hex
        self.path = pathlib.Path('/tmp') / self.name
        module.initialize(self.name)

    def tearDown(self):
        shutil.rmtree(self.path, ignore_errors=True)

    def test_initial_state_and_preserved_lock(self):
        lock_before = (self.path / 'lock').stat().st_ino
        gate = module.FixtureGate(self.name)
        try:
            self.assertEqual(gate.read_state(), module.NORMAL)
            gate.enter_maintenance()
            gate.enter_maintenance()
            self.assertEqual(gate.read_state(), module.MAINTENANCE)
            self.assertEqual((self.path / 'lock').stat().st_ino, lock_before)
            self.assertTrue(gate.exclusive_available())
            self.assertFalse(hasattr(gate, 'enter_normal'))
        finally:
            gate.close()

    def test_flock_detects_live_reader(self):
        fd = os.open(self.path / 'lock', os.O_RDONLY)
        gate = module.FixtureGate(self.name)
        try:
            fcntl.flock(fd, fcntl.LOCK_SH)
            self.assertFalse(gate.exclusive_available())
            fcntl.flock(fd, fcntl.LOCK_UN)
            self.assertTrue(gate.exclusive_available())
        finally:
            gate.close()
            os.close(fd)

    def test_no_existing_directory_adoption(self):
        with self.assertRaises(FileExistsError):
            module.initialize(self.name)
        self.assertEqual((self.path / 'state').read_bytes(), module.NORMAL)

    def test_unsafe_state_or_lock_refused(self):
        for name in ('state', 'lock'):
            path = self.path / name
            original = path.read_bytes()
            path.unlink()
            path.symlink_to('/etc/passwd')
            with self.assertRaises(OSError):
                module.FixtureGate(self.name)
            path.unlink()
            path.write_bytes(original)
            path.chmod(0o666)
            with self.assertRaises(module.LifecycleError):
                module.FixtureGate(self.name)
            path.chmod(0o644)

    def test_hardlink_and_lock_replacement_refused(self):
        gate = module.FixtureGate(self.name)
        try:
            lock = self.path / 'lock'
            lock.rename(self.path / 'previous')
            lock.write_bytes(b'')
            lock.chmod(0o644)
            with self.assertRaises(module.LifecycleError):
                gate.exclusive_available()
        finally:
            gate.close()
        os.link(self.path / 'state', self.path / 'state-link')
        with self.assertRaises(module.LifecycleError):
            module.FixtureGate(self.name)

    def test_kill_after_atomic_state_transition(self):
        child = os.fork()
        if child == 0:
            gate = module.FixtureGate(self.name)
            gate.enter_maintenance()
            os.kill(os.getpid(), signal.SIGSTOP)
            os._exit(0)
        try:
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                pid, status = os.waitpid(child, os.WNOHANG | os.WUNTRACED)
                if pid == child and os.WIFSTOPPED(status):
                    break
                time.sleep(0.01)
            else:
                self.fail('Child did not reach transition')
            os.kill(child, signal.SIGKILL)
            os.waitpid(child, 0)
            child = 0
            gate = module.FixtureGate(self.name)
            try:
                self.assertEqual(gate.read_state(), module.MAINTENANCE)
            finally:
                gate.close()
        finally:
            if child:
                os.kill(child, signal.SIGKILL)
                os.waitpid(child, 0)

    def test_simultaneous_maintenance_is_valid_and_preserves_lock(self):
        before = (self.path / 'lock').stat().st_ino
        children = []
        for _ in range(2):
            child = os.fork()
            if child == 0:
                try:
                    gate = module.FixtureGate(self.name)
                    gate.enter_maintenance()
                    gate.close()
                    os._exit(0)
                except BaseException:
                    os._exit(1)
            children.append(child)
        for child in children:
            _, status = os.waitpid(child, 0)
            self.assertTrue(os.WIFEXITED(status) and os.WEXITSTATUS(status) == 0)
        self.assertEqual((self.path / 'state').read_bytes(), module.MAINTENANCE)
        self.assertEqual((self.path / 'lock').stat().st_ino, before)

    def test_retry_syncs_state_after_kill_between_rename_and_directory_fsync(self):
        child = os.fork()
        if child == 0:
            gate = module.FixtureGate(self.name)
            real_fsync = os.fsync
            def pause_before_directory_sync(fd):
                if stat.S_ISDIR(os.fstat(fd).st_mode) and (self.path / 'state').read_bytes() == module.MAINTENANCE:
                    os.kill(os.getpid(), signal.SIGSTOP)
                return real_fsync(fd)
            os.fsync = pause_before_directory_sync
            gate.enter_maintenance()
            os._exit(1)
        try:
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                pid, status = os.waitpid(child, os.WNOHANG | os.WUNTRACED)
                if pid == child and os.WIFSTOPPED(status):
                    break
                time.sleep(0.01)
            else:
                self.fail('Child did not reach post-rename boundary')
            os.kill(child, signal.SIGKILL)
            os.waitpid(child, 0)
            child = 0
            self.assertEqual((self.path / 'state').read_bytes(), module.MAINTENANCE)
            gate = module.FixtureGate(self.name)
            real_fsync = os.fsync
            synced = []
            def record_fsync(fd):
                synced.append(os.fstat(fd).st_mode)
                return real_fsync(fd)
            try:
                os.fsync = record_fsync
                gate.enter_maintenance()
            finally:
                os.fsync = real_fsync
                gate.close()
            self.assertTrue(any(stat.S_ISREG(mode) for mode in synced))
            self.assertTrue(any(stat.S_ISDIR(mode) for mode in synced))
        finally:
            if child:
                os.kill(child, signal.SIGKILL)
                os.waitpid(child, 0)

    def test_production_paths_refused(self):
        for value in ('/etc/servus', '../servus', 'servus-lifecycle-fixture-bad'):
            with self.assertRaises(module.LifecycleError):
                module.FixtureGate(value)


if __name__ == '__main__':
    unittest.main()
