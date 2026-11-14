import importlib.util
import pathlib
import sqlite3
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('reconcile_policy', ROOT / 'apps/updater/reconcile-policy-journal.py')
recovery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recovery)
OP = '12345678-1234-4123-8123-123456789abc'
PREP = '12345678-1234-4123-8123-123456789abd'
ATTEMPT = '12345678-1234-4123-8123-123456789abe'
NONCE = 'c' * 64


class ReconciliationTest(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(':memory:', isolation_level=None)
        self.db.executescript('''
        CREATE TABLE operations(id TEXT PRIMARY KEY,status TEXT,attempt_id TEXT,attempt_nonce TEXT,config_digest TEXT);
        CREATE TABLE preparations(operation_id TEXT,attempt_id TEXT,attempt_nonce TEXT,preparation_id TEXT,status TEXT,staging_path TEXT);
        CREATE TABLE apply_requests(operation_id TEXT,state TEXT);
        CREATE TABLE update_transactions(operation_id TEXT,phase TEXT);
        CREATE TABLE extraction_probes(operation_id TEXT,attempt_id TEXT,attempt_nonce TEXT,preparation_id TEXT,purpose TEXT,status TEXT);
        CREATE TABLE policy_approvals(operation_id TEXT,state TEXT);
        CREATE TABLE policy_probes(operation_id TEXT,attempt_id TEXT,attempt_nonce TEXT,preparation_id TEXT,project TEXT,config_digest TEXT,state TEXT);
        ''')
        self.db.execute('INSERT INTO operations VALUES(?,?,?,?,?)', (OP, 'verified', ATTEMPT, NONCE, 'sha256:' + 'a' * 64))
        self.db.execute('INSERT INTO preparations VALUES(?,?,?,?,?,?)', (OP, ATTEMPT, NONCE, PREP, 'recovery_required', '/staging/servus-install-' + 'b' * 32))
        self.db.execute('INSERT INTO apply_requests VALUES(?,?)', (OP, 'recovery_required'))
        self.db.execute('INSERT INTO extraction_probes VALUES(?,?,?,?,?,?)', (OP, ATTEMPT, NONCE, PREP, 'prepare', 'removed'))
        self.db.execute('INSERT INTO policy_probes VALUES(?,?,?,?,?,?,?)', (OP, ATTEMPT, NONCE, PREP, 'servusprobe' + 'a' * 32, 'sha256:' + 'd' * 64, 'removed'))

    def tearDown(self):
        self.db.close()

    def test_requeues_only_pre_switch_attempt_and_preserves_probe_evidence(self):
        recovery.reconcile(self.db, OP)
        self.assertEqual(self.db.execute('SELECT status FROM preparations').fetchone(), ('prepared',))
        self.assertEqual(self.db.execute('SELECT state FROM apply_requests').fetchone(), ('requested',))
        self.assertEqual(self.db.execute('SELECT count(*) FROM policy_probes').fetchone(), (0,))
        self.assertEqual(self.db.execute('SELECT operation_id,preparation_id FROM policy_reconciliations').fetchone(), (OP, PREP))
        with self.assertRaises(recovery.ReconciliationError):
            recovery.reconcile(self.db, OP)

    def test_rejects_ambiguous_state_without_changing_journal(self):
        cases = [
            ("UPDATE operations SET status='verification_failed'", ()),
            ("UPDATE preparations SET attempt_nonce='other'", ()),
            ("UPDATE preparations SET staging_path=NULL", ()),
            ("UPDATE preparations SET staging_path='/tmp/../wrong'", ()),
            ("UPDATE apply_requests SET state='dispatching'", ()),
            ("INSERT INTO update_transactions VALUES(?, 'intent')", (OP,)),
            ("INSERT INTO update_transactions VALUES(?, 'completed')", (OP,)),
            ("UPDATE extraction_probes SET status='intent'", ()),
            ("UPDATE extraction_probes SET purpose='policy'", ()),
            ("INSERT INTO policy_approvals VALUES(?, 'candidate')", (OP,)),
            ("UPDATE policy_probes SET state='intent'", ()),
            ("UPDATE policy_probes SET attempt_nonce='other'", ()),
        ]
        for sql, args in cases:
            with self.subTest(sql=sql):
                self.db.execute('SAVEPOINT fixture')
                self.db.execute(sql, args)
                self.db.execute('RELEASE fixture')
                with self.assertRaises(recovery.ReconciliationError):
                    recovery.reconcile(self.db, OP)
                self.assertEqual(self.db.execute('SELECT status FROM preparations').fetchone()[0], 'recovery_required')
                self.tearDown()
                self.setUp()


if __name__ == '__main__':
    unittest.main()
