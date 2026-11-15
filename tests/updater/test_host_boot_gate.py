import importlib.util
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('host_boot_gate',ROOT/'apps/updater/host-boot-gate.py')
gate=importlib.util.module_from_spec(spec);spec.loader.exec_module(gate)


@unittest.skipUnless(sys.platform=='linux' and os.geteuid()==0 and sys.flags.isolated,'Requires isolated Linux root')
class HostBootGateTest(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(dir='/root');self.state=Path(self.tmp.name)/'state';self.state.mkdir(mode=0o700)
        self.path=self.state/'journal.sqlite';self.db=sqlite3.connect(self.path)
        self.db.execute('CREATE TABLE operations(id TEXT)');self.db.execute('PRAGMA user_version=8');self.db.commit();self.path.chmod(0o600)
    def tearDown(self):self.db.close();self.tmp.cleanup()
    def check(self):gate.assert_safe(str(self.state))

    def test_clean_journal_and_terminal_host_states_allow_startup(self):
        self.check()
        for table,column,value in (('host_stops','status','completed'),('host_preparations','status','abandoned'),
                                   ('host_switches','phase','rolled_back'),('host_unit_masks','phase','restored')):
            self.db.execute('CREATE TABLE '+table+'('+column+' TEXT)');self.db.execute('INSERT INTO '+table+' VALUES(?)',(value,))
        self.db.commit();self.check()

    def test_restart_phase_allows_services_only_after_other_work_is_terminal(self):
        self.db.execute('CREATE TABLE host_stops(status TEXT)');self.db.execute("INSERT INTO host_stops VALUES('restarting')")
        self.db.execute('CREATE TABLE host_preparations(status TEXT)');self.db.execute("INSERT INTO host_preparations VALUES('recovery_required')")
        self.db.commit()
        with self.assertRaises(gate.BootGateError):self.check()
        self.db.execute("UPDATE host_preparations SET status='abandoned'");self.db.commit();self.check()

    def test_pending_unknown_or_null_state_blocks_startup(self):
        for table,column,value in (('host_stops','status','stopped'),('host_preparations','status','prepared'),
                                   ('host_switches','phase','exchanged'),('host_unit_masks','phase','restoring')):
            with self.subTest(table=table):
                self.db.execute('CREATE TABLE '+table+'('+column+' TEXT)')
                for current in (value,'unexpected',None):
                    self.db.execute('DELETE FROM '+table);self.db.execute('INSERT INTO '+table+' VALUES(?)',(current,));self.db.commit()
                    with self.assertRaises(gate.BootGateError):self.check()
                self.db.execute('DROP TABLE '+table);self.db.commit()

    def test_rejects_unexpected_schema_version_and_unsafe_journal(self):
        self.db.execute('CREATE TABLE host_stops(wrong TEXT)');self.db.commit()
        with self.assertRaises(gate.BootGateError):self.check()
        self.db.execute('DROP TABLE host_stops');self.db.execute('PRAGMA user_version=7');self.db.commit()
        with self.assertRaises(gate.BootGateError):self.check()
        self.db.execute('PRAGMA user_version=8');self.db.commit();self.path.chmod(0o644)
        with self.assertRaises(gate.BootGateError):self.check()


if __name__=='__main__':unittest.main()
