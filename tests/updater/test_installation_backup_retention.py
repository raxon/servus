"""Retention, controlled archive deletion, verification and cancel/capture race checks."""
import hashlib
import hmac
import importlib.util
import json
import os
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest import mock
import uuid

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('installation_backups_retention', ROOT / 'apps/updater/installation-backups.py')
backups = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backups)
updater_spec = importlib.util.spec_from_file_location('installation_retention_updater', ROOT / 'apps/updater/servus-updater.py')
updater = importlib.util.module_from_spec(updater_spec)
updater_spec.loader.exec_module(updater)

API_TOKEN = 'a' * 64
DIGEST = 'sha256:' + 'e' * 64
CONTAINERS = {'api': '1' * 64, 'agent': '2' * 64, 'worker': '3' * 64}
BINDING = ['/etc/servus/policy.json', 'sha256:' + '4' * 64, 'sha256:' + '5' * 64]


def sign(operation_id, actor_id, name, issued_at, purpose='submit'):
    receipt = {'version': 1, 'operationId': operation_id, 'actorId': actor_id, 'name': name, 'issuedAt': issued_at, 'proof': '0' * 64}
    msg = backups.approval_message(receipt, purpose=purpose)
    receipt['proof'] = hmac.new(bytes.fromhex(API_TOKEN), msg, hashlib.sha256).hexdigest()
    return receipt


class RetentionAndVerificationTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.journal_dir = self.root / 'journal'
        self.backup_dir = self.root / 'backups'
        self.op_dir = self.journal_dir / 'installation-backups'
        self.journal_dir.mkdir(mode=0o700)
        self.backup_dir.mkdir(mode=0o700)
        self.op_dir.mkdir(mode=0o700)

    def _journal(self, *, active_record=None):
        journal = backups.BackupJournal.__new__(backups.BackupJournal)
        journal_fd = os.open(str(self.journal_dir), os.O_RDONLY | os.O_DIRECTORY)
        op_fd = os.open(str(self.op_dir), os.O_RDONLY | os.O_DIRECTORY)
        self.addCleanup(os.close, journal_fd)
        self.addCleanup(os.close, op_fd)
        journal.directory = op_fd
        journal.maintenance = SimpleNamespace(journal=journal_fd)
        journal._locked = lambda: None
        journal.assert_untouched = lambda: None

        def open_root_file(dir_fd, name, _mode):
            return os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=dir_fd)

        def atomic_file(dir_fd, name, data, mode):
            tmp = '.tmp-' + uuid.uuid4().hex
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode, dir_fd=dir_fd)
            try:
                os.write(fd, data)
                os.fsync(fd)
            finally:
                os.close(fd)
            os.replace(tmp, name, src_dir_fd=dir_fd, dst_dir_fd=dir_fd)

        def trusted_dir(path, _mode):
            return os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)

        journal.supervisor = SimpleNamespace(
            ROLES=('api', 'agent', 'worker'),
            _open_root_file=open_root_file,
            _atomic_file=atomic_file,
            _trusted_directory=trusted_dir,
        )

        # Bypass root uid check on macOS/non-root test runner inside _deletion_audit_dir
        def audit_dir(*, create=False):
            if create:
                try:
                    os.mkdir('installation-backup-deletions', 0o700, dir_fd=journal_fd)
                except FileExistsError:
                    pass
            return os.open('installation-backup-deletions', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=journal_fd)

        journal._deletion_audit_dir = audit_dir
        if active_record is not None:
            journal.active = lambda: active_record
        return journal

    def _completed(self, name='Snapshot', *, with_dir=True):
        op_id = str(uuid.uuid4())
        snap_path = self.backup_dir / ('installation-' + op_id)
        if with_dir:
            snap_path.mkdir(mode=0o700)
            (snap_path / 'manifest.json').write_text('{"version":1}\n')
        record = {
            'version': 1, 'operationId': op_id, 'actorId': str(uuid.uuid4()), 'name': name,
            'issuedAt': 1794923000000, 'state': 'completed', 'createdAt': 1794923000000, 'updatedAt': 1794923001000,
            'policyBinding': BINDING, 'containers': CONTAINERS,
            'snapshotPath': str(snap_path), 'manifestDigest': DIGEST, 'errorCode': None,
        }
        (self.op_dir / (op_id + '.json')).write_text(json.dumps(record))
        return record

    def test_delete_approval_is_domain_separated_from_submit_and_cancel(self):
        op_id, actor_id, now = str(uuid.uuid4()), str(uuid.uuid4()), 1794923000000
        submit_rcpt = sign(op_id, actor_id, 'Nightly', now, purpose='submit')
        cancel_rcpt = sign(op_id, actor_id, 'Nightly', now, purpose='cancel')
        delete_rcpt = sign(op_id, actor_id, 'Nightly', now, purpose='delete')
        self.assertEqual(backups.verify_approval(delete_rcpt, API_TOKEN, now_ms=now, purpose='delete')['operationId'], op_id)
        for wrong_purpose in ('submit', 'cancel'):
            with self.assertRaises(backups.BackupError):
                backups.verify_approval(delete_rcpt, API_TOKEN, now_ms=now, purpose=wrong_purpose)
        for wrong_receipt in (submit_rcpt, cancel_rcpt):
            with self.assertRaises(backups.BackupError):
                backups.verify_approval(wrong_receipt, API_TOKEN, now_ms=now, purpose='delete')

    def test_protects_last_verified_snapshot_and_deletes_idempotently_when_another_remains(self):
        journal = self._journal()
        first = self._completed('First')
        now = 1794923005000
        actor = str(uuid.uuid4())
        # Refuses deleting the only remaining verified snapshot on disk
        with self.assertRaises(backups.BackupError):
            journal.delete_snapshot(sign(first['operationId'], actor, 'First', now, purpose='delete'), API_TOKEN, str(self.backup_dir), now_ms=now)
        self.assertTrue(Path(first['snapshotPath']).exists())

        # Adding a second completed snapshot allows deleting the first
        second = self._completed('Second')
        receipt = sign(first['operationId'], actor, 'First', now, purpose='delete')
        result = journal.delete_snapshot(receipt, API_TOKEN, str(self.backup_dir), now_ms=now)
        self.assertEqual(result, {'operationId': first['operationId'], 'name': 'First', 'deleted': True, 'remainingSnapshots': 1})
        self.assertFalse(Path(first['snapshotPath']).exists())
        self.assertTrue(Path(second['snapshotPath']).exists())
        self.assertTrue(journal.is_deleted(first['operationId']))

        # Idempotent retry after deletion (e.g. crash right after writing audit receipt) succeeds
        retry = journal.delete_snapshot(receipt, API_TOKEN, str(self.backup_dir), now_ms=now)
        self.assertEqual(retry, {'operationId': first['operationId'], 'name': 'First', 'deleted': True, 'remainingSnapshots': 1})

        # Deleting the second (now last remaining) snapshot is refused
        with self.assertRaises(backups.BackupError):
            journal.delete_snapshot(sign(second['operationId'], actor, 'Second', now, purpose='delete'), API_TOKEN, str(self.backup_dir), now_ms=now)
        self.assertTrue(Path(second['snapshotPath']).exists())

    def test_refuses_deletion_while_operation_active_or_on_symlink_escape(self):
        first = self._completed('First')
        second = self._completed('Second')
        now = 1794923005000
        actor = str(uuid.uuid4())
        busy_journal = self._journal(active_record={'operationId': str(uuid.uuid4()), 'state': 'capturing'})
        with self.assertRaises(backups.BackupError):
            busy_journal.delete_snapshot(sign(first['operationId'], actor, 'First', now, purpose='delete'), API_TOKEN, str(self.backup_dir), now_ms=now)

        # Symlink placed inside snapshot directory must abort removal safely
        (Path(first['snapshotPath']) / 'escape').symlink_to('/etc')
        clean_journal = self._journal()
        with self.assertRaises(backups.BackupError):
            clean_journal.delete_snapshot(sign(first['operationId'], actor, 'First', now, purpose='delete'), API_TOKEN, str(self.backup_dir), now_ms=now)
        self.assertTrue(Path(second['snapshotPath']).exists())

    def test_verify_completed_snapshot_checks_manifest_and_rejects_deleted(self):
        journal = self._journal()
        first = self._completed('First')
        self._completed('Second')
        update_mod = SimpleNamespace(verify_snapshot=mock.Mock())
        res = backups.verify_completed_snapshot(journal, first['operationId'], object(), update_mod, 3, journal.supervisor)
        self.assertEqual(res, {'operationId': first['operationId'], 'name': 'First', 'verified': True, 'manifestDigest': DIGEST})
        self.assertNotIn('snapshotPath', res)
        update_mod.verify_snapshot.assert_called_once()

        # After deletion, verification fails closed
        now = 1794923005000
        journal.delete_snapshot(sign(first['operationId'], str(uuid.uuid4()), 'First', now, purpose='delete'), API_TOKEN, str(self.backup_dir), now_ms=now)
        with self.assertRaises(backups.BackupError):
            backups.verify_completed_snapshot(journal, first['operationId'], object(), update_mod, 3, journal.supervisor)

    def test_cancel_vs_capture_race_enforces_state_fence(self):
        journal = self._journal()
        op_id, actor, now = str(uuid.uuid4()), str(uuid.uuid4()), 1794923000000
        # Transitioned to capturing -> cancel must be refused
        record = {
            'version': 1, 'operationId': op_id, 'actorId': actor, 'name': 'Racing',
            'issuedAt': now, 'state': 'capturing', 'createdAt': now, 'updatedAt': now,
            'policyBinding': BINDING, 'containers': CONTAINERS,
            'snapshotPath': None, 'manifestDigest': None, 'errorCode': None,
        }
        (self.op_dir / (op_id + '.json')).write_text(json.dumps(record))
        (self.op_dir / 'active.json').write_text(json.dumps({'operationId': op_id}))
        with self.assertRaises(backups.BackupError):
            journal.cancel(sign(op_id, actor, 'Racing', now, purpose='cancel'), API_TOKEN, now_ms=now)

    def test_updater_proxy_delete_and_verify_strict_redaction(self):
        proxy = updater.InstallationBackupProxy('/run/servus-supervisor/command')
        op_id, actor, now = str(uuid.uuid4()), str(uuid.uuid4()), 1794923000000
        approval = sign(op_id, actor, 'Snap', now, purpose='delete')
        del_payload = {'operationId': op_id, 'name': 'Snap', 'deleted': True, 'remainingSnapshots': 2}
        with mock.patch.object(updater, 'supervisor_request', return_value={'version': 1, 'status': 'deleted', 'result': del_payload}):
            self.assertEqual(proxy.delete(approval), del_payload)
        with mock.patch.object(updater, 'supervisor_request', return_value={'version': 1, 'status': 'deleted', 'result': {**del_payload, 'snapshotPath': '/root/secret'}}):
            with self.assertRaises(updater.ProtocolError):
                proxy.delete(approval)
        ver_payload = {'operationId': op_id, 'name': 'Snap', 'verified': True, 'manifestDigest': DIGEST}
        with mock.patch.object(updater, 'supervisor_request', return_value={'version': 1, 'status': 'verified', 'verification': ver_payload}):
            self.assertEqual(proxy.verify(op_id), ver_payload)
        with mock.patch.object(updater, 'supervisor_request', return_value={'version': 1, 'status': 'not_found'}):
            with self.assertRaises(updater.ProtocolError) as caught:
                proxy.verify(op_id)
            self.assertEqual(caught.exception.code, 'not_found')


if __name__ == '__main__':
    unittest.main()
