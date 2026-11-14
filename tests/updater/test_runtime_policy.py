import importlib.util
import fcntl
import json
import os
import pathlib
import sqlite3
import sys
import tempfile
import unittest
import hashlib
import uuid
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


@unittest.skipUnless(sys.platform == 'linux' and os.geteuid() == 0 and sys.flags.isolated, 'Isolated Linux root fixture required')
class LockedActivationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='servus-swap-', dir='/run')
        self.root = pathlib.Path(self.tmp.name)
        self.install = self.root / 'install'; self.install.mkdir(mode=0o700)
        self.control = self.root / 'control'; self.control.mkdir(mode=0o700)
        self.private = self.root / 'private'; self.private.mkdir(mode=0o700)
        self.install_fd = os.open(self.install, os.O_RDONLY | os.O_DIRECTORY)
        self.control_fd = os.open(self.control, os.O_RDONLY | os.O_DIRECTORY)
        self.op = str(uuid.uuid4()); self.old_op = str(uuid.uuid4())
        self.attempt = str(uuid.uuid4()); self.nonce = 'e'*64; self.prep = str(uuid.uuid4())
        self.root_digest = 'sha256:'+'a'*64; self.config_digest = 'sha256:'+'b'*64
        self.env = ('SERVUS_IMAGE=ghcr.io/raxon/servus@'+self.root_digest+'\n').encode()
        self.old_env = b'SERVUS_IMAGE=ghcr.io/raxon/servus@sha256:' + b'c'*64 + b'\n'
        self.accepted = self.private/'candidate.env'; self.snapshot = self.private/'snapshot.env'
        self.active_env = self.private/'active.env'; self.old_snapshot = self.private/'old.env'
        self.old_policy = self.private/'old.json'; self.candidate = self.private/'candidate.json'
        self.target = self.private/'new.json'
        for path, content in ((self.accepted,self.env),(self.snapshot,self.env),(self.active_env,self.env),
                              (self.old_snapshot,self.old_env),(self.old_policy,b'old policy')):
            path.write_bytes(content); path.chmod(0o600)
        self.candidate.write_text(json.dumps({'version':1,'policy':{'image_reference':'ghcr.io/raxon/servus@'+self.root_digest,'install_dir':str(self.install),'control_dir':str(self.control)}}))
        self.candidate.chmod(0o600)
        self.db = sqlite3.connect(':memory:', isolation_level=None)
        self.db.executescript('''
          CREATE TABLE operations (id TEXT PRIMARY KEY,attempt_id TEXT,attempt_nonce TEXT,digest TEXT,config_digest TEXT,status TEXT);
          CREATE TABLE preparations (operation_id TEXT PRIMARY KEY,attempt_id TEXT,attempt_nonce TEXT,preparation_id TEXT,status TEXT);
          CREATE TABLE policy_approvals (operation_id TEXT PRIMARY KEY,attempt_id TEXT,attempt_nonce TEXT,preparation_id TEXT,root_digest TEXT,image_config_digest TEXT,env_digest TEXT,candidate_digest TEXT,accepted_env_path TEXT,source_env_path TEXT,candidate_path TEXT,policy_path TEXT,state TEXT);
          CREATE UNIQUE INDEX one_active_policy ON policy_approvals ((1)) WHERE state='active';
          CREATE TABLE policy_probes (operation_id TEXT,preparation_id TEXT,config_digest TEXT,state TEXT);
          CREATE TABLE extraction_probes (status TEXT);
          CREATE TABLE update_transactions (operation_id TEXT,preparation_id TEXT,attempt_id TEXT,attempt_nonce TEXT,root_digest TEXT,backup_path TEXT,backup_manifest_digest TEXT,phase TEXT);
        ''')
        digest = lambda data:'sha256:'+hashlib.sha256(data).hexdigest()
        self.env_digest=digest(self.env); self.candidate_digest=digest(self.candidate.read_bytes())
        self.db.execute('INSERT INTO operations VALUES (?,?,?,?,?,?)',(self.op,self.attempt,self.nonce,self.root_digest,self.config_digest,'verified'))
        self.db.execute('INSERT INTO preparations VALUES (?,?,?,?,?)',(self.op,self.attempt,self.nonce,self.prep,'prepared'))
        self.db.execute('INSERT INTO preparations VALUES (?,?,?,?,?)',(self.old_op,'old','old','old','completed'))
        self.db.execute('INSERT INTO policy_approvals VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
          (self.op,self.attempt,self.nonce,self.prep,self.root_digest,self.config_digest,self.env_digest,self.candidate_digest,str(self.snapshot),str(self.accepted),str(self.candidate),None,'candidate'))
        self.db.execute('INSERT INTO policy_approvals VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
          (self.old_op,'old','old','old','sha256:'+'c'*64,'sha256:'+'d'*64,digest(self.old_env),digest(b'old policy'),str(self.old_snapshot),str(self.active_env),'old',str(self.old_policy),'active'))
        self.db.execute('INSERT INTO policy_probes VALUES (?,?,?,?)',(self.op,self.prep,self.env_digest,'removed'))
        self.db.execute('INSERT INTO update_transactions VALUES (?,?,?,?,?,?,?,?)',(self.op,self.prep,self.attempt,self.nonce,self.root_digest,str(self.private),'sha256:'+'f'*64,'snapshot_verified'))
        self.journal=type('Journal',(),{'db':self.db})()
        self.calls=[]
        class Lease:
            def __init__(inner): inner._owner=type('Owner',(),{'install':self.install_fd})(); inner.valid=True; inner.active=True
            def assert_snapshot_verified(inner,operation):
                if not inner.valid or operation!=self.op: raise policy.PolicyError('Invalid lease')
            def assert_active_policy(inner,path,env_digest,policy_digest):
                if (not inner.active or path != str(self.old_policy) or env_digest != digest(self.old_env) or
                    policy_digest != digest(b'old policy')): raise policy.PolicyError('Invalid active policy')
        self.lease=Lease()
        class Supervisor:
            DrainLease=Lease
            @staticmethod
            def _uuid4(value):
                try: return str(uuid.UUID(value))==value and uuid.UUID(value).version==4
                except ValueError: return False
            @staticmethod
            def RuntimePolicy(**fields): return type('Policy',(),fields)()
        self.supervisor=Supervisor
        class Ownership:
            directory=self.control_fd
            def assert_held(inner,path):
                if path != str(self.control): raise policy.PolicyError('Invalid daemon lock')
        self.ownership=Ownership()
        class Extractor:
            @staticmethod
            def _trusted_parent(path): return os.open(path,os.O_RDONLY|os.O_DIRECTORY)
        self.extractor=Extractor
        class Coordinator:
            @staticmethod
            def verify_snapshot(path,digest,backup,node,supervisor): self.calls.append((path,digest))
        self.coordinator=Coordinator

    def tearDown(self):
        self.db.close(); os.close(self.install_fd); os.close(self.control_fd); self.tmp.cleanup()

    def activate(self):
        return policy.activate_locked(self.journal,self.op,str(self.accepted),str(self.candidate),str(self.target),
            str(self.active_env),self.lease,self.ownership,self.extractor,self.supervisor,self.coordinator,object(),0)

    @unittest.skipUnless(pathlib.Path('/app/dist/server/store.js').is_file(), 'Requires built Servus application and Node')
    def test_real_snapshot_and_held_locks_with_synthetic_drain(self):
        # This fixture constructs the lease directly: it tests the real lock and
        # snapshot verifiers, but does not claim an authenticated Docker drain.
        import copy
        import shutil
        def load(name, path):
            module_spec = importlib.util.spec_from_file_location(name, ROOT / path)
            module = importlib.util.module_from_spec(module_spec)
            module_spec.loader.exec_module(module)
            return module

        backup_tests = load('policy_integration_backup_tests', 'tests/updater/test_backup.py')
        supervisor_tests = load('policy_integration_supervisor_tests', 'tests/updater/test_supervisor.py')
        CaptureTest, backup = backup_tests.CaptureTest, backup_tests.backup
        HOST_CONFIGS, HEALTHCHECK = supervisor_tests.HOST_CONFIGS, supervisor_tests.HEALTHCHECK
        supervisor = load('policy_integration_supervisor', 'apps/updater/supervisor.py')
        old_module = sys.modules.get('supervisor')
        sys.modules['supervisor'] = supervisor
        try:
            daemon = load('policy_integration_daemon', 'apps/updater/supervisor-daemon.py')
        finally:
            if old_module is None: sys.modules.pop('supervisor', None)
            else: sys.modules['supervisor'] = old_module
        coordinator = load('policy_integration_coordinator', 'apps/updater/update-coordinator.py')
        gate = self.root / 'gate'; gate.mkdir(mode=0o755)
        journal_dir = self.root / 'journal'; journal_dir.mkdir(mode=0o700)
        self.control.chmod(0o750)
        (gate / 'state').write_text('servus-lifecycle-v1 maintenance\n')
        (gate / 'state').chmod(0o644)
        (gate / 'lock').touch(mode=0o644)
        (self.install / 'install.lock').touch(mode=0o600)
        capture = CaptureTest('test_real_store_agent_committed_wal_and_isolated_restore')
        capture.setUp()
        try:
            capture.panel.close(); capture.agent.close(); capture.capture()
            destination = self.private / 'backup'
            shutil.copytree(capture.dst, destination)
            digest = 'sha256:' + hashlib.sha256((destination / 'manifest.json').read_bytes()).hexdigest()
            self.db.execute('UPDATE update_transactions SET backup_path=?,backup_manifest_digest=?', (str(destination), digest))
            roles = supervisor.ROLES
            fields = {'image_reference': 'ghcr.io/raxon/servus@' + self.root_digest,
                'image_id': 'sha256:' + 'b'*64, 'install_dir': str(self.install),
                'data_dir': '/var/lib/servus', 'gate_dir': str(gate), 'control_dir': str(self.control),
                'secret_sources': {role: str(self.private / ('secret-' + role)) for role in roles},
                'config_hashes': {role: 'c'*64 for role in roles},
                'environments': {role: {'PANEL_DATA_DIR': '/var/lib/servus'} for role in roles},
                'host_configs': copy.deepcopy(HOST_CONFIGS),
                'healthchecks': {role: copy.deepcopy(HEALTHCHECK) for role in roles}}
            self.candidate.write_text(json.dumps({'version': 1, 'policy': fields}))
            digest_policy = 'sha256:' + hashlib.sha256(self.candidate.read_bytes()).hexdigest()
            self.db.execute('UPDATE policy_approvals SET candidate_digest=? WHERE operation_id=?', (digest_policy, self.op))
            with supervisor.MaintenanceSupervisor(str(self.install), str(gate), str(journal_dir)) as owner:
                fcntl.flock(owner.gate_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                ownership = daemon.DaemonOwnership(str(self.control), str(journal_dir), 0)
                try:
                    binding = (str(self.old_policy), 'sha256:' + hashlib.sha256(self.old_env).hexdigest(),
                               'sha256:' + hashlib.sha256(b'old policy').hexdigest(), None)
                    lease = supervisor.DrainLease(owner, self.op,
                        {role: str(uuid.uuid4()) for role in roles}, 30000, binding)
                    lease.record('snapshotting'); lease.record('snapshot_verified')
                    policy.activate_locked(self.journal, self.op, str(self.accepted), str(self.candidate),
                        str(self.target), str(self.active_env), lease, ownership, self.extractor,
                        supervisor, coordinator, backup, capture.node_fd)
                    self.assertEqual(self.db.execute('SELECT state FROM policy_approvals WHERE operation_id=?',
                                                     (self.op,)).fetchone()[0], 'active')
                    self.assertEqual(self.target.read_bytes(), self.candidate.read_bytes())
                finally:
                    ownership.close()
        finally:
            capture.tearDown()

    def test_verified_snapshot_atomically_supersedes_old_policy(self):
        self.assertEqual(self.activate(),str(self.target))
        self.assertEqual(self.target.read_bytes(),self.candidate.read_bytes())
        self.assertEqual(self.db.execute('SELECT state FROM policy_approvals WHERE operation_id=?',(self.old_op,)).fetchone()[0],'superseded')
        self.assertEqual(self.db.execute('SELECT state,source_env_path FROM policy_approvals WHERE operation_id=?',(self.op,)).fetchone(),('active',str(self.active_env)))
        self.assertEqual(len(self.calls),1)

    def test_rejects_unverified_snapshot_mismatch_and_expired_lease(self):
        for field,value in [('phase','switching'),('attempt_nonce','wrong'),('root_digest','sha256:'+'f'*64)]:
            with self.subTest(field=field):
                original=self.db.execute(f'SELECT {field} FROM update_transactions').fetchone()[0]
                self.db.execute(f'UPDATE update_transactions SET {field}=?',(value,))
                with self.assertRaises(policy.PolicyError): self.activate()
                self.db.execute(f'UPDATE update_transactions SET {field}=?',(original,))
        self.lease.valid=False
        with self.assertRaises(policy.PolicyError): self.activate()
        self.assertFalse(self.target.exists())

    def test_failed_snapshot_verification_does_not_publish(self):
        def rejected(*_): raise policy.PolicyError('Invalid snapshot')
        self.coordinator.verify_snapshot=rejected
        with self.assertRaises(policy.PolicyError): self.activate()
        self.assertFalse(self.target.exists())
        self.assertEqual(self.db.execute('SELECT state FROM policy_approvals WHERE operation_id=?',(self.old_op,)).fetchone()[0],'active')

    def test_unrelated_drained_hub_cannot_authorize_swap(self):
        self.lease.active=False
        with self.assertRaises(policy.PolicyError): self.activate()
        self.assertFalse(self.target.exists())
        self.assertEqual(self.db.execute('SELECT state FROM policy_approvals WHERE operation_id=?',(self.old_op,)).fetchone()[0],'active')

    def test_failure_after_publication_requires_recovery(self):
        original=policy._publish_private
        def publish_then_fail(*args):
            original(*args)
            raise OSError('injected failure')
        with mock.patch.object(policy,'_publish_private',side_effect=publish_then_fail):
            with self.assertRaises(OSError): self.activate()
        self.assertTrue(self.target.exists())
        self.assertEqual(self.db.execute('SELECT state FROM policy_approvals WHERE operation_id=?',(self.op,)).fetchone()[0],'recovery_required')
        self.assertEqual(self.db.execute('SELECT state FROM policy_approvals WHERE operation_id=?',(self.old_op,)).fetchone()[0],'active')

    def test_proof_revoked_after_publication_cannot_activate(self):
        original=policy._publish_private
        def publish_and_revoke(*args):
            original(*args)
            self.db.execute("UPDATE update_transactions SET phase='recovery_required' WHERE operation_id=?",(self.op,))
        with mock.patch.object(policy,'_publish_private',side_effect=publish_and_revoke):
            with self.assertRaises(policy.PolicyError): self.activate()
        self.assertEqual(self.db.execute('SELECT state FROM policy_approvals WHERE operation_id=?',(self.op,)).fetchone()[0],'recovery_required')
        self.assertEqual(self.db.execute('SELECT state FROM policy_approvals WHERE operation_id=?',(self.old_op,)).fetchone()[0],'active')


if __name__ == '__main__':
    unittest.main()
