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
from types import SimpleNamespace
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
quiescence = load('snapshot_quiescence', 'apps/updater/quiescence.py')


class RunningPreflightTest(unittest.TestCase):
    def test_inspects_external_containers_before_draining(self):
        identities={role:{'id':character * 64} for role,character in zip(('api','worker','agent'),'abc')}
        hub=mock.Mock(identities=identities,policy=mock.Mock(data_dir='/var/lib/servus'))
        guard=mock.Mock()
        trusted=('d' * 64,'panel-ingress','traefik:3.7.13','sha256:' + 'e' * 64)
        coordinator.preflight_external_containers(hub,supervisor,guard,trusted_ingress=trusted)
        args,kwargs=guard.ensure_no_other_data_mounts.call_args
        self.assertEqual(args[1],{item['id'] for item in identities.values()})
        self.assertEqual(args[2],'/var/lib/servus')
        self.assertEqual(kwargs,{'trusted_ingress':trusted,'allow_running_expected':True})

    def test_rejects_unexpected_socket_access(self):
        hub=mock.Mock(identities={role:{'id':character * 64} for role,character in zip(('api','worker','agent'),'abc')},
                      policy=mock.Mock(data_dir='/var/lib/servus'))
        guard=mock.Mock()
        guard.ensure_no_other_data_mounts.side_effect=quiescence.QuiescenceError('Unexpected container can access Docker API')
        with self.assertRaises(quiescence.QuiescenceError):
            coordinator.preflight_external_containers(hub,supervisor,guard)

    def test_failed_preflight_does_not_claim_update_or_stop_panel(self):
        hub=object.__new__(supervisor.DrainHub)
        hub.policy=SimpleNamespace(data_dir='/var/lib/servus')
        hub.identities={role:{'id':character * 64} for role,character in zip(supervisor.ROLES,'abc')}
        maintenance=object.__new__(supervisor.MaintenanceSupervisor)
        maintenance.install_lock=1
        ownership=SimpleNamespace(directory=1,assert_held=mock.Mock())
        journal=mock.Mock()
        journal.db.execute.side_effect=[SimpleNamespace(fetchone=lambda: (0,'main','/root/journal.sqlite')),
                                        SimpleNamespace(fetchone=lambda: ('/root/accepted.env','/root/candidate.json'))]
        daemon=SimpleNamespace(resolve_active_policy=mock.Mock(return_value=('/root/policy','/root/env',hub.policy)),
                               approved_policy_binding=mock.Mock(return_value=object()))
        guard=mock.Mock()
        guard.ensure_no_other_data_mounts.side_effect=quiescence.QuiescenceError('Unexpected container can access Docker API')
        node=SimpleNamespace(st_mode=0o100755,st_uid=0,st_nlink=1)
        with mock.patch.object(supervisor,'_assert_exclusive_flock'), mock.patch.object(coordinator.os,'fstat',return_value=node), \
             mock.patch.object(coordinator.os,'readlink',return_value='/root/control'), \
             mock.patch.object(maintenance,'drained_window') as drain:
            with self.assertRaises(quiescence.QuiescenceError):
                coordinator.apply_prepared_update(journal,str(uuid.uuid4()),hub,maintenance,ownership,
                    '/root/journal.sqlite','/root/active.env','/root/backups','/root/policies','/root/docker',
                    1,supervisor,daemon,object(),object(),guard,object())
        journal.claim_update.assert_not_called()
        drain.assert_not_called()


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
            lease = object.__new__(supervisor.DrainLease)
            try:
                with mock.patch.object(lease, 'assert_locked') as locked, mock.patch.object(lease, 'record') as record, mock.patch.object(backup, '_validate_staging'):
                    journal.db.execute("UPDATE preparations SET attempt_nonce=? WHERE operation_id=?", ('d' * 64, operation))
                    with self.assertRaisesRegex(coordinator.UpdateError, 'active update'):
                        coordinator.begin_snapshot(journal, operation, lease, supervisor)
                    self.assertEqual(journal.db.execute('SELECT phase FROM update_transactions').fetchone(), ('intent',))
                    journal.db.execute("UPDATE preparations SET attempt_nonce=? WHERE operation_id=?", (nonce, operation))
                    coordinator.begin_snapshot(journal, operation, lease, supervisor)
                    record.assert_called_once_with('snapshotting')
                    record.reset_mock()
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

    def test_failed_snapshot_start_handoff_requires_recovery(self):
        with tempfile.TemporaryDirectory(dir='/root') as state:
            journal = updater.Journal(pathlib.Path(state))
            operation, attempt, preparation = (str(uuid.uuid4()) for _ in range(3))
            root = 'sha256:' + 'b' * 64
            journal.db.execute("INSERT INTO operations(id,commit_sha,digest,tag,status,attempt_id,attempt_nonce,config_digest) VALUES(?,?,?,?,?,?,?,?)",
                               (operation, 'c' * 40, root, 'v1.2.3', 'verified', attempt, 'a' * 64, root))
            journal.db.execute("INSERT INTO preparations(operation_id,attempt_id,attempt_nonce,preparation_id,status) VALUES(?,?,?,?,?)",
                               (operation, attempt, 'a' * 64, preparation, 'prepared'))
            journal.claim_update(operation)
            lease = object.__new__(supervisor.DrainLease)
            try:
                with mock.patch.object(lease, 'assert_locked'), mock.patch.object(lease, 'record', side_effect=RuntimeError('lost lease')):
                    with self.assertRaisesRegex(RuntimeError, 'lost lease'):
                        coordinator.begin_snapshot(journal, operation, lease, supervisor)
                self.assertEqual(journal.db.execute('SELECT phase FROM update_transactions').fetchone(), ('recovery_required',))
            finally:
                journal.close()

    def test_capture_rechecks_writers_and_refuses_to_publish_after_drift(self):
        with tempfile.TemporaryDirectory(dir='/root') as state, tempfile.TemporaryDirectory(dir='/root') as destination:
            journal = updater.Journal(pathlib.Path(state))
            operation, attempt, preparation = (str(uuid.uuid4()) for _ in range(3))
            root = 'sha256:' + 'b' * 64
            journal.db.execute("INSERT INTO operations(id,commit_sha,digest,tag,status,attempt_id,attempt_nonce,config_digest) VALUES(?,?,?,?,?,?,?,?)",
                               (operation, 'c' * 40, root, 'v1.2.3', 'verified', attempt, 'a' * 64, root))
            journal.db.execute("INSERT INTO preparations(operation_id,attempt_id,attempt_nonce,preparation_id,status) VALUES(?,?,?,?,?)",
                               (operation, attempt, 'a' * 64, preparation, 'prepared'))
            journal.claim_update(operation)
            lease = object.__new__(supervisor.DrainLease)
            hub = mock.create_autospec(supervisor.DrainHub, instance=True)
            hub.used = True; hub.expected_uid = 1000
            hub.policy = mock.create_autospec(supervisor.RuntimePolicy, instance=True)
            hub.policy.data_dir = str(self.path)
            hub.identities = {role: {'id': char * 64} for role, char in zip(supervisor.ROLES, 'abc')}
            lease._hub = hub; lease._policy_binding = ('/root/policy', 'a', 'b')
            try:
                with mock.patch.object(lease, 'assert_locked'), mock.patch.object(lease, 'record'), \
                     mock.patch.object(supervisor, '_verify_data_directory'), \
                     mock.patch.object(quiescence, 'ensure_host_namespaces'), \
                     mock.patch.object(quiescence, 'ensure_no_other_data_mounts'), \
                     mock.patch.object(quiescence, 'ensure_no_mount_aliases'), \
                     mock.patch.object(quiescence, 'ensure_no_open_data'), \
                     mock.patch.object(quiescence, 'ensure_no_uid_writers', side_effect=[None, quiescence.QuiescenceError('writer')]), \
                     mock.patch.object(backup, '_capture_quiescent') as capture:
                    with self.assertRaisesRegex(quiescence.QuiescenceError, 'writer'):
                        coordinator.capture_stopped_snapshot(journal, operation, lease, destination, -1, supervisor, quiescence, backup)
                    capture.assert_called_once()
                self.assertEqual(journal.db.execute('SELECT phase,backup_path FROM update_transactions').fetchone(), ('recovery_required', None))
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
