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

import test_host_bundle as fixtures

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'apps/updater'))
import supervisor
spec=importlib.util.spec_from_file_location('host_coordinator',ROOT/'apps/updater/host-coordinator.py')
coordinator=importlib.util.module_from_spec(spec);spec.loader.exec_module(coordinator)
bundle=fixtures.bundle


@unittest.skipUnless(sys.platform=='linux' and os.geteuid()==0 and sys.flags.isolated,'Requires isolated Linux root')
class HostCoordinatorTest(unittest.TestCase):
    def setUp(self):
        self.fixture=fixtures.CompletedUpdateTest();self.fixture.setUp();self.fixture.db.commit()
        self.temp=tempfile.TemporaryDirectory(dir='/root');self.root=Path(self.temp.name)
        self.state,self.install,self.gate,self.candidates,self.host=(self.root/name for name in ('state','install','gate','candidates','host'))
        for path in (self.state,self.install,self.candidates):path.mkdir(mode=0o700)
        for path in (self.gate,self.host):path.mkdir(mode=0o755)
        (self.state/'maintenance').mkdir(mode=0o700);(self.state/'staging').mkdir(mode=0o700)
        self.stage=self.state/'staging'/('servus-install-'+'c'*32);self.stage.mkdir(mode=0o700)
        modules_dir=self.stage/'apps'/'updater';modules_dir.mkdir(parents=True,mode=0o755);(self.stage/'apps').chmod(0o755)
        self.cli=b'trusted cli';self.pin=('a'*64,hashlib.sha256(self.cli).hexdigest(),len(self.cli))
        source=('PINNED = '+repr({'amd64':self.pin,'arm64':self.pin})+'\ndef install(*, pinned=PINNED): pass\n').encode()
        contents={'install-gh.py':source,'core.py':b'core'};self.manifest={}
        for name,data in contents.items():
            path=modules_dir/name;path.write_bytes(data);path.chmod(0o644)
            self.manifest['apps/updater/'+name]=(0o644,len(data),hashlib.sha256(data).hexdigest())
        (self.stage/'manifest.json').write_bytes(b'fixture');(self.stage/'manifest.json').chmod(0o644)
        (self.host/'bin').mkdir(mode=0o755);(self.host/'bin'/'gh').write_bytes(self.cli);(self.host/'bin'/'gh').chmod(0o755)
        (self.gate/'state').write_bytes(b'servus-lifecycle-v1 normal\n');(self.gate/'state').chmod(0o644)
        for path in (self.state/'service.lock',self.install/'install.lock'):path.touch(mode=0o600)
        self.service_lock=os.open(self.state/'service.lock',os.O_RDONLY);self.install_lock=os.open(self.install/'install.lock',os.O_RDONLY)
        for fd in (self.service_lock,self.install_lock):fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        target=sqlite3.connect(self.state/'journal.sqlite');self.fixture.db.backup(target);target.close();(self.state/'journal.sqlite').chmod(0o600)
        self.db=sqlite3.connect(self.state/'journal.sqlite',isolation_level=None)
        self.db.execute('UPDATE preparations SET staging_path=?',(str(self.stage),))
        self.db.execute('CREATE TABLE extraction_probes(status TEXT)');self.db.execute('CREATE TABLE policy_probes(state TEXT)')
        self.policy=SimpleNamespace(image_reference=self.fixture.image)
        self.daemon=SimpleNamespace(resolve_active_policy=mock.Mock(return_value=('/root/policy','/root/accepted',self.policy)))
        self.extractor=SimpleNamespace(MANIFEST_LIMIT=262144,_manifest_files=mock.Mock(return_value=self.manifest))
        self.backup=SimpleNamespace(_read=lambda fd,limit:os.read(fd,limit+1))
        self.install_host=SimpleNamespace(MODULES=('install-gh.py','core.py'))
        self.install_gh=SimpleNamespace(PINNED={'amd64':self.pin,'arm64':self.pin})

    def tearDown(self):
        self.db.close();os.close(self.service_lock);os.close(self.install_lock);self.temp.cleanup();self.fixture.tearDown()

    def prepare(self):
        return coordinator.prepare_completed(self.db,self.fixture.op,state_dir=str(self.state),install_dir=str(self.install),
            gate_dir=str(self.gate),candidate_parent=str(self.candidates),host_dir=str(self.host),active_env='/root/env',
            service_lock=self.service_lock,install_lock=self.install_lock,supervisor=supervisor,daemon=self.daemon,
            extractor=self.extractor,backup=self.backup,bundle=bundle,install_host=self.install_host,install_gh=self.install_gh)

    def test_prepares_verified_generation_and_records_completion(self):
        with mock.patch.object(supervisor,'inspect_servus',return_value={'api':'same'}):name=self.prepare()
        self.assertEqual(name,'runtime-'+self.fixture.op)
        self.assertEqual(self.db.execute('select status from host_preparations').fetchone(),('prepared',))
        self.assertEqual((self.candidates/name/'bin'/'gh').read_bytes(),self.cli)

    def test_rejects_pending_update_without_creating_candidate(self):
        self.db.execute("INSERT INTO apply_requests VALUES('pending','requested')")
        with mock.patch.object(supervisor,'inspect_servus',return_value={'api':'same'}),self.assertRaises(coordinator.HostPreparationError):self.prepare()
        self.assertFalse(list(self.candidates.iterdir()))

    def test_failed_stage_records_recovery_before_returning(self):
        with mock.patch.object(supervisor,'inspect_servus',return_value={'api':'same'}), \
             mock.patch.object(bundle,'stage_runtime_tree',side_effect=OSError('fixture')),self.assertRaises(OSError):self.prepare()
        self.assertEqual(self.db.execute('select status from host_preparations').fetchone(),('recovery_required',))

    def test_changed_generation_after_stage_requires_recovery(self):
        with mock.patch.object(supervisor,'inspect_servus',side_effect=[{'api':'old'},{'api':'old'},{'api':'new'}]), \
             self.assertRaises(coordinator.HostPreparationError):self.prepare()
        self.assertEqual(self.db.execute('select status from host_preparations').fetchone(),('recovery_required',))

    def test_rejects_wrong_held_lock_before_staging(self):
        other=self.root/'other.lock';other.touch(mode=0o600);fd=os.open(other,os.O_RDONLY);fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        try:
            with mock.patch.object(supervisor,'inspect_servus',return_value={'api':'same'}):
                original=self.service_lock;self.service_lock=fd
                try:
                    with self.assertRaises(coordinator.HostPreparationError):self.prepare()
                finally:self.service_lock=original
        finally:os.close(fd)
        self.assertFalse(list(self.candidates.iterdir()))


if __name__=='__main__':unittest.main()
