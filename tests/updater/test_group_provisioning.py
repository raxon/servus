import grp
import builtins
import ctypes
import errno
import platform
import threading
import importlib.util
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import types
import time
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]

def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module

helper = load('group_helper', ROOT / 'apps/updater/servus-updater.py')
provisioner = load('group_provisioner', ROOT / 'apps/updater/provision-verifier-group.py')


class GroupSafetyTest(unittest.TestCase):
    def test_mount_namespace_must_match_pid_one(self):
        own = types.SimpleNamespace(st_dev=4, st_ino=30)
        foreign = types.SimpleNamespace(st_dev=4, st_ino=31)
        with mock.patch.object(helper.os, 'stat', side_effect=[own, foreign]):
            with self.assertRaisesRegex(RuntimeError, 'Host mount namespace'):
                helper.assert_host_mount_namespace()
        with mock.patch.object(helper.os, 'stat', side_effect=[own, own]):
            helper.assert_host_mount_namespace()

    def test_subgid_overlap_and_unknown_plugins_are_rejected(self):
        helper.validate_subgid_ranges(55533, 'user:100000:65536\n')
        with self.assertRaises(RuntimeError): helper.validate_subgid_ranges(55533, 'user:55500:100\n')
        with self.assertRaises(RuntimeError): helper.validate_subgid_ranges(55533, 'user:0:0\n')
        with self.assertRaises(RuntimeError): helper.nss_sources('passwd: files\ngroup: files\nsubid: sss\n')
        self.assertFalse(helper.nss_sources('passwd: files\ngroup: files\nsubid: files\n'))

    def test_scan_allows_process_list_churn(self):
        with mock.patch.object(helper, 'scan_live_group_holders', return_value={'1':10}) as scan:
            helper.assert_stable_processes_without_gid(55533)
            scan.assert_called_once_with(55533)

    def test_scan_refuses_unreadable_or_incomplete_task(self):
        with tempfile.TemporaryDirectory() as tmp:
            proc=Path(tmp); task=proc/'123'/'task'/'123'; task.mkdir(parents=True)
            with self.assertRaisesRegex(RuntimeError, 'incomplete'):
                helper.scan_live_group_holders(55533,proc)
            with mock.patch('builtins.open',side_effect=PermissionError(errno.EACCES, 'denied')):
                with self.assertRaisesRegex(RuntimeError, 'Cannot read'):
                    helper.scan_live_group_holders(55533,proc)

    def test_reappearing_task_after_missing_status_fails_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            proc=Path(tmp); task=proc/'123'/'task'/'123'; task.mkdir(parents=True)
            real_stat=os.stat; real_open=builtins.open; calls=[]
            def changing_stat(path, *args, **kwargs):
                if path == task:
                    calls.append(path)
                    if len(calls) == 1: raise FileNotFoundError(errno.ENOENT, 'gone')
                return real_stat(path, *args, **kwargs)
            def missing_status(path, *args, **kwargs):
                if path == task/'status': raise FileNotFoundError(errno.ENOENT, 'gone')
                return real_open(path, *args, **kwargs)
            with mock.patch.object(helper.os, 'stat', side_effect=changing_stat), \
                 mock.patch('builtins.open', side_effect=missing_status):
                with self.assertRaisesRegex(RuntimeError, 'identity changed'):
                    helper.scan_live_group_holders(55533,proc)
            self.assertEqual(len(calls), 2)


@unittest.skipUnless(sys.platform == 'linux' and os.geteuid() == 0, 'Requires Linux root')
class HostMountNamespaceTest(unittest.TestCase):
    def test_unshare_mount_is_rejected_on_systemd_host(self):
        try: helper.assert_host_systemd()
        except RuntimeError: self.skipTest('Requires host systemd namespaces')
        code = '''import importlib.util, sys
spec = importlib.util.spec_from_file_location("fixture", sys.argv[1])
helper = importlib.util.module_from_spec(spec); spec.loader.exec_module(helper)
try:
    helper.assert_host_systemd()
except RuntimeError as error:
    if str(error) == "Host mount namespace is required": sys.exit(0)
    raise
raise SystemExit("A foreign mount namespace was accepted")
'''
        result = subprocess.run(['unshare', '--mount', sys.executable, '-I', '-c', code,
                                 str(ROOT / 'apps/updater/servus-updater.py')],
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)


