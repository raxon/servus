import importlib.util
import json
import pathlib
import sqlite3
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('update_diagnose', ROOT / 'scripts/update-diagnose.py')
diagnostic = importlib.util.module_from_spec(spec)
spec.loader.exec_module(diagnostic)
OP = '12345678-1234-4123-8123-123456789abc'


class DiagnosticTest(unittest.TestCase):
    def test_reports_failure_without_copying_secrets_from_logs(self):
        with tempfile.TemporaryDirectory() as temp:
            state = pathlib.Path(temp)
            (state / 'maintenance').mkdir()
            (state / 'maintenance' / 'maintenance.json').write_text(json.dumps({'operationId': OP, 'state': 'recovery_required'}))
            with sqlite3.connect(state / 'journal.sqlite') as db:
                db.execute('CREATE TABLE update_transactions(operation_id TEXT, phase TEXT, backup_manifest_digest TEXT)')
                db.execute('INSERT INTO update_transactions VALUES(?,?,?)', (OP, 'recovery_required', None))
            logs = 'secret=do-not-share\nservus drain failure role=api outcome=uncertain\nservus maintenance failure phase=drain\n'
            result = diagnostic.diagnose(state, logs)
            self.assertEqual(result['operation_id'], OP)
            self.assertEqual(result['phase'], 'recovery_required')
            self.assertFalse(result['snapshot_verified'])
            self.assertEqual(len(result['events']), 2)
            self.assertNotIn('do-not-share', json.dumps(result))

    def test_missing_or_invalid_evidence_remains_unknown(self):
        with tempfile.TemporaryDirectory() as temp:
            state = pathlib.Path(temp)
            (state / 'maintenance').mkdir()
            (state / 'maintenance' / 'maintenance.json').write_text(json.dumps({'operationId': 'invalid', 'state': 'recovery_required'}))
            result = diagnostic.diagnose(state)
            self.assertIsNone(result['operation_id'])
            self.assertIsNone(result['snapshot_verified'])
            self.assertEqual(result['phase'], 'unavailable')

    def test_only_includes_matching_operation_and_known_outcomes(self):
        with tempfile.TemporaryDirectory() as temp:
            state = pathlib.Path(temp)
            (state / 'maintenance').mkdir()
            (state / 'maintenance' / 'maintenance.json').write_text(json.dumps({'operationId': OP, 'state': 'recovery_required'}))
            own = f'servus maintenance operation={OP} failure phase=drain'
            other = 'servus maintenance operation=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa failure phase=drain'
            result = diagnostic.diagnose(state, f'{own}\n{other}\nservus drain failure role=api outcome=channel_error\n')
            self.assertEqual(result['events'], [own, 'servus drain failure role=api outcome=channel_error'])


if __name__ == '__main__':
    unittest.main()
