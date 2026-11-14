import fcntl
import importlib.util
import os
from pathlib import Path
import socket
import sys
import tempfile
import threading
import unittest
import uuid
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

if __name__=='__main__':unittest.main()
