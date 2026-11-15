import fcntl
import hashlib
import importlib.util
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'apps/updater'))
import supervisor
def load(name):
    spec=importlib.util.spec_from_file_location(name.replace('-','_'),ROOT/'apps/updater'/name)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
bundle=load('host-bundle.py');coordinator=load('host-coordinator.py');exchange=load('host-exchange.py');switch=load('host-switch.py')


@unittest.skipUnless(sys.platform=='linux' and os.geteuid()==0 and sys.flags.isolated,'Requires isolated Linux root')
class HostSwitchTest(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(dir='/root');self.root=Path(self.temp.name)
        self.state,self.install,self.active,self.candidates=(self.root/name for name in ('state','install','active','candidates'))
        for path in (self.state,self.install,self.candidates):path.mkdir(mode=0o700)
        self.active.mkdir(mode=0o755);(self.active/'servus').mkdir(mode=0o755);(self.active/'servus'/'version').write_text('old')
        for path in (self.state/'service.lock',self.install/'install.lock'):path.touch(mode=0o600)
        self.sl=os.open(self.state/'service.lock',os.O_RDONLY);self.il=os.open(self.install/'install.lock',os.O_RDONLY)
        for fd in (self.sl,self.il):fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        self.s=os.open(self.state,os.O_RDONLY|os.O_DIRECTORY);self.i=os.open(self.install,os.O_RDONLY|os.O_DIRECTORY)
        self.a=os.open(self.active,os.O_RDONLY|os.O_DIRECTORY);self.c=os.open(self.candidates,os.O_RDONLY|os.O_DIRECTORY)
        self.db=sqlite3.connect(self.state/'journal.sqlite',isolation_level=None);(self.state/'journal.sqlite').chmod(0o600)
        self.db.execute("CREATE TABLE host_preparations(operation_id TEXT PRIMARY KEY,image_digest TEXT,generation TEXT,status TEXT)")
        self.op='12345678-1234-4234-8234-123456789abc';self.digest='sha256:'+'a'*64
        self.modules={'core.py':(0o644,b'new')};self.cli=b'gh';self.pin=('b'*64,hashlib.sha256(self.cli).hexdigest(),len(self.cli))
        bundle.stage_runtime_tree(self.c,self.op,self.digest,self.modules,self.cli,self.pin)
        self.db.execute('INSERT INTO host_preparations VALUES(?,?,?,?)',(self.op,self.digest,'runtime-'+self.op,'prepared'))
        self.fence=mock.Mock(return_value=None);self.old=exchange.identity(self.a,'servus');self.new=exchange.identity(self.c,'runtime-'+self.op)

    def tearDown(self):
        self.db.close()
        for fd in (self.sl,self.il,self.s,self.i,self.a,self.c):os.close(fd)
        self.temp.cleanup()

    def args(self):
        return dict(state_fd=self.s,install_fd=self.i,service_lock=self.sl,install_lock=self.il,active_parent=self.a,
                    candidate_parent=self.c,supervisor=supervisor,coordinator=coordinator,bundle=bundle,exchange=exchange,fence=self.fence)

    def apply(self):switch.exchange_prepared(self.db,self.op,self.digest,self.modules,self.cli,self.pin,**self.args())
    def observe(self):return switch.inspect_exchange(self.db,self.op,self.a,self.c,exchange,bundle)
    def rollback(self):switch.rollback_exchanged(self.db,self.op,**self.args())

    def test_journal_precedes_exchange_and_rollback_restores_old_runtime(self):
        original=exchange.exchange
        def guarded(*args):
            self.assertEqual(self.db.execute('select phase from host_switches').fetchone(),('intent',))
            return original(*args)
        with mock.patch.object(exchange,'exchange',side_effect=guarded):self.apply()
        self.assertEqual(self.db.execute('select phase from host_switches').fetchone(),('exchanged',))
        self.assertEqual(self.observe(),'exchanged');self.assertEqual((self.active/'servus'/'core.py').read_bytes(),b'new')
        self.rollback();self.assertEqual(self.observe(),'original')
        self.assertEqual(self.db.execute('select phase from host_switches').fetchone(),('rolled_back',))
        self.assertEqual(self.db.execute('select status from host_preparations').fetchone(),('recovery_required',))
        self.assertEqual((self.active/'servus'/'version').read_text(),'old')

    def test_process_loss_after_exchange_is_detected_and_can_be_rolled_back(self):
        original=exchange.exchange
        def interrupted(*args):original(*args);raise SystemExit(73)
        with mock.patch.object(exchange,'exchange',side_effect=interrupted),self.assertRaises(SystemExit):self.apply()
        self.assertEqual(self.db.execute('select phase from host_switches').fetchone(),('intent',))
        self.assertEqual(self.observe(),'exchanged');self.rollback();self.assertEqual(self.observe(),'original')

    def test_actual_process_loss_preserves_intent_and_allows_rollback(self):
        for fd in (self.sl,self.il):fcntl.flock(fd,fcntl.LOCK_UN)
        script='''import fcntl,hashlib,importlib.util,os,sqlite3,sys
root=sys.argv[1];base=sys.argv[2];sys.path.insert(0,base);import supervisor
def load(name):
 s=importlib.util.spec_from_file_location(name.replace("-","_"),base+"/"+name);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
bundle=load("host-bundle.py");coordinator=load("host-coordinator.py");exchange=load("host-exchange.py");switch=load("host-switch.py")
state=os.open(root+"/state",os.O_RDONLY|os.O_DIRECTORY);install=os.open(root+"/install",os.O_RDONLY|os.O_DIRECTORY)
active=os.open(root+"/active",os.O_RDONLY|os.O_DIRECTORY);candidate=os.open(root+"/candidates",os.O_RDONLY|os.O_DIRECTORY)
sl=os.open(root+"/state/service.lock",os.O_RDONLY);il=os.open(root+"/install/install.lock",os.O_RDONLY)
for fd in (sl,il):fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
db=sqlite3.connect(root+"/state/journal.sqlite",isolation_level=None);op="12345678-1234-4234-8234-123456789abc";digest="sha256:"+"a"*64
cli=b"gh";pin=("b"*64,hashlib.sha256(cli).hexdigest(),len(cli));original=exchange.exchange
def interrupted(*args):original(*args);os._exit(73)
exchange.exchange=interrupted
switch.exchange_prepared(db,op,digest,{"core.py":(0o644,b"new")},cli,pin,state_fd=state,install_fd=install,service_lock=sl,install_lock=il,active_parent=active,candidate_parent=candidate,supervisor=supervisor,coordinator=coordinator,bundle=bundle,exchange=exchange,fence=lambda:None)
'''
        try:
            result=subprocess.run([sys.executable,'-I','-c',script,str(self.root),str(ROOT/'apps/updater')],check=False)
            self.assertEqual(result.returncode,73)
        finally:
            for fd in (self.sl,self.il):fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        self.assertEqual(self.db.execute('select phase from host_switches').fetchone(),('intent',))
        self.assertEqual(self.observe(),'exchanged');self.rollback();self.assertEqual(self.observe(),'original')

    def test_rejects_tampering_or_lost_lock_before_journal(self):
        (self.candidates/('runtime-'+self.op)/'core.py').write_bytes(b'bad')
        with self.assertRaises(bundle.HostBundleError):self.apply()
        self.assertIsNone(self.db.execute("select name from sqlite_master where name='host_switches'").fetchone())
        (self.candidates/('runtime-'+self.op)/'core.py').write_bytes(b'new')
        fcntl.flock(self.sl,fcntl.LOCK_UN)
        with self.assertRaises(supervisor.SupervisorError):self.apply()
        self.assertEqual(exchange.identity(self.a,'servus'),self.old)

    def test_rejects_unfenced_or_changed_inode_without_exchange(self):
        self.fence.side_effect=RuntimeError('active consumer')
        with self.assertRaises(RuntimeError):self.apply()
        self.assertEqual(exchange.identity(self.a,'servus'),self.old)
        self.assertIsNone(self.db.execute("select name from sqlite_master where name='host_switches'").fetchone())

    def test_rejects_nonvoid_fence_result_before_exchange(self):
        self.fence.return_value=False
        with self.assertRaises(switch.HostSwitchError):self.apply()
        self.assertEqual(exchange.identity(self.a,'servus'),self.old)

    def test_failed_exchange_preserves_intent_and_original_tree(self):
        with mock.patch.object(exchange,'exchange',side_effect=OSError('exchange unavailable')),self.assertRaises(OSError):self.apply()
        self.assertEqual(self.db.execute('select phase from host_switches').fetchone(),('intent',))
        self.assertEqual(self.observe(),'original')
        self.assertEqual((self.active/'servus'/'version').read_text(),'old')

    def test_reconcile_failed_exchange_when_original_is_present(self):
        with mock.patch.object(exchange,'exchange',side_effect=OSError('fixture')),self.assertRaises(OSError):self.apply()
        switch.reconcile_original(self.db,self.op,**self.args())
        self.assertEqual(self.observe(),'original')
        self.assertEqual(self.db.execute('select phase from host_switches').fetchone(),('rolled_back',))
        self.assertEqual(self.db.execute('select status from host_preparations').fetchone(),('recovery_required',))

    def test_reconcile_refuses_exchanged_runtime_and_changed_identity(self):
        self.apply()
        with self.assertRaises(switch.HostSwitchError):switch.reconcile_original(self.db,self.op,**self.args())
        self.assertEqual(self.db.execute('select phase from host_switches').fetchone(),('exchanged',))
        original=exchange.identity
        with mock.patch.object(exchange,'identity',side_effect=lambda parent,name:(999,999) if name=='servus' else original(parent,name)):
            with self.assertRaises(switch.HostSwitchError):switch.reconcile_original(self.db,self.op,**self.args())
        self.assertEqual(self.db.execute('select phase from host_switches').fetchone(),('exchanged',))

    def test_reconcile_after_rollback_journal_failure(self):
        self.apply()
        self.db.execute("CREATE TRIGGER deny_host_recovery BEFORE UPDATE ON host_preparations BEGIN SELECT RAISE(ABORT,'fixture'); END")
        with self.assertRaises(sqlite3.IntegrityError):self.rollback()
        self.db.execute('DROP TRIGGER deny_host_recovery')
        switch.reconcile_original(self.db,self.op,**self.args())
        self.assertEqual(self.observe(),'original')
        self.assertEqual(self.db.execute('select phase from host_switches').fetchone(),('rolled_back',))
        self.assertEqual(self.db.execute('select status from host_preparations').fetchone(),('recovery_required',))

    def test_lost_lock_after_swap_preserves_intent_for_recovery(self):
        original=exchange.exchange
        def lose_lock(*args):original(*args);fcntl.flock(self.sl,fcntl.LOCK_UN)
        with mock.patch.object(exchange,'exchange',side_effect=lose_lock),self.assertRaises(supervisor.SupervisorError):self.apply()
        self.assertEqual(self.db.execute('select phase from host_switches').fetchone(),('intent',))
        self.assertEqual(self.observe(),'exchanged')
        fcntl.flock(self.sl,fcntl.LOCK_EX|fcntl.LOCK_NB);self.rollback()
        self.assertEqual(self.observe(),'original')

    def test_rollback_journal_failure_preserves_reconcilable_evidence(self):
        self.apply()
        self.db.execute("CREATE TRIGGER deny_host_recovery BEFORE UPDATE ON host_preparations BEGIN SELECT RAISE(ABORT,'fixture'); END")
        with self.assertRaises(sqlite3.IntegrityError):self.rollback()
        self.assertEqual(self.observe(),'original')
        self.assertEqual(self.db.execute('select phase from host_switches').fetchone(),('exchanged',))
        self.assertEqual(self.db.execute('select status from host_preparations').fetchone(),('prepared',))


if __name__=='__main__':unittest.main()
