import importlib.util
import errno
import hashlib
import fcntl
from contextlib import closing
import io
import json
import os
import pathlib
import select
import signal
import shutil
import sqlite3
import subprocess
import tempfile
import time
import unittest
from types import SimpleNamespace
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('servus_backup_capture', ROOT / 'apps/updater/backup.py')
backup = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(backup)
UUID = '12345678-1234-4123-8123-123456789abc'
NODE = os.environ.get('SERVUS_TEST_NODE', '/usr/local/bin/node')
APP = os.environ.get('SERVUS_TEST_APP', '/app')


class CgroupHeadroomTest(unittest.TestCase):
    def test_nested_limits_include_parent_siblings(self):
        with tempfile.TemporaryDirectory() as directory:
            root=pathlib.Path(directory)
            parent=root/'team'; child=parent/'reader'
            child.mkdir(parents=True)
            for path,limit,current in ((root,'5000','1000'),(parent,'2000','1900'),(child,'1000','100')):
                (path/'memory.max').write_text(limit);(path/'memory.current').write_text(current)
            self.assertEqual(backup._cgroup_v2_headroom(directory,'team/reader'),100)
            (parent/'memory.max').write_text('max')
            self.assertEqual(backup._cgroup_v2_headroom(directory,'team/reader'),900)
            (child/'memory.max').write_text('max');(root/'memory.max').write_text('max')
            self.assertIsNone(backup._cgroup_v2_headroom(directory,'team/reader'))
            with self.assertRaises(backup.CaptureError): backup._cgroup_v2_headroom(directory,'team/../reader')

    def test_only_actual_root_may_lack_both_memory_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root=pathlib.Path(directory);child=root/'service';child.mkdir()
            (child/'memory.max').write_text('2000');(child/'memory.current').write_text('1000')
            self.assertEqual(backup._cgroup_v2_headroom(directory,'service',actual_root=True),1000)
            with self.assertRaises(backup.CaptureError): backup._cgroup_v2_headroom(directory,'service',actual_root=False)
            (root/'memory.max').write_text('max')
            with self.assertRaises(backup.CaptureError): backup._cgroup_v2_headroom(directory,'service',actual_root=True)
            (root/'memory.max').unlink();(child/'memory.max').unlink();(child/'memory.current').unlink()
            with self.assertRaises(backup.CaptureError): backup._cgroup_v2_headroom(directory,'service',actual_root=True)

    def test_missing_root_still_requires_memavailable_and_other_limits(self):
        with tempfile.TemporaryDirectory() as directory:
            root=pathlib.Path(directory);child=root/'service';child.mkdir()
            (child/'memory.max').write_text('1000');(child/'memory.current').write_text('900')
            with mock.patch.object(backup,'_visible_cgroup_v2',return_value=(directory,'service',True)):
                with self.assertRaisesRegex(backup.CaptureError,'Insufficient memory'): backup._memory_headroom(1)
            real_open=open
            def missing_meminfo(path,*args,**kwargs):
                if path=='/proc/meminfo': raise FileNotFoundError(path)
                return real_open(path,*args,**kwargs)
            with mock.patch.object(backup,'_visible_cgroup_v2',return_value=(directory,'service',True)),mock.patch('builtins.open',side_effect=missing_meminfo):
                with self.assertRaisesRegex(backup.CaptureError,'Cannot check available memory'): backup._memory_headroom(1)

    def test_denied_memory_file_is_not_treated_as_missing(self):
        with tempfile.TemporaryDirectory() as directory:
            real_open=open
            def denied(path,*args,**kwargs):
                if str(path).endswith('memory.max'): raise PermissionError(path)
                return real_open(path,*args,**kwargs)
            with mock.patch.object(backup,'_visible_cgroup_v2',return_value=(directory,'',True)),mock.patch('builtins.open',side_effect=denied):
                with self.assertRaisesRegex(backup.CaptureError,'Cannot check available memory'): backup._memory_headroom(1)

    def test_namespace_relative_root_is_not_assumed_to_be_actual_root(self):
        real_open=open;real_stat=os.stat
        def fixtures(path,*args,**kwargs):
            if path=='/proc/self/cgroup': return io.StringIO('0::/service\n')
            if path=='/proc/self/mountinfo': return io.StringIO('40 30 0:31 / /sys/fs/cgroup rw - cgroup2 cgroup rw\n')
            return real_open(path,*args,**kwargs)
        class Stat: st_ino=42
        def namespace(path,*args,**kwargs):
            return Stat() if path=='/proc/self/ns/cgroup' else real_stat(path,*args,**kwargs)
        with mock.patch('builtins.open',side_effect=fixtures),mock.patch.object(backup.os,'stat',side_effect=namespace):
            self.assertEqual(backup._visible_cgroup_v2(),('/sys/fs/cgroup','service',False))

    def test_capture_refuses_hidden_cgroup_ancestors(self):
        with mock.patch.object(backup,'_visible_cgroup_v2',return_value=('/sys/fs/cgroup','service',False)),mock.patch.object(backup,'_cgroup_v2_headroom') as headroom:
            with self.assertRaisesRegex(backup.CaptureError,'Cannot verify complete cgroup ancestry'): backup._memory_headroom(1)
            headroom.assert_not_called()

