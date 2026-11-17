import importlib.util
import os
import pathlib
import sqlite3
import subprocess
import tempfile
import unittest
from unittest import mock
import test_updater

ROOT = pathlib.Path(__file__).resolve().parents[2]

def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

updater = load('updater', ROOT / 'apps/updater/servus-updater.py')
fence = load('preparation_fence', ROOT / 'apps/updater/preparation-fence.py')
policy = load('runtime_policy', ROOT / 'apps/updater/runtime-policy.py')
OP = '12345678-1234-4123-8123-123456789abc'
DIGEST = 'sha256:' + 'b' * 64


@unittest.skipUnless(os.geteuid() == 0, 'Requires isolated root Linux fixture')
class PreparationFenceTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.journal = updater.Journal(pathlib.Path(self.tmp.name))
        self.journal.submit(OP, 'a' * 40, DIGEST, 'v1.2.3')
        self.attempt = self.journal.claim()
        self.journal.finish(self.attempt, 'verified', 'sha256:' + 'c' * 64)

    def tearDown(self):
        self.journal.close()
        self.tmp.cleanup()

    def test_ipc_claim_is_durable_and_idempotent(self):
        request = {'version': 1, 'action': 'prepare', 'operationId': OP}
        first = updater.process(self.journal, request)
        self.assertEqual(first, updater.process(self.journal, request))
        self.assertEqual(set(first), {'operationId', 'preparationId', 'status'})
        self.assertEqual(first['status'], 'preparing')
        self.journal.recover()
        self.assertEqual(updater.process(self.journal, request)['status'], 'recovery_required')
        self.assertIsNone(self.journal.preparing(OP, first['preparationId']))

    def test_prepare_ipc_rejects_unauthorized_peer(self):
        fixture = test_updater.UpdaterTest('test_auth_idempotency_concurrency_and_restart')
        fixture.setUp()
        try:
            for delay in (0, 0.1):
                with self.subTest(client_send_delay=delay):
                    # SO_PEERCRED rejection happens before receive(). A client
                    # scheduled after rejection can see an early Unix close.
                    client = test_updater.CLIENT.replace('s.sendall(', f'__import__("time").sleep({delay});s.sendall(')
                    with mock.patch.object(test_updater, 'CLIENT', client):
                        try:
                            response = fixture.request({'version': 1, 'action': 'prepare', 'operationId': OP}, as_authorized=False)
                        except subprocess.CalledProcessError as error:
                            self.assertEqual(error.returncode, 1)
                            self.assertEqual(error.stdout, '')
                            self.assertRegex(error.stderr, r'(?:BrokenPipeError: \[Errno 32\] Broken pipe|ConnectionResetError: \[Errno 104\] Connection reset by peer)\s*$')
                        else:
                            self.assertEqual(response, {'ok': False, 'error': 'unauthorized'})
                    self.assertIsNone(fixture.server.poll(), 'The helper must survive rejection.')
                    with sqlite3.connect(fixture.state / 'journal.sqlite') as db:
                        self.assertEqual(db.execute('SELECT count(*) FROM operations').fetchone(), (0,))
                        self.assertEqual(db.execute('SELECT count(*) FROM preparations').fetchone(), (0,))
                    self.assertEqual(fixture.request({'version': 1, 'action': 'status', 'operationId': OP}), {'ok': False, 'error': 'not_found'})
        finally:
            fixture.tearDown()

    def test_late_worker_cannot_reuse_revoked_claim(self):
        operation = self.journal.claim_preparation(OP)
        self.journal.assert_preparation(operation)
        self.journal.finish_preparation(operation)
        with self.assertRaises(RuntimeError):
            self.journal.assert_preparation(operation)

    def test_failed_launch_marks_recovery_and_no_retry(self):
        operation = self.journal.claim_preparation(OP)
        def fail(_): raise OSError('synthetic launch error')
        worker = updater.PreparationWorker(self.journal, pathlib.Path(self.tmp.name), fail)
        worker.tick()
        self.assertEqual(self.journal.preparation_status(OP)['status'], 'recovery_required')
        self.assertIsNone(self.journal.preparing(OP, operation['preparationId']))
        worker.tick()
        self.assertIsNone(worker.process)

    def test_close_revokes_claim_before_stopping_unit(self):
        operation = self.journal.claim_preparation(OP)
        class Process:
            stopped = False
            def poll(self): return None if not self.stopped else -9
            def kill(self): self.stopped = True
            def wait(self, timeout): return -9
        seen = []
        def stop(item):
            seen.append((item['preparationId'], self.journal.preparation_status(OP)['status']))
        worker = updater.PreparationWorker(self.journal, pathlib.Path(self.tmp.name), lambda _: Process(), stop)
        worker.tick(); worker.close()
        self.assertEqual(seen, [(operation['preparationId'], 'recovery_required')])

    def test_unit_command_contains_cgroup_limits(self):
        operation = self.journal.claim_preparation(OP)
        command = fence.command(self.tmp.name, OP, operation['preparationId'])
        self.assertIn('--property=KillMode=control-group', command)
        self.assertIn('--property=RuntimeMaxSec=1000', command)
        self.assertIn('--property=NoNewPrivileges=yes', command)
        self.assertIn(fence.unit_name(operation['preparationId']), command)
        self.assertNotIn(operation['attemptNonce'], command)

    def test_success_is_published_only_after_unit_exits(self):
        operation = self.journal.claim_preparation(OP)
        class Process:
            result = None
            def poll(self): return self.result
        process = Process()
        worker = updater.PreparationWorker(self.journal, pathlib.Path(self.tmp.name), lambda _: process)
        worker.tick()
        probe = self.journal.record_extraction_probe(operation, 'prepare')
        self.journal.complete_extraction_probe(operation, probe)
        staged = '/run/servus-install-' + 'd' * 32
        self.journal.stage_preparation(operation, staged)
        worker.tick()
        self.assertEqual(self.journal.preparation_status(OP)['status'], 'preparing')
        process.result = 0
        worker.tick()
        self.assertEqual(self.journal.preparation_status(OP)['status'], 'prepared')

    def test_failed_unit_keeps_staging_path_for_recovery(self):
        operation = self.journal.claim_preparation(OP)
        class Process:
            def poll(self): return 1
        worker = updater.PreparationWorker(self.journal, pathlib.Path(self.tmp.name), lambda _: Process())
        worker.tick()
        probe = self.journal.record_extraction_probe(operation, 'prepare')
        self.journal.complete_extraction_probe(operation, probe)
        staged = '/run/servus-install-' + 'd' * 32
        self.journal.stage_preparation(operation, staged)
        worker.tick()
        row = self.journal.db.execute('SELECT status,staging_path FROM preparations WHERE operation_id=?', (OP,)).fetchone()
        self.assertEqual(row, ('recovery_required', staged))

    def test_policy_preparation_does_not_launch_a_second_extractor(self):
        operation = self.journal.claim_preparation(OP)
        probe = self.journal.record_extraction_probe(operation, 'prepare')
        self.journal.complete_extraction_probe(operation, probe)
        staged = '/run/servus-install-' + 'd' * 32
        self.journal.stage_preparation(operation, staged)
        self.journal.finish_preparation(operation, staged)
        policy._record_identity(self.journal.db, OP)
        launched = []
        worker = updater.PreparationWorker(self.journal, pathlib.Path(self.tmp.name), lambda item: launched.append(item))
        worker.tick()
        self.assertEqual(launched, [])
        self.assertEqual(self.journal.preparation_status(OP)['status'], 'preparing')


if __name__ == '__main__':
    unittest.main()
