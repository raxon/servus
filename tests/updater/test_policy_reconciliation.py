import importlib.util
import pathlib
import os
import sqlite3
import tempfile
import unittest
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('reconcile_policy', ROOT / 'apps/updater/reconcile-policy-journal.py')
recovery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recovery)
fence_spec = importlib.util.spec_from_file_location('policy_fence', ROOT / 'apps/updater/reconcile-policy-fence.py')
fence = importlib.util.module_from_spec(fence_spec)
fence_spec.loader.exec_module(fence)
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

    def test_requeues_failed_dispatch_only_before_policy_work(self):
        self.db.execute("UPDATE preparations SET status='prepared'")
        self.db.execute('DELETE FROM policy_probes')
        recovery.requeue_unstarted(self.db, OP)
        self.assertEqual(self.db.execute('SELECT state FROM apply_requests').fetchone(), ('requested',))
        self.assertEqual(self.db.execute('SELECT operation_id,preparation_id FROM apply_reconciliations').fetchone(), (OP, PREP))
        with self.assertRaises(recovery.ReconciliationError): recovery.requeue_unstarted(self.db, OP)

    def test_unstarted_dispatch_rejects_policy_or_switch_evidence(self):
        self.db.execute("UPDATE preparations SET status='prepared'")
        with self.assertRaises(recovery.ReconciliationError): recovery.requeue_unstarted(self.db, OP)
        self.db.execute('DELETE FROM policy_probes')
        self.db.execute("INSERT INTO update_transactions VALUES(?, 'intent')", (OP,))
        with self.assertRaises(recovery.ReconciliationError): recovery.requeue_unstarted(self.db, OP)
        self.assertEqual(self.db.execute('SELECT state FROM apply_requests').fetchone(), ('recovery_required',))

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

    @unittest.skipUnless(os.geteuid() == 0 and pathlib.Path('/proc/self/fd').exists(), 'Requires a Linux root fixture')
    def test_archives_artifacts_and_journal_before_requeuing(self):
        with tempfile.TemporaryDirectory() as directory:
            policy_dir = pathlib.Path(directory) / 'policy'; policy_dir.mkdir(mode=0o700)
            recovery_dir = pathlib.Path(directory) / 'recovery'; recovery_dir.mkdir(mode=0o700)
            names = ('candidate-env-' + PREP + '.env', 'env-' + PREP + '.env', 'candidate-' + PREP + '.json')
            for name in names:
                path = policy_dir / name; path.write_text('private'); path.chmod(0o600)
            policy_fd = os.open(policy_dir, os.O_RDONLY | os.O_DIRECTORY)
            recovery_fd = os.open(recovery_dir, os.O_RDONLY | os.O_DIRECTORY)
            try:
                recovery.archive_and_reconcile(self.db, OP, policy_fd, recovery_fd)
            finally:
                os.close(policy_fd); os.close(recovery_fd)
            archive = recovery_dir / ('policy-recovery-' + PREP)
            self.assertTrue(all((archive / name).read_text() == 'private' for name in names))
            self.assertTrue(all(not (policy_dir / name).exists() for name in names))
            with sqlite3.connect(archive / 'journal.sqlite') as backup:
                self.assertEqual(backup.execute('SELECT status FROM preparations').fetchone(), ('recovery_required',))
            self.assertEqual(self.db.execute('SELECT status FROM preparations').fetchone(), ('prepared',))

    @unittest.skipUnless(os.geteuid() == 0 and pathlib.Path('/proc/self/fd').exists(), 'Requires a Linux root fixture')
    def test_interrupted_archive_never_requeues(self):
        with tempfile.TemporaryDirectory() as directory:
            policy_dir = pathlib.Path(directory) / 'policy'; policy_dir.mkdir(mode=0o700)
            recovery_dir = pathlib.Path(directory) / 'recovery'; recovery_dir.mkdir(mode=0o700)
            for name in ('candidate-env-' + PREP + '.env', 'env-' + PREP + '.env', 'candidate-' + PREP + '.json'):
                path = policy_dir / name; path.write_text('private'); path.chmod(0o600)
            policy_fd = os.open(policy_dir, os.O_RDONLY | os.O_DIRECTORY)
            recovery_fd = os.open(recovery_dir, os.O_RDONLY | os.O_DIRECTORY)
            rename = os.rename
            calls = []
            def interrupt_second(*args, **kwargs):
                calls.append(args[0])
                if len(calls) == 2:
                    raise OSError('interrupted')
                return rename(*args, **kwargs)
            try:
                with mock.patch.object(recovery.os, 'rename', side_effect=interrupt_second):
                    with self.assertRaises(OSError):
                        recovery.archive_and_reconcile(self.db, OP, policy_fd, recovery_fd)
            finally:
                os.close(policy_fd); os.close(recovery_fd)
            self.assertEqual(self.db.execute('SELECT status FROM preparations').fetchone(), ('recovery_required',))
            self.assertEqual(self.db.execute('SELECT state FROM apply_requests').fetchone(), ('recovery_required',))
            archive = recovery_dir / ('policy-recovery-' + PREP)
            self.assertTrue((archive / 'journal.sqlite').exists())
            self.assertTrue((archive / calls[0]).exists())
            self.assertTrue((policy_dir / calls[1]).exists())

    @unittest.skipUnless(os.geteuid() == 0 and pathlib.Path('/proc/self/fd').exists(), 'Requires a Linux root fixture')
    def test_rejects_symlink_before_creating_archive(self):
        with tempfile.TemporaryDirectory() as directory:
            policy_dir = pathlib.Path(directory) / 'policy'; policy_dir.mkdir(mode=0o700)
            recovery_dir = pathlib.Path(directory) / 'recovery'; recovery_dir.mkdir(mode=0o700)
            names = ('candidate-env-' + PREP + '.env', 'env-' + PREP + '.env', 'candidate-' + PREP + '.json')
            for name in names:
                path = policy_dir / name; path.write_text('private'); path.chmod(0o600)
            (policy_dir / names[0]).unlink()
            (policy_dir / names[0]).symlink_to(policy_dir / names[1])
            policy_fd = os.open(policy_dir, os.O_RDONLY | os.O_DIRECTORY)
            recovery_fd = os.open(recovery_dir, os.O_RDONLY | os.O_DIRECTORY)
            try:
                with self.assertRaises(recovery.ReconciliationError):
                    recovery.archive_and_reconcile(self.db, OP, policy_fd, recovery_fd)
            finally:
                os.close(policy_fd); os.close(recovery_fd)
            self.assertEqual(list(recovery_dir.iterdir()), [])
            self.assertEqual(self.db.execute('SELECT status FROM preparations').fetchone(), ('recovery_required',))

    @unittest.skipUnless(os.geteuid() == 0 and pathlib.Path('/proc/self/fd').exists(), 'Requires a Linux root fixture')
    def test_fenced_recovery_archives_and_requeues(self):
        self.db.execute('ALTER TABLE extraction_probes ADD COLUMN name TEXT')
        self.db.execute('UPDATE extraction_probes SET name=?', ('servus-extract-' + 'e' * 32,))
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            for name in ('state', 'install', 'policy', 'recovery'):
                (root / name).mkdir(mode=0o700)
            (root / 'state' / 'maintenance').mkdir(mode=0o700)
            for path in (root / 'state' / 'service.lock', root / 'install' / 'install.lock'):
                path.touch(mode=0o600)
            for name in ('candidate-env-' + PREP + '.env', 'env-' + PREP + '.env', 'candidate-' + PREP + '.json'):
                path = root / 'policy' / name; path.write_text('private'); path.chmod(0o600)
            fds = [os.open(root / name, os.O_RDONLY | os.O_DIRECTORY) for name in ('state', 'install', 'policy', 'recovery')]
            try:
                inactive = 'LoadState=loaded\nActiveState=inactive\nControlGroup=\n'
                fence.fenced_reconcile(self.db, OP, *fds, recovery,
                                       execute=lambda command: inactive if command[0].endswith('systemctl') else '')
            finally:
                for fd in fds: os.close(fd)
            self.assertEqual(self.db.execute('SELECT state FROM apply_requests').fetchone(), ('requested',))
            self.assertTrue((root / 'recovery' / ('policy-recovery-' + PREP) / 'journal.sqlite').exists())


