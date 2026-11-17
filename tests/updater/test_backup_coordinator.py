import importlib.util
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import unittest
import uuid

FILE = Path(__file__).resolve().parents[2] / 'apps/updater/backup-coordinator.py'
SPEC = importlib.util.spec_from_file_location('backup_coordinator', FILE)
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)
OP = '12345678-1234-4123-8123-123456789abc'
OTHER = '12345678-1234-4123-8123-123456789abd'


@unittest.skipUnless(sys.platform == 'linux' and os.geteuid() == 0, 'Requires isolated root Linux')
class CoordinatorTest(unittest.TestCase):
    def setUp(self):
        self.path = Path('/tmp') / ('servus-backup-fixture-' + uuid.uuid4().hex)
        self.path.mkdir(mode=0o700)
        marker = self.path / '.fixture'
        marker.write_bytes(module.MARKER)
        marker.chmod(0o600)

    def tearDown(self):
        shutil.rmtree(self.path)

    def test_states_are_durable_and_never_authorize_capture(self):
        with module.Coordinator(str(self.path)) as c:
            self.assertEqual(c.submit(OP)['state'], 'requested')
            self.assertEqual(c.submit(OP)['state'], 'requested')
            with self.assertRaises(module.CoordinatorError):
                c.submit(OTHER)
            self.assertEqual(c.advance(OP)['state'], 'awaiting_quiescence')
        with module.Coordinator(str(self.path)) as c:
            self.assertEqual(c.status(OP)['state'], 'awaiting_quiescence')
            self.assertEqual(c.advance(OP), {'operationId': OP, 'state': 'blocked', 'reason': 'quiescence_unverified'})
            self.assertEqual(c.advance(OP)['state'], 'blocked')
            self.assertEqual(c.submit(OP)['state'], 'blocked')
            self.assertEqual(c.submit(OTHER)['state'], 'requested')
        self.assertEqual((self.path / 'journal.sqlite').stat().st_mode & 0o777, 0o600)
        self.assertEqual((self.path / 'coordinator.lock').stat().st_mode & 0o777, 0o600)

    def test_second_coordinator_cannot_bypass_lock(self):
        with module.Coordinator(str(self.path)) as first:
            first.submit(OP)
            with self.assertRaises(module.CoordinatorError):
                module.Coordinator(str(self.path))
            self.assertEqual(first.status(OP)['state'], 'requested')

    def test_killed_process_recovers_journal_and_lock(self):
        code = '''import importlib.util,sys,time\ns=importlib.util.spec_from_file_location("b",sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\nc=m.Coordinator(sys.argv[2]);c.submit(sys.argv[3]);c.advance(sys.argv[3]);print("ready",flush=True);time.sleep(60)'''
        process = subprocess.Popen([sys.executable, '-c', code, str(FILE), str(self.path), OP], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            self.assertEqual(process.stdout.readline().strip(), 'ready')
            process.kill()
            process.wait(timeout=5)
            with module.Coordinator(str(self.path)) as recovered:
                self.assertEqual(recovered.status(OP)['state'], 'awaiting_quiescence')
                self.assertEqual(recovered.advance(OP)['state'], 'blocked')
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()
            process.stdout.close()
            process.stderr.close()

    def test_rejects_invalid_ids_paths_marker_and_symlinks(self):
        with module.Coordinator(str(self.path)) as c:
            for bad in ('../x', '', 'A' * 36, None):
                with self.assertRaises(module.CoordinatorError):
                    c.submit(bad)
            with self.assertRaises(module.CoordinatorError):
                c.advance(OP)
        for bad in ('/etc/servus', str(self.path / '..' / self.path.name)):
            with self.assertRaises(module.CoordinatorError):
                module.Coordinator(bad)
        marker = self.path / '.fixture'
        marker.unlink()
        marker.symlink_to('/etc/passwd')
        with self.assertRaises((module.CoordinatorError, OSError)):
            module.Coordinator(str(self.path))

    def test_unsafe_journal_and_directory_are_rejected(self):
        journal = self.path / 'journal.sqlite'
        journal.symlink_to('/etc/passwd')
        with self.assertRaises((module.CoordinatorError, OSError)):
            module.Coordinator(str(self.path))
        journal.unlink()
        self.path.chmod(0o777)
        with self.assertRaises(module.CoordinatorError):
            module.Coordinator(str(self.path))
        self.path.chmod(0o700)


if __name__ == '__main__':
    unittest.main()
