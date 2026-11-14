import fcntl
import importlib.util
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
import uuid
from unittest import mock

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'apps/updater'))
import supervisor

def load(name,file):
    spec=importlib.util.spec_from_file_location(name,ROOT/'apps/updater'/file)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module

handoff=load('bootstrap_handoff','bootstrap-handoff.py')
updater=load('handoff_updater','servus-updater.py')
policy=load('handoff_policy','runtime-policy.py')

@unittest.skipUnless(sys.platform=='linux' and os.geteuid()==0 and sys.flags.isolated,'Requires isolated Linux root')
class HandoffTest(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(dir='/root');self.root=Path(self.temp.name)
        self.install=self.root/'install';self.state=self.root/'state'
        for path in (self.install,self.state):path.mkdir(mode=0o700)
        (self.install/'install.lock').touch(mode=0o600)
        self.journal=updater.Journal(self.state);self.op,self.attempt,self.prep=(str(uuid.uuid4()) for _ in range(3))
        self.journal.db.execute('CREATE TABLE policy_approvals(operation_id TEXT,state TEXT,policy_path TEXT,accepted_env_path TEXT,source_env_path TEXT)')
        self.journal.db.execute('INSERT INTO operations(id,commit_sha,digest,tag,status,attempt_id,attempt_nonce,config_digest) VALUES(?,?,?,?,?,?,?,?)',(self.op,'a'*40,'sha256:'+'b'*64,'v1.0.0','verified',self.attempt,'c'*64,'sha256:'+'d'*64))
        self.journal.db.execute('INSERT INTO preparations VALUES(?,?,?,?,?,?)',(self.op,self.attempt,'c'*64,self.prep,'prepared','/root/stage'))
        self.path=str(self.root/'policy');self.snapshot=str(self.root/'snapshot');self.env=str(self.root/'active')
        self.journal.db.execute('INSERT INTO policy_approvals VALUES(?,?,?,?,?)',(self.op,'active',self.path,self.snapshot,self.env))
        self.approved=SimpleNamespace(install_dir=str(self.install),control_dir='/root/control',updater_dir='/run/servus-updater/control')
        self.daemon=SimpleNamespace(resolve_active_policy=mock.Mock(return_value=(self.path,self.snapshot,self.approved)))
        self.events=[]
        def service(*args,**kwargs):
            self.events.append(args)
            if args[0]=='is-active':return 3,'inactive'
            if args[0]=='start':
                other=os.open(self.install/'install.lock',os.O_RDONLY)
                try:fcntl.flock(other,fcntl.LOCK_EX|fcntl.LOCK_NB)
                finally:os.close(other)
            return 0,''
        self.service=mock.Mock(side_effect=service)
        def launch(*args,**kwargs):
            self.events.append(('launch',))
            self.assertTrue((self.install/handoff.MARKER).exists())
            self.assertIsInstance(kwargs['inherited_lock'],int)
            other=os.open(self.install/'install.lock',os.O_RDONLY)
            try:
                with self.assertRaises(BlockingIOError):fcntl.flock(other,fcntl.LOCK_EX|fcntl.LOCK_NB)
            finally:os.close(other)
            self.journal.db.execute("UPDATE preparations SET status='completed' WHERE operation_id=?",(self.op,))
        self.initial=SimpleNamespace(check_supervisor=mock.Mock(),check_updater=mock.Mock(),launch=mock.Mock(side_effect=launch),InitialGenerationError=ValueError)

    def tearDown(self):self.journal.close();self.temp.cleanup()
    def run_handoff(self):
        with mock.patch.object(supervisor,'RuntimePolicy',SimpleNamespace):
            return handoff.handoff(self.journal,self.op,self.env,str(self.state),supervisor,self.daemon,policy,self.initial,object(),object(),service=self.service,timeout=5)

    def test_handoff_yields_lock_to_services_then_starts_and_completes(self):
        self.run_handoff()
        self.assertEqual([event[0] for event in self.events],['is-active','start','start','launch','enable'])
        self.assertFalse((self.install/handoff.MARKER).exists())
        self.assertEqual(self.journal.db.execute('SELECT status FROM preparations').fetchone(),('completed',))

    def test_service_failure_keeps_marker_and_refuses_a_second_attempt(self):
        self.service.side_effect=lambda *args,**kwargs:(3,'inactive') if args[0]=='is-active' else (1,'failed')
        with self.assertRaises(handoff.HandoffError):self.run_handoff()
        self.assertTrue((self.install/handoff.MARKER).is_file());self.initial.launch.assert_not_called()
        with self.assertRaises(FileExistsError):self.run_handoff()

    def test_verification_service_must_be_stopped_before_marker(self):
        self.service.side_effect=lambda *args,**kwargs:(0,'active')
        with self.assertRaises(handoff.HandoffError):self.run_handoff()
        self.assertFalse((self.install/handoff.MARKER).exists());self.initial.launch.assert_not_called()

    def test_enable_failure_keeps_marker_after_generation_started(self):
        original=self.service.side_effect
        def fail_enable(*args,**kwargs):
            if args[0]=='enable':return 1,''
            return original(*args,**kwargs)
        self.service.side_effect=fail_enable
        with self.assertRaises(handoff.HandoffError):self.run_handoff()
        self.assertTrue((self.install/handoff.MARKER).is_file())
        self.assertEqual(self.journal.db.execute('SELECT status FROM preparations').fetchone(),('completed',))

    def test_policy_change_during_service_start_stops_before_launch(self):
        binding=(self.path,self.snapshot,self.approved)
        self.daemon.resolve_active_policy.side_effect=[binding,binding,('/changed',self.snapshot,self.approved)]
        with self.assertRaises(handoff.HandoffError):self.run_handoff()
        self.initial.launch.assert_not_called();self.assertTrue((self.install/handoff.MARKER).is_file())

    def test_readiness_timeout_preserves_marker_and_never_enables_services(self):
        self.initial.launch.side_effect=lambda *args,**kwargs:None
        with mock.patch.object(supervisor,'RuntimePolicy',SimpleNamespace):
            with self.assertRaises(handoff.HandoffError):
                handoff.handoff(self.journal,self.op,self.env,str(self.state),supervisor,self.daemon,policy,self.initial,object(),object(),service=self.service,timeout=1)
        self.assertTrue((self.install/handoff.MARKER).is_file())
        self.assertNotIn('enable',[event[0] for event in self.events])

if __name__=='__main__':unittest.main()
