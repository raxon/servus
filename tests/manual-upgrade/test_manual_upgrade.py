import base64
import contextlib
import hashlib
import importlib.util
import json
import os
import pathlib
import sqlite3
import subprocess
import sys
import tempfile
import types
import unittest
from unittest import mock
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

PATH=pathlib.Path(__file__).resolve().parents[2]/'scripts/manual-upgrade.py'
spec=importlib.util.spec_from_file_location('manual_upgrade',PATH)
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
FAILED='11111111-1111-4111-8111-111111111111'
SUCCESS='22222222-2222-4222-8222-222222222222'
SERVICE='33333333-3333-4333-8333-333333333333'
SERVICE_ID='a'*64
TASK_ID='b'*25
CONTAINER_ID='c'*64
NETWORK_ID='d'*64


class Docker:
    def __init__(self):
        self.index=3
        self.target={'Name':'fixture','Labels':{'panel.service':SERVICE},'Mode':{'Replicated':{'Replicas':1}},
                     'TaskTemplate':{'Networks':[{'Target':'fixture-net'}],
                                     'ContainerSpec':{'Image':'fixture@sha256:'+'f'*64,'Env':['A=B'],
                                                      'Labels':{'panel.operation':SUCCESS,'panel.revision':'3'}}},
                     'EndpointSpec':{},'UpdateConfig':{},'RollbackConfig':{}}
        self.actual=json.loads(json.dumps(self.target));self.actual['TaskTemplate']['Networks'][0]['Target']=NETWORK_ID
    def call(self,*args,**kwargs):
        if args[:3]==('service','ls','-q'):return (SERVICE_ID+'\n').encode()
        if args[:2]==('service','inspect'):
            return json.dumps([{'ID':SERVICE_ID,'Spec':self.actual,'Version':{'Index':self.index},'UpdateStatus':{'State':'completed'}}]).encode()
        if args[:2]==('network','inspect'):return json.dumps([{'Id':NETWORK_ID}]).encode()
        if args[:3]==('service','ps','-q'):return (TASK_ID+'\n').encode()
        if args[:3]==('inspect','--type','task'):
            return json.dumps([{'Status':{'State':'running','ContainerStatus':{'ContainerID':CONTAINER_ID}}}]).encode()
        raise AssertionError(args)
    def inspect(self,*args):return [{'State':{'Running':True,'Health':{'Status':'healthy'}}}]


