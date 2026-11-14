import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
import uuid
from unittest import mock

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'apps/updater'))
import supervisor

def load(name,filename):
    spec=importlib.util.spec_from_file_location(name,ROOT/'apps/updater'/filename)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module

transition=load('legacy_transition','legacy-transition.py')
updater=load('legacy_transition_updater','servus-updater.py')
policy=load('legacy_transition_policy','runtime-policy.py')
backup=load('legacy_transition_backup','backup.py')

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
        self.adoption=SimpleNamespace(_binding=lambda *_:('/policy','/accepted',self.approved,self.binding),
                                      prepared_binding=lambda *_:('/policy','/accepted',self.approved,self.binding),record=action('adopt'))
        self.legacy=SimpleNamespace(stop=action('stop'),capture=action('capture','sha256:'+'d'*64),protect=action('protect'),remove=action('remove'))
        self.recovery=SimpleNamespace(capture=action('save'))
        self.restore=SimpleNamespace(stage=action('stage',self.approved.data_dir))
        self.initial=SimpleNamespace(launch=action('launch',{'api':'started'}))
        self.quiet=SimpleNamespace(ensure_host_namespaces=lambda:None,ensure_no_data_mounts=lambda *_:None,
                                   ensure_no_mount_aliases=lambda *_:None,ensure_no_open_data=lambda *_:None,ensure_no_uid_writers=lambda *_:None)
        self.fence=SimpleNamespace(journal=self.journal,operation=self.operation,active_env=self.active,source=self.source,old_ids=self.old)
        self.lock=os.open(self.install/'install.lock',os.O_RDONLY);fcntl.flock(self.lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    def tearDown(self):
        if self.lock>=0:os.close(self.lock)
        self.journal.close();self.temp.cleanup()
    def run_transition(self):
        return transition.transition(self.journal,self.operation,self.active,self.source,'image','image-id',self.old,'/old-env','/old-compose',
               '/recovery','/snapshot',self.parent,-1,str(self.docker_config),supervisor,object(),self.adoption,object(),self.quiet,
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
    def test_mounted_target_blocks_restore_and_requires_recovery(self):
        def reject(*_):raise RuntimeError('target mounted')
        self.quiet.ensure_no_data_mounts=reject
        with self.assertRaisesRegex(RuntimeError,'target mounted'):self.run_transition()
        self.assertEqual(self.events,['stop','save','capture'])
        self.assertEqual(self.journal.db.execute('SELECT phase FROM legacy_transitions').fetchone(),('recovery_required',))
    def test_prepared_stop_resumes_after_policy_activation_without_stopping_twice(self):
        transition.prepare_stop(self.journal,self.operation,self.active,'/policies',self.source,'image','image-id',self.old,
            supervisor,object(),self.adoption,object(),self.quiet,object(),self.legacy,install_lock=self.lock)
        self.assertEqual(self.journal.db.execute('SELECT phase FROM legacy_transitions').fetchone(),('stopped',))
        self.journal.db.execute('CREATE TABLE legacy_stop_operations(operation_id TEXT,preparation_id TEXT,attempt_id TEXT,nonce TEXT,root_digest TEXT,config_digest TEXT,policy_path TEXT,accepted_env TEXT,active_env TEXT,source TEXT,old_image TEXT,old_image_id TEXT,old_ids TEXT,state TEXT)')
        self.journal.db.execute('INSERT INTO legacy_stop_operations VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',(self.operation,*self.binding,'/policy','/accepted',self.active,self.source,'image','image-id',__import__('json').dumps(self.old,sort_keys=True,separators=(',',':')),'stopped'))
        self.assertEqual(self.run_transition(),{'api':'started'})
        self.assertEqual(self.events,['stop','save','capture','stage','protect','remove','adopt','launch'])
    def test_prepared_stop_failure_leaves_durable_recovery_marker(self):
        self.failure='stop'
        with self.assertRaises(RuntimeError):
            transition.prepare_stop(self.journal,self.operation,self.active,'/policies',self.source,'image','image-id',self.old,
                supervisor,object(),self.adoption,object(),self.quiet,object(),self.legacy,install_lock=self.lock)
        self.assertEqual(self.journal.db.execute('SELECT phase FROM legacy_transitions').fetchone(),('recovery_required',))
        self.assertTrue((self.install/transition.MARKER).is_file())
    def rollback_fixture(self):
        _,marker,_,_=self.completion_fixture()
        db=self.journal.db
        db.execute("UPDATE legacy_transitions SET phase='recovery_required'")
        db.execute('DELETE FROM initial_generations')
        self.fence.source=db.execute('SELECT source FROM legacy_protections').fetchone()[0]
        self.fence.assert_locked=mock.Mock()
        target=db.execute('SELECT target_dev,target_ino FROM legacy_protections').fetchone()
        self.restore.verify_staged=mock.Mock(return_value=target)
        self.recovery.verify=mock.Mock(return_value=('/recovery','env-digest','compose-digest'))
        def run():
            return transition.assess_rollback(self.journal,self.operation,self.active,self.parent,-1,supervisor,object(),
                self.adoption,object(),self.quiet,object(),object(),object(),self.restore,self.recovery,self.fence,install_lock=self.lock)
        return run,marker
    def test_rollback_assessment_checks_evidence_without_mutation(self):
        run,marker=self.rollback_fixture()
        result=run()
        self.assertEqual(result[0],('/snapshot','sha256:'+'d'*64))
        self.assertEqual(self.fence.assert_locked.call_count,2)
        self.assertTrue(marker.is_file())
        self.assertEqual(self.journal.db.execute('SELECT phase FROM legacy_transitions').fetchone(),('recovery_required',))
    def test_rollback_assessment_refuses_any_new_generation(self):
        run,_=self.rollback_fixture()
        for phase in ('starting','started','recovery_required'):
            with self.subTest(phase=phase):
                self.journal.db.execute('INSERT INTO initial_generations VALUES(?,?)',(self.operation,phase))
                with self.assertRaisesRegex(transition.TransitionError,'may have written'):run()
                self.journal.db.execute('DELETE FROM initial_generations')
        self.fence.assert_locked.assert_not_called()
    def test_rollback_assessment_rejects_changed_data_or_marker(self):
        run,marker=self.rollback_fixture()
        self.restore.verify_staged.return_value=(1,2)
        with self.assertRaisesRegex(transition.TransitionError,'Staged data identity'):run()
        marker.write_text('wrong')
        with self.assertRaisesRegex(transition.TransitionError,'marker'):run()
    def completion_fixture(self):
        parent=Path(self.parent);parent.mkdir(mode=0o711)
        target=Path(self.approved.data_dir);target.mkdir(mode=0o700);os.chown(target,1000,1000)
        source=self.root/'original';source.mkdir(mode=0o700);old=os.stat(source);new=os.stat(target)
        saved=self.root/'recovery';saved.mkdir(mode=0o700)
        (saved/'legacy.env').write_bytes(b'fixture env');(saved/'compose.yaml').write_bytes(b'fixture compose')
        for name in ('legacy.env','compose.yaml'):(saved/name).chmod(0o600)
        env_digest='sha256:'+hashlib.sha256(b'fixture env').hexdigest();compose_digest='sha256:'+hashlib.sha256(b'fixture compose').hexdigest()
        digest='sha256:'+'d'*64;marker=self.install/transition.MARKER
        marker.write_text('servus-legacy-migration-v1 '+self.operation+'\n');marker.chmod(0o600)
        db=self.journal.db
        db.executescript('''CREATE TABLE legacy_transitions(operation_id TEXT,phase TEXT);
        CREATE TABLE initial_generations(operation_id TEXT,phase TEXT);
        CREATE TABLE legacy_removals(operation_id TEXT,state TEXT);
        CREATE TABLE legacy_snapshots(operation_id TEXT,path TEXT,digest TEXT,state TEXT);
        CREATE TABLE legacy_protections(operation_id TEXT,source TEXT,source_dev INTEGER,source_ino INTEGER,snapshot_digest TEXT,target_dev INTEGER,target_ino INTEGER,state TEXT);
        CREATE TABLE initial_adoptions(operation_id TEXT,snapshot_path TEXT,snapshot_digest TEXT,data_parent TEXT,data_dev INTEGER,data_ino INTEGER,state TEXT);
        CREATE TABLE legacy_migration_fences(operation_id TEXT,source TEXT,source_dev INTEGER,source_ino INTEGER,old_ids TEXT,state TEXT);
        CREATE TABLE legacy_stop_operations(operation_id TEXT,source TEXT,source_dev INTEGER,source_ino INTEGER,old_ids TEXT,state TEXT);
        CREATE TABLE legacy_recovery(operation_id TEXT,path TEXT,env_digest TEXT,compose_digest TEXT,state TEXT);''')
        for table,value in (('legacy_transitions','started'),('initial_generations','started'),('legacy_removals','removed')):
            db.execute('INSERT INTO '+table+' VALUES(?,?)',(self.operation,value))
        db.execute("INSERT INTO preparations(operation_id,attempt_id,attempt_nonce,preparation_id,status) VALUES(?,?,?,?,?)",(self.operation,str(uuid.uuid4()),'a'*64,str(uuid.uuid4()),'completed'))
        db.execute("INSERT INTO legacy_snapshots VALUES(?,?,?,'verified')",(self.operation,'/snapshot',digest))
        db.execute("INSERT INTO legacy_protections VALUES(?,?,?,?,?,?,?,'protected')",(self.operation,str(source),old.st_dev,old.st_ino,digest,new.st_dev,new.st_ino))
        db.execute("INSERT INTO initial_adoptions VALUES(?,?,?,?,?,?,'consumed')",(self.operation,'/snapshot',digest,self.parent,new.st_dev,new.st_ino))
        ids=json.dumps(self.old,sort_keys=True,separators=(',',':'))
        db.execute("INSERT INTO legacy_migration_fences VALUES(?,?,?,?,?,'fenced')",(self.operation,str(source),old.st_dev,old.st_ino,ids))
        db.execute("INSERT INTO legacy_stop_operations VALUES(?,?,?,?,?,'stopped')",(self.operation,str(source),old.st_dev,old.st_ino,ids))
        db.execute("INSERT INTO legacy_recovery VALUES(?,?,?,?,'verified')",(self.operation,str(saved),env_digest,compose_digest))
        daemon=SimpleNamespace(resolve_active_policy=lambda *_:('/policy','/accepted',self.approved))
        initial=SimpleNamespace(check_supervisor=mock.Mock(),check_updater=mock.Mock())
        coordinator=SimpleNamespace(verify_snapshot=mock.Mock(),_pairs=dict)
        def service(*args,**kwargs):return (0,'active') if args[0]=='is-active' else (0,'')
        def run(service_call=service):
            with mock.patch.object(supervisor,'RuntimePolicy',SimpleNamespace),mock.patch.object(supervisor,'inspect_servus',return_value={role:{'id':letter*64} for role,letter in zip(supervisor.ROLES,'def')}):
                return transition.complete(self.journal,self.operation,self.active,-1,supervisor,daemon,policy,initial,backup,coordinator,service=service_call)
        return run,marker,saved,initial
    def test_completion_enables_services_and_removes_marker_after_verification(self):
        run,marker,_,initial=self.completion_fixture()
        os.close(self.lock);self.lock=-1
        run()
        self.assertFalse(marker.exists())
        self.assertEqual(self.journal.db.execute('SELECT phase FROM legacy_transitions').fetchone(),('completed',))
        self.assertEqual(initial.check_supervisor.call_count,2)
    def test_completion_failure_keeps_marker_and_durable_state(self):
        run,marker,_,_=self.completion_fixture()
        os.close(self.lock);self.lock=-1
        def service(*args,**kwargs):return (1,'') if args[0]=='enable' else (0,'active')
        with self.assertRaises(transition.TransitionError):run(service)
        self.assertTrue(marker.is_file())
        self.assertEqual(self.journal.db.execute('SELECT phase FROM legacy_transitions').fetchone(),('completing',))
    def test_completion_refuses_changed_recovery_before_enabling(self):
        run,marker,saved,_=self.completion_fixture();(saved/'legacy.env').write_bytes(b'changed')
        os.close(self.lock);self.lock=-1
        with self.assertRaises(transition.TransitionError):run()
        self.assertTrue(marker.is_file())
        self.assertEqual(self.journal.db.execute('SELECT phase FROM legacy_transitions').fetchone(),('started',))

if __name__=='__main__':unittest.main()
