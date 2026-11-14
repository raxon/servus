import importlib.util
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
import unittest
import uuid
from types import SimpleNamespace
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'apps/updater'))
import supervisor


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


daemon = load('generation_daemon', 'apps/updater/supervisor-daemon.py')
updater = load('generation_journal', 'apps/updater/servus-updater.py')


@unittest.skipUnless(sys.platform == 'linux' and os.geteuid() == 0, 'Requires isolated Linux root')
class CompleteGenerationTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir='/root'); self.root = Path(self.tmp.name)
        self.install, self.gate, self.maintenance, self.state = (self.root / x for x in ('install', 'gate', 'maintenance', 'state'))
        self.install.mkdir(mode=0o700); self.gate.mkdir(mode=0o755); self.maintenance.mkdir(mode=0o700); self.state.mkdir(mode=0o700)
        (self.install / 'install.lock').touch(mode=0o600); (self.gate / 'lock').touch(mode=0o644)
        (self.gate / 'state').write_bytes(b'servus-lifecycle-v1 normal\n'); (self.gate / 'state').chmod(0o644)
        self.owner = supervisor.MaintenanceSupervisor(str(self.install), str(self.gate), str(self.maintenance))
        self.operation, attempt, preparation = (str(uuid.uuid4()) for _ in range(3))
        self.owner._record(self.operation, 'starting', {role: str(uuid.uuid4()) for role in supervisor.ROLES}, 30000)
        self.journal = updater.Journal(self.state); root = 'sha256:' + 'a' * 64; nonce = 'b' * 64
        self.journal.db.execute('CREATE TABLE policy_approvals(operation_id TEXT,attempt_id TEXT,attempt_nonce TEXT,preparation_id TEXT,root_digest TEXT,image_config_digest TEXT,policy_path TEXT,accepted_env_path TEXT,state TEXT)')
        self.journal.db.execute('INSERT INTO operations(id,commit_sha,digest,tag,status,attempt_id,attempt_nonce,config_digest) VALUES(?,?,?,?,?,?,?,?)', (self.operation, 'c' * 40, root, 'v1.2.3', 'verified', attempt, nonce, root))
        self.journal.db.execute('INSERT INTO preparations(operation_id,attempt_id,attempt_nonce,preparation_id,status) VALUES(?,?,?,?,?)', (self.operation, attempt, nonce, preparation, 'prepared'))
        self.journal.claim_update(self.operation)
        self.journal.db.execute("UPDATE update_transactions SET phase='starting'")
        self.journal.db.execute('INSERT INTO policy_approvals VALUES (?,?,?,?,?,?,?,?,?)', (self.operation, attempt, nonce, preparation, root, root, '/root/policy', '/root/env', 'active'))
        self.pairs = [socket.socketpair() for _ in supervisor.ROLES]
        self.identities = {role: {'id': char * 64, 'pid': 123, 'cgroup': '/docker/' + char * 64} for role, char in zip(supervisor.ROLES, 'abc')}
        self.hub = SimpleNamespace(policy=object(), identities=self.identities, connections=dict(zip(supervisor.ROLES, [pair[0] for pair in self.pairs])))
        self.records = [{'Id': self.identities[role]['id'], 'State': {'Running': True, 'Health': {'Status': 'healthy'}}} for role in supervisor.ROLES]

    def tearDown(self):
        for pair in self.pairs:
            for item in pair: item.close()
        self.journal.close(); self.owner.close(); self.tmp.cleanup()

    def complete(self):
        return daemon.complete_healthy_preparation(self.hub, str(self.state / 'journal.sqlite'), self.operation, '/root/policy', '/root/env', maintenance=self.owner)

    def test_healthy_completion_clears_marker_and_both_states_atomically(self):
        with mock.patch.object(supervisor, 'inspect_servus', return_value=self.identities), mock.patch.object(supervisor, '_docker', return_value=json.dumps(self.records).encode()):
            self.complete()
        self.assertEqual(self.journal.db.execute('SELECT status FROM preparations').fetchone(), ('completed',))
        self.assertEqual(self.journal.db.execute('SELECT phase FROM update_transactions').fetchone(), ('completed',))
        self.assertFalse((self.maintenance / 'maintenance.json').exists())

    def test_identity_drift_rolls_back_both_states(self):
        with mock.patch.object(supervisor, 'inspect_servus', side_effect=[self.identities, {}]), mock.patch.object(supervisor, '_docker', return_value=json.dumps(self.records).encode()):
            with self.assertRaises(supervisor.SupervisorError): self.complete()
        self.assertEqual(self.journal.db.execute('SELECT status FROM preparations').fetchone(), ('prepared',))
        self.assertEqual(self.journal.db.execute('SELECT phase FROM update_transactions').fetchone(), ('starting',))
        self.assertTrue((self.maintenance / 'maintenance.json').exists())

    def test_interrupted_marker_cleanup_can_be_retried(self):
        with mock.patch.object(supervisor, 'inspect_servus', return_value=self.identities), mock.patch.object(supervisor, '_docker', return_value=json.dumps(self.records).encode()):
            with mock.patch.object(daemon.os, 'unlink', side_effect=OSError('fixture')):
                with self.assertRaises(supervisor.SupervisorError): self.complete()
            self.assertEqual(self.journal.db.execute('SELECT phase FROM update_transactions').fetchone(), ('completed',))
            self.assertTrue((self.maintenance / 'maintenance.json').exists())
            self.complete()
        self.assertFalse((self.maintenance / 'maintenance.json').exists())

    def test_unhealthy_container_or_wrong_marker_cannot_complete(self):
        self.records[0]['State']['Health']['Status'] = 'unhealthy'
        with mock.patch.object(supervisor, 'inspect_servus', return_value=self.identities), mock.patch.object(supervisor, '_docker', return_value=json.dumps(self.records).encode()):
            with self.assertRaises(supervisor.SupervisorError): self.complete()
            self.records[0]['State']['Health']['Status'] = 'healthy'
            self.owner._record(str(uuid.uuid4()), 'starting', {role: str(uuid.uuid4()) for role in supervisor.ROLES}, 30000)
            with self.assertRaises(supervisor.SupervisorError): self.complete()
        self.assertEqual(self.journal.db.execute('SELECT phase FROM update_transactions').fetchone(), ('starting',))

    def test_initial_install_without_update_transaction_can_complete(self):
        self.journal.db.execute('DELETE FROM update_transactions')
        (self.maintenance / 'maintenance.json').unlink()
        with mock.patch.object(supervisor, 'inspect_servus', return_value=self.identities), mock.patch.object(supervisor, '_docker', return_value=json.dumps(self.records).encode()):
            self.complete()
        self.assertEqual(self.journal.db.execute('SELECT status FROM preparations').fetchone(), ('completed',))


if __name__ == '__main__':
    unittest.main()