@unittest.skipUnless(os.geteuid()==0,'The snapshot validation requires a root-owned fixture')
class ReconcileTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='servus-manual-unit-',dir='/run')
        self.root=pathlib.Path(self.temp.name);os.chmod(self.root,0o700)
        self.docker=Docker();key=b'k'*32;(self.root/'secret-key').write_text(key.hex());os.chmod(self.root/'secret-key',0o600)
        iv=b'v'*12;packed=AESGCM(key).encrypt(iv,json.dumps(self.docker.target).encode(),b'panel-secret-v1');sealed='enc:v1:'+base64.b64encode(iv+packed[-16:]+packed[:-16]).decode()
        with sqlite3.connect(self.root/'panel.sqlite') as db:
            db.executescript('CREATE TABLE actions(id TEXT,type TEXT,service_id TEXT,created_at TEXT,finished_at TEXT,status TEXT); CREATE TABLE jobs(action_id TEXT,service_id TEXT,snapshot TEXT,status TEXT); CREATE TABLE services(id TEXT,deployed_revision INTEGER,deleted_at TEXT);')
            db.executemany('INSERT INTO actions VALUES(?,?,?,?,?,?)',[(FAILED,'deploy',SERVICE,'2026-01-01','2026-01-02','failed'),(SUCCESS,'deploy',SERVICE,'2026-01-03','2026-01-04','succeeded')])
            db.executemany('INSERT INTO jobs VALUES(?,?,?,?)',[(FAILED,SERVICE,json.dumps({'source':{'type':'image'}}),'failed'),(SUCCESS,SERVICE,'{}','succeeded')])
            db.execute('INSERT INTO services VALUES(?,?,NULL)',(SERVICE,3))
        with sqlite3.connect(self.root/'agent.sqlite') as db:
            db.execute('CREATE TABLE operations(id TEXT,service_id TEXT,state TEXT,operation_stage TEXT,response TEXT,target_spec TEXT,previous_spec TEXT)')
            db.executemany('INSERT INTO operations VALUES(?,?,?,?,?,?,?)',[(FAILED,SERVICE,'failed','rolling_back',json.dumps({'error':{'message':'Operation failed; restored the previous runtime configuration.'}}),'old-target','old-prev'),(SUCCESS,SERVICE,'succeeded','applying','{}',sealed,None)])
        for name in ('panel.sqlite','agent.sqlite'):os.chmod(self.root/name,0o600)
    def tearDown(self):self.temp.cleanup()
    def test_reconciles_and_preserves_historical_failure(self):
        self.assertEqual(module.reconciled_failure(self.root,self.docker),FAILED)
        with sqlite3.connect(self.root/'panel.sqlite') as db:self.assertEqual(db.execute('SELECT status FROM actions WHERE id=?',(FAILED,)).fetchone(),('failed',))
    def test_rejects_runtime_drift(self):
        self.docker.actual['TaskTemplate']['ContainerSpec']['Env']=['A=modified']
        with self.assertRaises(module.UpgradeError):module.reconciled_failure(self.root,self.docker)
    def test_rejects_failed_git_build(self):
        with sqlite3.connect(self.root/'panel.sqlite') as db:db.execute('UPDATE jobs SET snapshot=? WHERE action_id=?',(json.dumps({'source':{'type':'git'}}),FAILED))
        with self.assertRaises(module.UpgradeError):module.reconciled_failure(self.root,self.docker)
    def test_rejects_timeout_or_failed_recovery(self):
        for message in ('Operation failed; restored the previous runtime configuration. Timeout', 'Recovery also failed'):
            with self.subTest(message=message):
                with sqlite3.connect(self.root/'agent.sqlite') as db:db.execute('UPDATE operations SET response=? WHERE id=?',(json.dumps({'error':{'message':message}}),FAILED))
                with self.assertRaises(module.UpgradeError):module.reconciled_failure(self.root,self.docker)
    def test_rejects_unsuccessful_later_job(self):
        with sqlite3.connect(self.root/'panel.sqlite') as db:db.execute("UPDATE jobs SET status='running' WHERE action_id=?",(SUCCESS,))
        with self.assertRaises(module.UpgradeError):module.reconciled_failure(self.root,self.docker)
    def test_rejects_additional_failed_operation(self):
        with sqlite3.connect(self.root/'panel.sqlite') as db:db.execute('INSERT INTO actions VALUES(?,?,?,?,?,?)',('x','deploy',SERVICE,'2026-01-05','2026-01-06','failed'))
        with self.assertRaises(module.UpgradeError):module.reconciled_failure(self.root,self.docker)
    def test_rejects_tampered_ciphertext(self):
        with sqlite3.connect(self.root/'agent.sqlite') as db:db.execute('UPDATE operations SET target_spec=? WHERE id=?',('enc:v1:AAAA',SUCCESS))
        with self.assertRaises(module.UpgradeError):module.reconciled_failure(self.root,self.docker)
    def test_rejects_extra_specification_field(self):
        self.docker.actual['TaskTemplate']['Placement']={'Constraints':['node.hostname==external']}
        with self.assertRaises(module.UpgradeError):module.reconciled_failure(self.root,self.docker)
    def test_rejects_missing_required_health(self):
        self.docker.target['TaskTemplate']['ContainerSpec']['Healthcheck']={'Test':['CMD','true']}
        self.docker.actual['TaskTemplate']['ContainerSpec']['Healthcheck']={'Test':['CMD','true']}
        self._replace_target(self.docker.target)
        self.docker.inspect=lambda *_:[{'State':{'Running':True}}]
        with self.assertRaises(module.UpgradeError):module.reconciled_failure(self.root,self.docker)
    def _replace_target(self,target):
        key=b'k'*32;iv=b'v'*12;data=AESGCM(key).encrypt(iv,json.dumps(target).encode(),b'panel-secret-v1')
        sealed='enc:v1:'+base64.b64encode(iv+data[-16:]+data[:-16]).decode()
        with sqlite3.connect(self.root/'agent.sqlite') as db:db.execute('UPDATE operations SET target_spec=? WHERE id=?',(sealed,SUCCESS))
    def test_rejects_timestamp_tie(self):
        with sqlite3.connect(self.root/'panel.sqlite') as db:db.execute('INSERT INTO actions VALUES(?,?,?,?,?,?)',('x','deploy',SERVICE,'2026-01-03','2026-01-04','succeeded'))
        with self.assertRaises(module.UpgradeError):module.reconciled_failure(self.root,self.docker)
    def test_rejects_non_deployment_and_cross_service(self):
        with sqlite3.connect(self.root/'panel.sqlite') as db:db.execute("UPDATE actions SET type='restart' WHERE id=?",(SUCCESS,))
        with self.assertRaises(module.UpgradeError):module.reconciled_failure(self.root,self.docker)
        with sqlite3.connect(self.root/'panel.sqlite') as db:
            db.execute("UPDATE actions SET type='deploy' WHERE id=?",(SUCCESS,));db.execute("UPDATE jobs SET service_id='other' WHERE action_id=?",(FAILED,))
        with self.assertRaises(module.UpgradeError):module.reconciled_failure(self.root,self.docker)


