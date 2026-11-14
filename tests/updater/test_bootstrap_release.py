import importlib.util
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
import threading
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('bootstrap_release', ROOT / 'apps/updater/bootstrap-release.py')
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)


class BootstrapReleaseTest(unittest.TestCase):
    def setUp(self):
        self.op, self.prep = str(uuid.uuid4()), str(uuid.uuid4())
        self.commit='a'*40; self.digest='sha256:'+'b'*64; self.tag='v1.2.3'
        self.release={'operationId':self.op,'commit':self.commit,'digest':self.digest,'tag':self.tag,'createdAt':'2026-01-01 00:00:00'}

    def test_verification_then_preparation_with_same_identity(self):
        responses=[{**self.release,'status':'accepted'},{**self.release,'status':'verified'},
                   {'operationId':self.op,'preparationId':self.prep,'status':'preparing'},
                   {'operationId':self.op,'preparationId':self.prep,'status':'prepared'}]
        calls=[]
        def call(_path,payload): calls.append(payload);return responses.pop(0)
        module.run('/fixture',self.op,self.commit,self.digest,self.tag,interval=.001,call=call)
        self.assertEqual([item['action'] for item in calls],['submit','status','prepare','prepare'])
        self.assertTrue(all(item['operationId']==self.op for item in calls))

    def test_unexpected_or_failed_responses_never_prepare(self):
        for changes in ({'status':'verification_failed'}, {'status':'recovery_required'}, {'status':'verified','digest':'sha256:'+'c'*64}, {'status':'unknown'}):
            calls=[]
            def call(_path,payload): calls.append(payload);return {**self.release,**changes}
            with self.subTest(changes=changes), self.assertRaises(module.BootstrapError):
                module.run('/fixture',self.op,self.commit,self.digest,self.tag,interval=.001,call=call)
            self.assertEqual(len(calls),1)

    def test_preparation_needs_matching_operation_and_identity(self):
        for value in ({'operationId':str(uuid.uuid4()),'preparationId':self.prep,'status':'prepared'},
                      {'operationId':self.op,'preparationId':'invalid','status':'prepared'},
                      {'operationId':self.op,'preparationId':self.prep,'status':'recovery_required'}):
            responses=[{**self.release,'status':'verified'},value]
            with self.subTest(value=value), self.assertRaises(module.BootstrapError):
                module.run('/fixture',self.op,self.commit,self.digest,self.tag,interval=.001,call=lambda *_:responses.pop(0))

    def test_rejects_invalid_submission_before_connecting(self):
        for commit,digest,tag in [('bad',self.digest,self.tag),(self.commit,'invalid',self.tag),(self.commit,self.digest,'v1.2.3-rc1')]:
            with self.subTest(tag=tag), self.assertRaises(module.BootstrapError):
                module.run('/fixture',self.op,commit,digest,tag,call=lambda *_:self.fail('connected'))

    @unittest.skipUnless(sys.platform == 'linux' and os.geteuid() == 0, 'Requires isolated Linux root')
    def test_real_socket_rejects_duplicate_json_and_world_access(self):
        with tempfile.TemporaryDirectory(dir='/root') as directory:
            path=str(Path(directory)/'updater.sock')
            with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as server:
                server.bind(path);os.chmod(path,0o660);server.listen(1)
                def serve():
                    client,_=server.accept()
                    with client:
                        self.assertTrue(client.recv(1024).endswith(b'\n'))
                        client.sendall(b'{"ok":true,"ok":true,"operation":{}}\n')
                thread=threading.Thread(target=serve);thread.start()
                with self.assertRaises(module.BootstrapError): module.request(path,{'action':'status','operationId':self.op})
                thread.join(timeout=5);self.assertFalse(thread.is_alive())
                os.chmod(path,0o666)
                with self.assertRaises(module.BootstrapError): module.request(path,{'action':'status','operationId':self.op})


if __name__=='__main__': unittest.main()
