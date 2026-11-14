import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
from types import SimpleNamespace
import unittest
import uuid
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


sys.path.insert(0, str(ROOT / 'apps/updater'))
import supervisor
coordinator = load('generation_coordinator', 'apps/updater/update-coordinator.py')
updater = load('generation_updater', 'apps/updater/servus-updater.py')
extractor = load('generation_extractor', 'apps/updater/extract-install.py')
backup = load('generation_backup', 'apps/updater/backup.py')


@unittest.skipUnless(sys.platform == 'linux' and os.geteuid() == 0, 'Requires isolated Linux root')
class CreateGenerationTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir='/root')
        self.root = Path(self.tmp.name)
        self.state = self.root / 'journal'; self.state.mkdir(mode=0o700)
        self.control = self.root / 'control'; self.control.mkdir(mode=0o700)
        self.config = self.root / 'docker-config'; self.config.mkdir(mode=0o700)
        self.stage = self.root / ('servus-install-' + 'a' * 32); self.stage.mkdir(mode=0o700)
        deployment = self.stage / 'deployment'; deployment.mkdir(mode=0o755)
        self.compose = deployment / 'compose.yaml'; self.compose.write_bytes(b'services: {}\n'); self.compose.chmod(0o644)
        entries = [{'path': name, 'type': 'file', 'mode': mode, 'size': 0, 'sha256': hashlib.sha256(b'').hexdigest()} for name, mode in extractor.FILES.items()]
        entry = next(item for item in entries if item['path'] == 'deployment/compose.yaml')
        entry.update(size=self.compose.stat().st_size, sha256=hashlib.sha256(self.compose.read_bytes()).hexdigest())
        self.manifest = self.stage / 'manifest.json'
        self.manifest.write_text(json.dumps({'schema': 1, 'minimumUpdaterAbi': 1, 'files': entries})); self.manifest.chmod(0o644)
        self.journal = updater.Journal(self.state)
        self.journal.db.execute('CREATE TABLE policy_approvals(operation_id TEXT,attempt_id TEXT,attempt_nonce TEXT,preparation_id TEXT,root_digest TEXT,image_config_digest TEXT,policy_path TEXT,accepted_env_path TEXT,source_env_path TEXT,state TEXT)')
        self.op, attempt, prep = (str(uuid.uuid4()) for _ in range(3))
        self.digest = 'sha256:' + 'b' * 64; nonce = 'c' * 64
        self.env = '/root/active.env'; self.policy_path = '/root/policy'; self.accepted = '/root/accepted.env'
        self.journal.db.execute('INSERT INTO operations(id,commit_sha,digest,tag,status,attempt_id,attempt_nonce,config_digest) VALUES(?,?,?,?,?,?,?,?)', (self.op, 'd' * 40, self.digest, 'v1.2.3', 'verified', attempt, nonce, self.digest))
        self.journal.db.execute('INSERT INTO preparations(operation_id,attempt_id,attempt_nonce,preparation_id,status,staging_path) VALUES(?,?,?,?,?,?)', (self.op, attempt, nonce, prep, 'prepared', str(self.stage)))
        self.journal.claim_update(self.op)
        self.journal.db.execute("UPDATE update_transactions SET phase='snapshot_verified',backup_path=?,backup_manifest_digest=?", ('/root/backup', 'sha256:' + 'e' * 64))
        self.journal.db.execute('INSERT INTO policy_approvals VALUES (?,?,?,?,?,?,?,?,?,?)', (self.op, attempt, nonce, prep, self.digest, self.digest, self.policy_path, self.accepted, self.env, 'active'))
        self.policy = mock.create_autospec(supervisor.RuntimePolicy, instance=True)
        self.policy.control_dir = str(self.control); self.policy.image_reference = 'ghcr.io/raxon/servus@' + self.digest
        self.daemon = SimpleNamespace(resolve_active_policy=mock.Mock(return_value=(self.policy_path, self.accepted, self.policy)))
        self.control_fd = os.open(self.control, os.O_RDONLY | os.O_DIRECTORY)
        self.ownership = SimpleNamespace(directory=self.control_fd, assert_held=mock.Mock())
        self.lease = object.__new__(supervisor.DrainLease)
        self.runtime = SimpleNamespace(_docker=mock.Mock())
        self.ids = {role: {'id': char * 64} for role, char in zip(supervisor.ROLES, 'abc')}

    def tearDown(self):
        self.journal.close(); os.close(self.control_fd); self.tmp.cleanup()

    def execute(self):
        return coordinator.create_generation(self.journal, self.op, self.lease, self.ownership,
            str(self.state / 'journal.sqlite'), self.env, str(self.config), supervisor, self.daemon,
            extractor, self.runtime, backup, -1)

    def test_creates_exact_generation_without_starting_it(self):
        with mock.patch.object(self.lease, 'assert_snapshot_verified'), mock.patch.object(self.lease, 'assert_locked'), \
             mock.patch.object(self.lease, 'record') as record, mock.patch.object(coordinator, 'verify_snapshot'), \
             mock.patch.object(supervisor, 'inspect_servus', return_value=self.ids) as inspect:
            self.assertEqual(self.execute(), self.ids)
        args = self.runtime._docker.call_args
        self.assertEqual(args.args[1:], ('compose', '--env-file', self.env, '-f', str(self.compose), '-p', 'servus', 'create', '--no-build', '--pull', 'never', '--force-recreate'))
        inspect.assert_called_once_with(self.policy, created=True)
        record.assert_called_once_with('switching')
        self.assertEqual(self.journal.db.execute('SELECT phase FROM update_transactions').fetchone(), ('switching',))

    def test_tampered_compose_is_never_executed(self):
        self.compose.write_bytes(b'services: tampered\n')
        with mock.patch.object(self.lease, 'assert_snapshot_verified'):
            with self.assertRaisesRegex(coordinator.UpdateError, 'Compose file changed'):
                self.execute()
        self.runtime._docker.assert_not_called()
        self.assertEqual(self.journal.db.execute('SELECT phase FROM update_transactions').fetchone(), ('snapshot_verified',))

    def test_different_verified_image_is_never_created(self):
        self.policy.image_reference = 'ghcr.io/raxon/servus@sha256:' + 'f' * 64
        with mock.patch.object(self.lease, 'assert_snapshot_verified'):
            with self.assertRaisesRegex(coordinator.UpdateError, 'does not match'):
                self.execute()
        self.runtime._docker.assert_not_called()

    def test_changed_policy_after_create_requires_recovery(self):
        self.daemon.resolve_active_policy.side_effect = [(self.policy_path, self.accepted, self.policy),
                                                         ('/root/other-policy', self.accepted, self.policy)]
        with mock.patch.object(self.lease, 'assert_snapshot_verified'), mock.patch.object(self.lease, 'assert_locked'), \
             mock.patch.object(self.lease, 'record'), mock.patch.object(coordinator, 'verify_snapshot'):
            with self.assertRaisesRegex(coordinator.UpdateError, 'policy changed'):
                self.execute()
        self.assertEqual(self.journal.db.execute('SELECT phase FROM update_transactions').fetchone(), ('recovery_required',))

    def test_uncertain_creation_requires_recovery(self):
        self.runtime._docker.side_effect = TimeoutError('fixture timeout')
        with mock.patch.object(self.lease, 'assert_snapshot_verified'), mock.patch.object(self.lease, 'assert_locked'), \
             mock.patch.object(self.lease, 'record'), mock.patch.object(coordinator, 'verify_snapshot'):
            with self.assertRaises(TimeoutError): self.execute()
        self.assertEqual(self.journal.db.execute('SELECT phase FROM update_transactions').fetchone(), ('recovery_required',))

    def test_rejects_unapproved_created_container_and_stays_closed(self):
        with mock.patch.object(self.lease, 'assert_snapshot_verified'), mock.patch.object(self.lease, 'assert_locked'), \
             mock.patch.object(self.lease, 'record') as record, mock.patch.object(coordinator, 'verify_snapshot'), \
             mock.patch.object(supervisor, 'inspect_servus', side_effect=supervisor.SupervisorError('drift')):
            with self.assertRaises(supervisor.SupervisorError): self.execute()
        record.assert_called_once_with('switching')
        self.assertEqual(self.journal.db.execute('SELECT phase FROM update_transactions').fetchone(), ('recovery_required',))


if __name__ == '__main__':
    unittest.main()