class PureTests(unittest.TestCase):
    def test_replace_preserves_other_fields(self):
        before=('KEY=value\nSERVUS_IMAGE='+module.OLD+'\nLAST=value\n').encode()
        self.assertEqual(module.replace_image(before),('KEY=value\nSERVUS_IMAGE='+module.NEW+'\nLAST=value\n').encode())
        with self.assertRaises(module.UpgradeError):module.replace_image(before+b'SERVUS_IMAGE=another\n')
    def test_matching_rejects_extra_sensitive_env(self):
        self.assertFalse(module._matches(['A=B'],['A=B','X=Y']))
        self.assertFalse(module._matches(None,[]))
        self.assertFalse(module._matches([],{}))
    def test_only_known_docker_defaults_are_normalized(self):
        target={'TaskTemplate':{'ContainerSpec':{'Env':[]}}}
        actual={'TaskTemplate':{'ContainerSpec':{'StopGracePeriod':10_000_000_000,'Isolation':'default'},'Runtime':'container','Placement':{},'ForceUpdate':0}}
        self.assertTrue(module._matches(target,module.normalize_defaults(target,actual)))
        actual['TaskTemplate']['Placement']={'Constraints':['node.hostname==other']}
        self.assertFalse(module._matches(target,module.normalize_defaults(target,actual)))
    def test_rejects_data_alias_and_nested_mounts(self):
        base='1 0 8:1 / / rw - ext4 /dev/root rw\n'
        module.check_mount_topology('/var/lib/servus',base+'2 1 8:1 /var/lib/else /mnt/else rw - ext4 /dev/root rw\n')
        with self.assertRaises(module.UpgradeError):
            module.check_mount_topology('/var/lib/servus',base+'2 1 8:1 /var/lib/servus /mnt/alias rw - ext4 /dev/root rw\n')
        with self.assertRaises(module.UpgradeError):
            module.check_mount_topology('/var/lib/servus',base+'2 1 0:50 / /var/lib/servus/secrets rw - tmpfs tmpfs rw\n')
        module.check_mount_topology('/var/lib/servus',base+'2 1 0:51 net:[1] /run/netns/test rw - nsfs nsfs rw\n')
        with self.assertRaises(module.UpgradeError):
            module.check_mount_topology('/var/lib/servus',base+'2 1 8:1 net:[1] /run/netns/test rw - nsfs nsfs rw\n')
    def test_rejects_unknown_volume_devices(self):
        class Volumes:
            def call(self,*args):
                if args==('volume','ls','-q'):return b'fixture\n'
                return json.dumps([{'Driver':'local','Options':{'type':'none','o':'bind','device':'/var/lib/servus'}}]).encode()
        from unittest.mock import patch
        with patch.object(module,'check_mount_topology'), patch.object(module.os,'stat') as info, patch.object(module.pathlib.Path,'read_text',return_value=''):
            info.return_value.st_ino=1
            with self.assertRaises(module.UpgradeError):module.ensure_no_mount_aliases(Volumes(),'/var/lib/servus')
    def test_cgroup_headroom_accepts_absent_pair_and_checks_all_limits(self):
        with tempfile.TemporaryDirectory(prefix='servus-cgroup-') as directory:
            root=pathlib.Path(directory);parent=root/'parent';parent.mkdir();child=parent/'child';child.mkdir()
            (parent/'memory.max').write_text('1000\n');(parent/'memory.current').write_text('400\n')
            (child/'memory.max').write_text('900\n');(child/'memory.current').write_text('500\n')
            self.assertEqual(module.visible_cgroup_headroom(str(root),'parent/child'),400)
            (child/'memory.max').write_text('max\n')
            self.assertEqual(module.visible_cgroup_headroom(str(root),'parent/child'),600)
            (child/'memory.current').unlink()
            with self.assertRaises(module.UpgradeError):module.visible_cgroup_headroom(str(root),'parent/child')
            (child/'memory.max').unlink()
            with self.assertRaises(module.UpgradeError):module.visible_cgroup_headroom(str(root),'parent/child')
            with self.assertRaises((module.UpgradeError,OSError)):module.visible_cgroup_headroom(str(root),'parent/missing')


