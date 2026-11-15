import importlib.util
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('host_fence',ROOT/'apps/updater/host-fence.py')
fence=importlib.util.module_from_spec(spec);spec.loader.exec_module(fence)


@unittest.skipUnless(sys.platform=='linux' and os.geteuid()==0 and sys.flags.isolated,'Requires isolated Linux root')
class HostFenceTest(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(dir='/root');self.root=Path(self.temp.name)
        self.proc=self.root/'proc';self.cgroup=self.root/'system.slice';self.proc.mkdir();self.cgroup.mkdir()
        self.quiet=SimpleNamespace(ensure_host_namespaces=mock.Mock(),ensure_no_open_data=mock.Mock())
        self.states={unit:'LoadState=masked\nActiveState=inactive\nControlGroup=\nUnitFileState=masked-runtime\n' for unit in fence.UNITS}

    def tearDown(self):self.temp.cleanup()

    def check(self):
        fence.assert_fenced('/usr/local/libexec/servus',self.quiet,execute=lambda unit:self.states[unit],proc=self.proc,cgroup=self.cgroup,own_pid=42)

    def test_requires_all_masked_inactive_units_and_rechecks(self):
        self.check();self.quiet.ensure_host_namespaces.assert_called_once()
        self.quiet.ensure_no_open_data.assert_called_once_with('/usr/local/libexec/servus')
        self.states[fence.UNITS[0]]='LoadState=masked\nActiveState=inactive\nControlGroup=\nUnitFileState=masked\n'
        self.check()
        for change in ('LoadState=loaded','ActiveState=active','ControlGroup=/system.slice/example','UnitFileState=enabled'):
            with self.subTest(change=change):
                self.states[fence.UNITS[0]]='LoadState=masked\nActiveState=inactive\nControlGroup=\nUnitFileState=masked-runtime\n'
                key=change.split('=',1)[0]
                self.states[fence.UNITS[0]]='\n'.join(change if line.startswith(key+'=') else line for line in self.states[fence.UNITS[0]].splitlines())+'\n'
                with self.assertRaises(fence.HostFenceError):self.check()

    def test_rejects_live_transient_cgroup_and_accepts_empty(self):
        group=self.cgroup/'servus-verify-abc.service';group.mkdir();(group/'cgroup.events').write_text('populated 1\nfrozen 0\n')
        with self.assertRaises(fence.HostFenceError):self.check()
        (group/'cgroup.events').write_text('populated 0\nfrozen 0\n');self.check()
        (group/'cgroup.events').write_text('populated 0\npopulated 0\n')
        with self.assertRaises(fence.HostFenceError):self.check()

    def test_rejects_process_using_host_modules_without_disclosing_command(self):
        process=self.proc/'51';process.mkdir();(process/'cmdline').write_bytes(b'python3\x00/usr/local/libexec/servus/verify-release.py\x00secret\x00')
        with self.assertRaises(fence.HostFenceError) as error:self.check()
        self.assertNotIn('secret',str(error.exception))
        (process/'cmdline').write_bytes(b'python3\x00/usr/local/libexec/servus\x00')
        with self.assertRaises(fence.HostFenceError):self.check()
        (process/'cmdline').write_bytes(b'python3\x00/tmp/unrelated\x00');self.check()

    def test_rejects_unavailable_or_linked_cgroup_state(self):
        group=self.cgroup/'servus-prepare-fixture.service';group.mkdir()
        with self.assertRaises(fence.HostFenceError):self.check()
        (group/'cgroup.events').symlink_to('/dev/null')
        with self.assertRaises(fence.HostFenceError):self.check()


if __name__=='__main__':unittest.main()