class OperationHistoryTest(unittest.TestCase):
    def setUp(self):
        self.panel = sqlite3.connect(':memory:')
        self.agent = sqlite3.connect(':memory:')
        self.panel.executescript("""
            CREATE TABLE actions(id TEXT PRIMARY KEY,service_id TEXT,type TEXT,status TEXT,phase TEXT,created_at TEXT,finished_at TEXT);
            CREATE TABLE jobs(action_id TEXT UNIQUE,service_id TEXT,status TEXT,lease_until TEXT,snapshot TEXT);
        """)
        self.agent.execute('CREATE TABLE operations(id TEXT PRIMARY KEY,service_id TEXT,state TEXT,response TEXT)')
        self.panel.execute("INSERT INTO actions VALUES('old','service','deploy','failed','failed','2026-01-01T00:00:00.000Z','2026-01-01T00:01:00.000Z')")
        self.panel.execute("INSERT INTO jobs VALUES('old','service','failed',NULL,?)", (json.dumps({'id':'service','kind':'app','mounts':[]}),))
        self.agent.execute("INSERT INTO operations VALUES('old','service','failed','{}')")
        self.panel.execute("INSERT INTO actions VALUES('new','service','deploy','succeeded','complete','2026-01-01T00:02:00.000Z','2026-01-01T00:03:00.000Z')")
        self.panel.execute("INSERT INTO jobs VALUES('new','service','succeeded',NULL,?)", (json.dumps({'id':'service','kind':'app','mounts':[]}),))
        self.agent.execute("INSERT INTO operations VALUES('new','service','succeeded',?)", (json.dumps({'state':'running'}),))

    def tearDown(self):
        self.panel.close(); self.agent.close()

    def test_later_successful_deployment_preserves_failed_history(self):
        backup._validate_operation_history(self.panel, self.agent)
        self.assertEqual(self.panel.execute("SELECT status FROM actions WHERE id='old'").fetchone(), ('failed',))
        self.assertEqual(self.agent.execute("SELECT state FROM operations WHERE id='old'").fetchone(), ('failed',))

    def test_failed_history_requires_correlated_later_success(self):
        cases = [
            (self.panel, "UPDATE actions SET created_at='2026-01-01T00:00:30.000Z' WHERE id='new'"),
            (self.panel, "UPDATE actions SET type='restart' WHERE id='new'"),
            (self.panel, "UPDATE jobs SET service_id='other' WHERE action_id='new'"),
            (self.panel, "UPDATE jobs SET lease_until='held' WHERE action_id='old'"),
            (self.panel, "DELETE FROM jobs WHERE action_id='old'"),
            (self.panel, """UPDATE jobs SET snapshot='{"id":"service","kind":"postgres"}' WHERE action_id='old'"""),
            (self.panel, """UPDATE jobs SET snapshot='{"id":"service","kind":"app","mounts":[{}]}' WHERE action_id='new'"""),
            (self.panel, "UPDATE jobs SET snapshot='{}' WHERE action_id='old'"),
            (self.agent, "UPDATE operations SET service_id='other' WHERE id='new'"),
            (self.agent, "UPDATE operations SET state='failed' WHERE id='new'"),
            (self.agent, "UPDATE operations SET response='{}' WHERE id='new'"),
            (self.agent, "UPDATE operations SET response='invalid' WHERE id='new'"),
            (self.agent, "DELETE FROM operations WHERE id='old'"),
        ]
        for db, statement in cases:
            with self.subTest(statement=statement):
                db.execute('SAVEPOINT mutation')
                db.execute(statement)
                with self.assertRaises(backup.CaptureError): backup._validate_operation_history(self.panel, self.agent)
                db.execute('ROLLBACK TO mutation'); db.execute('RELEASE mutation')

    def test_running_or_queued_work_blocks_capture(self):
        for db, statement in [(self.panel, "UPDATE jobs SET status='queued' WHERE action_id='old'"),
                              (self.panel, "UPDATE actions SET status='running' WHERE id='old'"),
                              (self.agent, "UPDATE operations SET state='running' WHERE id='old'")]:
            with self.subTest(statement=statement):
                db.execute('SAVEPOINT mutation'); db.execute(statement)
                with self.assertRaises(backup.CaptureError): backup._validate_operation_history(self.panel, self.agent)
                db.execute('ROLLBACK TO mutation'); db.execute('RELEASE mutation')

