import importlib.util
from pathlib import Path
import unittest
import test_policy_reconciliation as fixture

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('pre_switch_recovery', ROOT / 'apps/updater/recover-pre-switch.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class RecoveryProofTest(unittest.TestCase):
    def setUp(self):
        self.fixture = fixture.AbandonedUpdateTest()
        self.fixture.setUp()
        self.db = self.fixture.db

    def tearDown(self):
        self.fixture.tearDown()

    def test_proof_does_not_retire_or_modify_live_journal(self):
        before = list(self.db.iterdump())
        module.prove(self.db, fixture.OP, fixture.recovery)
        self.assertEqual(before, list(self.db.iterdump()))

    def test_refuses_any_recorded_snapshot_or_switch(self):
        for sql in ("UPDATE update_transactions SET backup_path='/backup'",
                    "UPDATE update_transactions SET backup_manifest_digest='digest'",
                    "UPDATE policy_approvals SET state='activating' WHERE state='candidate'"):
            with self.subTest(sql=sql):
                self.db.execute(sql)
                with self.assertRaises(fixture.recovery.ReconciliationError):
                    module.prove(self.db, fixture.OP, fixture.recovery)
                self.tearDown()
                self.setUp()

    def test_refuses_overlapping_host_exchange(self):
        self.db.execute('CREATE TABLE host_switches(phase TEXT)')
        self.db.execute("INSERT INTO host_switches VALUES('switching')")
        with self.assertRaisesRegex(RuntimeError, 'Host update'):
            module.prove(self.db, fixture.OP, fixture.recovery)

    def test_allows_completed_host_exchange(self):
        self.db.execute('CREATE TABLE host_switches(phase TEXT)')
        self.db.execute("INSERT INTO host_switches VALUES('completed')")
        module.prove(self.db, fixture.OP, fixture.recovery)


if __name__ == '__main__':
    unittest.main()
