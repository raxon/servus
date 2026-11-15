import fcntl
import hashlib
import importlib.util
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'apps/updater'))
import supervisor

def load(name):
    spec=importlib.util.spec_from_file_location(name.replace('-','_'),ROOT/'apps/updater'/name)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
runner=load('host-runner.py');bundle=load('host-bundle.py')


class PendingActivationTest(unittest.TestCase):
    def setUp(self):
        self.db=sqlite3.connect(':memory:')
        self.db.executescript('''
            CREATE TABLE policy_approvals(operation_id TEXT, state TEXT, policy_path TEXT, source_env_path TEXT);
            CREATE TABLE update_transactions(operation_id TEXT, phase TEXT);
            CREATE TABLE apply_requests(operation_id TEXT, state TEXT);
        ''')
        self.operation='12345678-1234-4234-8234-123456789abc'
        self.bundle=SimpleNamespace(completed_update=mock.Mock())

    def tearDown(self):self.db.close()

    def add_update(self,operation=None,*,policy='/policy',env='/env',approval='active',phase='completed',request='completed'):
        operation=operation or self.operation
        self.db.execute('INSERT INTO policy_approvals VALUES(?,?,?,?)',(operation,approval,policy,env))
        self.db.execute('INSERT INTO update_transactions VALUES(?,?)',(operation,phase))
        self.db.execute('INSERT INTO apply_requests VALUES(?,?)',(operation,request))

    def select(self):
        return runner.pending_activation(self.db,'/policy','/env','image','/stage',bundle=self.bundle)

    def test_selects_only_completed_active_policy_and_verifies_release(self):
        self.add_update()
        self.assertEqual(self.select(),self.operation)
        self.bundle.completed_update.assert_called_once_with(self.db,self.operation,'/stage','/policy','/env','image')

    def test_ignores_incomplete_or_inactive_updates(self):
        self.add_update(phase='starting')
        self.assertIsNone(self.select())
        self.db.execute("UPDATE update_transactions SET phase='completed'")
        self.db.execute("UPDATE policy_approvals SET state='superseded'")
        self.assertIsNone(self.select())
        self.bundle.completed_update.assert_not_called()

    def test_refuses_ambiguous_and_unverified_releases(self):
        self.add_update();self.add_update('12345678-1234-4234-8234-123456789abd')
        with self.assertRaises(runner.HostRunnerError):self.select()
        self.db.execute('DELETE FROM policy_approvals WHERE operation_id!=?',(self.operation,))
        self.bundle.completed_update.side_effect=RuntimeError('unverified')
        with self.assertRaises(RuntimeError):self.select()

    def test_does_not_retry_completed_or_interrupted_host_operation(self):
        self.add_update()
        self.db.execute('CREATE TABLE host_stops(operation_id TEXT,status TEXT)')
        self.db.execute("INSERT INTO host_stops VALUES(?,'completed')",(self.operation,))
        self.assertIsNone(self.select())
        self.db.execute("INSERT INTO host_stops VALUES('another','stopped')")
        with self.assertRaises(runner.HostRunnerError):self.select()
        self.db.execute("DELETE FROM host_stops WHERE operation_id='another'")
        self.db.execute("UPDATE host_stops SET status='stopped'")
        with self.assertRaises(runner.HostRunnerError):self.select()
        self.db.execute('DELETE FROM host_stops')
        self.db.execute("INSERT INTO host_stops VALUES('another','stopped')")
        with self.assertRaises(runner.HostRunnerError):self.select()


class PolicyRetryTest(unittest.TestCase):
    def error(self,code):
        cause=sqlite3.OperationalError('fixture');cause.sqlite_errorcode=code
        error=supervisor.SupervisorError('unavailable');error.__cause__=cause
        return error

    def test_retries_transient_sqlite_error_and_returns_verified_binding(self):
        binding=('/policy','/accepted',object())
        daemon=SimpleNamespace(resolve_active_policy=mock.Mock(side_effect=[self.error(sqlite3.SQLITE_IOERR),binding]))
        with mock.patch.object(runner.time,'sleep') as sleep:
            self.assertEqual(runner.resolve_policy_retry(daemon,supervisor,'/journal','/env'),binding)
        self.assertEqual(daemon.resolve_active_policy.call_count,2);sleep.assert_called_once()

    def test_does_not_retry_invalid_or_expired_policy_checks(self):
        daemon=SimpleNamespace(resolve_active_policy=mock.Mock(side_effect=self.error(sqlite3.SQLITE_CORRUPT)))
        with self.assertRaises(supervisor.SupervisorError):runner.resolve_policy_retry(daemon,supervisor,'/journal','/env')
        self.assertEqual(daemon.resolve_active_policy.call_count,1)
        daemon.resolve_active_policy=mock.Mock(side_effect=self.error(sqlite3.SQLITE_IOERR))
        with self.assertRaises(supervisor.SupervisorError):runner.resolve_policy_retry(daemon,supervisor,'/journal','/env',timeout=0)
        self.assertEqual(daemon.resolve_active_policy.call_count,1)