@unittest.skipUnless(os.geteuid()==0 and sys.platform=='linux','Requires root Linux process inspection')
class ProcessInspectionTests(unittest.TestCase):
    def test_snapshot_inventory_rejects_tampering_and_unlisted_files(self):
        with tempfile.TemporaryDirectory(prefix='servus-snapshot-',dir='/run') as directory:
            root=pathlib.Path(directory);os.chmod(root,0o700)
            names=('panel.sqlite','agent.sqlite','secret-key','agent-token')
            hashes={}
            for name in names:
                path=root/name;path.write_bytes(name.encode());os.chmod(path,0o600)
                hashes[name]=hashlib.sha256(name.encode()).hexdigest()
            manifest=root/'manifest.json';manifest.write_text(json.dumps({'format':1,'files':hashes}));os.chmod(manifest,0o600)
            module.verify_snapshot_hashes(root)
            wal=root/'panel.sqlite-wal';wal.write_bytes(b'');os.chmod(wal,0o600)
            shm=root/'panel.sqlite-shm';shm.write_bytes(b'sqlite-index');os.chmod(shm,0o600)
            module.verify_snapshot_hashes(root)
            wal.write_bytes(b'uncheckpointed')
            with self.assertRaises(module.UpgradeError):module.verify_snapshot_hashes(root)
            wal.write_bytes(b'')
            (root/'secret-key').write_bytes(b'changed')
            with self.assertRaises(module.UpgradeError):module.verify_snapshot_hashes(root)
            (root/'secret-key').write_bytes(b'secret-key')
            (root/'extra').write_bytes(b'unknown');os.chmod(root/'extra',0o600)
            with self.assertRaises(module.UpgradeError):module.verify_snapshot_hashes(root)
    def test_uid_preflight_allows_only_panel_cgroups(self):
        with tempfile.TemporaryDirectory(prefix='servus-proc-',dir='/run') as directory:
            proc=pathlib.Path(directory);pid=proc/'123';pid.mkdir()
            (pid/'status').write_text('Name:\ttest\nUid:\t1000\t1000\t1000\t1000\n')
            (pid/'cgroup').write_text('0::/system.slice/docker-'+CONTAINER_ID+'.scope\n')
            module.ensure_no_uid_writers(proc=proc,allowed_containers={CONTAINER_ID})
            with self.assertRaises(module.UpgradeError):module.ensure_no_uid_writers(proc=proc)
            with self.assertRaises(module.UpgradeError):module.ensure_no_uid_writers(proc=proc,allowed_containers={'d'*64})
    def test_docker_socket_requires_exact_ingress_image(self):
        class Inventory:
            def __init__(self):
                self.item={'Id':'a'*64,'Image':module.TRUSTED_INGRESS_IMAGE,
                           'Config':{'Image':'traefik:3.7.13','Labels':{'com.docker.swarm.service.name':'panel-ingress'}},
                           'HostConfig':{'Privileged':False},
                           'Mounts':[{'Source':'/var/run/docker.sock','Destination':'/var/run/docker.sock','RW':False}]}
            def call(self,*_args):return (self.item['Id']+'\n').encode()
            def inspect(self,*_args):return [self.item]
        inventory=Inventory()
        module.ensure_no_other_data_mounts(inventory,set(),'/var/lib/servus')
        inventory.item['Image']='sha256:'+'f'*64
        with self.assertRaises(module.UpgradeError):module.ensure_no_other_data_mounts(inventory,set(),'/var/lib/servus')
        inventory.item['Image']=module.TRUSTED_INGRESS_IMAGE;inventory.item['HostConfig']['PidMode']='host'
        with self.assertRaises(module.UpgradeError):module.ensure_no_other_data_mounts(inventory,set(),'/var/lib/servus')
        inventory.item['HostConfig']['PidMode']='';inventory.item['HostConfig']['CapAdd']=['CAP_SYS_ADMIN']
        with self.assertRaises(module.UpgradeError):module.ensure_no_other_data_mounts(inventory,set(),'/var/lib/servus')