class AbandonedUpdateTest(unittest.TestCase):
    def setUp(self):
        self.db=sqlite3.connect(':memory:',isolation_level=None)
        self.db.executescript('''
        CREATE TABLE operations(id TEXT,status TEXT,attempt_id TEXT,attempt_nonce TEXT,digest TEXT,config_digest TEXT);
        CREATE TABLE preparations(operation_id TEXT,preparation_id TEXT,attempt_id TEXT,attempt_nonce TEXT,status TEXT);
        CREATE TABLE update_transactions(operation_id TEXT,preparation_id TEXT,attempt_id TEXT,attempt_nonce TEXT,root_digest TEXT,phase TEXT,backup_path TEXT,backup_manifest_digest TEXT);
        CREATE TABLE apply_requests(operation_id TEXT,state TEXT);
        CREATE TABLE extraction_probes(operation_id TEXT,status TEXT);
        CREATE TABLE policy_probes(operation_id TEXT,attempt_id TEXT,attempt_nonce TEXT,preparation_id TEXT,state TEXT);
        CREATE TABLE policy_approvals(operation_id TEXT,attempt_id TEXT,attempt_nonce TEXT,preparation_id TEXT,root_digest TEXT,image_config_digest TEXT,state TEXT);
        ''')
        self.db.execute('INSERT INTO operations VALUES(?,?,?,?,?,?)',(OP,'verified',ATTEMPT,NONCE,'root','config'))
        self.db.execute('INSERT INTO preparations VALUES(?,?,?,?,?)',(OP,PREP,ATTEMPT,NONCE,'prepared'))
        self.db.execute('INSERT INTO update_transactions VALUES(?,?,?,?,?,?,?,?)',(OP,PREP,ATTEMPT,NONCE,'root','recovery_required',None,None))
        self.db.execute('INSERT INTO apply_requests VALUES(?,?)',(OP,'recovery_required'))
        self.db.execute('INSERT INTO extraction_probes VALUES(?,?)',(OP,'removed'))
        self.db.execute('INSERT INTO policy_probes VALUES(?,?,?,?,?)',(OP,ATTEMPT,NONCE,PREP,'removed'))
        self.db.execute('INSERT INTO policy_approvals VALUES(?,?,?,?,?,?,?)',(OP,ATTEMPT,NONCE,PREP,'root','config','candidate'))
        self.db.execute('INSERT INTO policy_approvals VALUES(?,?,?,?,?,?,?)',('old','old-attempt','old-nonce','old-prep','old-root','old-config','active'))

    def tearDown(self): self.db.close()

    def test_preserves_evidence_and_only_retires_failed_attempt(self):
        recovery.archive_failed_before_snapshot(self.db,OP)
        evidence=self.db.execute('SELECT evidence_json FROM abandoned_updates WHERE operation_id=?',(OP,)).fetchone()[0]
        self.assertIn('recovery_required',evidence)
        for table in ('update_transactions','apply_requests','preparations','policy_approvals'):
            self.assertEqual(self.db.execute('SELECT count(*) FROM '+table+' WHERE operation_id=?',(OP,)).fetchone(),(0,))
        self.assertEqual(self.db.execute("SELECT operation_id FROM policy_approvals WHERE state='active'").fetchone(),('old',))
        self.assertEqual(self.db.execute('SELECT status FROM operations WHERE id=?',(OP,)).fetchone(),('verified',))

    def test_rejects_snapshot_activation_and_unresolved_probes(self):
        for sql in ("UPDATE update_transactions SET backup_path='/backup'", "UPDATE update_transactions SET backup_manifest_digest='digest'",
                    "UPDATE policy_approvals SET state='activating' WHERE operation_id='"+OP+"'",
                    "UPDATE policy_probes SET state='intent'", "UPDATE extraction_probes SET status='intent'",
                    "UPDATE preparations SET status='recovery_required'", "UPDATE apply_requests SET state='dispatching'"):
            with self.subTest(sql=sql):
                self.db.execute('SAVEPOINT fixture');self.db.execute(sql);self.db.execute('RELEASE fixture')
                with self.assertRaises(recovery.ReconciliationError): recovery.archive_failed_before_snapshot(self.db,OP)
                self.assertEqual(self.db.execute('SELECT count(*) FROM update_transactions WHERE operation_id=?',(OP,)).fetchone(),(1,))
                self.tearDown();self.setUp()


if __name__ == '__main__':
    unittest.main()
