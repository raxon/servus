import importlib.util
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
s.db.prepare('INSERT INTO service_secret_refs(reference,service_id) VALUES (?,?)').run(ref,id);
mkdirSync(d+'/database-roots',{mode:0o700});writeFileSync(d+'/database-roots/'+id,ref,{mode:0o600});
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
        with self.assertRaisesRegex(backup.CaptureError,'Unresolved agent'): self.capture()
        self.assertFalse((self.dst/'manifest.json').exists())

    def test_queued_panel_job_is_refused(self):
        self.panel.execute("INSERT INTO actions(id,project_id,service_id,actor_id,type,status,phase,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",(UUID,UUID,UUID,self.actor,'deploy','queued','queued','2020-01-01','2020-01-01'))
        self.panel.execute("INSERT INTO jobs(id,action_id,service_id,snapshot,status,attempts,created_at) VALUES(?,?,?,?,?,?,?)",(UUID,UUID,UUID,'{}','queued',0,'2020-01-01'));self.panel.commit();self.fix_permissions()
        with self.assertRaisesRegex(backup.CaptureError,'Unresolved panel jobs'): self.capture()
        self.assertFalse((self.dst/'manifest.json').exists())

    def test_failed_panel_job_is_refused(self):
        self.panel.execute("INSERT INTO actions(id,project_id,service_id,actor_id,type,status,phase,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",(UUID,UUID,UUID,self.actor,'deploy','failed','failed','2020-01-01','2020-01-01'))
        self.panel.execute("INSERT INTO jobs(id,action_id,service_id,snapshot,status,attempts,created_at) VALUES(?,?,?,?,?,?,?)",(UUID,UUID,UUID,'{}','failed',1,'2020-01-01'));self.panel.commit();self.fix_permissions()
        with self.assertRaisesRegex(backup.CaptureError,'Unresolved panel jobs'): self.capture()
        self.assertFalse((self.dst/'manifest.json').exists())

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