@unittest.skipUnless(sys.platform=='linux' and os.geteuid()==0 and sys.flags.isolated,'Requires isolated Linux root')
class HostRunnerTest(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(dir='/root');root=Path(self.tmp.name)
        self.paths={key:str(root/key) for key in ('state','install','units','parent','candidates','gate','active','active_env','socket')}
        for key in ('state','install','candidates'):Path(self.paths[key]).mkdir(mode=0o700)
        for key in ('units','parent','gate','active'):Path(self.paths[key]).mkdir(mode=0o755)
        for path in (Path(self.paths['state'])/'host.lock',Path(self.paths['install'])/'install.lock',Path(self.paths['state'])/'service.lock'):path.touch(mode=0o600)
        db=sqlite3.connect(Path(self.paths['state'])/'journal.sqlite');db.close();os.chmod(Path(self.paths['state'])/'journal.sqlite',0o600)
        self.op='12345678-1234-4234-8234-123456789abc';self.digest='sha256:'+'a'*64;self.policy=SimpleNamespace(image_reference='image')
        self.daemon=SimpleNamespace(resolve_active_policy=mock.Mock(return_value=('/policy','/accepted',self.policy)))
        self.bundle=SimpleNamespace(OPERATION=bundle.OPERATION,completed_update=mock.Mock(return_value=(self.digest,'/stage')))
        self.coordinator=SimpleNamespace(stop_updater=mock.Mock(),prepare_completed=mock.Mock(),prepare_recovery_snapshot=mock.Mock(),activate_prepared=mock.Mock())
        self.coordinator.stop_updater.side_effect=lambda *a,**k:(os.open(Path(self.paths['state'])/'service.lock',os.O_RDONLY),{'state':'fixture'})
        self.coordinator.prepare_completed.return_value=('runtime-'+self.op,self.digest,{'core.py':(0o644,b'core')},b'cli',('pin',))
        self.unit=SimpleNamespace(UNITS=('unit-a','unit-b'))
        self.modules=dict(supervisor=supervisor,daemon=self.daemon,bundle=self.bundle,coordinator=self.coordinator,
                          unit_mask=self.unit,switch=object(),install_host=SimpleNamespace(read_file=mock.Mock(return_value=b'unit')),
                          extractor=object(),backup=object(),install_gh=object(),fence=SimpleNamespace(assert_fenced=mock.Mock()),
                          quiescence=object(),exchange=object())

    def tearDown(self):self.tmp.cleanup()

    def test_binds_activation_to_completed_update_and_releases_locks(self):
        with mock.patch.object(supervisor,'inspect_servus',return_value={'api':'same'}):
            runner.activate(self.op,modules=self.modules,paths=self.paths)
        self.coordinator.stop_updater.assert_called_once();self.coordinator.prepare_completed.assert_called_once()
        self.coordinator.prepare_recovery_snapshot.assert_called_once();self.coordinator.activate_prepared.assert_called_once()
        fd=os.open(Path(self.paths['state'])/'host.lock',os.O_RDONLY)
        try:fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        finally:os.close(fd)

    def test_rechecks_running_generation_before_stopping(self):
        def check(*args,**kwargs):kwargs['authorize']()
        self.coordinator.stop_updater.side_effect=check
        with mock.patch.object(supervisor,'inspect_servus',side_effect=[{'api':'old'},{'api':'changed'}]),self.assertRaises(runner.HostRunnerError):
            runner.activate(self.op,modules=self.modules,paths=self.paths)
        self.coordinator.prepare_completed.assert_not_called()

    def test_snapshot_loader_verifies_all_bytes_before_executing(self):
        names=('supervisor.py','host-coordinator.py','host-unit-mask.py','host-switch.py','host-bundle.py',
               'host-exchange.py','host-fence.py','quiescence.py','install-host.py','host-recovery.py')
        contents={name:(0o644,(ROOT/'apps/updater'/name).read_bytes()) for name in names}
        parent=os.open(self.paths['candidates'],os.O_RDONLY|os.O_DIRECTORY)
        db=sqlite3.connect(Path(self.paths['state'])/'journal.sqlite',isolation_level=None);previous=sys.modules.get('supervisor')
        try:
            generation=bundle.stage_generation(parent,self.op,self.digest,contents)
            metadata=(Path(self.paths['candidates'])/generation/'complete.json').read_bytes()
            db.execute('CREATE TABLE host_recovery_snapshots(operation_id TEXT,image_digest TEXT,metadata_size INTEGER,metadata_digest TEXT,status TEXT)')
            db.execute("INSERT INTO host_recovery_snapshots VALUES(?,?,?,?,'prepared')",(self.op,self.digest,len(metadata),hashlib.sha256(metadata).hexdigest()))
            loaded=runner.load_recovery_snapshot(db,self.op,self.digest,parent,bundle=bundle)
            self.assertTrue(callable(loaded['recovery'].recover));self.assertTrue(callable(loaded['coordinator'].recover_exchange))
            (Path(self.paths['candidates'])/generation/'host-recovery.py').write_bytes(b'modified')
            with self.assertRaises(bundle.HostBundleError):runner.load_recovery_snapshot(db,self.op,self.digest,parent,bundle=bundle)
        finally:
            if previous is None:sys.modules.pop('supervisor',None)
            else:sys.modules['supervisor']=previous
            for key in ('coordinator','unit_mask','switch','bundle','exchange','fence','quiescence','install_host','recovery'):
                sys.modules.pop('servus_saved_'+key,None)
            db.close();os.close(parent)

    def test_recovery_falls_back_only_before_host_exchange(self):
        database=Path(self.paths['state'])/'journal.sqlite'
        with sqlite3.connect(database) as db:
            db.execute('CREATE TABLE host_stops(operation_id TEXT,image_digest TEXT,status TEXT)')
            db.execute("INSERT INTO host_stops VALUES(?,?,'stopped')",(self.op,self.digest))
        recovery=SimpleNamespace(recover=mock.Mock());modules={**self.modules,'bundle':bundle,'recovery':recovery}
        runner.recover_pending(modules=modules,paths=self.paths,prepare_only=True)
        recovery.recover.assert_called_once_with(self.op,self.digest,modules=modules,paths=self.paths,prepare_only=True)
        with sqlite3.connect(database) as db:
            db.execute('CREATE TABLE host_switches(operation_id TEXT,phase TEXT)')
            db.execute("INSERT INTO host_switches VALUES(?,'intent')",(self.op,))
        with self.assertRaises(runner.HostRunnerError):runner.recover_pending(modules=modules,paths=self.paths,prepare_only=True)
        self.assertEqual(recovery.recover.call_count,1)

    def test_recovery_rejects_ambiguous_journal_and_noops_when_complete(self):
        database=Path(self.paths['state'])/'journal.sqlite'
        with sqlite3.connect(database) as db:
            db.execute('CREATE TABLE host_stops(operation_id TEXT,image_digest TEXT,status TEXT)')
            db.execute("INSERT INTO host_stops VALUES(?,?,'completed')",(self.op,self.digest))
        recovery=SimpleNamespace(recover=mock.Mock());modules={**self.modules,'bundle':bundle,'recovery':recovery}
        runner.recover_pending(modules=modules,paths=self.paths,prepare_only=False);recovery.recover.assert_not_called()
        with sqlite3.connect(database) as db:
            db.execute("UPDATE host_stops SET status='stopped'");db.execute("INSERT INTO host_stops VALUES(?,?,'stopped')",('12345678-1234-4234-8234-123456789abd',self.digest))
        with self.assertRaises(runner.HostRunnerError):runner.recover_pending(modules=modules,paths=self.paths,prepare_only=False)
        recovery.recover.assert_not_called()

    def test_unverified_release_never_stops_updater(self):
        self.bundle.completed_update.side_effect=RuntimeError('unverified')
        with mock.patch.object(supervisor,'inspect_servus',return_value={'api':'same'}),self.assertRaises(RuntimeError):
            runner.activate(self.op,modules=self.modules,paths=self.paths)
        self.coordinator.stop_updater.assert_not_called()

    def test_activate_current_delegates_only_selected_operation(self):
        with mock.patch.object(runner,'pending_activation',return_value=self.op) as select, \
             mock.patch.object(runner,'activate') as activate:
            runner.activate_current(modules=self.modules,paths=self.paths)
        select.assert_called_once()
        activate.assert_called_once_with(self.op,modules=self.modules,paths=self.paths)
        with mock.patch.object(runner,'pending_activation',return_value=None), \
             mock.patch.object(runner,'activate') as activate:
            runner.activate_current(modules=self.modules,paths=self.paths)
        activate.assert_not_called()


if __name__=='__main__':unittest.main()
