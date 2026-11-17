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
        self.journal.db.execute('CREATE TABLE policy_approvals(operation_id TEXT,state TEXT,policy_path TEXT,accepted_env_path TEXT,source_env_path TEXT,attempt_id TEXT,attempt_nonce TEXT,preparation_id TEXT,root_digest TEXT,image_config_digest TEXT)')
        self.journal.db.execute('INSERT INTO operations(id,commit_sha,digest,tag,status,attempt_id,attempt_nonce,config_digest) VALUES(?,?,?,?,?,?,?,?)',(self.op,'a'*40,'sha256:'+'b'*64,'v1.0.0','verified',self.attempt,'c'*64,'sha256:'+'d'*64))
        self.journal.db.execute('INSERT INTO preparations VALUES(?,?,?,?,?,?)',(self.op,self.attempt,'c'*64,self.prep,'prepared','/root/stage'))
        self.path=str(self.root/'policy');self.snapshot=str(self.root/'snapshot');self.env=str(self.root/'active')
        self.journal.db.execute('INSERT INTO policy_approvals VALUES(?,?,?,?,?,?,?,?,?,?)',(self.op,'active',self.path,self.snapshot,self.env,self.attempt,'c'*64,self.prep,'sha256:'+'b'*64,'sha256:'+'d'*64))
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
        self.docker=mock.Mock(return_value='')
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
    def run_handoff(self,*,recover=False):
        with mock.patch.object(supervisor,'RuntimePolicy',SimpleNamespace),mock.patch.object(policy,'_docker',self.docker):
            return handoff.handoff(self.journal,self.op,self.env,str(self.state),supervisor,self.daemon,policy,self.initial,object(),object(),service=self.service,timeout=5,recover=recover)

    def marker(self,operation=None):
        path=self.install/handoff.MARKER
        path.write_bytes(('servus-initial-handoff-v1 '+(operation or self.op)+'\n').encode('ascii'))
        path.chmod(0o600)
        return path

    def test_explicit_recovery_reuses_marker_and_finishes_original_handoff(self):
        marker=self.marker();identity=marker.stat().st_ino
        original=self.initial.launch.side_effect
        def launch(*args,**kwargs):
            self.assertEqual(marker.stat().st_ino,identity)
            original(*args,**kwargs)
        self.initial.launch.side_effect=launch
        self.run_handoff(recover=True)
        self.initial.launch.assert_called_once()
        self.assertEqual(self.docker.call_count,2)
        self.assertFalse(marker.exists())
        self.assertEqual(self.events[-1],('start','servus-host-update.timer'))

    def test_recovery_requires_existing_marker(self):
        with self.assertRaises(FileNotFoundError):self.run_handoff(recover=True)
        self.initial.launch.assert_not_called()
        self.assertNotIn('start',[event[0] for event in self.events])

    def test_recovery_accepts_an_empty_generation_table(self):
        self.marker()
        self.journal.db.execute('CREATE TABLE initial_generations(operation_id TEXT,phase TEXT)')
        self.run_handoff(recover=True)
        self.initial.launch.assert_called_once()

    def test_recovery_refuses_another_operation_marker(self):
        marker=self.marker(str(uuid.uuid4()));before=marker.read_bytes()
        with self.assertRaises(handoff.HandoffError):self.run_handoff(recover=True)
        self.assertEqual(marker.read_bytes(),before);self.initial.launch.assert_not_called()

    def test_recovery_refuses_unsafe_marker(self):
        marker=self.install/handoff.MARKER
        for unsafe in ('mode','symlink','hardlink','uid','gid','directory','extra_bytes'):
            with self.subTest(unsafe=unsafe):
                if unsafe=='directory':marker.mkdir(mode=0o600)
                elif unsafe=='symlink':marker.symlink_to(self.marker_target())
                else:
                    self.marker()
                    if unsafe=='mode':marker.chmod(0o644)
                    if unsafe=='hardlink':os.link(marker,self.install/'extra-link')
                    if unsafe=='uid':os.chown(marker,1000,0)
                    if unsafe=='gid':os.chown(marker,0,1000)
                    if unsafe=='extra_bytes':
                        with marker.open('ab') as stream:stream.write(b'extra')
                with self.assertRaises((handoff.HandoffError,supervisor.SupervisorError,OSError)):
                    self.run_handoff(recover=True)
                self.initial.launch.assert_not_called()
                if unsafe=='directory':marker.rmdir()
                else:marker.unlink()
                if unsafe=='hardlink':(self.install/'extra-link').unlink()

    def marker_target(self):
        target=self.install/'marker-target';target.write_bytes(('servus-initial-handoff-v1 '+self.op+'\n').encode('ascii'));target.chmod(0o600)
        return target

    def test_recovery_refuses_every_existing_generation_phase(self):
        self.marker()
        self.journal.db.execute('CREATE TABLE initial_generations(operation_id TEXT,phase TEXT)')
        for phase in ('starting','started','recovery_required'):
            with self.subTest(phase=phase):
                self.journal.db.execute('INSERT INTO initial_generations VALUES(?,?)',(self.op,phase))
                with self.assertRaisesRegex(handoff.HandoffError,'Existing initial generation'):self.run_handoff(recover=True)
                self.initial.launch.assert_not_called();self.docker.assert_not_called()
                self.journal.db.execute('DELETE FROM initial_generations')

    def test_recovery_refuses_existing_containers(self):
        self.marker();self.docker.return_value='a'*64
        with self.assertRaisesRegex(handoff.HandoffError,'Existing Servus containers'):self.run_handoff(recover=True)
        self.initial.launch.assert_not_called()
        self.assertNotIn('start',[event[0] for event in self.events])

    def test_recovery_refuses_policy_change_after_service_start(self):
        self.marker()
        binding=(self.path,self.snapshot,self.approved)
        self.daemon.resolve_active_policy.side_effect=[binding,binding,('/changed',self.snapshot,self.approved)]
        with self.assertRaisesRegex(handoff.HandoffError,'Active policy changed'):self.run_handoff(recover=True)
        self.initial.launch.assert_not_called();self.assertTrue((self.install/handoff.MARKER).exists())

    def test_recovery_refuses_marker_replacement_during_service_start(self):
        marker=self.marker();original=self.service.side_effect;held=[]
        def service(*args,**kwargs):
            result=original(*args,**kwargs)
            if args==('start','servus-supervisor.service'):
                held.append(os.open(marker,os.O_RDONLY));marker.unlink();self.marker()
            return result
        self.service.side_effect=service
        try:
            with self.assertRaisesRegex(handoff.HandoffError,'Handoff marker changed'):self.run_handoff(recover=True)
        finally:
            for fd in held:os.close(fd)
        self.initial.launch.assert_not_called()

    def test_recovery_rechecks_launch_intent_before_launch(self):
        self.marker();original=self.service.side_effect
        def service(*args,**kwargs):
            result=original(*args,**kwargs)
            if args==('start','servus-updater.service'):
                self.journal.db.execute('CREATE TABLE initial_generations(operation_id TEXT,phase TEXT)')
                self.journal.db.execute("INSERT INTO initial_generations VALUES(?,'starting')",(self.op,))
            return result
        self.service.side_effect=service
        with self.assertRaisesRegex(handoff.HandoffError,'Existing initial generation'):self.run_handoff(recover=True)
        self.initial.launch.assert_not_called()

    def test_recovery_requires_verified_approval_bindings(self):
        self.marker()
        for column in ('attempt_id','attempt_nonce','preparation_id','root_digest','image_config_digest'):
            with self.subTest(column=column):
                self.journal.db.execute('SAVEPOINT binding')
                self.journal.db.execute('UPDATE policy_approvals SET '+column+"='wrong'")
                with self.assertRaisesRegex(handoff.HandoffError,'Initial generation is not prepared'):self.run_handoff(recover=True)
                self.initial.launch.assert_not_called();self.service.assert_not_called()
                self.journal.db.execute('ROLLBACK TO binding');self.journal.db.execute('RELEASE binding')

    def test_nonrecovery_still_refuses_existing_marker(self):
        self.marker()
        with self.assertRaises(FileExistsError):self.run_handoff()
        self.initial.launch.assert_not_called();self.docker.assert_not_called()

    def test_handoff_yields_lock_to_services_then_starts_and_completes(self):
        self.run_handoff()
        self.assertEqual([event[0] for event in self.events],['is-active','start','start','launch','enable','start'])
        self.assertIn('servus-host-update.timer',self.events[-2])
        self.assertEqual(self.events[-1],('start','servus-host-update.timer'))
        self.assertFalse((self.install/handoff.MARKER).exists())
        self.assertEqual(self.journal.db.execute('SELECT status FROM preparations').fetchone(),('completed',))

    def test_timer_start_failure_is_reported_after_handoff(self):
        original=self.service.side_effect
        def fail_timer(*args,**kwargs):
            if args==('start','servus-host-update.timer'):return 1,''
            return original(*args,**kwargs)
        self.service.side_effect=fail_timer
        with self.assertRaises(handoff.HandoffError):self.run_handoff()
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

class FailureMessageTest(unittest.TestCase):
    def test_known_failure_reports_fixed_message(self):
        self.assertEqual(handoff._failure_message(handoff.HandoffError('Active policy changed')),'Initial handoff failed: Active policy changed.')

    def test_unexpected_failure_does_not_expose_exception_text(self):
        try:raise RuntimeError('secret stderr and credentials')
        except RuntimeError as error:message=handoff._failure_message(error)
        self.assertRegex(message,r'^Initial handoff failed: RuntimeError at line [1-9][0-9]*\.$')
        self.assertNotIn('secret',message)

    def test_partial_initial_import_still_reports_safe_error(self):
        message=handoff._failure_message(ImportError('secret path'),SimpleNamespace())
        self.assertEqual(message,'Initial handoff failed: ImportError at line 0.')

if __name__=='__main__':unittest.main()
