import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'apps/updater'))
import supervisor
import test_host_bundle as fixtures

def load(name):
    spec=importlib.util.spec_from_file_location(name.replace('-','_'),ROOT/'apps/updater'/(name+'.py'))
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module

adoption=load('host-adoption');bundle=load('host-bundle');installer=load('install-host');provisioner=load('provision-host')

@unittest.skipUnless(sys.platform=='linux' and os.geteuid()==0 and sys.flags.isolated,'Requires isolated Linux root')
class HostAdoptionTest(unittest.TestCase):
    def test_bootstrap_journal_check_preserves_sqlite_locks(self):
        path=Path(self.paths['state'])/'journal.sqlite'
        initial=sqlite3.connect(path);initial.execute('PRAGMA journal_mode=WAL')
        initial.execute('CREATE TABLE fixture(value)');initial.commit();initial.close()
        script=('import sqlite3,sys; db=sqlite3.connect(sys.argv[1]); '
                'db.execute("SELECT * FROM fixture").fetchall(); '
                'print("ready",flush=True); sys.stdin.readline(); db.close()')
        peer=subprocess.Popen([sys.executable,'-I','-c',script,str(path)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True)
        db=None;directory=None
        try:
            self.assertEqual(peer.stdout.readline().strip(),'ready')
            db=sqlite3.connect(path,isolation_level=None);db.execute('SELECT * FROM fixture').fetchall()
            directory=adoption._directory(self.paths['state'],0o700)
            adoption._check_journal(directory)
            peer.stdin.write('stop\n');peer.stdin.flush();peer.wait(timeout=10)
            db.execute('INSERT INTO fixture VALUES(1)')
            with sqlite3.connect('file:'+str(path)+'?mode=ro',uri=True) as reader:
                self.assertEqual(reader.execute('SELECT COUNT(*) FROM fixture').fetchone(),(1,))
        finally:
            if directory is not None:os.close(directory)
            if db is not None:db.close()
            if peer.poll() is None:peer.kill();peer.wait()
            peer.stdin.close();peer.stdout.close()

    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(dir='/root');root=Path(self.tmp.name)
        self.paths={key:str(root/key) for key in ('state','install','active','units','active_env')}
        for key in ('state','install'):Path(self.paths[key]).mkdir(mode=0o700)
        for key in ('active','units'):Path(self.paths[key]).mkdir(mode=0o755)
        (Path(self.paths['install'])/'install.lock').touch(mode=0o600)
        database=Path(self.paths['state'])/'journal.sqlite';sqlite3.connect(database).close();database.chmod(0o600)
        self.old='12345678-1234-4234-8234-123456789abc';self.active='12345678-1234-4234-8234-123456789abd'
        self.events=[]
        def prepare(*_args,**kwargs):
            self.events.append('prepare')
            for name in ('host_lock','install_lock'):
                supervisor._assert_exclusive_flock(kwargs[name])
        def activate(*_args,**_kwargs):
            for path in (Path(self.paths['state'])/'host.lock',Path(self.paths['install'])/'install.lock'):
                fd=os.open(path,os.O_RDONLY)
                try:fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
                finally:os.close(fd)
            self.events.append('activate')
        self.coordinator=SimpleNamespace(adopt_verified_units=mock.Mock(side_effect=prepare))
        self.runner=SimpleNamespace(activate=mock.Mock(side_effect=activate))
        self.modules=dict(supervisor=supervisor,bundle=bundle,install_host=installer,provisioner=provisioner,
            coordinator=self.coordinator,runner=self.runner,daemon=object(),extractor=object(),backup=object(),unit_mask=object())
        self.service=mock.Mock(side_effect=lambda *args:self.events.append(args))

    def tearDown(self):self.tmp.cleanup()
    def run_adoption(self):return adoption.adopt(self.old,self.active,modules=self.modules,paths=self.paths,service=self.service)

    def test_prepares_recovery_before_activation_and_enables_timer_afterward(self):
        self.run_adoption()
        self.assertEqual(self.events,['prepare',('daemon-reload',),('enable','servus-host-recovery.service','servus-host-recovery-finish.service'),
                                      'activate',('enable','--now','servus-host-update.timer')])
        self.assertTrue((Path(self.paths['state'])/'host-generations').is_dir())

    def test_failed_preparation_never_changes_services(self):
        self.coordinator.adopt_verified_units.side_effect=RuntimeError('unsafe')
        with self.assertRaises(RuntimeError):self.run_adoption()
        self.service.assert_not_called();self.runner.activate.assert_not_called()

    def test_failed_activation_never_enables_timer(self):
        self.runner.activate.side_effect=RuntimeError('recovery required')
        with self.assertRaises(RuntimeError):self.run_adoption()
        self.assertNotIn(('enable','--now','servus-host-update.timer'),self.events)

    def test_bootstrap_verifies_active_stage_before_loading_dependencies(self):
        fixture=fixtures.CompletedUpdateTest();fixture.setUp()
        state=Path(self.paths['state']);stage=state/'staging'/('servus-install-'+'c'*32)
        modules=stage/'apps'/'updater';modules.mkdir(parents=True,mode=0o755)
        (state/'staging').chmod(0o700);stage.chmod(0o700);(stage/'apps').chmod(0o755)
        entries=[]
        for name in set(adoption.MODULE_FILES.values())|{'host-adoption.py'}:
            data=(ROOT/'apps/updater'/name).read_bytes();path=modules/name;path.write_bytes(data);path.chmod(0o644)
            entries.append({'path':'apps/updater/'+name,'type':'file','mode':0o644,'size':len(data),'sha256':hashlib.sha256(data).hexdigest()})
        (stage/'manifest.json').write_text(json.dumps({'schema':1,'minimumUpdaterAbi':1,'files':entries}))
        (stage/'manifest.json').chmod(0o644)
        database=state/'journal.sqlite';database.unlink()
        fixture.db.execute('UPDATE preparations SET staging_path=?',(str(stage),));fixture.db.commit()
        with sqlite3.connect(database) as target:fixture.db.backup(target)
        database.chmod(0o600);fixture.tearDown()
        args=dict(state_dir=str(state),active_env='/root/env',source_file=str(modules/'host-adoption.py'))
        with mock.patch.dict(sys.modules):
            loaded=adoption.load_verified_modules(fixture.op,**args)
            self.assertTrue(callable(loaded['runner'].activate))
        (modules/'host-runner.py').write_bytes(b'changed')
        with self.assertRaises(adoption.HostAdoptionError):adoption.load_verified_modules(fixture.op,**args)
        with self.assertRaises(adoption.HostAdoptionError):
            adoption.load_verified_modules(fixture.op,**{**args,'source_file':'/root/other.py'})

if __name__=='__main__':unittest.main()
