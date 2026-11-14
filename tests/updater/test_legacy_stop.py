import fcntl
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

legacy=load('legacy_stop','legacy-stop.py')
updater=load('legacy_stop_updater','servus-updater.py')
recovery=load('legacy_recovery','legacy-recovery.py')
policy=load('legacy_recovery_policy','runtime-policy.py')
backup=load('legacy_recovery_backup','backup.py')
fence_module=load('legacy_removal_fence','migration-fence.py')

@unittest.skipUnless(sys.platform=='linux' and os.geteuid()==0 and sys.flags.isolated,'Requires isolated Linux root')
class LegacyStopTest(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(dir='/root');self.root=Path(self.temp.name)
        self.install=self.root/'install';self.install.mkdir(mode=0o700);(self.install/'install.lock').touch(mode=0o600)
        self.state=self.root/'state';self.state.mkdir(mode=0o700)
        self.source=self.root/'source';self.source.mkdir(mode=0o700);os.chown(self.source,1000,1000)
        self.operation=str(uuid.uuid4());self.old={role:letter*64 for role,letter in zip(('api','worker','agent'),'abc')}
        self.image='ghcr.io/raxon/servus@sha256:'+'d'*64
        self.binding=(str(uuid.uuid4()),str(uuid.uuid4()),'e'*64,'sha256:'+'f'*64,'sha256:'+'1'*64)
        self.approved=SimpleNamespace(install_dir=str(self.install),data_dir=str(self.root/'restore'))
        self.adoption=SimpleNamespace(_binding=mock.Mock(return_value=('/policy','/accepted',self.approved,self.binding)),_check_paths=mock.Mock())
        self.quiet=SimpleNamespace(ensure_host_namespaces=mock.Mock(),ensure_restart_fenced=mock.Mock(),ensure_no_other_data_mounts=mock.Mock(),
                                   ensure_no_mount_aliases=mock.Mock(),ensure_no_open_data=mock.Mock(),ensure_no_uid_writers=mock.Mock())
        self.items={}
        for role,cid in self.old.items():
            mounts=[{'Type':'bind','Source':str(self.source),'Destination':str(self.source),'RW':True}]
            if role=='agent':mounts.append({'Type':'bind','Source':'/var/run/docker.sock','Destination':'/var/run/docker.sock','RW':True})
            self.items[cid]={'Id':cid,'Image':self.image.split('@')[1],
                'Config':{'Image':self.image,'User':'node','Cmd':['node','dist/'+('server' if role=='api' else role)+'/index.js'],
                          'Labels':{'com.docker.compose.project':'servus','com.docker.compose.service':role}},
                'State':{'Running':True,'Paused':False,'Restarting':False,'ExitCode':0},
                'HostConfig':{'Privileged':False,'PidMode':'','AutoRemove':False,'RestartPolicy':{'Name':'unless-stopped'}},'Mounts':mounts}
        self.calls=[];self.failure=None
        def call(*args,**kwargs):
            self.calls.append(args)
            if self.failure==args[0]:raise RuntimeError('fixture failure')
            if args[0]=='ps':return ('\n'.join(self.items)+('\n' if self.items else '')).encode()
            if args[0]=='update':self.items[args[-1]]['HostConfig']['RestartPolicy']['Name']='no'
            if args[0]=='stop':self.items[args[-1]]['State']['Running']=False
            return b''
        self.docker=SimpleNamespace(call=call,inspect=lambda *ids:[self.items[cid] for cid in ids])
        self.journal=updater.Journal(self.state)
        self.lock=os.open(self.install/'install.lock',os.O_RDONLY);fcntl.flock(self.lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    def tearDown(self):os.close(self.lock);self.journal.close();self.temp.cleanup()
    def stop(self):
        return legacy.stop(self.journal,self.operation,'/active',str(self.source),self.image,self.image.split('@')[1],self.old,supervisor,object(),self.adoption,self.quiet,self.docker,install_lock=self.lock)
    def test_stop_records_intent_before_mutation_and_quiesces_all_roles(self):
        original=self.docker.call
        def checked(*args,**kwargs):
            if args[0] in ('update','stop'):
                self.assertEqual(self.journal.db.execute('SELECT state FROM legacy_stop_operations').fetchone(),('stopping',))
            return original(*args,**kwargs)
        self.docker.call=checked
        identity=self.stop()
        self.assertEqual(identity,(os.stat(self.source).st_dev,os.stat(self.source).st_ino))
        self.assertEqual(self.journal.db.execute('SELECT state FROM legacy_stop_operations').fetchone(),('stopped',))
        self.assertEqual([args[-1] for args in self.calls if args[0]=='stop'],[self.old[x] for x in ('api','worker','agent')])
        self.quiet.ensure_restart_fenced.assert_called()
        self.quiet.ensure_no_open_data.assert_called_with(str(self.source))
        with self.assertRaises(legacy.LegacyStopError):self.stop()
    def test_failure_requires_recovery_and_does_not_modify_data(self):
        self.failure='stop'
        with self.assertRaises(RuntimeError):self.stop()
        self.assertEqual(self.journal.db.execute('SELECT state FROM legacy_stop_operations').fetchone(),('recovery_required',))
        self.assertEqual((os.stat(self.source).st_uid,os.stat(self.source).st_gid),(1000,1000))
        self.assertTrue(all(item['HostConfig']['RestartPolicy']['Name']=='no' for item in self.items.values()))
        self.journal.close();self.journal=updater.Journal(self.state)
        self.assertEqual(self.journal.db.execute('SELECT state FROM legacy_stop_operations').fetchone(),('recovery_required',))
    def test_invalid_identity_is_rejected_before_mutation(self):
        self.items[self.old['agent']]['Config']['Labels']['com.docker.swarm.service.name']='unexpected'
        with self.assertRaises(legacy.LegacyStopError):self.stop()
        self.assertFalse(any(args[0] in ('update','stop') for args in self.calls))
        self.assertIsNone(self.journal.db.execute("SELECT 1 FROM sqlite_master WHERE name='legacy_stop_operations'").fetchone())
    def test_prepared_policy_can_stop_only_with_matching_marker(self):
        self.adoption.prepared_binding=mock.Mock(return_value=('/policy','/accepted',self.approved,self.binding))
        def stop():
            return legacy.stop(self.journal,self.operation,'/active',str(self.source),self.image,self.image.split('@')[1],self.old,
                               supervisor,object(),self.adoption,self.quiet,self.docker,install_lock=self.lock,candidate_policy=('/policies',policy))
        with self.assertRaises(FileNotFoundError):stop()
        self.assertFalse(any(args[0] in ('update','stop') for args in self.calls))
        marker=self.install/'.legacy-migration-v1';marker.write_text('servus-legacy-migration-v1 '+self.operation+'\n');marker.chmod(0o600)
        stop()
        self.assertEqual(self.journal.db.execute('SELECT state FROM legacy_stop_operations').fetchone(),('stopped',))
        self.adoption._binding.assert_not_called()
    def test_writer_after_stop_requires_recovery(self):
        self.quiet.ensure_no_uid_writers.side_effect=RuntimeError('writer')
        with self.assertRaises(RuntimeError):self.stop()
        self.assertEqual(self.journal.db.execute('SELECT state FROM legacy_stop_operations').fetchone(),('recovery_required',))
    def test_failed_capture_requires_recovery_and_rejects_retry(self):
        self.stop();destination=self.root/'snapshot';destination.mkdir(mode=0o700)
        capture=SimpleNamespace(_capture_quiescent=mock.Mock(side_effect=RuntimeError('capture failed')))
        coordinator=SimpleNamespace(_pairs=dict)
        def run():
            return legacy.capture(self.journal,self.operation,'/active',str(destination),-1,supervisor,object(),self.adoption,self.quiet,self.docker,capture,coordinator,install_lock=self.lock)
        with self.assertRaisesRegex(RuntimeError,'capture failed'):run()
        self.assertEqual(self.journal.db.execute('SELECT state FROM legacy_snapshots').fetchone(),('recovery_required',))
        self.assertEqual(self.journal.db.execute('SELECT state FROM legacy_stop_operations').fetchone(),('recovery_required',))
        with self.assertRaises(legacy.LegacyStopError):run()
    def test_protect_requires_staged_data_and_records_original_identity(self):
        self.stop();self.journal.db.execute('CREATE TABLE legacy_snapshots(operation_id TEXT,path TEXT,digest TEXT,state TEXT)')
        self.journal.db.execute("INSERT INTO legacy_snapshots VALUES(?,?,?,'verified')",(self.operation,'/snapshot','sha256:'+'9'*64))
        restored=SimpleNamespace(verify_staged=mock.Mock(return_value=(11,12)))
        result=legacy.protect(self.journal,self.operation,'/active','/parent',-1,supervisor,object(),self.adoption,self.quiet,self.docker,object(),SimpleNamespace(_pairs=dict),restored,install_lock=self.lock)
        self.assertEqual(result,(11,12));self.assertEqual((os.stat(self.source).st_uid,os.stat(self.source).st_gid),(0,0))
        self.assertEqual(self.journal.db.execute('SELECT state,target_dev,target_ino FROM legacy_protections').fetchone(),('protected',11,12))
        self.assertEqual(restored.verify_staged.call_count,2)
    def test_failed_protection_records_recovery_after_ownership_change(self):
        self.stop();self.journal.db.execute('CREATE TABLE legacy_snapshots(operation_id TEXT,path TEXT,digest TEXT,state TEXT)')
        self.journal.db.execute("INSERT INTO legacy_snapshots VALUES(?,?,?,'verified')",(self.operation,'/snapshot','sha256:'+'9'*64))
        restored=SimpleNamespace(verify_staged=mock.Mock(side_effect=[(11,12),RuntimeError('staged data changed')]))
        with self.assertRaisesRegex(RuntimeError,'staged data changed'):
            legacy.protect(self.journal,self.operation,'/active','/parent',-1,supervisor,object(),self.adoption,self.quiet,self.docker,object(),SimpleNamespace(_pairs=dict),restored,install_lock=self.lock)
        self.assertEqual(os.stat(self.source).st_uid,0)
        self.assertEqual(self.journal.db.execute('SELECT state FROM legacy_protections').fetchone(),('recovery_required',))
    def recovery_fixture(self):
        self.stop();env=self.root/'legacy.env';env.write_text('SERVUS_IMAGE='+self.image+'\nSERVUS_DATA_DIR='+str(self.source)+'\n');env.chmod(0o600)
        compose=self.root/'compose.yaml';compose.write_text('fixture\n');compose.chmod(0o644)
        destination=self.root/'recovery';destination.mkdir(mode=0o700)
        services={}
        for role,cid in self.old.items():
            self.items[cid]['Config']['Env']=['PANEL_DATA_DIR='+str(self.source)]
            volumes=[{'type':'bind','source':str(self.source),'target':str(self.source)}]
            if role=='agent':volumes.append({'type':'bind','source':'/var/run/docker.sock','target':'/var/run/docker.sock'})
            services[role]={'image':self.image,'environment':{'PANEL_DATA_DIR':str(self.source)},'command':self.items[cid]['Config']['Cmd'],'volumes':volumes}
        original=self.docker.call
        def call(*args,**kwargs):
            if args[0]=='compose':return json.dumps({'services':services}).encode()
            return original(*args,**kwargs)
        self.docker.call=call
        def run():
            return recovery.capture(self.journal,self.operation,'/active',str(env),str(compose),str(destination),supervisor,object(),self.adoption,policy,backup,self.quiet,self.docker,install_lock=self.lock)
        return run,env,compose,destination,services
    def test_recovery_inputs_match_legacy_runtime_and_remain_private(self):
        run,env,compose,destination,_=self.recovery_fixture()
        env_hash,compose_hash=run()
        self.assertEqual((destination/'legacy.env').read_bytes(),env.read_bytes())
        self.assertEqual((destination/'compose.yaml').read_bytes(),compose.read_bytes())
        self.assertEqual((destination/'legacy.env').stat().st_mode & 0o777,0o600)
        self.assertEqual(self.journal.db.execute('SELECT env_digest,compose_digest,state FROM legacy_recovery').fetchone(),(env_hash,compose_hash,'verified'))
        self.assertEqual(recovery.verify(self.journal,self.operation,'/active',supervisor,object(),self.adoption,policy,backup,install_lock=self.lock),(str(destination),env_hash,compose_hash))
        (destination/'compose.yaml').write_text('changed')
        with self.assertRaises(recovery.RecoveryError):
            recovery.verify(self.journal,self.operation,'/active',supervisor,object(),self.adoption,policy,backup,install_lock=self.lock)
        with self.assertRaises(recovery.RecoveryError):run()
    def test_recovery_rejects_mismatched_compose_before_writing(self):
        run,_,_,destination,services=self.recovery_fixture()
        services['api']['environment']['PANEL_DATA_DIR']='/other'
        with self.assertRaises(recovery.RecoveryError):run()
        self.assertEqual(list(destination.iterdir()),[])
    def test_recovery_preserves_failed_capture_state(self):
        run,_,_,_,_=self.recovery_fixture()
        with mock.patch.object(policy,'_publish_private',side_effect=OSError('fixture')):
            with self.assertRaises(OSError):run()
        self.assertEqual(self.journal.db.execute('SELECT state FROM legacy_recovery').fetchone(),('recovery_required',))
    def removal_fixture(self):
        run,_,_,destination,_=self.recovery_fixture();run()
        source=os.stat(self.source);os.chown(self.source,0,0)
        self.journal.db.execute('CREATE TABLE legacy_snapshots(operation_id TEXT,path TEXT,digest TEXT,state TEXT)')
        self.journal.db.execute("INSERT INTO legacy_snapshots VALUES(?,?,?,'verified')",(self.operation,'/snapshot','sha256:'+'9'*64))
        self.journal.db.execute('CREATE TABLE legacy_protections(operation_id TEXT,source TEXT,source_dev INTEGER,source_ino INTEGER,snapshot_digest TEXT,target_dev INTEGER,target_ino INTEGER,state TEXT)')
        self.journal.db.execute("INSERT INTO legacy_protections VALUES(?,?,?,?,?,?,?,'protected')",(self.operation,str(self.source),source.st_dev,source.st_ino,'sha256:'+'9'*64,11,12))
        restored=SimpleNamespace(verify_staged=mock.Mock(return_value=(11,12)))
        fence=fence_module.MigrationFence(self.journal,self.operation,'/active',str(self.source),self.old,supervisor,object(),self.adoption,self.quiet,self.docker)
        original=self.docker.call
        def call(*args,**kwargs):
            if args[0]=='rm':
                if self.failure=='rm' and args[-1]==self.old['worker']:raise RuntimeError('removal failed')
                del self.items[args[-1]];return b''
            return original(*args,**kwargs)
        self.docker.call=call
        def execute():
            return legacy.remove(self.journal,self.operation,'/active','/parent',-1,supervisor,object(),self.adoption,policy,self.quiet,self.docker,backup,SimpleNamespace(_pairs=dict),restored,recovery,fence,install_lock=self.lock)
        return execute,fence,destination
    def test_removal_requires_recovery_files_and_records_fence(self):
        run,fence,_=self.removal_fixture();run()
        self.assertEqual(self.items,{})
        self.assertEqual(self.journal.db.execute('SELECT state FROM legacy_removals').fetchone(),('removed',))
        self.assertEqual(self.journal.db.execute('SELECT state FROM legacy_migration_fences').fetchone(),('fenced',))
        fence.assert_locked(self.operation,self.lock)
        self.assertEqual(os.stat(self.source).st_uid,0)
    def test_interrupted_removal_requires_recovery(self):
        run,fence,_=self.removal_fixture();self.failure='rm'
        with self.assertRaisesRegex(RuntimeError,'removal failed'):run()
        self.assertEqual(self.journal.db.execute('SELECT state FROM legacy_removals').fetchone(),('recovery_required',))
        self.assertNotIn(self.old['api'],self.items);self.assertIn(self.old['worker'],self.items)
        self.assertIsNone(self.journal.db.execute("SELECT 1 FROM sqlite_master WHERE name='legacy_migration_fences'").fetchone())
    def test_changed_recovery_files_block_removal(self):
        run,fence,destination=self.removal_fixture()
        (destination/'compose.yaml').write_text('changed')
        with self.assertRaises(recovery.RecoveryError):run()
        self.assertEqual(len(self.items),3)
        self.assertIsNone(self.journal.db.execute("SELECT 1 FROM sqlite_master WHERE name='legacy_migration_fences'").fetchone())

if __name__=='__main__':unittest.main()
