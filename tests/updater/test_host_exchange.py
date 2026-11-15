import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

ROOT=Path(__file__).resolve().parents[2]
MODULE=ROOT/'apps/updater/host-exchange.py'
spec=importlib.util.spec_from_file_location('host_exchange',MODULE)
exchange=importlib.util.module_from_spec(spec);spec.loader.exec_module(exchange)


@unittest.skipUnless(sys.platform=='linux' and os.geteuid()==0 and sys.flags.isolated,'Requires isolated Linux root')
class HostExchangeTest(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(dir='/root');self.root=Path(self.temp.name)
        self.active=self.root/'active';self.staging=self.root/'staging'
        self.active.mkdir(mode=0o755);self.staging.mkdir(mode=0o700)
        (self.active/'servus').mkdir(mode=0o755);(self.staging/'runtime-fixture').mkdir(mode=0o755)
        (self.active/'servus'/'version').write_text('old');(self.staging/'runtime-fixture'/'version').write_text('new')
        self.a=os.open(self.active,os.O_RDONLY|os.O_DIRECTORY);self.b=os.open(self.staging,os.O_RDONLY|os.O_DIRECTORY)
        self.old=exchange.identity(self.a,'servus');self.new=exchange.identity(self.b,'runtime-fixture')

    def tearDown(self):os.close(self.a);os.close(self.b);self.temp.cleanup()

    def swap(self,old=None,new=None):
        exchange.exchange(self.a,'servus',self.b,'runtime-fixture',old or self.old,new or self.new)

    def test_atomic_exchange_preserves_old_tree_for_rollback(self):
        self.swap()
        self.assertEqual((self.active/'servus'/'version').read_text(),'new')
        self.assertEqual((self.staging/'runtime-fixture'/'version').read_text(),'old')
        self.assertEqual(exchange.identity(self.a,'servus'),self.new)
        self.assertEqual(exchange.identity(self.b,'runtime-fixture'),self.old)
        self.swap(self.new,self.old)
        self.assertEqual((self.active/'servus'/'version').read_text(),'old')

    def test_rejects_changed_identity_symlinks_and_unsafe_parent(self):
        with self.assertRaises(exchange.HostExchangeError):self.swap((self.old[0],self.old[1]+1),self.new)
        self.assertEqual((self.active/'servus'/'version').read_text(),'old')
        (self.staging/'runtime-fixture').rename(self.staging/'original')
        (self.staging/'runtime-fixture').symlink_to(self.staging/'original',target_is_directory=True)
        with self.assertRaises(OSError):self.swap()
        (self.staging/'runtime-fixture').unlink();(self.staging/'original').rename(self.staging/'runtime-fixture')
        self.staging.chmod(0o777)
        with self.assertRaises(exchange.HostExchangeError):self.swap()

    def test_fsync_failure_after_swap_leaves_reconcilable_identities(self):
        with mock.patch.object(exchange.os,'fsync',side_effect=OSError('fixture')):
            with self.assertRaises(OSError):self.swap()
        self.assertEqual(exchange.identity(self.a,'servus'),self.new)
        self.assertEqual(exchange.identity(self.b,'runtime-fixture'),self.old)
        self.swap(self.new,self.old)
        self.assertEqual((self.active/'servus'/'version').read_text(),'old')

    def test_process_loss_after_swap_leaves_old_inode_available(self):
        script='''import importlib.util,os,sys
spec=importlib.util.spec_from_file_location("exchange",sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
a=int(sys.argv[2]);b=int(sys.argv[3]);old=m.identity(a,"servus");new=m.identity(b,"runtime-fixture")
m.exchange(a,"servus",b,"runtime-fixture",old,new);os._exit(73)
'''
        result=subprocess.run([sys.executable,'-I','-c',script,str(MODULE),str(self.a),str(self.b)],pass_fds=(self.a,self.b),check=False)
        self.assertEqual(result.returncode,73)
        self.assertEqual(exchange.identity(self.a,'servus'),self.new)
        self.assertEqual(exchange.identity(self.b,'runtime-fixture'),self.old)
        self.swap(self.new,self.old)
        self.assertEqual((self.active/'servus'/'version').read_text(),'old')


if __name__=='__main__':unittest.main()
