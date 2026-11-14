import fcntl
import importlib.util
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
        self.adoption=SimpleNamespace(_binding=mock.Mock(return_value=('/policy','/accepted',self.approved,self.binding)))
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
            if args[0]=='ps':return ('\n'.join(self.items)+'\n').encode()
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
    def test_writer_after_stop_requires_recovery(self):
        self.quiet.ensure_no_uid_writers.side_effect=RuntimeError('writer')
        with self.assertRaises(RuntimeError):self.stop()
        self.assertEqual(self.journal.db.execute('SELECT state FROM legacy_stop_operations').fetchone(),('recovery_required',))

if __name__=='__main__':unittest.main()
