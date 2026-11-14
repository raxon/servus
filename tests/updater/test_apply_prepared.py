import importlib.util
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
import uuid
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'apps/updater'))
import supervisor


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


coordinator = load('apply_coordinator', 'apps/updater/update-coordinator.py')
updater = load('apply_updater', 'apps/updater/servus-updater.py')


@unittest.skipUnless(sys.platform == 'linux' and os.geteuid() == 0, 'Requires isolated Linux root')
class ApplyPreparedTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir='/root'); self.root = Path(self.tmp.name)
        self.state, self.backup, self.policies, self.control = (self.root / name for name in ('state', 'backup', 'policies', 'control'))
        for directory in (self.state, self.backup, self.policies, self.control): directory.mkdir(mode=0o700)
        self.journal = updater.Journal(self.state)
        self.journal.db.execute('CREATE TABLE policy_approvals(operation_id TEXT,attempt_id TEXT,attempt_nonce TEXT,preparation_id TEXT,root_digest TEXT,image_config_digest TEXT,source_env_path TEXT,candidate_path TEXT,state TEXT)')
        self.op, attempt, preparation = (str(uuid.uuid4()) for _ in range(3))
        digest, nonce = 'sha256:' + 'a' * 64, 'b' * 64
        self.journal.db.execute('INSERT INTO operations(id,commit_sha,digest,tag,status,attempt_id,attempt_nonce,config_digest) VALUES(?,?,?,?,?,?,?,?)', (self.op, 'c' * 40, digest, 'v1.2.3', 'verified', attempt, nonce, digest))
        self.journal.db.execute('INSERT INTO preparations(operation_id,attempt_id,attempt_nonce,preparation_id,status) VALUES(?,?,?,?,?)', (self.op, attempt, nonce, preparation, 'prepared'))
        self.journal.db.execute('INSERT INTO policy_approvals VALUES(?,?,?,?,?,?,?,?,?)', (self.op, attempt, nonce, preparation, digest, digest, '/root/candidate-env', '/root/candidate-policy', 'candidate'))
        self.control_fd = os.open(self.control, os.O_RDONLY | os.O_DIRECTORY)
        self.node_fd = os.open(os.path.realpath(sys.executable), os.O_RDONLY)
        self.ownership = SimpleNamespace(directory=self.control_fd, assert_held=mock.Mock())
        self.hub = mock.create_autospec(supervisor.DrainHub, instance=True); self.hub.policy = object()
        self.owner = mock.create_autospec(supervisor.MaintenanceSupervisor, instance=True); self.owner.install_lock = 42
        self.lease = object()
        self.window = mock.MagicMock(); self.window.__enter__.return_value = self.lease
        self.owner.drained_window.return_value = self.window
        self.binding = ('/root/old-policy', 'sha256:' + 'd' * 64, 'sha256:' + 'e' * 64, self.hub.policy)
        self.daemon = SimpleNamespace(resolve_active_policy=mock.Mock(return_value=('/root/old-policy', '/root/old-env', self.hub.policy)), approved_policy_binding=mock.Mock(return_value=self.binding))
        self.runtime = SimpleNamespace(activate_locked=mock.Mock())
        self.created = {'fixture': 'created'}; self.started = {'fixture': 'running'}

    def tearDown(self):
        self.journal.close(); os.close(self.control_fd); os.close(self.node_fd); self.tmp.cleanup()

    def execute(self):
        return coordinator.apply_prepared_update(self.journal, self.op, self.hub, self.owner, self.ownership,
            str(self.state / 'journal.sqlite'), '/root/active-env', str(self.backup), str(self.policies),
            '/root/docker-config', self.node_fd, supervisor, self.daemon, object(), self.runtime, object(), object())

    def test_runs_all_stages_in_order_under_same_drain(self):
        events = []
        with mock.patch.object(supervisor, '_assert_exclusive_flock'), \
             mock.patch.object(coordinator, 'capture_stopped_snapshot', side_effect=lambda *a, **k: events.append('capture')), \
             mock.patch.object(self.runtime, 'activate_locked', side_effect=lambda *a: events.append('activate')), \
             mock.patch.object(coordinator, 'create_generation', side_effect=lambda *a: events.append('create') or self.created), \
             mock.patch.object(coordinator, 'start_generation', side_effect=lambda *a: events.append('start') or self.started):
            self.assertEqual(self.execute(), self.started)
        self.assertEqual(events, ['capture', 'activate', 'create', 'start'])
        self.owner.drained_window.assert_called_once_with(self.hub, self.op, policy_binding=self.binding)
        self.assertTrue((self.backup / ('update-' + self.op)).is_dir())

    def test_failure_stops_remaining_stages_and_records_recovery(self):
        with mock.patch.object(supervisor, '_assert_exclusive_flock'), \
             mock.patch.object(coordinator, 'capture_stopped_snapshot', side_effect=RuntimeError('fixture')), \
             mock.patch.object(coordinator, 'create_generation') as create, mock.patch.object(coordinator, 'start_generation') as start:
            with self.assertRaises(RuntimeError): self.execute()
        self.runtime.activate_locked.assert_not_called(); create.assert_not_called(); start.assert_not_called()
        self.assertEqual(self.journal.db.execute('SELECT phase FROM update_transactions').fetchone(), ('recovery_required',))

    def test_existing_backup_cannot_be_overwritten(self):
        (self.backup / ('update-' + self.op)).mkdir()
        with mock.patch.object(supervisor, '_assert_exclusive_flock'):
            with self.assertRaises(coordinator.UpdateError): self.execute()
        self.assertEqual(self.journal.db.execute('SELECT count(*) FROM update_transactions').fetchone(), (0,))


if __name__ == '__main__': unittest.main()