@unittest.skipUnless(os.geteuid()==0 and sys.platform=='linux','Requires root-owned verifier fixture')
class AttestationTests(unittest.TestCase):
    def test_rejects_unverified_or_wrong_release_and_tampered_verifier(self):
        with tempfile.TemporaryDirectory(prefix='servus-verifier-',dir='/run') as directory:
            base=pathlib.Path(directory);os.chmod(base,0o700)
            entries={}
            for name in ('verification-executor.py','verify-release.py'):
                data=name.encode();path=base/name;path.write_bytes(data);os.chmod(path,0o644)
                entries[name]=hashlib.sha256(data).hexdigest()
            good={'image':'ghcr.io/raxon/servus','digest':module.NEW.split('@')[1],
                  'commit':module.REVISION,'tag':'v0.1.5','verified':True,'configDigest':module.CONFIG_DIGEST}
            with mock.patch.object(module,'VERIFIER_FILES',entries),mock.patch.object(module.subprocess,'run') as run:
                run.return_value=types.SimpleNamespace(returncode=0,stdout=json.dumps(good).encode())
                module.verify_release_attestation(directory=base)
                for key,value in (('verified',False),('digest','sha256:'+'f'*64),('configDigest','sha256:'+'f'*64),('commit','f'*40)):
                    changed={**good,key:value};run.return_value=types.SimpleNamespace(returncode=0,stdout=json.dumps(changed).encode())
                    with self.assertRaises(module.UpgradeError):module.verify_release_attestation(directory=base)
                run.return_value=types.SimpleNamespace(returncode=1,stdout=b'')
                with self.assertRaises(module.UpgradeError):module.verify_release_attestation(directory=base)
                (base/'verify-release.py').write_bytes(b'tampered')
                with self.assertRaises(module.UpgradeError):module.verify_release_attestation(directory=base)
    def test_detects_open_file_and_working_directory(self):
        with tempfile.TemporaryDirectory(prefix='servus-open-fd-',dir='/run') as directory:
            path=pathlib.Path(directory)/'data';path.mkdir();(path/'fixture').write_text('fixture')
            cases=(("file=open(__import__('sys').argv[1]);print('ready',flush=True);__import__('time').sleep(60)",'/',str(path/'fixture')),
                   ("print('ready',flush=True);__import__('time').sleep(60)",path,''))
            for statement,cwd,argument in cases:
                child=subprocess.Popen([sys.executable,'-c',statement,argument],cwd=cwd,stdout=subprocess.PIPE,text=True)
                try:
                    self.assertEqual(child.stdout.readline().strip(),'ready')
                    with self.assertRaises(module.UpgradeError):module.ensure_no_open_data(path)
                finally:
                    child.terminate();child.wait(timeout=5);child.stdout.close()
            module.ensure_no_open_data(path)


