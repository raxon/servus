import importlib.util
import fcntl
import os
import pathlib
import sqlite3
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('policy_fence', ROOT / 'apps/updater/reconcile-policy-fence.py')
fence = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fence)
OP = '12345678-1234-4123-8123-123456789abc'
PREP = '12345678-1234-4123-8123-123456789abd'
NAME = 'servus-extract-' + 'b' * 32
PROJECT = 'servusprobe' + 'c' * 32
INACTIVE = 'LoadState=loaded\nActiveState=inactive\nControlGroup=\n'


class RecoveryFenceTest(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(':memory:')
        self.db.executescript('''CREATE TABLE preparations(operation_id TEXT,preparation_id TEXT,status TEXT);
        CREATE TABLE extraction_probes(operation_id TEXT,name TEXT,status TEXT);
        CREATE TABLE policy_probes(operation_id TEXT,project TEXT,state TEXT);''')
        self.db.execute('INSERT INTO preparations VALUES(?,?,?)', (OP, PREP, 'recovery_required'))
        self.db.execute('INSERT INTO extraction_probes VALUES(?,?,?)', (OP, NAME, 'removed'))
        self.db.execute('INSERT INTO policy_probes VALUES(?,?,?)', (OP, PROJECT, 'removed'))

    def tearDown(self):
        self.db.close()

    def test_checks_every_recorded_unit_and_docker_resource(self):
        commands = []
        def execute(command):
            commands.append(command)
            return INACTIVE if command[0].endswith('systemctl') else ''
        fence.assert_stopped(self.db, OP, execute=execute)
        self.assertEqual(len(commands), 8)
        self.assertIn('servus-prepare-' + PREP.replace('-', '') + '.service', commands[2])
        self.assertIn('name=^/' + NAME + '$', commands[3])
        self.assertIn('name=^' + PROJECT + '_default$', commands[4])
        for command in commands[5:]:
            self.assertIn('label=com.docker.compose.project=' + PROJECT, command)

    def test_rejects_uncertain_unit_status(self):
        for status in ('LoadState=loaded\nActiveState=active\nControlGroup=/x\n',
                       'LoadState=loaded\nActiveState=inactive\nControlGroup=/x\n',
                       'LoadState=not-found\nActiveState=inactive\nControlGroup=\n',
                       'LoadState=loaded\nActiveState=inactive\n',
                       INACTIVE + 'ActiveState=inactive\n'):
            with self.subTest(status=status), self.assertRaises(fence.FenceError):
                fence.assert_stopped(self.db, OP, execute=lambda _: status)

    def test_rejects_remaining_docker_objects(self):
        for resource in ('container', 'network', 'volume'):
            def execute(command):
                if command[0].endswith('systemctl'): return INACTIVE
                return 'object\n' if command[1] == resource else ''
            with self.subTest(resource=resource), self.assertRaises(fence.FenceError):
                fence.assert_stopped(self.db, OP, execute=execute)

    def test_rejects_unresolved_or_malformed_journal_evidence(self):
        for sql in ("UPDATE extraction_probes SET status='intent'", "UPDATE extraction_probes SET name='bad'",
                    "UPDATE policy_probes SET state='intent'", "UPDATE policy_probes SET project='bad'",
                    "UPDATE preparations SET status='prepared'"):
            with self.subTest(sql=sql):
                self.db.execute('SAVEPOINT fixture'); self.db.execute(sql)
                with self.assertRaises(fence.FenceError):
                    fence.assert_stopped(self.db, OP, execute=lambda command: INACTIVE if command[0].endswith('systemctl') else '')
                self.db.execute('ROLLBACK TO fixture'); self.db.execute('RELEASE fixture')

    @unittest.skipUnless(os.geteuid() == 0, 'Requires root-owned lock fixtures')
    def test_holds_both_locks_for_entire_reconciliation(self):
        with tempfile.TemporaryDirectory() as directory:
            state = pathlib.Path(directory) / 'state'; state.mkdir(mode=0o700)
            install = pathlib.Path(directory) / 'install'; install.mkdir(mode=0o700)
            (state / 'maintenance').mkdir(mode=0o700)
            for path in (state / 'service.lock', install / 'install.lock'):
                path.touch(mode=0o600)
            state_fd = os.open(state, os.O_RDONLY | os.O_DIRECTORY)
            install_fd = os.open(install, os.O_RDONLY | os.O_DIRECTORY)
            calls = []
            class Journal:
                @staticmethod
                def archive_and_reconcile(*args):
                    for path in (state / 'service.lock', install / 'install.lock'):
                        fd = os.open(path, os.O_RDONLY)
                        try:
                            with unittest.TestCase().assertRaises(BlockingIOError):
                                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                        finally:
                            os.close(fd)
                    calls.append(args[1])
            try:
                fence.fenced_reconcile(self.db, OP, state_fd, install_fd, -1, -1, Journal,
                                       execute=lambda command: INACTIVE if command[0].endswith('systemctl') else '')
            finally:
                os.close(state_fd); os.close(install_fd)
            self.assertEqual(calls, [OP])

    @unittest.skipUnless(os.geteuid() == 0, 'Requires root-owned lock fixtures')
    def test_refuses_held_lock_and_existing_maintenance_marker(self):
        with tempfile.TemporaryDirectory() as directory:
            state = pathlib.Path(directory) / 'state'; state.mkdir(mode=0o700)
            install = pathlib.Path(directory) / 'install'; install.mkdir(mode=0o700)
            maintenance = state / 'maintenance'; maintenance.mkdir(mode=0o700)
            for path in (state / 'service.lock', install / 'install.lock'):
                path.touch(mode=0o600)
            state_fd = os.open(state, os.O_RDONLY | os.O_DIRECTORY)
            install_fd = os.open(install, os.O_RDONLY | os.O_DIRECTORY)
            lock_fd = os.open(state / 'service.lock', os.O_RDONLY)
            try:
                fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                with self.assertRaises(fence.FenceError):
                    with fence.hold_locks(state_fd, install_fd): pass
                fcntl.flock(lock_fd, fcntl.LOCK_UN)
                (maintenance / 'maintenance.json').touch()
                with self.assertRaises(fence.FenceError):
                    fence.assert_no_maintenance(state_fd)
            finally:
                os.close(lock_fd); os.close(state_fd); os.close(install_fd)


if __name__ == '__main__':
    unittest.main()
