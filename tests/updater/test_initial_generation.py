import fcntl
import hashlib
import importlib.util
import json
import os
import socket
import struct
from pathlib import Path
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
import uuid
from unittest import mock

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'apps/updater'))
import supervisor

def load(name,filename):
    spec=importlib.util.spec_from_file_location(name,ROOT/'apps/updater'/filename)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module

initial=load('initial_generation','initial-generation.py')
updater=load('initial_updater','servus-updater.py')
policy=load('initial_policy','runtime-policy.py')
backup=load('initial_backup','backup.py')

@unittest.skipUnless(sys.platform=='linux' and os.geteuid()==0 and sys.flags.isolated,'Requires isolated Linux root')
class InitialGenerationTest(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(dir='/root');self.root=Path(self.temp.name)
        self.install,self.gate,self.state,self.control,self.docker,self.data=(self.root/name for name in ('install','gate','state','control','docker','data'))
        for path in (self.install,self.state,self.docker):path.mkdir(mode=0o700)
        self.gate.mkdir(mode=0o755);self.control.mkdir(mode=0o750)
        self.data.mkdir(mode=0o700);os.chown(self.data,1000,1000)
        (self.install/'install.lock').touch(mode=0o600)
        (self.gate/'state').write_bytes(b'servus-lifecycle-v1 normal\n');(self.gate/'state').chmod(0o644)
        self.stage=self.state/('servus-install-'+'a'*32);self.stage.mkdir(mode=0o700)
        (self.stage/'deployment').mkdir(mode=0o755)
        self.compose=self.stage/'deployment/compose-supervised.yaml';self.compose.write_bytes(b'fixture');self.compose.chmod(0o644)
        manifest=self.stage/'manifest.json';manifest.write_bytes(b'fixture');manifest.chmod(0o644)
        self.journal=updater.Journal(self.state)
        self.journal.db.execute('CREATE TABLE policy_approvals(operation_id TEXT,attempt_id TEXT,attempt_nonce TEXT,preparation_id TEXT,root_digest TEXT,image_config_digest TEXT,policy_path TEXT,accepted_env_path TEXT,source_env_path TEXT,state TEXT)')
        self.op,self.attempt,self.prep=(str(uuid.uuid4()) for _ in range(3));self.digest='sha256:'+'a'*64;self.nonce='b'*64
        self.journal.db.execute('INSERT INTO operations(id,commit_sha,digest,tag,status,attempt_id,attempt_nonce,config_digest) VALUES(?,?,?,?,?,?,?,?)',(self.op,'c'*40,self.digest,'v1.2.3','verified',self.attempt,self.nonce,self.digest))
        self.journal.db.execute('INSERT INTO preparations VALUES(?,?,?,?,?,?)',(self.op,self.attempt,self.nonce,self.prep,'prepared',str(self.stage)))
        self.env=str(self.root/'active.env');self.path=str(self.root/'policy');self.snapshot=str(self.root/'snapshot')
        self.journal.db.execute('INSERT INTO policy_approvals VALUES(?,?,?,?,?,?,?,?,?,?)',(self.op,self.attempt,self.nonce,self.prep,self.digest,self.digest,self.path,self.snapshot,self.env,'active'))
        self.approved=SimpleNamespace(install_dir=str(self.install),gate_dir=str(self.gate),control_dir=str(self.control),data_dir=str(self.data),updater_dir='/run/servus-updater/control',image_reference='ghcr.io/raxon/servus@'+self.digest)
        self.daemon=SimpleNamespace(resolve_active_policy=mock.Mock(return_value=(self.path,self.snapshot,self.approved)))
        self.extractor=SimpleNamespace(MANIFEST_LIMIT=4096,MAX_FILE=4096,_manifest_files=lambda _: {'deployment/compose-supervised.yaml':(0o644,7,hashlib.sha256(b'fixture').hexdigest())})
        self.ids={role:{'id':letter*64} for role,letter in zip(supervisor.ROLES,'abc')}
        self.check=mock.Mock();self.updater_check=mock.Mock();self.docker_call=mock.Mock(return_value=b'')

    def tearDown(self):self.journal.close();self.temp.cleanup()
    def run_launch(self,**kwargs):
        with mock.patch.object(supervisor,'RuntimePolicy',SimpleNamespace), mock.patch.object(supervisor,'inspect_servus',return_value=self.ids), mock.patch.object(supervisor,'_docker',return_value=b'') as start, mock.patch.object(policy,'_docker',self.docker_call):
            result=initial.launch(self.journal,self.op,self.env,str(self.docker),supervisor,self.daemon,self.extractor,backup,policy,check=self.check,updater_check=self.updater_check,**kwargs)
            return result,start.call_args_list

    def test_starts_only_approved_created_containers_and_records_state(self):
        result,calls=self.run_launch()
        self.assertEqual(result,self.ids)
        self.assertEqual([call.args for call in calls],[('start',self.ids[role]['id']) for role in ('agent','api','worker')])
        self.assertEqual(self.journal.db.execute('SELECT phase FROM initial_generations').fetchone(),('started',))
        with self.assertRaises(initial.InitialGenerationError):self.run_launch()

    def test_refuses_modified_bundle_before_docker_changes(self):
        self.compose.write_bytes(b'changed');self.compose.chmod(0o644)
        with self.assertRaises(initial.InitialGenerationError):self.run_launch()
        self.docker_call.assert_not_called()

    def test_refuses_to_start_on_existing_data_without_migration(self):
        (self.data/'panel.sqlite').write_text('existing')
        with self.assertRaises(initial.InitialGenerationError):self.run_launch()
        self.docker_call.assert_not_called()

    def test_existing_containers_and_changed_policy_are_rejected(self):
        self.docker_call.return_value=b'existing\n'
        with self.assertRaises(initial.InitialGenerationError):self.run_launch()
        self.assertFalse(self.journal.db.execute("SELECT 1 FROM sqlite_master WHERE name='initial_generations'").fetchone())
        self.docker_call.reset_mock();self.docker_call.return_value=b''
        self.daemon.resolve_active_policy.side_effect=[(self.path,self.snapshot,self.approved),('/changed',self.snapshot,self.approved)]
        with self.assertRaises(initial.InitialGenerationError):self.run_launch()
        self.docker_call.assert_not_called()

    def test_unavailable_updater_stops_before_container_creation(self):
        self.updater_check.side_effect=initial.InitialGenerationError('updater unavailable')
        with self.assertRaises(initial.InitialGenerationError):self.run_launch()
        self.docker_call.assert_not_called()
        self.assertFalse(self.journal.db.execute("SELECT 1 FROM sqlite_master WHERE name='initial_generations'").fetchone())

    def test_duplicate_container_ids_require_recovery_before_any_start(self):
        self.ids['worker']={'id':self.ids['api']['id']}
        with mock.patch.object(supervisor,'RuntimePolicy',SimpleNamespace), mock.patch.object(supervisor,'inspect_servus',return_value=self.ids), mock.patch.object(supervisor,'_docker') as start, mock.patch.object(policy,'_docker',self.docker_call):
            with self.assertRaises(initial.InitialGenerationError):initial.launch(self.journal,self.op,self.env,str(self.docker),supervisor,self.daemon,self.extractor,backup,policy,check=self.check,updater_check=self.updater_check)
        start.assert_not_called()
        self.assertEqual(self.journal.db.execute('SELECT phase FROM initial_generations').fetchone(),('recovery_required',))

    def test_failed_start_records_recovery(self):
        with mock.patch.object(supervisor,'RuntimePolicy',SimpleNamespace), mock.patch.object(supervisor,'inspect_servus',return_value=self.ids), mock.patch.object(supervisor,'_docker',side_effect=OSError('fixture')), mock.patch.object(policy,'_docker',self.docker_call):
            with self.assertRaises(OSError):initial.launch(self.journal,self.op,self.env,str(self.docker),supervisor,self.daemon,self.extractor,backup,policy,check=self.check,updater_check=self.updater_check)
        self.assertEqual(self.journal.db.execute('SELECT phase FROM initial_generations').fetchone(),('recovery_required',))
        with self.assertRaises(initial.InitialGenerationError):self.run_launch()

    def test_inherited_lock_stays_held(self):
        fd=os.open(self.install/'install.lock',os.O_RDONLY)
        try:
            fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB);self.run_launch(inherited_lock=fd)
            other=os.open(self.install/'install.lock',os.O_RDONLY)
            try:
                with self.assertRaises(BlockingIOError):fcntl.flock(other,fcntl.LOCK_EX|fcntl.LOCK_NB)
            finally:os.close(other)
        finally:os.close(fd)

    def test_supervisor_socket_must_answer_as_root_and_be_waiting(self):
        path=self.control/'command';listener=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
        listener.bind(str(path));os.chmod(path,0o600);listener.listen(1)
        def serve():
            connection,_=listener.accept()
            with connection:
                message=supervisor._read_message(connection,time.monotonic()+3)
                self.assertEqual(message,{'version':1,'type':'status'})
                supervisor._send_message(connection,{'version':1,'status':'waiting'},time.monotonic()+3)
        worker=threading.Thread(target=serve);worker.start()
        try:
            initial.check_supervisor(str(self.control),supervisor)
            worker.join(timeout=4);self.assertFalse(worker.is_alive())
            os.chmod(path,0o666)
            with self.assertRaises(initial.InitialGenerationError):initial.check_supervisor(str(self.control),supervisor)
        finally:listener.close();path.unlink()

    def test_updater_check_requires_unprivileged_apply_enabled_endpoint(self):
        request={'version':1,'action':'apply','operationId':'invalid'}
        for allowed,expected in ((True,'invalid_request'),(False,'unavailable')):
            with self.assertRaises(updater.ProtocolError) as error:updater.process(self.journal,request,allow_apply=allowed)
            self.assertEqual(error.exception.code,expected)
        with tempfile.TemporaryDirectory(dir='/run',prefix='servus-updater-test-') as temp:
            root=Path(temp);root.chmod(0o755);control=root/'control';control.mkdir(mode=0o710)
            os.chown(control,0,1000);control.chmod(0o710);path=control/'updater.sock'
            listener=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);listener.bind(str(path))
            os.chown(path,0,1000);os.chmod(path,0o660);listener.listen(1);listener.settimeout(4)
            def serve(error):
                connection,_=listener.accept()
                with connection:
                    _,uid,gid=struct.unpack('3i',connection.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))
                    if (uid,gid) != (1000,1000):return
                    message=supervisor._read_message(connection,time.monotonic()+3)
                    if message != {'version':1,'action':'apply','operationId':'invalid'}:return
                    supervisor._send_message(connection,{'ok':False,'error':error},time.monotonic()+3)
            try:
                with mock.patch.object(initial,'UPDATER_DIR',str(control)):
                    for error,accepted in (('invalid_request',True),('unavailable',False)):
                        worker=os.fork()
                        if worker == 0:
                            try:serve(error)
                            finally:os._exit(0)
                        try:
                            if accepted:initial.check_updater(str(control),supervisor)
                            else:
                                with self.assertRaises(initial.InitialGenerationError):initial.check_updater(str(control),supervisor)
                        finally:
                            _,status=os.waitpid(worker,0);self.assertEqual(status,0)
            finally:listener.close();path.unlink()

if __name__=='__main__':unittest.main()
