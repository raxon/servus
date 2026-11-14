import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

import test_policy_reconciliation as fixture

ROOT = Path(__file__).resolve().parents[2]
def load(name, file):
    spec=importlib.util.spec_from_file_location(name,ROOT/'apps/updater'/file)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
retire=load('retire','retire-update-fence.py')
fence=load('fence','reconcile-policy-fence.py')
journal=load('journal','reconcile-policy-journal.py')
IMAGE='ghcr.io/raxon/servus@sha256:'+'a'*64
INACTIVE='LoadState=loaded\nActiveState=inactive\nControlGroup=\n'


@unittest.skipUnless(os.geteuid()==0 and Path('/proc/self/fd').exists(),'Requires Linux root')
class RetireFenceTest(unittest.TestCase):
    def setUp(self):
        self.base=fixture.AbandonedUpdateTest();self.base.setUp();self.db=self.base.db
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        for name in ('state','install','gate'):(self.root/name).mkdir(mode=0o700)
        (self.root/'state'/'maintenance').mkdir(mode=0o700)
        for path in (self.root/'state'/'service.lock',self.root/'install'/'install.lock'):
            path.touch(mode=0o600)
        (self.root/'gate'/'state').write_text('servus-lifecycle-v1 normal\n');(self.root/'gate'/'state').chmod(0o644)
        self.fds=[os.open(self.root/name,os.O_RDONLY|os.O_DIRECTORY) for name in ('state','install','gate')]
        self.policy=SimpleNamespace(image_reference=IMAGE)
        self.identities={role:{'id':role} for role in ('api','worker','agent')}
        self.records=[{'Id':role,'State':{'Running':True,'Health':{'Status':'healthy'}}} for role in self.identities]
        self.supervisor=SimpleNamespace(ROLES=('api','worker','agent'),
            _open_root_file=lambda fd,name,mode:os.open(name,os.O_RDONLY|os.O_NOFOLLOW,dir_fd=fd),
            inspect_servus=lambda _:self.identities,_docker=lambda *args:json.dumps(self.records).encode(),
            _pairs=lambda pairs:dict(pairs))
        self.daemon=SimpleNamespace(resolve_active_policy=lambda *_:('/policy','/accepted',self.policy))
        self.execute=lambda args:INACTIVE if args[1]=='show' else ''

    def tearDown(self):
        for fd in self.fds:os.close(fd)
        self.temp.cleanup();self.base.tearDown()

    def run_retire(self):
        with mock.patch.object(fence,'assert_no_probe_resources'):
            retire.archive_restored(self.db,fixture.OP,*self.fds,'/journal','/env',IMAGE,
                                    fence,journal,self.supervisor,self.daemon,execute=self.execute)

    def test_archives_only_after_healthy_generation_checks(self):
        self.run_retire()
        archived=self.root/'state'/('retired-update-'+fixture.OP)/'journal.sqlite'
        with sqlite3.connect(archived) as backup:
            self.assertEqual(backup.execute('SELECT phase FROM update_transactions').fetchone(),('recovery_required',))
        self.assertEqual(self.db.execute('SELECT operation_id FROM abandoned_updates').fetchone(),(fixture.OP,))
        self.assertEqual(self.db.execute("SELECT operation_id FROM policy_approvals WHERE state='active'").fetchone(),('old',))

    def test_unhealthy_or_wrong_generation_is_not_retired(self):
        self.records[0]['State']['Health']['Status']='unhealthy'
        with self.assertRaises(retire.RetirementError):self.run_retire()
        self.assertFalse((self.root/'state'/('retired-update-'+fixture.OP)).exists())
        self.records[0]['State']['Health']['Status']='healthy';self.policy.image_reference='ghcr.io/raxon/servus@sha256:'+'b'*64
        with self.assertRaises(retire.RetirementError):self.run_retire()
        self.assertEqual(self.db.execute('SELECT phase FROM update_transactions').fetchone(),('recovery_required',))

    def test_closed_gate_or_maintenance_marker_blocks_retirement(self):
        gate=self.root/'gate'/'state';gate.write_text('servus-lifecycle-v1 maintenance\n')
        with self.assertRaises(retire.RetirementError):self.run_retire()
        gate.write_text('servus-lifecycle-v1 normal\n')
        (self.root/'state'/'maintenance'/'maintenance.json').write_text('{}')
        with self.assertRaises(fence.FenceError):self.run_retire()
        self.assertFalse((self.root/'state'/('retired-update-'+fixture.OP)).exists())
        self.assertEqual(self.db.execute('SELECT phase FROM update_transactions').fetchone(),('recovery_required',))

    def test_failed_preflight_does_not_archive_or_mutate(self):
        def fail():raise RuntimeError('Incorrect updater')
        with mock.patch.object(fence,'assert_no_probe_resources'):
            with self.assertRaises(RuntimeError):
                retire.archive_restored(self.db,fixture.OP,*self.fds,'/journal','/env',IMAGE,
                                        fence,journal,self.supervisor,self.daemon,execute=self.execute,preflight=fail)
        self.assertFalse((self.root/'state'/('retired-update-'+fixture.OP)).exists())
        self.assertEqual(self.db.execute('SELECT phase FROM update_transactions').fetchone(),('recovery_required',))


if __name__=='__main__':unittest.main()