@unittest.skipUnless(sys.platform == 'linux' and os.geteuid() == 0 and Path('/.dockerenv').exists(), 'Requires disposable Linux root container')
class RealGroupProvisionTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='servus-gid-', dir='/run')
        self.root = Path(self.tmp.name); self.root.chmod(0o755)
        self.install = self.root / 'install'; self.install.mkdir(mode=0o755)
        self.state = self.root / 'state'; self.state.mkdir(mode=0o700)
        (self.install/'install.lock').touch(mode=0o600)
        self.original_group = Path('/etc/group').read_bytes()
        self.original_gshadow = Path('/etc/gshadow').read_bytes() if Path('/etc/gshadow').exists() else None

    def tearDown(self):
        Path('/etc/group').write_bytes(self.original_group)
        if self.original_gshadow is not None: Path('/etc/gshadow').write_bytes(self.original_gshadow)
        self.tmp.cleanup()

    def test_live_stale_supplementary_gid_is_rejected(self):
        def drop():
            os.setgroups([55533]); os.setgid(65533); os.setuid(65533)
        child=subprocess.Popen(['/bin/sleep','30'],preexec_fn=drop)
        try:
            for _ in range(20):
                try:
                    with self.assertRaises(RuntimeError) as error: helper.scan_live_group_holders(55533)
                    if 'held by a live process' in str(error.exception): break
                except AssertionError: pass
                time.sleep(.05)
            else: self.fail('The live stale supplementary group was not detected')
        finally:
            child.send_signal(signal.SIGKILL);child.wait(timeout=3)

    def test_container_is_not_host_systemd(self):
        with self.assertRaisesRegex(RuntimeError, 'host namespaces'):
            helper.assert_host_systemd()

    def test_normal_process_churn_does_not_block_scan(self):
        stop = threading.Event()
        def churn():
            while not stop.is_set():
                subprocess.run(['/bin/true'], check=True, stdout=subprocess.DEVNULL)
        thread = threading.Thread(target=churn); thread.start()
        try:
            for _ in range(15): helper.assert_stable_processes_without_gid(1073741947)
        finally:
            stop.set(); thread.join(5)

    def test_nonleader_thread_with_distinct_supplementary_gid_is_rejected(self):
        number = {'x86_64': 116, 'aarch64': 159}.get(platform.machine())
        if number is None: self.skipTest('Unknown setgroups syscall number')
        ready = threading.Event(); release = threading.Event(); result = []
        def worker():
            group = (ctypes.c_uint * 1)(55533)
            libc = ctypes.CDLL(None, use_errno=True)
            result.append((libc.syscall(number, 1, group), ctypes.get_errno(), threading.get_native_id()))
            ready.set(); release.wait(10)
        thread = threading.Thread(target=worker); thread.start()
        try:
            self.assertTrue(ready.wait(5)); self.assertEqual(result[0][0], 0, result)
            leader = Path('/proc/self/status').read_text()
            other = Path(f'/proc/self/task/{result[0][2]}/status').read_text()
            leader_groups = next(line for line in leader.splitlines() if line.startswith('Groups:'))
            other_groups = next(line for line in other.splitlines() if line.startswith('Groups:'))
            self.assertNotIn('55533', leader_groups.split())
            self.assertIn('55533', other_groups.split())
            with self.assertRaisesRegex(RuntimeError, 'held by a live process'):
                helper.scan_live_group_holders(55533)
        finally:
            release.set(); thread.join(5)

    def test_real_groupadd_records_fresh_gid_and_refuses_adoption(self):
        # A fixed synthetic GID makes the fixture independent of host accounts.
        candidate=1073741947
        with mock.patch.object(helper, 'assert_host_systemd'), mock.patch.object(provisioner.secrets,'randbelow',return_value=candidate-(1<<30)):
            gid=provisioner.provision(helper, self.state, self.install, Path('/usr/sbin/groupadd'))
        self.assertEqual(gid,candidate)
        self.assertEqual(grp.getgrnam('servus-verifier').gr_gid,gid)
        self.assertIn(b'"state":"ready"',(self.state/'verifier-group.json').read_bytes())
        with mock.patch.object(helper,'VERIFIER_RECORD_DIR',self.state):
            helper.assert_fresh_gid_provenance(gid)
        with mock.patch.object(helper, 'assert_host_systemd'), self.assertRaises(provisioner.ProvisionError):
            provisioner.provision(helper, self.state, self.install, Path('/usr/sbin/groupadd'))


if __name__ == '__main__': unittest.main()
