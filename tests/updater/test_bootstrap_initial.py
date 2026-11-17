import fcntl
import importlib.util
import io
import os
from pathlib import Path
import socket
import sqlite3
import sys
import tempfile
import threading
import unittest
import uuid
from types import SimpleNamespace
from unittest import mock

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'apps/updater'))
import supervisor

def load(name,path):
    spec=importlib.util.spec_from_file_location(name,ROOT/'apps/updater'/path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module

initial=load('bootstrap_initial','bootstrap-initial.py')
policy=load('bootstrap_initial_policy','runtime-policy.py')

@unittest.skipUnless(sys.platform=='linux' and os.geteuid()==0 and sys.flags.isolated,'Requires isolated Linux root')
class BootstrapInitialTest(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(dir='/root');self.root=Path(self.tmp.name)
        self.install,self.config,self.state,self.data=(self.root/name for name in ('install','config','state','data'))
        for path in (self.install,self.config,self.state,self.data):path.mkdir(mode=0o700)
        os.chown(self.data,1000,1000);(self.state/'docker-config').mkdir(mode=0o700)
        (self.install/'install.lock').touch(mode=0o600)
        self.op=str(uuid.uuid4());self.commit='a'*40;self.digest='sha256:'+'b'*64;self.tag='v1.0.0'
        content={'SERVUS_IMAGE':'ghcr.io/raxon/servus@'+self.digest,'SERVUS_DATA_DIR':str(self.data),
                 'SERVUS_LIFECYCLE_DIR':str(self.config/'lifecycle'), 'SERVUS_SUPERVISOR_CONTROL_DIR':str(self.config/'supervisor-control'),
                 'SERVUS_SUPERVISOR_SECRET_DIR':str(self.config/'supervisor-secrets'),'SERVUS_UPDATER_SOCKET_DIR':'/run/servus-updater/control'}
        self.env=self.config/'servus.env';self.env.write_text(''.join(k+'='+v+'\n' for k,v in content.items()));self.env.chmod(0o600)
        self.events=[]
        def run(args,**kwargs):
            self.events.append(tuple(args))
            if args[-2:] == ['--operation',self.op] and args[2].endswith('/bootstrap-handoff.py'):
                other=os.open(self.install/'install.lock',os.O_RDONLY)
                try:fcntl.flock(other,fcntl.LOCK_EX|fcntl.LOCK_NB)
                finally:os.close(other)
                self.assertTrue((self.install/initial.MARKER).exists())
            if args[0:2]==['/usr/bin/python3','-I'] and 'bootstrap-handoff.py' not in args[2]:
                self.assertIn('pass_fds',kwargs)
        self.run=mock.Mock(side_effect=run);self.ready=mock.Mock();self.inactive=mock.Mock(return_value=True)

    def tearDown(self):self.tmp.cleanup()
    def execute(self,**kwargs):
        with mock.patch.object(policy,'_docker',return_value=b''):
            return initial.bootstrap(self.op,self.commit,self.digest,self.tag,str(self.install),str(self.config),str(self.state),supervisor,policy,run=self.run,ready=self.ready,is_inactive=self.inactive,**kwargs)

    def test_verification_policy_and_handoff_run_in_order(self):
        self.execute()
        self.assertEqual([event[1] if event[0]=='/usr/bin/systemctl' else Path(event[2] if event[0]=='/usr/bin/python3' else event[6]).name for event in self.events],
                         ['daemon-reload','start','start','bootstrap-release.py','stop','bootstrap-policy.py','provision-host.py','bootstrap-handoff.py'])
        self.assertFalse((self.install/initial.MARKER).exists());self.ready.assert_called_once()

    def test_takes_installer_lock_and_releases_it_for_handoff(self):
        fd=os.open(self.install/'install.lock',os.O_RDONLY)
        fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        self.execute(take_lock_fd=fd)
        with self.assertRaises(OSError):os.fstat(fd)
        self.assertFalse((self.install/initial.MARKER).exists())

    def test_wrong_inherited_lock_is_not_consumed(self):
        other=self.root/'other.lock';other.touch(mode=0o600)
        fd=os.open(other,os.O_RDONLY)
        try:
            with self.assertRaises(policy.PolicyError):self.execute(take_lock_fd=fd)
            os.fstat(fd)
            self.run.assert_not_called()
        finally:os.close(fd)

    def test_verification_failure_stops_bootstrap_and_preserves_marker(self):
        def fail(args,**kwargs):
            self.events.append(tuple(args))
            if args[0]=='/usr/bin/setpriv':raise initial.BootstrapError('fixture')
        self.run.side_effect=fail
        with self.assertRaises(initial.BootstrapError):self.execute()
        self.assertTrue((self.install/initial.MARKER).is_file())
        self.assertEqual(self.events[-1],('/usr/bin/systemctl','stop','servus-updater-bootstrap.service'))
        self.assertFalse(any('bootstrap-handoff.py' in ' '.join(event) for event in self.events))
        with self.assertRaises(FileExistsError):self.execute()

    def test_existing_data_active_service_or_wrong_image_are_not_changed(self):
        (self.data/'panel.sqlite').write_text('existing')
        with self.assertRaises(initial.BootstrapError):self.execute()
        self.run.assert_not_called();self.assertFalse((self.install/initial.MARKER).exists())
        (self.data/'panel.sqlite').unlink();self.inactive.return_value=False
        with self.assertRaises(initial.BootstrapError):self.execute()
        self.assertFalse((self.install/initial.MARKER).exists())
        self.inactive.return_value=True;self.env.write_text('SERVUS_IMAGE=changed\n');self.env.chmod(0o600)
        with self.assertRaises(initial.BootstrapError):self.execute()

    def test_interrupted_legacy_migration_blocks_bootstrap(self):
        (self.install/'.legacy-migration-v1').write_text('interrupted')
        with self.assertRaisesRegex(initial.BootstrapError,'legacy migration requires recovery'):self.execute()
        self.assertFalse((self.install/initial.MARKER).exists())
        self.assertFalse(any('bootstrap-release.py' in ' '.join(event) for event in self.events))

    def test_wait_socket_requires_root_peer_and_unchanged_socket(self):
        control=self.root/'control';control.mkdir(mode=0o710);os.chown(control,0,1000);control.chmod(0o710)
        path=control/'updater.sock';listener=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
        listener.bind(str(path));os.chown(path,0,1000);os.chmod(path,0o660);listener.listen(1)
        def serve():
            conn,_=listener.accept();conn.close()
        thread=threading.Thread(target=serve);thread.start()
        try:
            initial.wait_socket(str(path),supervisor,timeout=2);thread.join(3);self.assertFalse(thread.is_alive())
            os.chmod(path,0o666)
            with self.assertRaises(initial.BootstrapError):initial.wait_socket(str(path),supervisor,timeout=1)
        finally:listener.close();path.unlink()

    def recovery_fixture(self, phase='prepared', generation=None):
        self.marker=self.install/initial.MARKER
        self.marker.write_text('servus-bootstrap-verification-v1 '+self.op+'\n');self.marker.chmod(0o600)
        self.handoff_marker=self.install/'.initial-handoff-v1'
        if phase=='prepared':self.handoff_marker.write_text('protected handoff');self.handoff_marker.chmod(0o600)
        with sqlite3.connect(self.state/'journal.sqlite') as db:
            db.execute('CREATE TABLE operations(id TEXT,status TEXT)')
            db.execute('INSERT INTO operations VALUES (?,?)',(self.op,'verified'))
            db.execute('CREATE TABLE preparations(operation_id TEXT,status TEXT)')
            db.execute('INSERT INTO preparations VALUES (?,?)',(self.op,phase))
            db.execute('CREATE TABLE policy_approvals(operation_id TEXT,state TEXT,source_env_path TEXT)')
            db.execute('INSERT INTO policy_approvals VALUES (?,?,?)',(self.op,'active',str(self.env)))
            db.execute('CREATE TABLE initial_generations(operation_id TEXT,phase TEXT)')
            if generation:db.execute('INSERT INTO initial_generations VALUES (?,?)',(self.op,generation))
        approved=SimpleNamespace(control_dir='/root/control',updater_dir='/run/servus-updater/control')
        self.daemon=SimpleNamespace(resolve_active_policy=mock.Mock(return_value=('policy','snapshot',approved)))
        self.helpers=SimpleNamespace(check_supervisor=mock.Mock(),check_updater=mock.Mock())
        def finish(args,**kwargs):
            if args[0]=='/usr/bin/systemctl':return
            self.assertIn('--recover',args);self.assertTrue(self.marker.is_file())
            fd=os.open(self.install/'install.lock',os.O_RDONLY)
            try:fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
            finally:os.close(fd)
            with sqlite3.connect(self.state/'journal.sqlite') as db:
                db.execute("UPDATE preparations SET status='completed'")
                db.execute("INSERT INTO initial_generations VALUES (?,'started')",(self.op,))
            self.handoff_marker.unlink()
        self.recovery_run=mock.Mock(side_effect=finish)

    def recover(self):
        return initial.recover_bootstrap(self.op,str(self.install),str(self.config),str(self.state),supervisor,policy,self.helpers,self.daemon,run=self.recovery_run)

    def test_explicit_recovery_resumes_same_handoff_and_clears_only_healthy_marker(self):
        self.recovery_fixture()
        def unlocked(*args,**kwargs):
            fd=os.open(self.install/'install.lock',os.O_RDONLY)
            try:fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
            finally:os.close(fd)
        self.helpers.check_supervisor.side_effect=unlocked
        self.helpers.check_updater.side_effect=unlocked
        self.recover()
        self.assertEqual(self.recovery_run.call_count,2);self.assertFalse(self.marker.exists())
        self.helpers.check_supervisor.assert_called_once_with('/root/control',supervisor,expected='ready')

    def test_completed_healthy_recovery_finalizes_without_relaunch(self):
        self.recovery_fixture('completed','started');self.recover()
        self.recovery_run.assert_called_once_with(['/usr/bin/systemctl','start','servus-host-update.timer'],timeout=45)
        self.assertFalse(self.marker.exists())

    def test_timer_failure_keeps_completed_bootstrap_fence(self):
        self.recovery_fixture('completed','started')
        self.recovery_run.side_effect=initial.BootstrapError('Timer start failed')
        with self.assertRaises(initial.BootstrapError):self.recover()
        self.assertTrue(self.marker.is_file())

    def test_partial_import_diagnostics_do_not_expose_exception_details(self):
        self.assertEqual(initial.failure_detail(ValueError('private diagnostic'),SimpleNamespace()),'ValueError')

    def test_recovery_waits_for_a_brief_host_installation_lock(self):
        self.recovery_fixture('completed','started');original=policy._installation_lock;calls=[]
        def busy_once(*args,**kwargs):
            calls.append(1)
            if len(calls)==1:raise BlockingIOError()
            return original(*args,**kwargs)
        with mock.patch.object(policy,'_installation_lock',side_effect=busy_once):self.recover()
        self.assertFalse(self.marker.exists());self.assertGreaterEqual(len(calls),3)

    def test_uncertain_initial_generation_keeps_bootstrap_fence(self):
        self.recovery_fixture(generation='recovery_required')
        with self.assertRaises(initial.BootstrapError):self.recover()
        self.recovery_run.assert_not_called();self.assertTrue(self.marker.is_file())

    def test_recovery_marker_mismatch_stops_before_handoff(self):
        self.recovery_fixture();self.marker.write_text('servus-bootstrap-verification-v1 '+str(uuid.uuid4())+'\n')
        with self.assertRaises(initial.BootstrapError):self.recover()
        self.recovery_run.assert_not_called();self.assertTrue(self.marker.is_file())

    def test_failed_readiness_preserves_bootstrap_fence(self):
        self.recovery_fixture();self.helpers.check_supervisor.side_effect=ValueError('not ready')
        with self.assertRaises(ValueError):self.recover()
        self.assertTrue(self.marker.is_file())

    def test_policy_change_during_recovery_preserves_bootstrap_fence(self):
        self.recovery_fixture()
        self.daemon.resolve_active_policy.side_effect=[('policy','snapshot',object()),('changed','snapshot',object())]
        with self.assertRaises(initial.BootstrapError):self.recover()
        self.assertTrue(self.marker.is_file())

    def test_success_summary_contains_setup_tunnel_and_status_without_secrets(self):
        values={'SERVUS_PORT':'4280','SERVUS_BIND_ADDRESS':'127.0.0.1','SERVUS_PUBLIC_URL':'http://localhost:4280','SERVUS_TRUSTED_PROXY_SECRET':'never-print-this'}
        output=io.StringIO()
        with mock.patch('sys.stdout',output):initial.installation_summary(values,'165.227.165.232')
        text=output.getvalue();self.assertIn('Create administrator',text);self.assertIn('at least 8 characters',text)
        self.assertIn('root@165.227.165.232',text);self.assertIn('127.0.0.1:4280:127.0.0.1:4280',text)
        self.assertIn('logs --tail=100',text);self.assertNotIn('never-print-this',text)

    def test_public_origin_summary_does_not_suggest_local_http(self):
        output=io.StringIO()
        with mock.patch('sys.stdout',output):initial.installation_summary({'SERVUS_PUBLIC_URL':'https://panel.example.test'})
        self.assertNotIn('ssh -N',output.getvalue());self.assertIn('https://panel.example.test',output.getvalue())

if __name__=='__main__':unittest.main()
