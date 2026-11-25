"""History paging against persisted records without root, Docker or host changes."""
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('backup_history_module', ROOT / 'apps/updater/installation-backups.py')
backups = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backups)


class BackupHistoryTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)

    def journal(self):
        # Exercise the real reader, validation and paging algorithm. Root file
        # protection and flock ownership have separate Linux-only tests.
        journal = backups.BackupJournal.__new__(backups.BackupJournal)
        journal.directory = str(self.root)
        journal._locked = lambda: None
        journal._read = lambda name: json.loads((self.root / name).read_text())
        journal.supervisor = SimpleNamespace(ROLES=('api', 'agent', 'worker'))
        return journal

    def record(self, created, name='Backup'):
        operation_id = str(uuid.uuid4())
        record = {'version': 1, 'operationId': operation_id, 'actorId': str(uuid.uuid4()),
                  'name': name, 'issuedAt': created, 'createdAt': created, 'updatedAt': created,
                  'state': 'failed', 'policyBinding': None, 'containers': None,
                  'snapshotPath': None, 'manifestDigest': None, 'errorCode': 'capture_failed'}
        (self.root / (operation_id + '.json')).write_text(json.dumps(record))
        return record

    def test_reads_persisted_history_after_reopen_with_stable_order_and_wire_budget(self):
        records = [self.record(index // 2, '🚀' * 100) for index in range(23)]
        cursor, seen = None, []
        while True:
            page = self.journal().history(cursor)
            self.assertLessEqual(len(json.dumps({'version': 1, 'status': 'history', 'history': page}).encode()), 4096)
            self.assertLessEqual(len(page['operations']), 10)
            for item in page['operations']:
                self.assertEqual(set(item), {'operationId', 'actorId', 'name', 'state', 'createdAt', 'updatedAt', 'errorCode'})
                self.assertEqual(item['name'], '🚀' * 100)
            seen.extend(item['operationId'] for item in page['operations'])
            cursor = page['nextCursor']
            if cursor is None:
                break
        expected = sorted(records, key=lambda item: (item['createdAt'], item['operationId']), reverse=True)
        self.assertEqual(seen, [item['operationId'] for item in expected])

    def test_empty_missing_invalid_corrupt_and_unexpected_records(self):
        self.assertEqual(self.journal().history(), {'operations': [], 'nextCursor': None})
        with self.assertRaises(backups.BackupError):
            self.journal().history('../escape')
        with self.assertRaises(FileNotFoundError):
            self.journal().history(str(uuid.uuid4()))
        record = self.record(1)
        path = self.root / (record['operationId'] + '.json')
        path.write_text(json.dumps({**record, 'snapshotPath': '/private/secret'}))
        with self.assertRaises(backups.BackupError):
            self.journal().history()
        path.unlink()
        (self.root / 'unexpected').touch()
        with self.assertRaises(backups.BackupError):
            self.journal().history()


if __name__ == '__main__':
    unittest.main()
