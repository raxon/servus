import hashlib
from contextlib import closing
import importlib.util
import json
import os
import pathlib
import shutil
import sqlite3
import tempfile
import unittest
import uuid
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[2]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


backup = load('snapshot_backup', 'apps/updater/backup.py')
supervisor = load('snapshot_supervisor', 'apps/updater/supervisor.py')
coordinator = load('update_coordinator', 'apps/updater/update-coordinator.py')
updater = load('snapshot_updater', 'apps/updater/servus-updater.py')


@unittest.skipUnless(os.geteuid() == 0 and pathlib.Path('/proc/self/fd').exists(), 'Requires Linux root')
class SnapshotVerificationTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir='/root')
        self.path = pathlib.Path(self.tmp.name)
        for name in ('secrets', 'database-roots'):
            (self.path / name).mkdir(mode=0o700)
        for name in ('panel.sqlite', 'agent.sqlite'):
            with closing(sqlite3.connect(self.path / name)) as db:
                db.execute('CREATE TABLE example (id INTEGER PRIMARY KEY)')
                db.commit()
            os.chmod(self.path / name, 0o600)
        for name in ('secret-key', 'agent-token'):
            (self.path / name).write_text('a' * 64)
            os.chmod(self.path / name, 0o600)
        self.manifest()

    def tearDown(self):
        self.tmp.cleanup()

    def manifest(self):
        names = ('panel.sqlite', 'agent.sqlite', 'secret-key', 'agent-token')
        payload = {'format': 1, 'files': {name: hashlib.sha256((self.path / name).read_bytes()).hexdigest() for name in names}}
        raw = json.dumps(payload, sort_keys=True, separators=(',', ':')).encode() + b'\n'
        (self.path / 'manifest.json').write_bytes(raw)
        os.chmod(self.path / 'manifest.json', 0o600)
        self.digest = 'sha256:' + hashlib.sha256(raw).hexdigest()

    def verify(self):
        with mock.patch.object(backup, '_validate_staging'):
            coordinator.verify_snapshot(str(self.path), self.digest, backup, -1, supervisor)

    def test_rejects_corruption_unexpected_files_and_links(self):
        self.verify()
        (self.path / 'agent-token').write_text('b' * 64)
        with self.assertRaises(coordinator.UpdateError):
            self.verify()
        (self.path / 'agent-token').write_text('a' * 64)
        (self.path / 'unexpected').touch()
        with self.assertRaises(coordinator.UpdateError):
            self.verify()
        (self.path / 'unexpected').unlink()
        (self.path / 'agent-token').unlink()
        os.symlink('secret-key', self.path / 'agent-token')
        with self.assertRaises(OSError):
            self.verify()

    def test_rejects_database_corruption_even_with_matching_manifest(self):
        (self.path / 'panel.sqlite').write_bytes(b'not a database')
        self.manifest()
        with self.assertRaises(sqlite3.DatabaseError):
            self.verify()

    def test_rechecks_files_after_validation(self):
        def mutate(*args):
            (self.path / 'agent-token').write_text('c' * 64)
        with mock.patch.object(backup, '_validate_staging', side_effect=mutate):
            with self.assertRaises(coordinator.UpdateError):
                coordinator.verify_snapshot(str(self.path), self.digest, backup, -1, supervisor)

    def test_validation_refuses_unexpected_sqlite_sidecars(self):
        directory = os.open(self.path, os.O_RDONLY | os.O_DIRECTORY)
        try:
            for name in ('panel.sqlite-wal', 'agent.sqlite-shm', 'panel.sqlite-journal'):
                (self.path / name).touch()
                with self.assertRaisesRegex(backup.CaptureError, 'sidecar'):
                    backup._validate_staging(directory, -1)
                (self.path / name).unlink()
        finally:
            os.close(directory)

    def test_snapshot_proof_is_bound_to_real_journal_and_current_release(self):
        with tempfile.TemporaryDirectory(dir='/root') as state:
            journal = updater.Journal(pathlib.Path(state))
            operation, attempt, preparation = (str(uuid.uuid4()) for _ in range(3))
            nonce, root = 'a' * 64, 'sha256:' + 'b' * 64
            journal.db.execute("INSERT INTO operations(id,commit_sha,digest,tag,status,attempt_id,attempt_nonce,config_digest) VALUES(?,?,?,?,?,?,?,?)",
                               (operation, 'c' * 40, root, 'v1.2.3', 'verified', attempt, nonce, root))
            journal.db.execute("INSERT INTO preparations(operation_id,attempt_id,attempt_nonce,preparation_id,status) VALUES(?,?,?,?,?)",
                               (operation, attempt, nonce, preparation, 'prepared'))
            journal.claim_update(operation)
            journal.db.execute("UPDATE update_transactions SET phase='snapshotting' WHERE operation_id=?", (operation,))
            lease = object.__new__(supervisor.DrainLease)
            try:
                with mock.patch.object(lease, 'assert_locked') as locked, mock.patch.object(lease, 'record') as record, mock.patch.object(backup, '_validate_staging'):
                    (self.path / 'agent-token').write_text('d' * 64)
                    with self.assertRaisesRegex(coordinator.UpdateError, 'digest mismatch'):
                        coordinator.record_verified_snapshot(journal, operation, str(self.path), self.digest, lease, backup, -1, supervisor)
                    self.assertEqual(journal.db.execute('SELECT phase,backup_path FROM update_transactions').fetchone(), ('snapshotting', None))
                    (self.path / 'agent-token').write_text('a' * 64)
                    journal.db.execute("UPDATE operations SET digest=? WHERE id=?", ('sha256:' + 'd' * 64, operation))
                    with self.assertRaisesRegex(coordinator.UpdateError, 'active update'):
                        coordinator.record_verified_snapshot(journal, operation, str(self.path), self.digest, lease, backup, -1, supervisor)
                    self.assertEqual(journal.db.execute('SELECT phase,backup_path FROM update_transactions').fetchone(), ('snapshotting', None))
                    journal.db.execute('UPDATE operations SET digest=? WHERE id=?', (root, operation))
                    coordinator.record_verified_snapshot(journal, operation, str(self.path), self.digest, lease, backup, -1, supervisor)
                    self.assertEqual(journal.db.execute('SELECT phase,backup_path,backup_manifest_digest FROM update_transactions').fetchone(), ('snapshot_verified', str(self.path), self.digest))
                    record.assert_called_once_with('snapshot_verified')
                    self.assertGreaterEqual(locked.call_count, 3)
                    with self.assertRaises(coordinator.UpdateError):
                        coordinator.record_verified_snapshot(journal, operation, str(self.path), self.digest, lease, backup, -1, supervisor)
            finally:
                journal.close()

    def test_failed_lease_handoff_requires_recovery(self):
        with tempfile.TemporaryDirectory(dir='/root') as state:
            journal = updater.Journal(pathlib.Path(state))
            operation, attempt, preparation = (str(uuid.uuid4()) for _ in range(3))
            root = 'sha256:' + 'b' * 64
            journal.db.execute("INSERT INTO operations(id,commit_sha,digest,tag,status,attempt_id,attempt_nonce,config_digest) VALUES(?,?,?,?,?,?,?,?)",
                               (operation, 'c' * 40, root, 'v1.2.3', 'verified', attempt, 'a' * 64, root))
            journal.db.execute("INSERT INTO preparations(operation_id,attempt_id,attempt_nonce,preparation_id,status) VALUES(?,?,?,?,?)",
                               (operation, attempt, 'a' * 64, preparation, 'prepared'))
            journal.claim_update(operation)
            journal.db.execute("UPDATE update_transactions SET phase='snapshotting' WHERE operation_id=?", (operation,))
            lease = object.__new__(supervisor.DrainLease)
            try:
                with mock.patch.object(lease, 'assert_locked'), mock.patch.object(lease, 'record', side_effect=RuntimeError('lost lease')), mock.patch.object(backup, '_validate_staging'):
                    with self.assertRaisesRegex(RuntimeError, 'lost lease'):
                        coordinator.record_verified_snapshot(journal, operation, str(self.path), self.digest, lease, backup, -1, supervisor)
                self.assertEqual(journal.db.execute('SELECT phase FROM update_transactions').fetchone(), ('recovery_required',))
            finally:
                journal.close()

    @unittest.skipUnless(pathlib.Path('/app/dist/server/store.js').is_file(), 'Requires built Servus application')
    def test_real_capture_and_encrypted_secret_validation(self):
        capture_test = load('snapshot_capture_fixture', 'tests/updater/test_backup.py')
        fixture = capture_test.CaptureTest('test_real_store_agent_committed_wal_and_isolated_restore')
        fixture.setUp()
        try:
            fixture.panel.close()
            fixture.agent.close()
            fixture.capture()
            target = self.path / 'actual'
            shutil.copytree(fixture.dst, target)
            digest = 'sha256:' + hashlib.sha256((target / 'manifest.json').read_bytes()).hexdigest()
            coordinator.verify_snapshot(str(target), digest, backup, fixture.node_fd, supervisor)
        finally:
            fixture.tearDown()
