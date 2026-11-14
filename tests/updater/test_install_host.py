import fcntl
import importlib.util
import os
from pathlib import Path
import shutil
import stat
import sys
import tempfile
import unittest
from unittest import mock

ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('install_host',ROOT/'apps/updater/install-host.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)

@unittest.skipUnless(sys.platform=='linux' and os.geteuid()==0 and sys.flags.isolated,'Requires isolated Linux root')
class HostFileInstallTest(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(dir='/root');self.root=Path(self.tmp.name)
        self.source=self.root/'source';self.install=self.root/'install';self.libexec=self.root/'libexec';self.units=self.root/'units'
        for path in (self.source,self.install):path.mkdir(mode=0o700)
        for path in (self.libexec,self.units):path.mkdir(mode=0o755)
        (self.install/'install.lock').touch(mode=0o600)
        (self.source/'apps/updater').mkdir(parents=True,mode=0o755)
        (self.source/'deployment/systemd').mkdir(parents=True,mode=0o755)
        for name in module.MODULES:
            dest=self.source/'apps/updater'/name;shutil.copyfile(ROOT/'apps/updater'/name,dest)
            dest.chmod(0o755 if name=='servus-updater.py' else 0o644)
        for name in module.UNITS:
            dest=self.source/'deployment/systemd'/name;shutil.copyfile(ROOT/'deployment/systemd'/name,dest);dest.chmod(0o644)

    def tearDown(self):self.tmp.cleanup()
    def run_install(self,**kwargs):module.install(str(self.source),str(self.install),str(self.libexec),str(self.units),**kwargs)

    def test_installs_exact_files_and_reuses_them_without_replacing(self):
        self.run_install();dest=self.libexec/'servus'
        self.assertEqual({item.name for item in dest.iterdir()},set(module.MODULES))
        self.assertEqual({item.name for item in self.units.iterdir()},set(module.UNITS))
        for name in module.MODULES:
            path=dest/name;self.assertEqual(path.read_bytes(),(self.source/'apps/updater'/name).read_bytes())
            self.assertEqual((path.stat().st_uid,path.stat().st_gid,stat.S_IMODE(path.stat().st_mode)),(0,0,0o755 if name=='servus-updater.py' else 0o644))
        inode=(dest/'supervisor.py').stat().st_ino;self.run_install()
        self.assertEqual((dest/'supervisor.py').stat().st_ino,inode)

    def test_creates_missing_libexec_parent_without_following_symlinks(self):
        self.libexec.rmdir();self.run_install()
        self.assertEqual(stat.S_IMODE(self.libexec.stat().st_mode),0o755)
        alias=self.root/'alias';alias.symlink_to(self.libexec)
        with self.assertRaises(OSError):module.install(str(self.source),str(self.install),str(alias),str(self.units))

    def test_conflicting_unit_or_module_is_never_replaced(self):
        path=self.units/module.UNITS[0];path.write_bytes(b'other');path.chmod(0o644)
        with self.assertRaises(module.InstallHostError):self.run_install()
        self.assertEqual(path.read_bytes(),b'other');self.assertFalse((self.libexec/'servus').exists())
        path.unlink();self.run_install();target=self.libexec/'servus'/'supervisor.py';target.write_bytes(b'other');target.chmod(0o644)
        with self.assertRaises(module.InstallHostError):self.run_install()
        self.assertEqual(target.read_bytes(),b'other')

    def test_untrusted_or_missing_source_does_not_publish(self):
        path=self.source/'apps/updater/supervisor.py';path.unlink();path.symlink_to('/etc/passwd')
        with self.assertRaises(OSError):self.run_install()
        self.assertFalse((self.libexec/'servus').exists());self.assertEqual(list(self.units.iterdir()),[])

    def test_partial_install_can_resume_without_overwriting(self):
        original=module.publish;calls=[]
        def interrupted(*args):
            calls.append(args[1])
            if len(calls)==4:raise OSError('interrupted')
            return original(*args)
        with mock.patch.object(module,'publish',side_effect=interrupted):
            with self.assertRaises(OSError):self.run_install()
        first=self.libexec/'servus'/calls[0];inode=first.stat().st_ino
        self.run_install();self.assertEqual(first.stat().st_ino,inode)
        self.assertEqual({item.name for item in (self.libexec/'servus').iterdir()},set(module.MODULES))

    def test_borrows_only_matching_installer_lock(self):
        held=os.open(self.install/'install.lock',os.O_RDONLY);wrong=os.open(self.source,os.O_RDONLY)
        try:
            fcntl.flock(held,fcntl.LOCK_EX|fcntl.LOCK_NB)
            with self.assertRaises(module.InstallHostError):self.run_install(inherited_lock=wrong)
            self.run_install(inherited_lock=held)
            contender=os.open(self.install/'install.lock',os.O_RDONLY)
            try:
                with self.assertRaises(BlockingIOError):fcntl.flock(contender,fcntl.LOCK_EX|fcntl.LOCK_NB)
            finally:os.close(contender)
        finally:os.close(wrong);os.close(held)

if __name__=='__main__':unittest.main()
