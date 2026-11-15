import importlib.util
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

ROOT=Path(__file__).resolve().parents[2];sys.path.insert(0,str(ROOT/'apps/updater'))
import supervisor

def load(name):
    spec=importlib.util.spec_from_file_location(name.replace('-','_'),ROOT/'apps/updater'/name)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
recovery=load('host-recovery.py');bundle=load('host-bundle.py')


@unittest.skipUnless(sys.platform=='linux' and os.geteuid()==0 and sys.flags.isolated,'Requires isolated Linux root')
class HostRecoveryTest(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(dir='/root');root=Path(self.tmp.name)
        self.paths={key:str(root/key) for key in ('state','install','units','parent','candidates','active','socket')}
        for key in ('state','install','candidates'):Path(self.paths[key]).mkdir(mode=0o700)
        for key in ('units','parent','active'):Path(self.paths[key]).mkdir(mode=0o755)
        for path in (Path(self.paths['state'])/'host.lock',Path(self.paths['install'])/'install.lock',Path(self.paths['state'])/'service.lock'):path.touch(mode=0o600)
        self.dbpath=Path(self.paths['state'])/'journal.sqlite';self.op='12345678-1234-4234-8234-123456789abc';self.digest='sha256:'+'a'*64
        with sqlite3.connect(self.dbpath) as db:
            db.execute('CREATE TABLE host_stops(operation_id TEXT PRIMARY KEY,image_digest TEXT,status TEXT)')
            db.execute("INSERT INTO host_stops VALUES(?,?,'stopped')",(self.op,self.digest))
        self.dbpath.chmod(0o600)
        self.mask=SimpleNamespace(UNITS=('a','b'),load_verified_backup=mock.Mock(return_value=({'a':b'a','b':b'b'},{})),
                                  remask_for_recovery=mock.Mock(),stop_masked_units=mock.Mock(),restore_from_journal=mock.Mock())
        self.coordinator=SimpleNamespace(recover_exchange=mock.Mock(),recover_stopped_updater=mock.Mock())
        self.switch=SimpleNamespace(assert_supervisor_normal_ready=mock.Mock())
        self.modules=dict(supervisor=supervisor,coordinator=self.coordinator,unit_mask=self.mask,switch=self.switch,bundle=bundle,
            exchange=object(),install_host=SimpleNamespace(read_file=mock.Mock(return_value=b'unit')),
            fence=SimpleNamespace(assert_fenced=mock.Mock()),quiescence=object())

    def tearDown(self):self.tmp.cleanup()

    def test_prepare_before_exchange_and_finish_use_root_locks(self):
        recovery.recover(self.op,self.digest,modules=self.modules,paths=self.paths,prepare_only=True)
        self.coordinator.recover_exchange.assert_not_called()
        self.assertTrue(self.coordinator.recover_stopped_updater.call_args.kwargs['prepare_only'])
        with sqlite3.connect(self.dbpath) as db:db.execute("UPDATE host_stops SET status='restarting'")
        recovery.recover(self.op,self.digest,modules=self.modules,paths=self.paths,prepare_only=False)
        self.assertFalse(self.coordinator.recover_stopped_updater.call_args.kwargs['prepare_only'])

    def test_exchange_recovery_requires_matching_identity(self):
        with sqlite3.connect(self.dbpath) as db:
            db.execute('CREATE TABLE host_switches(operation_id TEXT,image_digest TEXT,phase TEXT)')
            db.execute("INSERT INTO host_switches VALUES(?,?,'exchanged')",(self.op,self.digest))
        recovery.recover(self.op,self.digest,modules=self.modules,paths=self.paths,prepare_only=True)
        self.coordinator.recover_exchange.assert_called_once()
        with sqlite3.connect(self.dbpath) as db:db.execute("UPDATE host_switches SET image_digest='different'")
        with self.assertRaises(recovery.HostRecoveryError):recovery.recover(self.op,self.digest,modules=self.modules,paths=self.paths,prepare_only=True)

    def test_unknown_or_completed_stop_never_mutates(self):
        with sqlite3.connect(self.dbpath) as db:db.execute("UPDATE host_stops SET status='completed'")
        with self.assertRaises(recovery.HostRecoveryError):recovery.recover(self.op,self.digest,modules=self.modules,paths=self.paths,prepare_only=True)
        self.coordinator.recover_exchange.assert_not_called();self.coordinator.recover_stopped_updater.assert_not_called()


if __name__=='__main__':unittest.main()