@unittest.skipUnless(os.name == 'posix' and os.geteuid() == 0 and pathlib.Path('/proc/self/fd').exists() and pathlib.Path(NODE).is_file() and pathlib.Path(APP, 'dist/server/store.js').is_file(), 'Requires isolated Linux, root and a built Servus image')
class CaptureTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='servus-capture-')
        self.root = pathlib.Path(self.temp.name)
        os.chmod(self.root, 0o711)
        self.src = self.root / 'source'; self.dst = self.root / 'staging'
        self.src.mkdir(mode=0o700); self.dst.mkdir(mode=0o700)
        # Exercise the real Store migrations, vault and agent journal rather
        # than reconstructing their schema in the test.
        script = r'''import {Store} from '/app/dist/server/store.js';import {hashPassword} from '/app/dist/server/auth.js';
import {createAgent} from '/app/dist/agent/app.js';import {writeFileSync,mkdirSync} from 'node:fs';
const d=process.argv[1], id=process.argv[2];const s=new Store(d);const ref=s.vault.put('synthetic-secret');const user=s.createUser('fixture@example.test',await hashPassword('fixture-password'),'admin');
s.db.prepare('INSERT INTO projects(id,name,description,created_at) VALUES(?,?,?,?)').run(id,'fixture','before','2020-01-01');
s.db.prepare('INSERT INTO services(id,project_id,name,image,port,hostname,replicas,revision,state,created_at,updated_at,config,deployed_revision) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,id,'fixture','mariadb:11.4',3306,'fixture.internal',1,1,'running','2020-01-01','2020-01-01',JSON.stringify({kind:'mariadb'}),1);
s.db.prepare('INSERT INTO service_secret_refs(reference,service_id,purpose) VALUES (?,?,?)').run(ref,id,'database');
const rootRef=s.vault.put('synthetic-root-secret');mkdirSync(d+'/database-roots',{mode:0o700});writeFileSync(d+'/database-roots/'+id,rootRef,{mode:0o600});
writeFileSync(d+'/agent-token','42'.repeat(32),{mode:0o600});s.close();
const cfg={dataDir:d,token:'42'.repeat(32),socketPath:d+'/agent.sock',dockerSocket:'/none',ingressPort:18080,ingressImage:'unused'};
const a=await createAgent(cfg,{});await a.ready();await a.close();process.stdout.write(JSON.stringify({ref,actor:user.id}));'''
        details=json.loads(subprocess.check_output([NODE,'--input-type=module','-e',script,str(self.src),UUID],text=True))
        self.ref=details['ref'];self.actor=details['actor']
        self.panel = sqlite3.connect(self.src / 'panel.sqlite')
        self.panel.execute('PRAGMA journal_mode=WAL'); self.panel.execute('PRAGMA wal_autocheckpoint=0')
        self.panel.execute("UPDATE projects SET description='committed-wal' WHERE id=?",(UUID,));self.panel.commit()
        self.agent = sqlite3.connect(self.src / 'agent.sqlite')
        self.agent.execute('PRAGMA journal_mode=WAL'); self.agent.execute('PRAGMA wal_autocheckpoint=0')
        self.agent.execute('INSERT INTO operations (id,request_hash,state,response,updated_at,previous_spec) VALUES (?,?,?,?,?,?)',(UUID,'a'*64,'succeeded','{}','2020-01-01','{"legacy":true}'));self.agent.commit()
        self.fix_permissions()
        self.source_fd = os.open(self.src, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        self.destination_fd = os.open(self.dst, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        self.node_fd = os.open(NODE, os.O_RDONLY | os.O_NOFOLLOW)

    def fix_permissions(self):
        for path in [self.src, *self.src.rglob('*')]:
            if path.is_symlink(): continue
            os.chown(path, 1000, 1000)
            mode=0o700 if path.is_dir() else (0o644 if path.name.startswith(('panel.sqlite','agent.sqlite')) else 0o600)
            os.chmod(path,mode)

    def tearDown(self):
        for fd in ('source_fd','destination_fd','node_fd'):
            if hasattr(self, fd): os.close(getattr(self, fd))
        self.panel.close(); self.agent.close(); self.temp.cleanup()

    def capture(self,reader_gid=65534): return backup._capture_quiescent(self.source_fd,self.destination_fd,self.node_fd,source_uid=1000,reader_gid=reader_gid)

    def test_standalone_v5_capture_has_no_sidecars_and_restores(self):
        self.panel.close(); self.agent.close()
        self.capture()
        self.assertFalse(any(p.name.endswith(('-wal', '-shm', '-journal')) for p in self.dst.iterdir()))
        backup._validate_staging(self.destination_fd, self.node_fd)
        with closing(sqlite3.connect(f'file:{self.dst}/panel.sqlite?mode=ro&immutable=1',uri=True)) as db:
            self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0],5)
            self.assertEqual(db.execute('PRAGMA integrity_check').fetchall(), [('ok',)])
            self.assertEqual(db.execute('SELECT description FROM projects WHERE id=?',(UUID,)).fetchone(),('committed-wal',))
        restored=self.root/'restored-v5'; shutil.copytree(self.dst,restored)
        script="import {Store} from '/app/dist/server/store.js';import {createAgent} from '/app/dist/agent/app.js';const d=process.argv[1],s=new Store(d);if(s.vault.get(process.argv[2])!=='synthetic-secret')process.exit(2);s.close();const a=await createAgent({dataDir:d,token:'42'.repeat(32),socketPath:d+'/agent.sock',dockerSocket:'/none',ingressPort:18080,ingressImage:'unused'},{});await a.ready();await a.close();"
        subprocess.run([NODE,'--input-type=module','-e',script,str(restored),self.ref],check=True,timeout=20)
        (self.dst/'panel.sqlite-wal').touch(mode=0o600)
        with self.assertRaisesRegex(backup.CaptureError,'sidecar'):
            backup._validate_staging(self.destination_fd,self.node_fd)

    def test_standalone_v4_capture_has_no_sidecars_and_restores(self):
        self.panel.execute('ALTER TABLE service_secret_refs DROP COLUMN purpose')
        self.panel.execute('PRAGMA user_version=4'); self.panel.commit()
        self.panel.close(); self.agent.close()
        self.fix_permissions()
        self.capture()
        self.assertFalse(any(p.name.endswith(('-wal', '-shm', '-journal')) for p in self.dst.iterdir()))
        backup._validate_staging(self.destination_fd, self.node_fd)
        with closing(sqlite3.connect(f'file:{self.dst}/panel.sqlite?mode=ro&immutable=1',uri=True)) as db:
            self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0],4)
            self.assertEqual(db.execute('PRAGMA integrity_check').fetchall(), [('ok',)])
            self.assertEqual(db.execute('SELECT description FROM projects WHERE id=?',(UUID,)).fetchone(),('committed-wal',))
        restored=self.root/'restored-v4-standalone'; shutil.copytree(self.dst,restored)
        script="import {Store} from '/app/dist/server/store.js';const s=new Store(process.argv[1]);if(s.db.pragma('user_version',{simple:true})!==5||s.vault.get(process.argv[2])!=='synthetic-secret')process.exit(2);s.close()"
        subprocess.run([NODE,'--input-type=module','-e',script,str(restored),self.ref],check=True,timeout=20)

    def test_capture_rejects_private_cgroup_before_fork_or_copy(self):
        with mock.patch.object(backup,'_visible_cgroup_v2',return_value=('/sys/fs/cgroup','',False)),mock.patch.object(backup.os,'fork') as fork:
            with self.assertRaisesRegex(backup.CaptureError,'Cannot verify complete cgroup ancestry'): self.capture()
            fork.assert_not_called()
        self.assertEqual(list(self.dst.iterdir()),[])

    def test_real_cgroup_namespace_policy(self):
        expected=os.environ.get('SERVUS_CGROUP_EXPECT','host')
        if expected=='private':
            self.assertFalse(backup._visible_cgroup_v2()[2])
            with self.assertRaisesRegex(backup.CaptureError,'Cannot verify complete cgroup ancestry'): self.capture()
            self.assertEqual(list(self.dst.iterdir()),[])
        elif expected=='host':
            self.assertTrue(backup._visible_cgroup_v2()[2])
            self.capture()
            self.assertIn('manifest.json',os.listdir(self.dst))
        else: self.fail('Invalid cgroup fixture mode')

    def test_real_store_agent_committed_wal_and_isolated_restore(self):
        manifest = self.capture()
        self.assertIn('secrets/'+self.ref, manifest['files'])
        restored_dir=self.root/'restored';shutil.copytree(self.dst,restored_dir)
        with sqlite3.connect(restored_dir/'panel.sqlite') as restored:
            self.assertEqual(restored.execute('SELECT description FROM projects WHERE id=?',(UUID,)).fetchone(),('committed-wal',))
            self.assertEqual(restored.execute('PRAGMA integrity_check').fetchone(),('ok',))
        with sqlite3.connect(restored_dir/'agent.sqlite') as restored:
            self.assertEqual(restored.execute('SELECT previous_spec FROM operations WHERE id=?',(UUID,)).fetchone(),('{"legacy":true}',))
        # Start real Store and agent against the isolated copy. The fake
        # runtime has no socket or access to the host Docker daemon.
        script=r'''import {Store} from '/app/dist/server/store.js';import {createApp} from '/app/dist/server/app.js';import {createAgent} from '/app/dist/agent/app.js';const d=process.argv[1];const s=new Store(d);if(s.vault.get(process.argv[2])!=='synthetic-secret')process.exit(2);s.close();const panel=await createApp({dataDir:d,logger:false});const login=await panel.inject({method:'POST',url:'/api/v1/auth/login',payload:{email:'fixture@example.test',password:'fixture-password'}});if(login.statusCode!==200)process.exit(3);await panel.close();const cfg={dataDir:d,token:'42'.repeat(32),socketPath:d+'/agent.sock',dockerSocket:'/none',ingressPort:18080,ingressImage:'unused'};const a=await createAgent(cfg,{});await a.ready();await a.close();'''
        subprocess.run([NODE,'--input-type=module','-e',script,str(restored_dir),self.ref],check=True,timeout=20)
        raw=(self.dst/'manifest.json').read_text();self.assertNotIn('synthetic-secret',raw)
        with self.assertRaises(backup.CaptureError): self.capture()

    def test_v4_snapshot_restores_and_migrates_without_changing_source(self):
        self.panel.execute('ALTER TABLE service_secret_refs DROP COLUMN purpose')
        self.panel.execute('PRAGMA user_version=4');self.panel.commit();self.fix_permissions()
        self.capture()
        restored_dir=self.root/'restored-v4';shutil.copytree(self.dst,restored_dir)
        script="import {Store} from '/app/dist/server/store.js';const s=new Store(process.argv[1]);if(s.db.pragma('user_version',{simple:true})!==5)process.exit(2);s.close()"
        subprocess.run([NODE,'--input-type=module','-e',script,str(restored_dir)],check=True,timeout=20)
        self.assertEqual(self.panel.execute('PRAGMA user_version').fetchone(),(4,))

    def test_v4_capture_stages_verified_restore_and_preserves_source(self):
        self.panel.execute('ALTER TABLE service_secret_refs DROP COLUMN purpose')
        self.panel.execute('PRAGMA user_version=4');self.panel.commit();self.fix_permissions()
        self.capture()
        def load(name, filename):
            spec=importlib.util.spec_from_file_location(name,ROOT/'apps/updater'/filename)
            module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
        supervisor=load('restore_real_supervisor','supervisor.py')
        coordinator=load('restore_real_coordinator','update-coordinator.py')
        restore=load('restore_real_snapshot','restore-snapshot.py')
        adoption=load('restore_real_adoption','adoption-proof.py')
        runtime=load('restore_real_runtime','runtime-policy.py')
        updater=load('restore_real_updater','servus-updater.py')
        with tempfile.TemporaryDirectory(dir='/root') as protected:
            parent=pathlib.Path(protected)/'migration';parent.mkdir(mode=0o711)
            snapshot=pathlib.Path(protected)/'snapshot';shutil.copytree(self.dst,snapshot)
            manifest=(snapshot/'manifest.json').read_bytes()
            digest='sha256:'+hashlib.sha256(manifest).hexdigest()
            destination=restore.stage(str(snapshot),digest,str(parent),UUID,
                                      backup,self.node_fd,supervisor,coordinator)
            install=pathlib.Path(protected)/'install';install.mkdir(mode=0o700);(install/'install.lock').touch(mode=0o600)
            state=pathlib.Path(protected)/'state';state.mkdir(mode=0o700);journal=updater.Journal(state)
            attempt='12345678-1234-4123-8123-123456789abd';prep='12345678-1234-4123-8123-123456789abe'
            image='sha256:'+'a'*64;config='sha256:'+'b'*64;nonce='c'*64
            active=str(pathlib.Path(protected)/'active.env');policy_path=str(pathlib.Path(protected)/'policy');accepted=str(pathlib.Path(protected)/'accepted.env')
            journal.db.execute('CREATE TABLE policy_approvals(operation_id TEXT,attempt_id TEXT,attempt_nonce TEXT,preparation_id TEXT,root_digest TEXT,image_config_digest TEXT,policy_path TEXT,accepted_env_path TEXT,source_env_path TEXT,state TEXT)')
            journal.db.execute('INSERT INTO operations(id,commit_sha,digest,tag,status,attempt_id,attempt_nonce,config_digest) VALUES(?,?,?,?,?,?,?,?)',(UUID,'d'*40,image,'v1.0.0','verified',attempt,nonce,config))
            journal.db.execute('INSERT INTO preparations(operation_id,attempt_id,attempt_nonce,preparation_id,status) VALUES(?,?,?,?,?)',(UUID,attempt,nonce,prep,'prepared'))
            journal.db.execute('INSERT INTO policy_approvals VALUES(?,?,?,?,?,?,?,?,?,?)',(UUID,attempt,nonce,prep,image,config,policy_path,accepted,active,'active'))
            approved=SimpleNamespace(install_dir=str(install),data_dir=destination,image_reference='ghcr.io/raxon/servus@'+image)
            daemon=SimpleNamespace(resolve_active_policy=lambda *_:(policy_path,accepted,approved))
            quiet=SimpleNamespace(ensure_host_namespaces=lambda:None,ensure_no_uid_writers=lambda _:None,ensure_no_open_data=lambda _:None)
            lock=os.open(install/'install.lock',os.O_RDONLY);fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            try:
                with mock.patch.object(supervisor,'RuntimePolicy',SimpleNamespace):
                    identity=adoption.record(journal,UUID,active,str(snapshot),digest,str(parent),backup,self.node_fd,supervisor,daemon,runtime,coordinator,restore,quiet,inherited_lock=lock)
                    self.assertEqual(adoption.verify(journal,UUID,active,backup,self.node_fd,supervisor,daemon,coordinator,restore,quiet,install_lock=lock),identity)
                    self.assertEqual(adoption.claim(journal,UUID,active,backup,self.node_fd,supervisor,daemon,coordinator,restore,quiet,install_lock=lock),identity)
                    self.assertEqual(journal.db.execute('SELECT state FROM initial_adoptions').fetchone(),('consumed',))
                    self.assertEqual(journal.db.execute('SELECT phase FROM initial_generations').fetchone(),('starting',))
            finally:os.close(lock);journal.close()
            script="import {Store} from '/app/dist/server/store.js';const s=new Store(process.argv[1]);if(s.db.pragma('user_version',{simple:true})!==5||s.vault.get(process.argv[2])!=='synthetic-secret')process.exit(2);s.close()"
            subprocess.run([NODE,'--input-type=module','-e',script,destination,self.ref],check=True,timeout=20)
            self.assertEqual(self.panel.execute('PRAGMA user_version').fetchone(),(4,))
            self.assertEqual((pathlib.Path(destination)/'panel.sqlite').stat().st_uid,1000)

    def test_wrong_key_or_corrupted_ciphertext_is_rejected(self):
        (self.src/'secret-key').write_text('43'*32); self.fix_permissions()
        with self.assertRaisesRegex(backup.CaptureError,'Encryption verification failed'): self.capture()
        self.assertFalse((self.dst/'manifest.json').exists())

    def test_missing_reference_is_rejected(self):
        (self.src/'secrets'/self.ref).unlink()
        with self.assertRaisesRegex(backup.CaptureError,'referenced secret is missing'): self.capture()
        self.assertFalse((self.dst/'manifest.json').exists())

    def add_other_service(self):
        other='22345678-1234-4123-8123-123456789abc'
        self.panel.execute("INSERT INTO services(id,project_id,name,image,port,hostname,replicas,revision,state,created_at,updated_at,config) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",(other,UUID,'other','test',80,'other.internal',1,1,'created','2020-01-01','2020-01-01','{}'))
        self.panel.execute('UPDATE service_secret_refs SET service_id=? WHERE reference=?',(other,self.ref))
        return other

    def test_foreign_secret_in_service_config_is_rejected_by_real_store_and_capture(self):
        self.add_other_service()
        config={'kind':'mariadb','database':{'database':'app','user':'app','passwordSecretRef':self.ref}}
        self.panel.execute('UPDATE services SET config=? WHERE id=?',(json.dumps(config),UUID));self.panel.commit();self.fix_permissions()
        script="import {Store} from '/app/dist/server/store.js';const s=new Store(process.argv[1]);try{s.requireOwnedSecret(process.argv[2],process.argv[3]);process.exit(2)}catch(e){if(e.code!=='SECRET_REFERENCE')process.exit(3)}finally{s.close()}"
        subprocess.run([NODE,'--input-type=module','-e',script,str(self.src),UUID,self.ref],check=True,timeout=20)
        with self.assertRaisesRegex(backup.CaptureError,'belongs to another service'): self.capture()
        self.assertFalse((self.dst/'manifest.json').exists())

    def test_foreign_secret_in_succeeded_job_snapshot_is_rejected(self):
        self.add_other_service()
        snapshot={'environment':[{'name':'TOKEN','secret':True,'secretRef':self.ref}]}
        self.panel.execute("INSERT INTO actions(id,project_id,service_id,actor_id,type,status,phase,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",(UUID,UUID,UUID,self.actor,'deploy','succeeded','finished','2020-01-01','2020-01-01'))
        self.panel.execute("INSERT INTO jobs(id,action_id,service_id,snapshot,status,attempts,created_at) VALUES(?,?,?,?,?,?,?)",(UUID,UUID,UUID,json.dumps(snapshot),'succeeded',1,'2020-01-01'))
        self.panel.commit();self.fix_permissions()
        with self.assertRaisesRegex(backup.CaptureError,'belongs to another service'): self.capture()
        self.assertFalse((self.dst/'manifest.json').exists())

    def test_git_credential_reference_cannot_be_used_as_environment(self):
        self.panel.execute("UPDATE service_secret_refs SET purpose='git' WHERE reference=?",(self.ref,))
        config={'kind':'app','environment':[{'name':'TOKEN','secret':True,'secretRef':self.ref}]}
        self.panel.execute('UPDATE services SET config=? WHERE id=?',(json.dumps(config),UUID));self.panel.commit();self.fix_permissions()
        with self.assertRaisesRegex(backup.CaptureError,'invalid purpose'): self.capture()
        self.assertFalse((self.dst/'manifest.json').exists())

    def add_git_credential(self, *, service_id=UUID, repository='https://github.com/example/private.git', username='git-user'):
        script=r'''import {Store} from '/app/dist/server/store.js';const [dir,service,repository,username]=process.argv.slice(1);const s=new Store(dir);const ref=s.vault.put(JSON.stringify({kind:'git-credential-v1',serviceId:service,repository,username,token:'fixture-git-token'}));s.db.prepare('INSERT INTO service_secret_refs(reference,service_id,purpose) VALUES (?,?,?)').run(ref,'12345678-1234-4123-8123-123456789abc','git');s.close();process.stdout.write(ref);'''
        reference=subprocess.check_output([NODE,'--input-type=module','-e',script,str(self.src),service_id,repository,username],text=True,timeout=20)
        config={'kind':'app','source':{'type':'git','repository':'https://github.com/example/private.git','branch':'main','context':'.','dockerfile':'Dockerfile','credential':{'username':'git-user','secretRef':reference}}}
        self.panel.execute('UPDATE services SET config=? WHERE id=?',(json.dumps(config),UUID));self.panel.commit();self.fix_permissions()
        return reference,config

    def test_git_metadata_is_checked_for_matching_configuration_and_snapshot(self):
        reference,config=self.add_git_credential()
        self.panel.execute("INSERT INTO actions(id,project_id,service_id,actor_id,type,status,phase,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",(UUID,UUID,UUID,self.actor,'deploy','succeeded','finished','2020-01-01','2020-01-01'))
        self.panel.execute("INSERT INTO jobs(id,action_id,service_id,snapshot,status,attempts,created_at) VALUES(?,?,?,?,?,?,?)",(UUID,UUID,UUID,json.dumps(config),'succeeded',1,'2020-01-01'))
        self.panel.commit();self.fix_permissions();manifest=self.capture()
        self.assertIn('secrets/'+reference,manifest['files']);self.assertNotIn('fixture-git-token',json.dumps(manifest))

    def test_git_metadata_rejects_mismatched_repository(self):
        self.add_git_credential(repository='https://github.com/other/repo.git')
        with self.assertRaisesRegex(backup.CaptureError,'Encryption verification failed'): self.capture()
        self.assertFalse((self.dst/'manifest.json').exists())

    def test_git_metadata_rejects_mismatched_username(self):
        self.add_git_credential(username='other-user')
        with self.assertRaisesRegex(backup.CaptureError,'Encryption verification failed'): self.capture()
        self.assertFalse((self.dst/'manifest.json').exists())

    def test_git_metadata_rejects_mismatched_service(self):
        self.add_git_credential(service_id='22345678-1234-4123-8123-123456789abc')
        with self.assertRaisesRegex(backup.CaptureError,'Encryption verification failed'): self.capture()
        self.assertFalse((self.dst/'manifest.json').exists())

    def test_git_metadata_checks_every_historical_job_snapshot(self):
        _reference,config=self.add_git_credential()
        config['source']['repository']='https://github.com/other/repo.git'
        self.panel.execute("INSERT INTO actions(id,project_id,service_id,actor_id,type,status,phase,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",(UUID,UUID,UUID,self.actor,'deploy','succeeded','finished','2020-01-01','2020-01-01'))
        self.panel.execute("INSERT INTO jobs(id,action_id,service_id,snapshot,status,attempts,created_at) VALUES(?,?,?,?,?,?,?)",(UUID,UUID,UUID,json.dumps(config),'succeeded',1,'2020-01-01'))
        self.panel.commit();self.fix_permissions()
        with self.assertRaisesRegex(backup.CaptureError,'Encryption verification failed'): self.capture()
        self.assertFalse((self.dst/'manifest.json').exists())

    def test_docker_group_is_rejected(self):
        original=backup.grp.getgrgid
        class DockerGroup: gr_name='docker'
        backup.grp.getgrgid=lambda _gid:DockerGroup()
        try:
            with self.assertRaisesRegex(backup.CaptureError,'Reader group is not trusted'): self.capture()
        finally: backup.grp.getgrgid=original
        self.assertFalse((self.dst/'manifest.json').exists())

    def test_symlink_is_refused(self):
        p=self.src/'secrets'/self.ref;p.unlink();p.symlink_to(self.src/'secret-key')
        secret_dir=os.open(self.src/'secrets',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
        try:
            with self.assertRaises(OSError) as rejected:
                backup._file(secret_dir,self.ref,1000,os.fstat(secret_dir).st_dev)
            self.assertEqual(rejected.exception.errno,errno.ELOOP)
        finally: os.close(secret_dir)
        with self.assertRaises(backup.CaptureError): self.capture()
        self.assertFalse((self.dst/'manifest.json').exists())

    def test_hardlink_is_refused(self):
        p=self.src/'secrets'/self.ref;os.link(p,self.src/'secrets'/UUID)
        with self.assertRaises(backup.CaptureError): self.capture()
        self.assertFalse((self.dst/'manifest.json').exists())

    def test_running_agent_operation_is_refused(self):
        self.agent.execute("UPDATE operations SET state='running'");self.agent.commit();self.fix_permissions()
        with self.assertRaisesRegex(backup.CaptureError,'Unresolved agent'): self.capture()
        self.assertFalse((self.dst/'manifest.json').exists())

    def test_failed_agent_rollback_is_refused(self):
        self.agent.execute("UPDATE operations SET state='failed',operation_stage='rolling_back'");self.agent.commit();self.fix_permissions()
        with self.assertRaisesRegex(backup.CaptureError,'Unresolved failed operations'): self.capture()
        self.assertFalse((self.dst/'manifest.json').exists())

    def test_queued_panel_job_is_refused(self):
        self.panel.execute("INSERT INTO actions(id,project_id,service_id,actor_id,type,status,phase,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",(UUID,UUID,UUID,self.actor,'deploy','queued','queued','2020-01-01','2020-01-01'))
        self.panel.execute("INSERT INTO jobs(id,action_id,service_id,snapshot,status,attempts,created_at) VALUES(?,?,?,?,?,?,?)",(UUID,UUID,UUID,'{}','queued',0,'2020-01-01'));self.panel.commit();self.fix_permissions()
        with self.assertRaisesRegex(backup.CaptureError,'Unresolved panel jobs'): self.capture()
        self.assertFalse((self.dst/'manifest.json').exists())

    def test_failed_panel_job_is_refused(self):
        self.panel.execute("INSERT INTO actions(id,project_id,service_id,actor_id,type,status,phase,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",(UUID,UUID,UUID,self.actor,'deploy','failed','failed','2020-01-01','2020-01-01'))
        self.panel.execute("INSERT INTO jobs(id,action_id,service_id,snapshot,status,attempts,created_at) VALUES(?,?,?,?,?,?,?)",(UUID,UUID,UUID,'{}','failed',1,'2020-01-01'));self.panel.commit();self.fix_permissions()
        with self.assertRaisesRegex(backup.CaptureError,'Unresolved failed operations'): self.capture()
        self.assertFalse((self.dst/'manifest.json').exists())

    def test_capture_preserves_superseded_failed_deployment(self):
        old='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
        new='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
        for ident,status,phase,created,finished in (
            (old,'failed','failed','2026-01-01T00:00:00.000Z','2026-01-01T00:01:00.000Z'),
            (new,'succeeded','complete','2026-01-01T00:02:00.000Z','2026-01-01T00:03:00.000Z')):
            self.panel.execute('INSERT INTO actions(id,project_id,service_id,actor_id,type,status,phase,created_at,updated_at,finished_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
                               (ident,UUID,UUID,self.actor,'deploy',status,phase,created,finished,finished))
            self.panel.execute('INSERT INTO jobs(id,action_id,service_id,snapshot,status,attempts,created_at) VALUES(?,?,?,?,?,?,?)',
                               (ident,ident,UUID,json.dumps({'id':UUID,'kind':'app','mounts':[]}),status,1,created))
            response=json.dumps({'state':'running'}) if status=='succeeded' else json.dumps({'error':{'code':'RUNTIME_FAILED'}})
            self.agent.execute('INSERT INTO operations(id,request_hash,state,response,updated_at,service_id,operation_stage) VALUES(?,?,?,?,?,?,?)',
                               (ident,'a'*64,status,response,finished,UUID,'applying' if status=='succeeded' else 'rolling_back'))
        self.panel.commit(); self.agent.commit(); self.fix_permissions()
        self.capture()
        with closing(sqlite3.connect(f'file:{self.dst}/panel.sqlite?mode=ro&immutable=1',uri=True)) as panel:
            self.assertEqual(panel.execute('SELECT status FROM actions WHERE id=?',(old,)).fetchone(),('failed',))
        with closing(sqlite3.connect(f'file:{self.dst}/agent.sqlite?mode=ro&immutable=1',uri=True)) as agent:
            self.assertEqual(agent.execute('SELECT state,operation_stage FROM operations WHERE id=?',(old,)).fetchone(),('failed','rolling_back'))

    def test_malformed_legacy_json_is_refused(self):
        self.agent.execute("UPDATE operations SET previous_spec='not-json'");self.agent.commit();self.fix_permissions()
        with self.assertRaisesRegex(backup.CaptureError,'Agent snapshot is invalid'): self.capture()
        self.assertFalse((self.dst/'manifest.json').exists())

    def test_missing_mariadb_root_reference_is_refused(self):
        (self.src/'database-roots'/UUID).unlink()
        with self.assertRaisesRegex(backup.CaptureError,'MariaDB root reference is missing'): self.capture()
        self.assertFalse((self.dst/'manifest.json').exists())

    def test_source_owner_and_destination_permissions_are_checked(self):
        os.chmod(self.dst,0o755)
        with self.assertRaises(backup.CaptureError): self.capture()
        self.assertFalse((self.dst/'manifest.json').exists())

    def test_reader_runs_as_source_owner_and_cannot_modify_staging(self):
        original=backup._database_to_temp
        def probe(*args):
            if os.geteuid()!=1000 or os.getegid()!=65534 or os.getgroups(): raise RuntimeError('Reader is privileged')
            try: os.open(str(self.dst/'unexpected'),os.O_WRONLY|os.O_CREAT,0o600)
            except PermissionError: pass
            else: raise RuntimeError('Reader can modify staging')
            return original(*args)
        backup._database_to_temp=probe
        try: self.capture()
        finally: backup._database_to_temp=original
        self.assertFalse((self.dst/'unexpected').exists())

    def test_root_group_on_source_never_becomes_reader_group(self):
        os.chown(self.src,1000,0)
        with self.assertRaisesRegex(backup.CaptureError,'Capture environment is invalid'): self.capture(reader_gid=0)
        self.assertFalse((self.dst/'manifest.json').exists())
        self.capture(reader_gid=65534)

    def test_caller_tmpdir_is_ignored(self):
        target=self.src/'untrusted-temp';target.mkdir(mode=0o700);os.chown(target,1000,1000)
        old=os.environ.get('TMPDIR');os.environ['TMPDIR']=str(target)
        try: self.capture()
        finally:
            if old is None: os.environ.pop('TMPDIR',None)
            else: os.environ['TMPDIR']=old
        self.assertEqual(list(target.iterdir()),[])

    def test_sigkill_leaves_no_named_database_copy(self):
        before=set(pathlib.Path('/tmp').glob('servus-capture-reader-*'))
        read_fd,write_fd=os.pipe(); pid=os.fork()
        if pid==0:
            os.close(read_fd);os.dup2(write_fd,2);os.close(write_fd)
            def stall(_sock,_name,_fd,_size):
                os.write(2,('READY:'+str(os.getpid())+'\n').encode());signal.pause()
            backup._send_file=stall
            try: self.capture()
            finally: os._exit(1)
        os.close(write_fd)
        reader_pid=None
        try:
            readable,_,_=select.select([read_fd],[],[],20)
            self.assertTrue(readable,'Reader did not reach anonymous snapshot')
            line=os.read(read_fd,128).decode('ascii').strip();self.assertRegex(line,r'^READY:[0-9]+$')
            reader_pid=int(line.split(':')[1]); created=set(pathlib.Path('/tmp').glob('servus-capture-reader-*'))-before
            self.assertEqual(created,set())
            os.kill(pid,signal.SIGKILL);os.waitpid(pid,0);pid=None
            for _ in range(100):
                try:
                    state=pathlib.Path(f'/proc/{reader_pid}/status').read_text().split('State:',1)[1].lstrip()[0]
                except (FileNotFoundError,ProcessLookupError): break
                if state=='Z': break
                time.sleep(.05)
            else: self.fail('Reader survived coordinator death')
            self.assertFalse((self.dst/'manifest.json').exists())
            self.assertEqual(set(pathlib.Path('/tmp').glob('servus-capture-reader-*'))-before,set())
        finally:
            os.close(read_fd)
            if pid is not None:
                try: os.kill(pid,signal.SIGKILL)
                except ProcessLookupError: pass
                os.waitpid(pid,0)

    def test_memory_exhaustion_aborts_without_manifest(self):
        original=backup._memory_headroom
        def exhausted(_size): raise MemoryError('Simulated allocation failure')
        backup._memory_headroom=exhausted
        try:
            with self.assertRaises(backup.CaptureError): self.capture()
        finally: backup._memory_headroom=original
        self.assertFalse((self.dst/'manifest.json').exists())

    def test_oversize_database_aborts_without_manifest(self):
        original=backup.MAX_DATABASE
        backup.MAX_DATABASE=1
        try:
            with self.assertRaises(backup.CaptureError): self.capture()
        finally: backup.MAX_DATABASE=original
        self.assertFalse((self.dst/'manifest.json').exists())

    def test_unknown_schema_is_refused(self):
        self.panel.execute('CREATE TABLE unexpected (value TEXT)');self.panel.commit();self.fix_permissions()
        with self.assertRaisesRegex(backup.CaptureError,'Unsupported database schema'): self.capture()
        self.assertFalse((self.dst/'manifest.json').exists())


if __name__=='__main__': unittest.main()