@unittest.skipUnless(os.geteuid()==0 and __import__('sys').flags.isolated,'Requires isolated root Linux')
class CoordinatorTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='servus-manual-coordinator-',dir='/run')
        self.base=pathlib.Path(self.temp.name);os.chmod(self.base,0o700)
        self.install=self.base/'install';self.install.mkdir(mode=0o700)
        self.config=self.base/'config';self.config.mkdir(mode=0o700)
        self.data=self.base/'data';self.data.mkdir(mode=0o700);os.chown(self.data,1000,1000)
        (self.install/'install.lock').write_text('');os.chmod(self.install/'install.lock',0o600)
        (self.install/'current').symlink_to('fixture-release')
        self.env=(f'SERVUS_IMAGE={module.OLD}\nSERVUS_DATA_DIR={self.data}\nSERVUS_BIND_ADDRESS=127.0.0.1\n'
                  'SERVUS_PORT=4180\nSERVUS_PUBLIC_URL=https://159.65.115.230\nSERVUS_SECURE_COOKIES=true\n').encode()
        (self.config/'servus.env').write_bytes(self.env);os.chmod(self.config/'servus.env',0o600)
        self.events=[];self.fail_at=None
        self.old={r:{'Id':str(i)*64} for i,r in enumerate(module.ROLES,1)}
        self.new={r:{'Id':str(i)*64} for i,r in enumerate(module.ROLES,4)}
        test=self
        class DockerFake:
            def __init__(self,_config):pass
            def call(self,*args,**kwargs):
                test.events.append(args)
                if test.fail_at and args[:len(test.fail_at)]==test.fail_at:raise module.UpgradeError('Injected failure')
                return b''
        def tools(_docker,path,**_kwargs):
            (path/'node').write_bytes(b'fixture');os.chmod(path/'node',0o755)
            (path/'backup.py').write_bytes(b'fixture')
        def checkpoint(_docker,item):
            self.events.append(('stop',item['Id']))
            if self.fail_at==('stop',):raise module.UpgradeError('Injected failure')
        def validate(_docker,_data,**kwargs):return self.old if kwargs.get('image')==module.OLD else self.new
        def capture(_module,_docker,_source,dest,_node):
            (dest/'panel.sqlite').write_bytes(b'fixture')
            if self.fail_at==('capture',):raise module.UpgradeError('Injected failure')
            return {'files':{'panel.sqlite':'fixture'}}
        def health(*args,**kwargs):
            self.events.append(('health',args[0]))
            if self.fail_at==('health',):raise module.UpgradeError('Injected failure')
        self.stack=contextlib.ExitStack()
        for name,value in [('Docker',DockerFake),('current_compose',lambda *_a,**_k:self.install/'compose.yaml'),
                           ('image_preflight',lambda *_a:None),('validate_running_components',validate),
                           ('expected_runtime',lambda *_a:({},None,None)),
                           ('ensure_host_namespaces',lambda:None),
                           ('release_tools',tools),('load_backup',lambda *_a:types.SimpleNamespace(_cgroup_v2_headroom=lambda *_x:None,_memory_headroom=lambda *_x:None,MAX_DATABASE=1)),('checkpoint_role',checkpoint),
                           ('check_stopped',lambda *_a:None),('ensure_no_other_data_mounts',lambda *_a:None),
                           ('ensure_no_mount_aliases',lambda *_a:None),('ensure_no_open_data',lambda *_a:None),
                           ('ensure_no_uid_writers',lambda *_a,**_k:None),
                           ('capture_snapshot',capture),('verify_restored_image',lambda *_a,**_k:None),
                           ('_wait_component',lambda *_a,**_k:None)]:
            self.stack.enter_context(mock.patch.object(module,name,value))
        self.stack.enter_context(mock.patch.object(module.subprocess,'run',return_value=type('Result',(),{'returncode':0,'stdout':b'v24.22.3\n'})()))
        self.health=health
    def tearDown(self):self.stack.close();self.temp.cleanup()
    def invoke(self):return module.run_upgrade(install=self.install,config_dir=self.config,data_dir=self.data,health=self.health)
    def marker(self):return json.loads((self.install/'manual-upgrade-state.json').read_text())
    def test_success_orders_freeze_backup_health_and_restart(self):
        directory=self.invoke()
        self.assertEqual(self.marker()['phase'],'complete');self.assertEqual((directory/'servus.env').read_bytes(),self.env)
        self.assertEqual(module.recovery_status(self.install),{'phase':'complete','action':'none','backup':str(directory)})
        self.assertEqual((self.config/'servus.env').read_bytes(),module.replace_image(self.env))
        stop=[self.events.index(('stop',self.old[role]['Id'])) for role in ('api','worker','agent')]
        self.assertEqual(stop,sorted(stop))
        first_switch=next(i for i,event in enumerate(self.events) if event[0]=='compose')
        self.assertGreater(first_switch,stop[-1])
        first_restart=next(i for i,event in enumerate(self.events) if event[:2]==('update','--restart=unless-stopped'))
        self.assertGreater(first_restart,max(i for i,event in enumerate(self.events) if event[0]=='health'))
    def test_failure_before_capture_retains_marker_and_old_environment(self):
        self.fail_at=('stop',)
        with self.assertRaises(module.UpgradeError):self.invoke()
        self.assertEqual(self.marker()['phase'],'stopping');self.assertEqual((self.config/'servus.env').read_bytes(),self.env)
        self.assertEqual(module.recovery_status(self.install)['action'],'inspection_required')
        self.assertFalse(any(event[0]=='compose' for event in self.events))
        with self.assertRaises(module.UpgradeError):self.invoke()
    def test_recovery_status_rejects_tampered_marker(self):
        self.fail_at=('stop',)
        with self.assertRaises(module.UpgradeError):self.invoke()
        marker=self.marker();marker['backup']='/tmp/attacker';(self.install/'manual-upgrade-state.json').write_text(json.dumps(marker))
        with self.assertRaises(module.UpgradeError):module.recovery_status(self.install)
    def test_failed_health_does_not_restore_restart_policy(self):
        self.fail_at=('health',)
        with self.assertRaises(module.UpgradeError):self.invoke()
        self.assertEqual(self.marker()['phase'],'verifying')
        self.assertFalse(any(event[:2]==('update','--restart=unless-stopped') for event in self.events))
    def test_capture_failure_never_switches_images(self):
        self.fail_at=('capture',)
        with self.assertRaises(module.UpgradeError):self.invoke()
        self.assertEqual(self.marker()['phase'],'capturing')
        self.assertEqual((self.config/'servus.env').read_bytes(),self.env)
        self.assertFalse(any(event[0]=='compose' for event in self.events))
        self.assertFalse(any(event[:2]==('update','--restart=unless-stopped') for event in self.events))
    def test_failed_switch_keeps_marker_and_no_auto_restart(self):
        self.fail_at=('compose',)
        with self.assertRaises(module.UpgradeError):self.invoke()
        self.assertEqual(self.marker()['phase'],'switching')
        self.assertEqual((self.config/'servus.env').read_bytes(),module.replace_image(self.env))
        self.assertFalse(any(event[:2]==('update','--restart=unless-stopped') for event in self.events))
    def test_recovery_refuses_unsettled_and_interrupted_phases(self):
        self.fail_at=('stop',)
        with self.assertRaises(module.UpgradeError):self.invoke()
        marker=self.install/'manual-upgrade-state.json'
        for phase in ('intent','preventing_restart','stopping','capturing','testing_restore','switching','verifying',
                      'recovery_starting','recovery_verifying','recovered','complete'):
            with self.subTest(phase=phase):
                state=json.loads(marker.read_text());state['phase']=phase
                marker.write_text(json.dumps(state));self.events.clear()
                with self.assertRaises(module.UpgradeError):
                    module.recover_old(install=self.install,config_dir=self.config,data_dir=self.data,health=self.health)
                self.assertFalse(any(event[0] in ('start','update') for event in self.events))


