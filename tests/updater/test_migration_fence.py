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

def load(name,filename):
    spec=importlib.util.spec_from_file_location(name,ROOT/'apps/updater'/filename)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module

fence_module=load('migration_fence','migration-fence.py')
updater=load('migration_fence_updater','servus-updater.py')

@unittest.skipUnless(sys.platform=='linux' and os.geteuid()==0 and sys.flags.isolated,'Requires isolated Linux root')
class MigrationFenceTest(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(dir='/root');self.root=Path(self.temp.name)
        self.install=self.root/'install';self.install.mkdir(mode=0o700);(self.install/'install.lock').touch(mode=0o600)
        self.state=self.root/'state';self.state.mkdir(mode=0o700)
        self.source=self.root/'original';self.source.mkdir(mode=0o700)
        self.operation=str(uuid.uuid4());self.old={role:letter*64 for role,letter in zip(('api','agent','worker'),'abc')}
        self.binding=(str(uuid.uuid4()),str(uuid.uuid4()),'a'*64,'sha256:'+'b'*64,'sha256:'+'c'*64)
        self.approved=SimpleNamespace(install_dir=str(self.install),data_dir=str(self.root/'restore'))
        self.adoption=SimpleNamespace(_binding=mock.Mock(return_value=('/policy','/accepted',self.approved,self.binding)))
        self.quiet=SimpleNamespace(ensure_host_namespaces=mock.Mock(),ensure_no_mount_aliases=mock.Mock(),ensure_no_open_data=mock.Mock())
        self.docker=mock.Mock();self.docker.call.return_value=b''
        self.journal=updater.Journal(self.state)
        self.fence=fence_module.MigrationFence(self.journal,self.operation,'/active',str(self.source),self.old,supervisor,object(),self.adoption,self.quiet,self.docker)
        self.lock=os.open(self.install/'install.lock',os.O_RDONLY);fcntl.flock(self.lock,fcntl.LOCK_EX|fcntl.LOCK_NB)

    def tearDown(self):os.close(self.lock);self.journal.close();self.temp.cleanup()

    def test_record_and_recheck_under_same_lock(self):
        self.fence.record(self.operation,self.lock);self.fence.assert_locked(self.operation,self.lock)
        self.assertEqual(self.journal.db.execute('SELECT state FROM legacy_migration_fences').fetchone(),('fenced',))
        with self.assertRaises(fence_module.MigrationFenceError):self.fence.record(self.operation,self.lock)

    def test_rejects_restart_or_original_data_mount(self):
        self.fence.record(self.operation,self.lock)
        self.docker.call.return_value=(self.old['api']+'\n').encode()
        with self.assertRaises(fence_module.MigrationFenceError):self.fence.assert_locked(self.operation,self.lock)
        other='d'*64;self.docker.call.return_value=(other+'\n').encode()
        for path in (str(self.source),str(self.source/'secrets'),str(self.root)):
            self.docker.inspect.return_value=[{'Id':other,'Mounts':[{'Source':path}]}]
            with self.subTest(path=path),self.assertRaises(fence_module.MigrationFenceError):self.fence.assert_locked(self.operation,self.lock)
        self.docker.inspect.return_value=[{'Id':other,'Mounts':[{'Source':str(self.root/'restore')}]}]
        self.fence.assert_locked(self.operation,self.lock)

    def test_rejects_changed_permissions_identity_policy_and_lock(self):
        self.fence.record(self.operation,self.lock)
        self.source.chmod(0o755)
        with self.assertRaises((fence_module.MigrationFenceError,supervisor.SupervisorError)):self.fence.assert_locked(self.operation,self.lock)
        self.source.chmod(0o700)
        self.adoption._binding.return_value=('/changed','/accepted',self.approved,self.binding)
        with self.assertRaises(fence_module.MigrationFenceError):self.fence.assert_locked(self.operation,self.lock)
        self.adoption._binding.return_value=('/policy','/accepted',self.approved,self.binding)
        wrong=self.root/'wrong';wrong.touch(mode=0o600);fd=os.open(wrong,os.O_RDONLY)
        try:
            fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
            with self.assertRaises(fence_module.MigrationFenceError):self.fence.assert_locked(self.operation,fd)
        finally:os.close(fd)
        self.source.rename(self.root/'old');self.source.mkdir(mode=0o700)
        with self.assertRaises(fence_module.MigrationFenceError):self.fence.assert_locked(self.operation,self.lock)

    def test_fails_closed_for_invalid_inventory_and_interrupted_state(self):
        self.docker.call.return_value=b'bad-id\n'
        with self.assertRaises(fence_module.MigrationFenceError):self.fence.record(self.operation,self.lock)
        self.docker.call.return_value=b'';self.fence.record(self.operation,self.lock)
        self.journal.db.execute("UPDATE legacy_migration_fences SET state='recovery_required'")
        with self.assertRaises(fence_module.MigrationFenceError):self.fence.assert_locked(self.operation,self.lock)

if __name__=='__main__':unittest.main()
