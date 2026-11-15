import fcntl
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import unittest
from unittest import mock

import test_host_switch as fixtures

ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('host_unit_mask',ROOT/'apps/updater/host-unit-mask.py')
mask=importlib.util.module_from_spec(spec);spec.loader.exec_module(mask)


@unittest.skipUnless(sys.platform=='linux' and os.geteuid()==0 and sys.flags.isolated,'Requires isolated Linux root')
class HostUnitMaskTest(unittest.TestCase):
    def setUp(self):
        self.base=fixtures.HostSwitchTest();self.base.setUp()
        self.units=self.base.root/'units';self.units.mkdir(mode=0o755);self.fd=os.open(self.units,os.O_RDONLY|os.O_DIRECTORY)
        self.originals={name:('unit:'+name).encode() for name in mask.UNITS}
        self.states={name:('inactive' if name == 'servus-updater-bootstrap.service' else 'active') for name in mask.UNITS}
        for name,data in self.originals.items():
            path=self.units/name;path.write_bytes(data);path.chmod(0o644)

    def tearDown(self):os.close(self.fd);self.base.tearDown()

    def args(self):
        return dict(state=self.base.s,install=self.base.i,units=self.fd,service_lock=self.base.sl,
                    install_lock=self.base.il,supervisor=fixtures.supervisor,coordinator=fixtures.coordinator)

    def apply(self):mask.mask_units(self.base.db,self.base.op,self.base.digest,self.originals,self.states,**self.args())
    def restore(self):mask.restore_units(self.base.db,self.base.op,self.base.digest,self.originals,self.states,**self.args())
    def phase(self):return self.base.db.execute('select phase from host_unit_masks').fetchone()[0]
    def assert_originals(self):
        for name,data in self.originals.items():
            path=self.units/name;self.assertFalse(path.is_symlink());self.assertEqual(path.read_bytes(),data);self.assertEqual(path.stat().st_mode & 0o777,0o644)

    def test_masks_and_restores_exact_unit_files(self):
        self.apply();self.assertEqual(self.phase(),'masked')
        for name in mask.UNITS:self.assertEqual(os.readlink(self.units/name),'/dev/null')
        self.restore();self.assertEqual(self.phase(),'restored');self.assert_originals()

    def test_recovery_loads_verified_originals_from_journal(self):
        self.apply()
        self.assertEqual(mask.load_verified_backup(self.base.db,self.base.op,self.base.digest,self.base.s),(self.originals,self.states))
        self.assertEqual(mask.restore_from_journal(self.base.db,self.base.op,self.base.digest,**self.args()),self.states)
        self.assertEqual(self.phase(),'restored');self.assert_originals()
        self.assertEqual(mask.load_verified_backup(self.base.db,self.base.op,self.base.digest,self.base.s),(self.originals,self.states))

    def test_journal_recovery_rejects_forged_metadata_and_files(self):
        self.apply();backup=self.base.state/('unit-backup-'+self.base.op)
        metadata=backup/'complete.json';original=metadata.read_bytes();metadata.write_bytes(original+b' ')
        with self.assertRaises(mask.UnitMaskError):mask.restore_from_journal(self.base.db,self.base.op,self.base.digest,**self.args())
        metadata.write_bytes(original);unit=backup/mask.UNITS[0];unit.write_bytes(b'forged')
        with self.assertRaises(mask.UnitMaskError):mask.restore_from_journal(self.base.db,self.base.op,self.base.digest,**self.args())
        self.assertEqual(self.phase(),'masked')
        for name in mask.UNITS:self.assertEqual(os.readlink(self.units/name),'/dev/null')

    def test_rejects_invalid_or_active_bootstrap_before_masking(self):
        for states in ({**self.states, 'servus-updater-bootstrap.service':'active'},
                       {**self.states, 'servus-updater.service':'activating'},
                       {name:'active' for name in mask.UNITS[:-1]}):
            with self.subTest(states=states), self.assertRaises(mask.UnitMaskError):
                mask.mask_units(self.base.db,self.base.op,self.base.digest,self.originals,states,**self.args())
            self.assert_originals()

    def test_changed_unit_rejected_before_journal_or_mask(self):
        (self.units/mask.UNITS[0]).write_bytes(b'changed')
        with self.assertRaises(mask.UnitMaskError):self.apply()
        self.assertIsNone(self.base.db.execute("select name from sqlite_master where name='host_unit_masks'").fetchone())
        self.assertFalse((self.units/mask.UNITS[0]).is_symlink())

    def test_partial_masking_restores_only_verified_originals(self):
        original=mask._replace_with_mask;calls=0
        def interrupted(*args):
            nonlocal calls
            original(*args);calls+=1
            if calls==2:raise OSError('fixture')
        with mock.patch.object(mask,'_replace_with_mask',side_effect=interrupted),self.assertRaises(OSError):self.apply()
        self.assertEqual(self.phase(),'masking');self.assertEqual(sum((self.units/name).is_symlink() for name in mask.UNITS),2)
        self.restore();self.assertEqual(self.phase(),'restored');self.assert_originals()

    def test_incomplete_backup_intent_can_be_retired_if_units_are_intact(self):
        with mock.patch.object(mask,'_write',side_effect=OSError('fixture')),self.assertRaises(OSError):self.apply()
        self.assertEqual(self.phase(),'intent');self.assert_originals()
        path=self.base.state/('unit-backup-'+self.base.op);self.assertTrue(path.is_dir())
        mask.reconcile_unmasked_intent(self.base.db,self.base.op,self.base.digest,self.originals,self.states,**self.args())
        self.assertEqual(self.phase(),'restored');self.assertTrue(path.is_dir());self.assert_originals()

    def test_incomplete_backup_intent_cannot_be_retired_after_unit_change(self):
        with mock.patch.object(mask,'_write',side_effect=OSError('fixture')),self.assertRaises(OSError):self.apply()
        (self.units/mask.UNITS[0]).unlink();(self.units/mask.UNITS[0]).symlink_to('/dev/null')
        with self.assertRaises(OSError):
            mask.reconcile_unmasked_intent(self.base.db,self.base.op,self.base.digest,self.originals,self.states,**self.args())
        self.assertEqual(self.phase(),'intent')

    def test_partial_restore_can_resume(self):
        self.apply();original=mask._replace_with_original;calls=0
        def interrupted(*args):
            nonlocal calls
            original(*args);calls+=1
            if calls==2:raise OSError('fixture')
        with mock.patch.object(mask,'_replace_with_original',side_effect=interrupted),self.assertRaises(OSError):self.restore()
        self.assertEqual(self.phase(),'restoring');self.restore();self.assertEqual(self.phase(),'restored');self.assert_originals()

    def test_rejects_modified_backup_or_unknown_symlink(self):
        self.apply();backup=self.base.state/('unit-backup-'+self.base.op)/mask.UNITS[0];backup.write_bytes(b'forged')
        with self.assertRaises(mask.UnitMaskError):self.restore()
        self.assertEqual(self.phase(),'masked')
        backup.write_bytes(self.originals[mask.UNITS[0]]);(self.units/mask.UNITS[0]).unlink();(self.units/mask.UNITS[0]).symlink_to('/tmp/other')
        with self.assertRaises(OSError):self.restore()
        self.assertEqual(self.phase(),'masked')

    def test_process_loss_during_mask_is_recoverable(self):
        for fd in (self.base.sl,self.base.il):fcntl.flock(fd,fcntl.LOCK_UN)
        script='''import fcntl,importlib.util,os,sqlite3,sys
root=sys.argv[1];base=sys.argv[2];sys.path.insert(0,base);import supervisor
def load(name):
 s=importlib.util.spec_from_file_location(name.replace("-","_"),base+"/"+name);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
mask=load("host-unit-mask.py");coordinator=load("host-coordinator.py");state=os.open(root+"/state",os.O_RDONLY|os.O_DIRECTORY);install=os.open(root+"/install",os.O_RDONLY|os.O_DIRECTORY);units=os.open(root+"/units",os.O_RDONLY|os.O_DIRECTORY)
sl=os.open(root+"/state/service.lock",os.O_RDONLY);il=os.open(root+"/install/install.lock",os.O_RDONLY)
for fd in (sl,il):fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
db=sqlite3.connect(root+"/state/journal.sqlite",isolation_level=None);op="12345678-1234-4234-8234-123456789abc";digest="sha256:"+"a"*64
originals={name:("unit:"+name).encode() for name in mask.UNITS};original=mask._replace_with_mask;count=0
def crash(*args):
 global count
 original(*args);count+=1
 if count==2:os._exit(73)
mask._replace_with_mask=crash
states={name:("inactive" if name=="servus-updater-bootstrap.service" else "active") for name in mask.UNITS}
mask.mask_units(db,op,digest,originals,states,state=state,install=install,units=units,service_lock=sl,install_lock=il,supervisor=supervisor,coordinator=coordinator);os._exit(99)
'''
        try:
            result=subprocess.run([sys.executable,'-I','-c',script,str(self.base.root),str(ROOT/'apps/updater')],check=False)
            self.assertEqual(result.returncode,73)
        finally:
            for fd in (self.base.sl,self.base.il):fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        self.assertEqual(self.phase(),'masking');self.restore();self.assertEqual(self.phase(),'restored');self.assert_originals()


if __name__=='__main__':unittest.main()
