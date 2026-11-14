import fcntl
import importlib.util
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock
import types

ROOT = Path(__file__).resolve().parents[2]
GUARD = ROOT / 'apps/updater/guarded-verifier.py'
FENCE = ROOT / 'apps/updater/verification-fence.py'
HELPER = ROOT / 'apps/updater/servus-updater.py'
OPERATION = '12345678-1234-4123-8123-123456789abc'
ATTEMPT = '12345678-1234-4123-8123-123456789abd'
NONCE = 'a' * 64


@unittest.skipUnless(sys.platform == 'linux' and os.geteuid() == 0, 'Requires isolated Linux root fixture')
class GuardedVerifierTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='servus-guard-', dir='/run')
        self.root = Path(self.temp.name)
        self.root.chmod(0o755)
        self.fence = self.root / OPERATION
        self.fence.mkdir(mode=0o710)
        os.chown(self.fence, 0, 55533)
        (self.fence / 'lock').write_text('')
        os.chown(self.fence / 'lock', 0, 55533)
        (self.fence / 'lock').chmod(0o640)
        self.set_state(ATTEMPT, NONCE)
        spec=importlib.util.spec_from_file_location('fence', FENCE)
        self.fence_module=importlib.util.module_from_spec(spec);spec.loader.exec_module(self.fence_module)

    def tearDown(self):
        self.temp.cleanup()

    def set_state(self, attempt, nonce):
        file = self.fence / 'next'
        file.write_text(f'{OPERATION} {attempt} {nonce}\n')
        os.chown(file, 0, 55533)
        file.chmod(0o640)
        os.replace(file, self.fence / 'state')

    def launch(self, tail):
        code = '''import importlib.util,sys
spec=importlib.util.spec_from_file_location('guard',sys.argv[1]);g=importlib.util.module_from_spec(spec);spec.loader.exec_module(g)
fd=g.lock_fence(__import__('pathlib').Path(sys.argv[2]),sys.argv[3],sys.argv[4],sys.argv[5],55533)
''' + tail
        def drop():
            os.setgroups([]); os.setgid(55533); os.setuid(65534)
        return subprocess.Popen([sys.executable,'-I','-c',code,str(GUARD),str(self.root),OPERATION,ATTEMPT,NONCE],
                                stdout=subprocess.PIPE,stderr=subprocess.PIPE,preexec_fn=drop,text=True)

    def test_late_start_checks_rotated_nonce_after_exclusive_fence(self):
        with self.fence_module.Fence(self.root, OPERATION, 55533) as fence:
            process=self.launch("print('SHOULD_NOT_RUN',flush=True)")
            try:
                time.sleep(.1)
                self.assertIsNone(process.poll())
                fence.revoke(ATTEMPT, NONCE)
                fence.close()
                out, _ = process.communicate(timeout=4)
                self.assertNotEqual(process.returncode, 0)
                self.assertNotIn('SHOULD_NOT_RUN', out)
            finally:
                if process.poll() is None: process.kill(); process.wait()

    def test_lock_is_held_across_exec(self):
        process=self.launch("import os; print('ready',flush=True);os.execv('/bin/sleep',['sleep','30'])")
        try:
            self.assertEqual(process.stdout.readline().strip(), 'ready')
            with open(self.fence / 'lock','rb') as lock:
                with self.assertRaises(BlockingIOError): fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            process.send_signal(signal.SIGKILL);process.wait(timeout=3)
            with open(self.fence / 'lock','rb') as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        finally:
            if process.poll() is None: process.kill();process.wait()
            process.stdout.close();process.stderr.close()

    def test_activation_and_revoke_require_exclusive_lock(self):
        running=self.launch("import os; print('ready',flush=True);os.execv('/bin/sleep',['sleep','30'])")
        try:
            self.assertEqual(running.stdout.readline().strip(), 'ready')
            with self.assertRaises(BlockingIOError): self.fence_module.Fence(self.root, OPERATION, 55533)
            running.kill();running.wait(timeout=3)
            with self.fence_module.Fence(self.root, OPERATION, 55533) as fence:
                fence.revoke(ATTEMPT, NONCE)
                next_attempt='12345678-1234-4123-8123-123456789abe'
                fence.activate(next_attempt, 'b'*64)
                with self.assertRaises(self.fence_module.FenceError): fence.revoke(ATTEMPT, NONCE)
            self.assertEqual((self.fence / 'state').read_text(), f'{OPERATION} {next_attempt} {"b"*64}\n')
        finally:
            if running.poll() is None: running.kill();running.wait()
            running.stdout.close();running.stderr.close()

    def test_unprivileged_wrong_group_cannot_take_shared_lock(self):
        code = "import fcntl,sys; f=open(sys.argv[1], 'rb'); fcntl.flock(f, fcntl.LOCK_SH); print('unsafe')"
        def drop():
            os.setgroups([]); os.setgid(65533); os.setuid(65533)
        process = subprocess.run([sys.executable, '-I', '-c', code, str(self.fence / 'lock')], preexec_fn=drop, capture_output=True, text=True, timeout=4)
        self.assertNotEqual(process.returncode, 0)
        self.assertNotIn('unsafe', process.stdout)

    def test_wrong_group_on_fence_is_refused(self):
        os.chown(self.fence / 'state', 0, 65533)
        process=self.launch("print('SHOULD_NOT_RUN')")
        out,_=process.communicate(timeout=4)
        self.assertNotEqual(process.returncode,0);self.assertNotIn('SHOULD_NOT_RUN',out)
        with self.fence_module.Fence(self.root, OPERATION, 55533) as fence:
            with self.assertRaises(self.fence_module.FenceError): fence.read_state()

    def test_root_provisioning_creates_private_fence_under_restrictive_umask(self):
        next_operation='12345678-1234-4123-8123-123456789abe'
        previous=os.umask(0o077)
        try: self.fence_module.create_operation(self.root, next_operation, 55533)
        finally: os.umask(previous)
        target=self.root / next_operation
        self.assertEqual(target.stat().st_mode & 0o777, 0o710)
        self.assertEqual(target.stat().st_gid, 55533)
        for name in ('state','lock'):
            self.assertEqual((target/name).stat().st_mode & 0o777, 0o640)
            self.assertEqual((target/name).stat().st_gid, 55533)
        with self.assertRaises(FileExistsError): self.fence_module.create_operation(self.root, next_operation, 55533)

    def test_revoke_uses_durable_gid_without_process_scan(self):
        spec=importlib.util.spec_from_file_location('helper_fixture', HELPER)
        helper=importlib.util.module_from_spec(spec);spec.loader.exec_module(helper)
        operation={'operationId':OPERATION,'attemptId':ATTEMPT,'attemptNonce':NONCE}
        with mock.patch.object(helper,'assert_host_systemd'), \
             mock.patch.object(helper,'FENCE_MODULE',FENCE), mock.patch.object(helper,'FENCE_ROOT',self.root), \
             mock.patch.object(helper,'assert_fresh_gid_provenance',return_value=55533), \
             mock.patch.object(helper,'scan_live_group_holders',side_effect=AssertionError('unexpected scan')):
            wrong=dict(operation, attemptNonce='b'*64)
            with self.assertRaises(RuntimeError): helper.revoke_fence(wrong)
            helper.revoke_fence(operation)
            self.assertEqual((self.fence/'state').read_bytes(),b'revoked\n')

    def test_helper_rejects_groups_with_members_or_untraversable_ancestors(self):
        spec=importlib.util.spec_from_file_location('helper_fixture', HELPER)
        helper=importlib.util.module_from_spec(spec);spec.loader.exec_module(helper)
        patcher=mock.patch.object(helper,'assert_host_systemd');patcher.start();self.addCleanup(patcher.stop)
        with mock.patch.object(helper,'FENCE_MODULE',FENCE), mock.patch.object(helper,'FENCE_ROOT',self.root), \
             mock.patch.object(helper,'assert_supported_nss',return_value=('', 'servus-verifier:x:55533:\n')), \
             mock.patch.object(helper,'assert_no_subgid_delegation'), \
             mock.patch.object(helper,'assert_stable_processes_without_gid'), \
             mock.patch.object(helper,'assert_fresh_gid_provenance',return_value=55533), \
             mock.patch.object(helper.grp,'getgrall',return_value=[types.SimpleNamespace(gr_gid=55533,gr_name='servus-verifier',gr_mem=[])]), \
             mock.patch.object(helper.grp,'getgrnam',return_value=types.SimpleNamespace(gr_gid=55533,gr_mem=['foreign'])), \
             mock.patch.object(helper.pwd,'getpwall',return_value=[]):
            with self.assertRaises(RuntimeError): helper.fence_context()
        with mock.patch.object(helper,'FENCE_MODULE',FENCE), mock.patch.object(helper,'FENCE_ROOT',self.root), \
             mock.patch.object(helper,'assert_supported_nss',return_value=('', 'servus-verifier:x:55533:\n')), \
             mock.patch.object(helper,'assert_no_subgid_delegation'), \
             mock.patch.object(helper,'assert_stable_processes_without_gid'), \
             mock.patch.object(helper,'assert_fresh_gid_provenance',return_value=55533), \
             mock.patch.object(helper.grp,'getgrall',return_value=[types.SimpleNamespace(gr_gid=55533,gr_name='servus-verifier',gr_mem=[])]), \
             mock.patch.object(helper.grp,'getgrnam',return_value=types.SimpleNamespace(gr_gid=55533,gr_mem=[])), \
             mock.patch.object(helper.pwd,'getpwall',return_value=[types.SimpleNamespace(pw_gid=55533)]):
            with self.assertRaises(RuntimeError): helper.fence_context()
        self.root.chmod(0o700)
        try:
            with mock.patch.object(helper,'FENCE_MODULE',FENCE), mock.patch.object(helper,'FENCE_ROOT',self.root), \
             mock.patch.object(helper,'assert_supported_nss',return_value=('', 'servus-verifier:x:55533:\n')), \
             mock.patch.object(helper,'assert_no_subgid_delegation'), \
             mock.patch.object(helper,'assert_stable_processes_without_gid'), \
             mock.patch.object(helper,'assert_fresh_gid_provenance',return_value=55533), \
             mock.patch.object(helper.grp,'getgrall',return_value=[types.SimpleNamespace(gr_gid=55533,gr_name='servus-verifier',gr_mem=[])]), \
                 mock.patch.object(helper.grp,'getgrnam',return_value=types.SimpleNamespace(gr_gid=55533,gr_mem=[])), \
                 mock.patch.object(helper.pwd,'getpwall',return_value=[]):
                with self.assertRaises(RuntimeError): helper.fence_context()
        finally: self.root.chmod(0o755)

    def test_successful_verification_revokes_nonce_before_marking_verified(self):
        import json
        spec=importlib.util.spec_from_file_location('helper_fixture', HELPER)
        helper=importlib.util.module_from_spec(spec);spec.loader.exec_module(helper)
        patcher=mock.patch.object(helper,'assert_host_systemd');patcher.start();self.addCleanup(patcher.stop)
        state=Path(tempfile.mkdtemp(prefix='servus-journal-',dir='/run'))
        journal=helper.Journal(state)
        commit='a'*40;digest='sha256:'+'b'*64;tag='v1.2.3'
        output=json.dumps({'image':'ghcr.io/raxon/servus','commit':commit,'digest':digest,'tag':tag,'verified':True})
        def launch(op, pipe): return subprocess.Popen([sys.executable,'-I','-c','print('+repr(output)+')'],stdout=pipe,stderr=subprocess.DEVNULL)
        # Existing test fence is revoked before the worker creates its own operation directory.
        (self.fence/'state').unlink(); (self.fence/'lock').unlink(); self.fence.rmdir()
        try:
            with mock.patch.object(helper,'FENCE_MODULE',FENCE), mock.patch.object(helper,'FENCE_ROOT',self.root), \
             mock.patch.object(helper,'assert_supported_nss',return_value=('', 'servus-verifier:x:55533:\n')), \
             mock.patch.object(helper,'assert_no_subgid_delegation'), \
             mock.patch.object(helper,'assert_stable_processes_without_gid'), \
             mock.patch.object(helper,'assert_fresh_gid_provenance',return_value=55533), \
             mock.patch.object(helper.grp,'getgrall',return_value=[types.SimpleNamespace(gr_gid=55533,gr_name='servus-verifier',gr_mem=[])]), \
                 mock.patch.object(helper.grp,'getgrnam',return_value=types.SimpleNamespace(gr_gid=55533,gr_mem=[])), \
                 mock.patch.object(helper.pwd,'getpwall',return_value=[]):
                journal.submit(OPERATION,commit,digest,tag)
                worker=helper.VerificationWorker(journal, launch)
                worker.tick()
                for _ in range(200):
                    worker.tick()
                    if worker.process is None: break
                    time.sleep(.01)
                self.assertEqual(journal.status(OPERATION)['status'],'verified')
                self.assertEqual((self.root/OPERATION/'state').read_bytes(),b'revoked\n')
        finally:
            journal.close()
            import shutil
            shutil.rmtree(state)

    def test_crash_before_verifier_start_revokes_old_nonce_before_retry(self):
        spec=importlib.util.spec_from_file_location('helper_fixture', HELPER)
        helper=importlib.util.module_from_spec(spec);spec.loader.exec_module(helper)
        patcher=mock.patch.object(helper,'assert_host_systemd');patcher.start();self.addCleanup(patcher.stop)
        state=Path(tempfile.mkdtemp(prefix='servus-journal-',dir='/run'))
        journal=helper.Journal(state)
        (self.fence/'state').unlink(); (self.fence/'lock').unlink(); self.fence.rmdir()
        try:
            with mock.patch.object(helper,'FENCE_MODULE',FENCE), mock.patch.object(helper,'FENCE_ROOT',self.root), \
             mock.patch.object(helper,'assert_supported_nss',return_value=('', 'servus-verifier:x:55533:\n')), \
             mock.patch.object(helper,'assert_no_subgid_delegation'), \
             mock.patch.object(helper,'assert_stable_processes_without_gid'), \
             mock.patch.object(helper,'assert_fresh_gid_provenance',return_value=55533), \
             mock.patch.object(helper.grp,'getgrall',return_value=[types.SimpleNamespace(gr_gid=55533,gr_name='servus-verifier',gr_mem=[])]), \
                 mock.patch.object(helper.grp,'getgrnam',return_value=types.SimpleNamespace(gr_gid=55533,gr_mem=[])), \
                 mock.patch.object(helper.pwd,'getpwall',return_value=[]):
                journal.submit(OPERATION,'a'*40,'sha256:'+'b'*64,'v1.2.3')
                operation=journal.claim();helper.prepare_fence(operation)
                journal.recover()
                pending=journal.pending_recoveries()[0]
                helper.revoke_fence(pending)
                self.assertEqual((self.root/OPERATION/'state').read_bytes(),b'revoked\n')
                self.assertEqual(journal.status(OPERATION)['status'],'recovery_required')
                with self.assertRaises(helper.ProtocolError): journal.retry(OPERATION)
        finally:
            journal.close()
            import shutil
            shutil.rmtree(state)

    def test_rejects_symlink_and_untrusted_permissions(self):
        (self.fence / 'state').unlink();(self.fence / 'state').symlink_to('/etc/passwd')
        process=self.launch("print('SHOULD_NOT_RUN')")
        out,_=process.communicate(timeout=4)
        self.assertNotEqual(process.returncode,0);self.assertNotIn('SHOULD_NOT_RUN',out)
        (self.fence / 'state').unlink();self.set_state(ATTEMPT, NONCE)
        (self.fence / 'lock').chmod(0o666)
        process=self.launch("print('SHOULD_NOT_RUN')")
        out,_=process.communicate(timeout=4)
        self.assertNotEqual(process.returncode,0);self.assertNotIn('SHOULD_NOT_RUN',out)


if __name__ == '__main__': unittest.main()
