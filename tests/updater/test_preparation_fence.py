import importlib.util
import os
import pathlib
import tempfile
import unittest
import test_updater

ROOT = pathlib.Path(__file__).resolve().parents[2]

def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

updater = load('updater', ROOT / 'apps/updater/servus-updater.py')
fence = load('preparation_fence', ROOT / 'apps/updater/preparation-fence.py')
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
            response = fixture.request({'version': 1, 'action': 'prepare', 'operationId': OP}, as_authorized=False)
            self.assertEqual(response, {'ok': False, 'error': 'unauthorized'})
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
        probe = self.journal.record_extraction_probe(operation, 'prepare')
        self.journal.complete_extraction_probe(operation, probe)
        staged = '/run/servus-install-' + 'd' * 32
        self.journal.stage_preparation(operation, staged)
        class Process:
            result = None
            def poll(self): return self.result
        process = Process()
        worker = updater.PreparationWorker(self.journal, pathlib.Path(self.tmp.name), lambda _: process)
        worker.tick()
        worker.tick()
        self.assertEqual(self.journal.preparation_status(OP)['status'], 'preparing')
        process.result = 0
        worker.tick()
        self.assertEqual(self.journal.preparation_status(OP)['status'], 'prepared')

    def test_failed_unit_keeps_staging_path_for_recovery(self):
        operation = self.journal.claim_preparation(OP)
        probe = self.journal.record_extraction_probe(operation, 'prepare')
        self.journal.complete_extraction_probe(operation, probe)
        staged = '/run/servus-install-' + 'd' * 32
        self.journal.stage_preparation(operation, staged)
        class Process:
            def poll(self): return 1
        worker = updater.PreparationWorker(self.journal, pathlib.Path(self.tmp.name), lambda _: Process())
        worker.tick(); worker.tick()
        row = self.journal.db.execute('SELECT status,staging_path FROM preparations WHERE operation_id=?', (OP,)).fetchone()
        self.assertEqual(row, ('recovery_required', staged))


if __name__ == '__main__':
    unittest.main()
