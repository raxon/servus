import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import uuid

ROOT=Path(__file__).resolve().parents[2]
HELPER=ROOT/'apps/updater/servus-updater.py'
CLIENT="import socket,sys;s=socket.socket(socket.AF_UNIX);s.settimeout(5);s.connect(sys.argv[1]);s.sendall(sys.argv[2].encode()+b'\\n');print(s.recv(8192).decode().strip())"


@unittest.skipUnless(sys.platform=='linux' and os.geteuid()==0 and hasattr(socket,'SO_PEERCRED'),'Requires isolated Linux root')
class LegacyRecoverySocketTest(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='servus-legacy-socket-',dir='/tmp');root=Path(self.temp.name);root.chmod(0o711)
        self.state=root/'state';self.state.mkdir(mode=0o700)
        self.runtime=root/'runtime';self.runtime.mkdir(mode=0o710)
        self.control=root/'control';self.control.mkdir(mode=0o750)
        self.sock=self.runtime/'updater.sock';self.supervisor_sock=self.control/'command'
        self.listener=socket.socket(socket.AF_UNIX);self.listener.bind(str(self.supervisor_sock));os.chmod(self.supervisor_sock,0o600);self.listener.listen(16);self.listener.settimeout(.2)
        self.stop=threading.Event();self.dispatched=threading.Event();self.release=threading.Event();self.backup_busy=threading.Event();self.received=[];self.handlers=[]
        self.server=threading.Thread(target=self.serve,daemon=True);self.server.start();self.process=None;self.start()
    def tearDown(self):
        self.release.set();self.stop.set()
        if self.process is not None and self.process.poll() is None:self.process.terminate();self.process.wait(timeout=5)
        if self.process is not None and self.process.stderr:self.process.stderr.close()
        self.server.join(timeout=2);self.listener.close()
        for handler in self.handlers:handler.join(timeout=2)
        self.temp.cleanup()
    def serve(self):
        while not self.stop.is_set():
            try:peer,_=self.listener.accept()
            except TimeoutError:continue
            except OSError:return
            handler=threading.Thread(target=self.respond,args=(peer,),daemon=True);self.handlers.append(handler);handler.start()
    def respond(self,peer):
        with peer:
            try:
                data=b''
                while not data.endswith(b'\n'):
                    chunk=peer.recv(4096)
                    if not chunk:return
                    data+=chunk
                request=json.loads(data);self.received.append(request)
                if request['type']=='status':status='ready'
                elif request['type']=='installation_backup_active':
                    status=('busy' if self.backup_busy.is_set() else 'idle') if set(request)=={'version','type'} else 'failed'
                elif request['type']=='recover_legacy_upload':
                    self.dispatched.set();self.release.wait(5);status='starting'
                elif request['type']=='legacy_recovery_status':status='completed'
                else:status='failed'
                peer.sendall(json.dumps({'version':1,'status':status}).encode()+b'\n')
            except OSError:pass
    def start(self):
        if self.process is not None and self.process.stderr:self.process.stderr.close()
        program="import importlib.util,pathlib,sys;s=importlib.util.spec_from_file_location('u',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);m.run(pathlib.Path(sys.argv[2]),pathlib.Path(sys.argv[3]),1000,0,supervisor_socket=sys.argv[4])"
        self.process=subprocess.Popen([sys.executable,'-I','-B','-c',program,str(HELPER),str(self.state),str(self.runtime),str(self.supervisor_sock)],stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,text=True)
        deadline=time.monotonic()+5
        while time.monotonic()<deadline:
            if self.process.poll() is not None:self.fail('Updater fixture exited: '+self.process.stderr.read())
            try:
                with socket.socket(socket.AF_UNIX) as probe:probe.connect(str(self.sock))
                return
            except OSError:time.sleep(.02)
        self.fail('Updater fixture did not start')
    def request(self,value):
        def demote():os.setgroups([]);os.setgid(0);os.setuid(1000)
        run=subprocess.run([sys.executable,'-c',CLIENT,str(self.sock),json.dumps(value,separators=(',',':'))],preexec_fn=demote,capture_output=True,text=True,timeout=6,check=True)
        return json.loads(run.stdout)
    def test_process_death_after_dispatch_never_resends_and_can_confirm_completion(self):
        op=str(uuid.uuid4());restore='a'*32;service=str(uuid.uuid4())
        response=self.request({'version':1,'action':'legacy_recovery','operationId':op,'restoreId':restore,'serviceId':service})
        self.assertTrue(response['ok']);self.assertEqual(response['operation']['status'],'requested')
        self.assertTrue(self.dispatched.wait(5))
        blocked=self.request({'version':1,'action':'submit'})
        self.assertEqual(blocked,{'ok':False,'error':'operation_in_progress'})
        self.process.kill();self.process.wait(timeout=5);self.release.set();self.start()
        deadline=time.monotonic()+10;state=None
        while time.monotonic()<deadline:
            response=self.request({'version':1,'action':'legacy_recovery_status','operationId':op})
            state=response['operation']['status']
            if state=='completed':break
            time.sleep(.1)
        self.assertEqual(state,'completed')
        self.assertEqual(sum(item['type']=='recover_legacy_upload' for item in self.received),1)

    def test_active_installation_backup_blocks_legacy_admission_until_idle(self):
        self.backup_busy.set()
        op=str(uuid.uuid4());restore='a'*32;service=str(uuid.uuid4())
        request={'version':1,'action':'legacy_recovery','operationId':op,'restoreId':restore,'serviceId':service}
        self.assertEqual(self.request(request),{'ok':False,'error':'operation_in_progress'})
        self.assertFalse(self.dispatched.wait(.1))
        self.assertFalse(any(item['type']=='recover_legacy_upload' for item in self.received))
        self.assertEqual(self.request({'version':1,'action':'legacy_recovery_status','operationId':op}),{'ok':False,'error':'not_found'})
        self.backup_busy.clear()
        accepted=self.request(request)
        self.assertTrue(accepted['ok']);self.assertEqual(accepted['operation']['status'],'requested')
        self.assertTrue(self.dispatched.wait(5));self.release.set()


if __name__=='__main__':unittest.main()
