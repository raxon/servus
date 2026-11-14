import fcntl
import importlib.util
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
import uuid

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'apps/updater'))
import supervisor

def load(name,filename):
    spec=importlib.util.spec_from_file_location(name,ROOT/'apps/updater'/filename)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module

transition=load('legacy_transition','legacy-transition.py')
updater=load('legacy_transition_updater','servus-updater.py')

@unittest.skipUnless(sys.platform=='linux' and os.geteuid()==0 and sys.flags.isolated,'Requires isolated Linux root')
class LegacyTransitionTest(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(dir='/root');self.root=Path(self.temp.name)
        self.install=self.root/'install';self.install.mkdir(mode=0o700);(self.install/'install.lock').touch(mode=0o600)
        self.state=self.root/'state';self.state.mkdir(mode=0o700)
        self.docker_config=self.root/'docker';self.docker_config.mkdir(mode=0o700)
        self.parent=str(self.root/'restores');self.operation=str(uuid.uuid4());self.active='/active';self.source='/legacy'
        self.old={role:letter*64 for role,letter in zip(('api','worker','agent'),'abc')}
        self.approved=SimpleNamespace(install_dir=str(self.install),data_dir=self.parent+'/restore-'+self.operation,control_dir='/control',updater_dir='/updater')
        self.binding=(str(uuid.uuid4()),str(uuid.uuid4()),'a'*64,'sha256:'+'b'*64,'sha256:'+'c'*64)
        self.journal=updater.Journal(self.state);self.events=[];self.failure=None
        def action(name,result=None):
            def run(*args,**kwargs):
                self.events.append(name)
                if self.failure==name:raise RuntimeError(name+' failed')
                return result
            return run
        self.adoption=SimpleNamespace(_binding=lambda *_:('/policy','/accepted',self.approved,self.binding),record=action('adopt'))
        self.legacy=SimpleNamespace(stop=action('stop'),capture=action('capture','sha256:'+'d'*64),protect=action('protect'),remove=action('remove'))
        self.recovery=SimpleNamespace(capture=action('save'))
        self.restore=SimpleNamespace(stage=action('stage',self.approved.data_dir))
        self.initial=SimpleNamespace(launch=action('launch',{'api':'started'}))
        self.fence=SimpleNamespace(journal=self.journal,operation=self.operation,active_env=self.active,source=self.source,old_ids=self.old)
        self.lock=os.open(self.install/'install.lock',os.O_RDONLY);fcntl.flock(self.lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    def tearDown(self):os.close(self.lock);self.journal.close();self.temp.cleanup()
    def run_transition(self):
        return transition.transition(self.journal,self.operation,self.active,self.source,'image','image-id',self.old,'/old-env','/old-compose',
               '/recovery','/snapshot',self.parent,-1,str(self.docker_config),supervisor,object(),self.adoption,object(),object(),
               object(),object(),object(),self.restore,self.recovery,self.legacy,self.initial,object(),self.fence,
               install_lock=self.lock,check=lambda *_:None,updater_check=lambda *_:None)
    def test_runs_all_stages_in_order_and_keeps_marker_for_health_handoff(self):
        self.assertEqual(self.run_transition(),{'api':'started'})
        self.assertEqual(self.events,['stop','save','capture','stage','protect','remove','adopt','launch'])
        self.assertEqual(self.journal.db.execute('SELECT phase FROM legacy_transitions').fetchone(),('started',))
        self.assertEqual((self.install/transition.MARKER).read_text(),'servus-legacy-migration-v1 '+self.operation+'\n')
        with self.assertRaises(transition.TransitionError):self.run_transition()
    def test_each_interrupted_stage_requires_recovery_and_stops_sequence(self):
        for index,name in enumerate(('stop','save','capture','stage','protect','remove','adopt','launch')):
            with self.subTest(name=name):
                if index:self.tearDown();self.setUp()
                self.failure=name
                with self.assertRaisesRegex(RuntimeError,name+' failed'):self.run_transition()
                self.assertEqual(self.events[-1],name)
                self.assertEqual(self.journal.db.execute('SELECT phase FROM legacy_transitions').fetchone(),('recovery_required',))
                self.assertTrue((self.install/transition.MARKER).exists())
    def test_invalid_lock_and_existing_marker_prevent_mutations(self):
        other=self.root/'other';other.touch(mode=0o600);fd=os.open(other,os.O_RDONLY);fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        original=self.lock;self.lock=fd
        try:
            with self.assertRaises(transition.TransitionError):self.run_transition()
            self.assertEqual(self.events,[])
        finally:self.lock=original;os.close(fd)
        (self.install/transition.MARKER).write_text('previous')
        with self.assertRaises(FileExistsError):self.run_transition()
        self.assertEqual(self.events,[])

if __name__=='__main__':unittest.main()
