import importlib.util
import fcntl
import json
import os
import pathlib
import sqlite3
import sys
import tempfile
import unittest
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('runtime_policy', ROOT / 'apps/updater/runtime-policy.py')
policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy)


class RuntimePolicyTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(':memory:', isolation_level=None)
        self.db.execute('CREATE TABLE operations (id TEXT, digest TEXT, config_digest TEXT, attempt_id TEXT, attempt_nonce TEXT, status TEXT)')
        self.db.execute('CREATE TABLE preparations (operation_id TEXT, attempt_id TEXT, attempt_nonce TEXT, preparation_id TEXT, staging_path TEXT, status TEXT)')
        self.db.execute('INSERT INTO operations VALUES (?,?,?,?,?,?)', ('op', 'sha256:'+'a'*64, 'sha256:'+'b'*64, 'attempt', 'nonce', 'verified'))
        self.db.execute('INSERT INTO preparations VALUES (?,?,?,?,?,?)', ('op', 'attempt', 'nonce', 'prep', '/staging', 'prepared'))

    def tearDown(self):
        self.db.close()

    def test_intent_binds_attempt_nonce_and_preparation(self):
        result = policy._record_identity(self.db, 'op')
        self.assertEqual(result[2:5], ('attempt', 'nonce', 'prep'))
        self.assertEqual(self.db.execute('SELECT status FROM preparations').fetchone()[0], 'preparing')
        with self.assertRaises(policy.PolicyError): policy._record_identity(self.db, 'op')

    def test_rejects_mismatched_identity_and_unverified_release(self):
        for table, column, value in (('operations', 'status', 'verification_failed'),
                                     ('operations', 'config_digest', 'invalid'),
                                     ('preparations', 'attempt_nonce', 'other'),
                                     ('preparations', 'status', 'recovery_required')):
            with self.subTest(column=column):
                self.db.execute('SAVEPOINT fixture')
                self.db.execute(f'UPDATE {table} SET {column}=?', (value,))
                # _record_identity owns a transaction, so release the fixture first.
                self.db.execute('RELEASE fixture')
                with self.assertRaises(policy.PolicyError): policy._record_identity(self.db, 'op')
                self.db.execute("UPDATE operations SET status='verified', config_digest=?", ('sha256:'+'b'*64,))
                self.db.execute("UPDATE preparations SET status='prepared', attempt_nonce='nonce'")

    def test_environment_rejects_duplicate_and_non_servus_keys(self):
        self.assertEqual(policy._env(b'SERVUS_IMAGE=example\n'), {'SERVUS_IMAGE': 'example'})
        for data in (b'SERVUS_X=a\nSERVUS_X=b\n', b'PATH=/tmp\n', b'SERVUS_X=a\x00b\n', b'bad'):
            with self.subTest(data=data), self.assertRaises(policy.PolicyError): policy._env(data)

    def test_probe_intent_records_project_and_config_under_exact_preparation(self):
        policy._record_identity(self.db, 'op')
        project = 'servusprobe' + 'a'*32
        config = 'sha256:' + 'f'*64
        with self.assertRaises(policy.PolicyError):
            policy._record_probe(self.db, 'op', 'wrong', 'nonce', 'prep', project, config)
        policy._record_probe(self.db, 'op', 'attempt', 'nonce', 'prep', project, config)
        self.assertEqual(self.db.execute('SELECT project,config_digest,state FROM policy_probes').fetchone(), (project, config, 'intent'))
        with self.assertRaises(sqlite3.IntegrityError):
            policy._record_probe(self.db, 'op', 'attempt', 'nonce', 'prep', project, config)

    def test_duplicate_json_is_rejected(self):
        with self.assertRaises(policy.PolicyError): policy._json(b'{"x":1,"x":2}')
        with self.assertRaises(policy.PolicyError): policy._json(b'{"x":NaN}')

    @unittest.skipUnless(os.geteuid() == 0 and pathlib.Path('/run').is_dir(), 'Linux root fixture required')
    def test_private_file_rejects_symlink_and_permissions(self):
        with tempfile.TemporaryDirectory(prefix='servus-policy-test-', dir='/run') as directory:
            path = pathlib.Path(directory) / 'env'
            path.write_text('SERVUS_X=one\n')
            path.chmod(0o600)
            self.assertEqual(policy._read_private_file(str(path)), b'SERVUS_X=one\n')
            path.chmod(0o644)
            with self.assertRaises(policy.PolicyError): policy._read_private_file(str(path))
            link = pathlib.Path(directory) / 'link'
            link.symlink_to(path)
            with self.assertRaises(OSError): policy._read_private_file(str(link))

    @unittest.skipUnless(os.geteuid() == 0 and sys.platform == 'linux' and sys.flags.isolated, 'Isolated Linux root fixture required')
    def test_busy_install_lock_prevents_reading_accepted_configuration(self):
        with tempfile.TemporaryDirectory(prefix='servus-policy-lock-', dir='/run') as directory:
            root = pathlib.Path(directory)
            install = root / 'install'; install.mkdir(mode=0o700)
            output = root / 'output'; output.mkdir(mode=0o700)
            stage = root / 'staging'; stage.mkdir(mode=0o700)
            lock = install / 'install.lock'; lock.touch(mode=0o600)
            class Extractor:
                @staticmethod
                def _trusted_parent(path): return os.open(path, os.O_RDONLY | os.O_DIRECTORY)
            class Supervisor:
                @staticmethod
                def _trusted_directory(path): return os.open(path, os.O_RDONLY | os.O_DIRECTORY)
                @staticmethod
                def _open_root_file(parent, name, mode): return os.open(name, os.O_RDONLY, dir_fd=parent)
            holder = os.open(lock, os.O_RDONLY)
            try:
                fcntl.flock(holder, fcntl.LOCK_EX | fcntl.LOCK_NB)
                with mock.patch.object(policy, '_read_private_file') as read:
                    with self.assertRaises(BlockingIOError):
                        policy.produce(None, 'op', str(stage), str(root / 'env'), str(install), str(output / 'candidate.json'), Extractor, Supervisor)
                    read.assert_not_called()
            finally:
                os.close(holder)


if __name__ == '__main__':
    unittest.main()