@unittest.skipUnless(sys.platform=='linux' and os.geteuid()==0,'Requires the Linux system CA bundle')
class HealthTests(unittest.TestCase):
    def test_hostile_tls_and_proxy_environment_is_ignored(self):
        response=mock.MagicMock();response.status=200
        response.read.return_value=json.dumps({'status':'ok','version':'test','revision':'rev'}).encode()
        opener=mock.MagicMock();opener.open.return_value.__enter__.return_value=response
        with mock.patch.dict(os.environ,{'SSL_CERT_FILE':'/untrusted','SSL_CERT_DIR':'/untrusted',
                                        'SSLKEYLOGFILE':'/tmp/untrusted-keylog','https_proxy':'http://attacker:9'}), \
             mock.patch.object(module.urllib.request,'build_opener',return_value=opener) as build:
            module.health_check('https://example.test','test','rev',timeout=1)
        proxy,https=build.call_args.args
        self.assertEqual(proxy.proxies,{})
        self.assertTrue(https._context.check_hostname)
        self.assertEqual(https._context.verify_mode,module.ssl.CERT_REQUIRED)
        self.assertIsNone(https._context.keylog_filename)
        self.assertGreater(https._context.cert_store_stats()['x509_ca'],0)


if __name__=='__main__':unittest.main()
