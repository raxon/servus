import importlib.util
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
import threading
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('queued_updater', ROOT / 'apps/updater/servus-updater.py')
updater = importlib.util.module_from_spec(spec); spec.loader.exec_module(updater)


@unittest.skipUnless(sys.platform == 'linux' and os.geteuid() == 0, 'Requires isolated Linux root')
class ApplyQueueTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir='/root'); self.root = Path(self.tmp.name)
        self.state = self.root / 'state'; self.state.mkdir(mode=0o700)
        self.journal = updater.Journal(self.state)
        self.op, self.attempt, self.prep = (str(uuid.uuid4()) for _ in range(3))
        digest, nonce = 'sha256:' + 'a' * 64, 'b' * 64
        self.journal.db.execute('INSERT INTO operations(id,commit_sha,digest,tag,status,attempt_id,attempt_nonce,config_digest) VALUES(?,?,?,?,?,?,?,?)', (self.op, 'c' * 40, digest, 'v1.2.3', 'verified', self.attempt, nonce, digest))
        self.journal.db.execute('INSERT INTO preparations(operation_id,attempt_id,attempt_nonce,preparation_id,status) VALUES(?,?,?,?,?)', (self.op, self.attempt, nonce, self.prep, 'prepared'))

    def tearDown(self):
        self.journal.close(); self.tmp.cleanup()

    def test_request_is_idempotent_and_requires_prepared_verified_release(self):
        with self.assertRaises(updater.ProtocolError): updater.process(self.journal, {'version': 1, 'action': 'apply', 'operationId': self.op})
        self.journal.db.execute("UPDATE preparations SET status='preparing'")
        with self.assertRaises(updater.ProtocolError): self.journal.request_apply(self.op)
        self.journal.db.execute("UPDATE preparations SET status='prepared'")
        expected = {'operationId': self.op, 'status': 'requested'}
        self.assertEqual(updater.process(self.journal, {'version': 1, 'action': 'apply', 'operationId': self.op}, allow_apply=True), expected)
        self.assertEqual(self.journal.request_apply(self.op), expected)
        self.assertEqual(updater.process(self.journal, {'version': 1, 'action': 'apply_status', 'operationId': self.op}), expected)
        with self.assertRaises(updater.ProtocolError): updater.process(self.journal, {'version': 1, 'action': 'apply', 'operationId': self.op, 'image': 'untrusted'}, allow_apply=True)

    def test_interrupted_dispatch_requires_recovery_and_is_not_resent(self):
        self.journal.request_apply(self.op)
        self.assertEqual(self.journal.claim_apply_request(), self.op)
        self.journal.recover()
        self.assertEqual(self.journal.apply_status(self.op)['status'], 'recovery_required')
        self.assertIsNone(self.journal.claim_apply_request())

    def test_worker_tracks_verified_completion_and_uncertain_failure(self):
        self.journal.request_apply(self.op); sent = []
        worker = updater.ApplyWorker(self.journal, '/root/socket', lambda path, op: sent.append((path, op)))
        worker.tick(); worker.thread.join(timeout=2); worker.tick()
        self.assertEqual(sent, [('/root/socket', self.op)])
        self.assertEqual(self.journal.apply_status(self.op)['status'], 'awaiting_completion')
        self.journal.claim_update(self.op)
        self.journal.db.execute("UPDATE update_transactions SET phase='completed'")
        worker.tick()
        self.assertEqual(self.journal.apply_status(self.op)['status'], 'completed')

    def test_worker_marks_failed_dispatch_for_recovery(self):
        self.journal.request_apply(self.op)
        def fail(*_): raise TimeoutError('fixture')
        worker = updater.ApplyWorker(self.journal, '/root/socket', fail)
        worker.tick(); worker.thread.join(timeout=2); worker.tick()
        self.assertEqual(self.journal.apply_status(self.op)['status'], 'recovery_required')

    def test_supervisor_socket_sends_only_operation_identity(self):
        control = self.root / 'control'; control.mkdir(mode=0o750)
        path = control / 'command'; server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        server.bind(str(path)); os.chmod(path, 0o600); server.listen(1)
        received = []
        def serve():
            with server.accept()[0] as peer:
                received.append(json.loads(peer.recv(4096)))
                peer.sendall(b'{"version":1,"status":"starting"}\n')
        thread = threading.Thread(target=serve); thread.start()
        try:
            updater.dispatch_apply(str(path), self.op)
            thread.join(timeout=2)
            self.assertEqual(received, [{'version': 1, 'type': 'apply', 'operationId': self.op}])
        finally:
            server.close()


if __name__ == '__main__': unittest.main()
