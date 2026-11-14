import hashlib
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import shutil
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock
import uuid

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'apps/updater'))
import supervisor

def load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module); return module
bootstrap = load('bootstrap_policy', 'apps/updater/bootstrap-policy.py')
policy = load('bootstrap_runtime_policy', 'apps/updater/runtime-policy.py')
extractor = load('bootstrap_extract', 'apps/updater/extract-install.py')
daemon = load('bootstrap_supervisor_daemon', 'apps/updater/supervisor-daemon.py')


@unittest.skipUnless(sys.platform == 'linux' and os.geteuid() == 0 and sys.flags.isolated, 'Requires isolated Linux root')
class BootstrapPolicyTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir='/root'); self.root = Path(self.temp.name)
        self.install = self.root/'install'; self.control = self.root/'control'; self.private = self.root/'private'; self.staging = self.root/'staging'
        for directory in (self.install, self.private, self.staging): directory.mkdir(mode=0o700)
        self.control.mkdir(mode=0o750); (self.install/'install.lock').touch(mode=0o600)
        self.op, self.attempt, self.prep = (str(uuid.uuid4()) for _ in range(3))
        self.stage = self.staging/('servus-install-'+'a'*32); self.stage.mkdir(mode=0o700)
        self.env = self.private/'servus.env'; self.snapshot = self.private/'snapshot.env'
        self.candidate = self.private/('candidate-'+self.prep+'.json'); self.active = self.private/('policy-'+self.op+'.json')
        self.digest='sha256:'+'b'*64; self.config='sha256:'+'c'*64
        env=('SERVUS_IMAGE=ghcr.io/raxon/servus@'+self.digest+'\n').encode()
        document=json.dumps({'version':1,'policy':{'image_reference':'ghcr.io/raxon/servus@'+self.digest,'install_dir':str(self.install),'control_dir':str(self.control)}}).encode()
        for path, content in ((self.env,env),(self.snapshot,env),(self.candidate,document)):
            path.write_bytes(content);path.chmod(0o600)
        self.db=sqlite3.connect(':memory:',isolation_level=None)
        self.db.executescript('''
          CREATE TABLE operations(id TEXT,status TEXT,attempt_id TEXT,attempt_nonce TEXT,digest TEXT,config_digest TEXT);
          CREATE TABLE preparations(operation_id TEXT,status TEXT,attempt_id TEXT,attempt_nonce TEXT,preparation_id TEXT,staging_path TEXT);
          CREATE TABLE policy_approvals(operation_id TEXT,state TEXT,candidate_path TEXT,source_env_path TEXT,attempt_id TEXT,attempt_nonce TEXT,preparation_id TEXT,root_digest TEXT,image_config_digest TEXT,env_digest TEXT,candidate_digest TEXT,accepted_env_path TEXT,policy_path TEXT);
          CREATE TABLE extraction_probes(status TEXT);
          CREATE TABLE policy_probes(operation_id TEXT,preparation_id TEXT,config_digest TEXT,state TEXT);
        ''')
        self.db.execute('INSERT INTO operations VALUES(?,?,?,?,?,?)',(self.op,'verified',self.attempt,'nonce',self.digest,self.config))
        self.db.execute('INSERT INTO preparations VALUES(?,?,?,?,?,?)',(self.op,'prepared',self.attempt,'nonce',self.prep,str(self.stage)))
        eh='sha256:'+hashlib.sha256(env).hexdigest(); ch='sha256:'+hashlib.sha256(document).hexdigest()
        self.db.execute('INSERT INTO policy_approvals VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',(self.op,'candidate',str(self.candidate),str(self.env),self.attempt,'nonce',self.prep,self.digest,self.config,eh,ch,str(self.snapshot),None))
        self.db.execute('INSERT INTO policy_probes VALUES(?,?,?,?)',(self.op,self.prep,eh,'removed'))
        self.journal=SimpleNamespace(db=self.db)
        self.policy_value=SimpleNamespace(image_reference='ghcr.io/raxon/servus@'+self.digest,install_dir=str(self.install),control_dir=str(self.control))

    def tearDown(self): self.db.close();self.temp.cleanup()

    def invoke(self, **kwargs):
        return bootstrap.bootstrap(self.journal,self.op,str(self.env),str(self.install),str(self.control),str(self.private),extractor,supervisor,policy,**kwargs)

    def test_existing_candidate_activates_without_repeating_probe(self):
        with mock.patch.object(supervisor,'RuntimePolicy',return_value=self.policy_value), mock.patch.object(supervisor,'_docker',return_value=b''), mock.patch.object(policy,'produce') as produce:
            self.assertEqual(self.invoke(),str(self.active));produce.assert_not_called()
        self.assertEqual(self.db.execute('SELECT state FROM policy_approvals').fetchone(),('active',))
        self.assertEqual(self.active.read_bytes(),self.candidate.read_bytes())

    def test_resuming_active_initial_policy_reverifies_exact_binding(self):
        snapshot = self.private/('env-'+self.prep+'.env')
        self.db.execute("UPDATE policy_approvals SET state='active',policy_path=?,accepted_env_path=?",(str(self.active),str(snapshot)))
        verify = mock.Mock(return_value=self.policy_value)
        with mock.patch.object(policy,'produce') as produce, mock.patch.object(policy,'activate') as activate:
            self.assertEqual(self.invoke(verify_active=verify),str(self.active))
            verify.assert_called_once_with(str(self.active),str(snapshot),self.op)
            produce.assert_not_called();activate.assert_not_called()
        with self.assertRaises(bootstrap.BootstrapError): self.invoke()
        verify.return_value=SimpleNamespace(install_dir='/unexpected',control_dir=str(self.control))
        with self.assertRaises(bootstrap.BootstrapError): self.invoke(verify_active=verify)
        self.db.execute("UPDATE policy_approvals SET policy_path=?",(str(self.private/'forged'),))
        verify.reset_mock()
        with self.assertRaises(bootstrap.BootstrapError): self.invoke(verify_active=verify)
        verify.assert_not_called()

    def test_resume_checks_real_approval_and_refuses_modified_environment(self):
        snapshot = self.private/('env-'+self.prep+'.env')
        snapshot.write_bytes(self.env.read_bytes());snapshot.chmod(0o600)
        self.active.write_bytes(self.candidate.read_bytes());self.active.chmod(0o600)
        self.db.execute("UPDATE policy_approvals SET state='active',policy_path=?,accepted_env_path=?",(str(self.active),str(snapshot)))
        journal_file=self.private/'journal.sqlite'
        disk=sqlite3.connect(journal_file);self.db.backup(disk);disk.close();journal_file.chmod(0o600)
        def verify(path, accepted, operation):
            return daemon.load_approved_policy(path,str(journal_file),accepted,expected_operation_id=operation)
        with mock.patch.object(daemon,'load_policy',return_value=self.policy_value):
            self.assertEqual(self.invoke(verify_active=verify),str(self.active))
            self.env.write_text('SERVUS_IMAGE=changed\n');self.env.chmod(0o600)
            with self.assertRaises(supervisor.SupervisorError): self.invoke(verify_active=verify)

    def test_new_candidate_is_generated_before_activation(self):
        self.db.execute('DELETE FROM policy_approvals')
        with mock.patch.object(policy,'produce') as produce, mock.patch.object(policy,'activate',return_value=str(self.active)) as activate:
            self.assertEqual(self.invoke(),str(self.active))
        self.assertEqual(produce.call_args.args[0:6], (self.journal,self.op,str(self.staging),str(self.env),str(self.install),str(self.candidate)))
        self.assertEqual(activate.call_args.args[0:7], (self.journal,self.op,str(self.env),str(self.candidate),str(self.active),str(self.install),str(self.control)))

    def test_running_containers_and_changed_environment_are_refused(self):
        with mock.patch.object(supervisor,'RuntimePolicy',return_value=self.policy_value), mock.patch.object(supervisor,'_docker',return_value=b'running'):
            with self.assertRaises(policy.PolicyError): self.invoke()
        self.assertFalse(self.active.exists())
        self.env.write_text('SERVUS_IMAGE=changed\n');self.env.chmod(0o600)
        with mock.patch.object(supervisor,'RuntimePolicy',return_value=self.policy_value), mock.patch.object(supervisor,'_docker',return_value=b''):
            with self.assertRaises(policy.PolicyError): self.invoke()
        self.assertEqual(self.db.execute('SELECT state FROM policy_approvals').fetchone(),('candidate',))

    def test_interrupted_publication_requires_recovery(self):
        with mock.patch.object(supervisor,'RuntimePolicy',return_value=self.policy_value), mock.patch.object(supervisor,'_docker',return_value=b''), mock.patch.object(policy.os,'link',side_effect=OSError('injected')):
            with self.assertRaises(OSError): self.invoke()
        self.assertEqual(self.db.execute('SELECT state FROM policy_approvals').fetchone(),('recovery_required',))
        with self.assertRaises(bootstrap.BootstrapError): self.invoke()

    def test_command_refuses_active_updater_lock(self):
        source=ROOT/'apps/updater'; module_dir=self.root/'modules'; module_dir.mkdir(mode=0o700)
        for name in ('bootstrap-policy.py','supervisor.py','servus-updater.py','runtime-policy.py','extract-install.py','verify-release.py','supervisor-daemon.py'):
            path=module_dir/name; shutil.copyfile(source/name,path); path.chmod(0o755 if name=='servus-updater.py' else 0o644)
        state=self.root/'state';state.mkdir(mode=0o700)
        lock=state/'service.lock';lock.touch(mode=0o600)
        db=state/'journal.sqlite';db.write_bytes(b'');db.chmod(0o600)
        fd=os.open(lock,os.O_RDWR)
        try:
            fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
            result=subprocess.run([sys.executable,'-I',str(module_dir/'bootstrap-policy.py'),'--operation',self.op,
                '--state-dir',str(state),'--accepted-env',str(self.env),'--install-dir',str(self.install),
                '--control-dir',str(self.control),'--policy-dir',str(self.private)],capture_output=True,text=True,timeout=10)
            self.assertNotEqual(result.returncode,0);self.assertEqual(db.read_bytes(),b'')
            self.assertIn('could not be activated safely',result.stderr)
        finally: os.close(fd)

    def test_unverified_or_unprepared_operation_cannot_activate(self):
        for table,column in [('operations','status'),('preparations','status')]:
            with self.subTest(table=table):
                self.db.execute('SAVEPOINT corrupt');self.db.execute(f"UPDATE {table} SET {column}='recovery_required'")
                with mock.patch.object(policy,'produce') as produce, mock.patch.object(policy,'activate') as activate:
                    with self.assertRaises(bootstrap.BootstrapError): self.invoke()
                    produce.assert_not_called();activate.assert_not_called()
                self.db.execute('ROLLBACK TO corrupt');self.db.execute('RELEASE corrupt')


if __name__=='__main__': unittest.main()
