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
import stat
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

class RestoreJournalSchemaTest(unittest.TestCase):
    def test_dns_journal_only_allows_well_formed_terminal_operations(self):
        schema={**backup.AGENT_SCHEMA,'acme_dns_challenges':backup.AGENT_DNS_COLUMNS}
        with sqlite3.connect(':memory:') as db:
            for table,columns in schema.items():
                db.execute('CREATE TABLE '+table+' ('+','.join(column+' TEXT' for column in columns)+')')
            backup._agent_schema(db)
            values=['a'*32,'*.example.com','_acme-challenge.example.com','A'*43,'cloudflare','completed','b'*32,'valid',None,'2026-11-15T00:00:00.000Z']
            db.execute('INSERT INTO acme_dns_challenges(operation_id,identifier,record_name,value,provider,state,record_id,outcome,review_from,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)',values)
            backup._agent_schema(db)
            for phase in ('pending','presenting','awaiting_manual','awaiting_dns','ready','validating','ready_to_cleanup','cleaning','awaiting_manual_cleanup','needs_review'):
                with self.subTest(phase=phase):
                    db.execute('UPDATE acme_dns_challenges SET state=?',(phase,))
                    with self.assertRaisesRegex(backup.CaptureError,'Unresolved DNS challenge'): backup._agent_schema(db)
            db.execute("UPDATE acme_dns_challenges SET state='completed'")
            for column,bad in (('operation_id','bad'),('identifier','EXAMPLE.COM'),('record_name','other.example.com'),('value','A'*42+'B'),('provider','unknown'),('record_id',None),('outcome',None),('review_from','cleaning'),('updated_at','today')):
                with self.subTest(column=column):
                    old=db.execute('SELECT '+column+' FROM acme_dns_challenges').fetchone()[0]
                    db.execute('UPDATE acme_dns_challenges SET '+column+'=?',(bad,))
                    with self.assertRaisesRegex(backup.CaptureError,'DNS challenge journal is invalid'): backup._agent_schema(db)
                    db.execute('UPDATE acme_dns_challenges SET '+column+'=?',(old,))
            db.execute("UPDATE acme_dns_challenges SET state='cancelled',outcome='cancelled',record_id=NULL")
            backup._agent_schema(db)
            db.execute("UPDATE acme_dns_challenges SET provider='manual',state='completed',outcome='valid'")
            backup._agent_schema(db)
            db.execute("UPDATE acme_dns_challenges SET record_id=?",('b'*32,))
            with self.assertRaises(backup.CaptureError): backup._agent_schema(db)

    def test_upload_lock_and_review_tables_are_validated(self):
        schema={**backup.AGENT_RESTORE_SCHEMA,'restore_upload_locks':{'operation_id','lock_id'},'restore_review_phases':{'operation_id','phase'}}
        with sqlite3.connect(':memory:') as db:
            for table, columns in schema.items():
                db.execute('CREATE TABLE ' + table + ' (' + ','.join(column + ' TEXT' for column in columns) + ')')
            ident='a'*32; now='2026-11-15T00:00:00.000Z'
            db.execute('INSERT INTO restore_operations(id,service_id,kind,archive_sha256,phase,updated_at) VALUES(?,?,?,?,?,?)',(ident,UUID,'postgres','b'*64,'cancelled',now))
            db.execute('INSERT INTO restore_upload_locks(operation_id,lock_id) VALUES(?,?)',(ident,'c'*32))
            backup._agent_schema(db)
            db.execute("UPDATE restore_upload_locks SET lock_id='bad'")
            with self.assertRaisesRegex(backup.CaptureError,'Upload lock journal is invalid'): backup._agent_schema(db)
            db.execute("UPDATE restore_upload_locks SET lock_id=?",('c'*32,))
            db.execute('DELETE FROM restore_operations')
            with self.assertRaisesRegex(backup.CaptureError,'Upload lock journal is invalid'): backup._agent_schema(db)
            db.execute('DELETE FROM restore_upload_locks')
            db.execute('INSERT INTO restore_operations(id,service_id,kind,archive_sha256,phase,updated_at) VALUES(?,?,?,?,?,?)',(ident,UUID,'postgres','b'*64,'cancelled',now))
            db.execute('INSERT INTO restore_review_phases(operation_id,phase) VALUES(?,?)',(ident,'importing'))
            with self.assertRaises(backup.CaptureError): backup._agent_schema(db)

    def test_upload_and_discard_remain_unresolved_for_backup(self):
        with sqlite3.connect(':memory:') as db:
            for table, columns in backup.AGENT_RESTORE_SCHEMA.items():
                db.execute('CREATE TABLE ' + table + ' (' + ','.join(column + ' TEXT' for column in columns) + ')')
            for phase in ('uploading', 'discarding', 'discarding_candidate'):
                with self.subTest(phase=phase):
                    db.execute('DELETE FROM restore_operations')
                    db.execute('INSERT INTO restore_operations(id,service_id,kind,archive_sha256,phase,updated_at) VALUES(?,?,?,?,?,?)',
                        ('a'*32,UUID,'postgres','b'*64,phase,'2026-11-15T00:00:00.000Z'))
                    with self.assertRaisesRegex(backup.CaptureError,'Unresolved database restore'): backup._agent_schema(db)

    def test_switch_intents_must_be_empty_for_backup(self):
        with sqlite3.connect(':memory:') as db:
            for table, columns in backup.AGENT_SWITCH_SCHEMA.items():
                db.execute('CREATE TABLE ' + table + ' (' + ','.join(column + ' TEXT' for column in columns) + ')')
            backup._agent_schema(db)
            db.execute('INSERT INTO restore_switch_intents(id,service_id,service_version,sealed_plan,created_at) VALUES(?,?,?,?,?)',('a'*32,UUID,'1','encrypted','2026-11-15T00:00:00.000Z'))
            with self.assertRaisesRegex(backup.CaptureError,'Unresolved database restore'): backup._agent_schema(db)

    def test_retained_volume_must_reference_a_cancelled_restore(self):
        with sqlite3.connect(':memory:') as db:
            schema={**backup.AGENT_SWITCH_SCHEMA,'restore_retained_volumes':backup.AGENT_RETAINED_COLUMNS}
            for table, columns in schema.items():
                db.execute('CREATE TABLE ' + table + ' (' + ','.join(column + ' TEXT' for column in columns) + ')')
            now='2026-11-15T00:00:00.000Z'; ident='a'*32
            db.execute('INSERT INTO restore_operations(id,service_id,kind,archive_sha256,phase,updated_at) VALUES(?,?,?,?,?,?)',(ident,UUID,'postgres','b'*64,'cancelled',now))
            db.execute('INSERT INTO restore_retained_volumes(operation_id,service_id,volume_name,reason,created_at) VALUES(?,?,?,?,?)',(ident,UUID,'panel-restore-'+ident,'rollback_candidate',now))
            backup._agent_schema(db)
            db.execute("UPDATE restore_retained_volumes SET volume_name='wrong'")
            with self.assertRaisesRegex(backup.CaptureError,'Retained database restore volume is invalid'): backup._agent_schema(db)

    def test_completed_restore_binding_requires_matching_retained_source(self):
        with sqlite3.connect(':memory:') as db:
            schema={**backup.AGENT_SWITCH_SCHEMA,'restore_retained_volumes':backup.AGENT_RETAINED_COLUMNS,'restore_volume_bindings':backup.AGENT_BINDING_COLUMNS}
            for table, columns in schema.items():
                db.execute('CREATE TABLE ' + table + ' (' + ','.join(column + ' TEXT' for column in columns) + ')')
            now='2026-11-15T00:00:00.000Z'; ident='a'*32
            db.execute('INSERT INTO restore_operations(id,service_id,kind,archive_sha256,phase,updated_at) VALUES(?,?,?,?,?,?)',(ident,UUID,'postgres','b'*64,'completed',now))
            db.execute('INSERT INTO restore_retained_volumes(operation_id,service_id,volume_name,reason,created_at) VALUES(?,?,?,?,?)',(ident,UUID,'panel-data-'+UUID+'-database','pre_restore_source',now))
            db.execute('INSERT INTO restore_volume_bindings(service_id,operation_id,volume_name,kind,created_at) VALUES(?,?,?,?,?)',(UUID,ident,'panel-restore-'+ident,'postgres',now))
            backup._agent_schema(db)
            db.execute("UPDATE restore_volume_bindings SET kind='mariadb'")
            with self.assertRaisesRegex(backup.CaptureError,'Database restore volume binding is invalid'): backup._agent_schema(db)


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

    def test_standalone_v9_capture_has_no_sidecars_and_restores(self):
        profile_id='11111111-1111-4111-8111-111111111111'
        script=r'''import {Store} from '/app/dist/server/store.js';const s=new Store(process.argv[1]);const ref=s.vault.put(JSON.stringify({kind:'backup-global-v1',destination:{type:'s3',provider:'s3',endpoint:'https://s3.example.test',region:'us-east-1',bucket:'backups',prefix:'',storageClass:'STANDARD',accessKeyId:'fixture',secretAccessKey:'fixture'}}));s.db.prepare('INSERT INTO backup_storage_profiles(id,name,destination_ref,updated_at,active) VALUES(?,?,?,?,1)').run(process.argv[2],'Offsite',ref,'2026-11-18T00:00:00.000Z');s.close();'''
        self.panel.close(); self.agent.close()
        subprocess.run([NODE,'--input-type=module','-e',script,str(self.src),profile_id],check=True,timeout=20)
        self.fix_permissions()
        self.capture()
        self.assertFalse(any(p.name.endswith(('-wal', '-shm', '-journal')) for p in self.dst.iterdir()))
        backup._validate_staging(self.destination_fd, self.node_fd)
        with closing(sqlite3.connect(f'file:{self.dst}/panel.sqlite?mode=ro&immutable=1',uri=True)) as db:
            self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0],9)
            self.assertEqual(db.execute('PRAGMA integrity_check').fetchall(), [('ok',)])
            self.assertEqual(db.execute('SELECT description FROM projects WHERE id=?',(UUID,)).fetchone(),('committed-wal',))
            self.assertEqual(db.execute('SELECT name FROM backup_storage_profiles WHERE id=?',(profile_id,)).fetchone(),('Offsite',))
        restored=self.root/'restored-v9'; shutil.copytree(self.dst,restored)
        script="import {Store} from '/app/dist/server/store.js';import {createAgent} from '/app/dist/agent/app.js';const d=process.argv[1],s=new Store(d);if(s.db.pragma('user_version',{simple:true})!==9||s.vault.get(process.argv[2])!=='synthetic-secret')process.exit(2);s.close();const a=await createAgent({dataDir:d,token:'42'.repeat(32),socketPath:d+'/agent.sock',dockerSocket:'/none',ingressPort:18080,ingressImage:'unused'},{});await a.ready();await a.close();"
        subprocess.run([NODE,'--input-type=module','-e',script,str(restored),self.ref],check=True,timeout=20)
        (self.dst/'panel.sqlite-wal').touch(mode=0o600)
        with self.assertRaisesRegex(backup.CaptureError,'sidecar'):
            backup._validate_staging(self.destination_fd,self.node_fd)

    def _downgrade_v9_to_v8(self):
        for table, column in (('database_backup_settings','profile_id'),('database_backup_settings','encrypted'),('database_backup_settings','retention_policy'),('database_backups','encrypted'),('database_backups','plaintext_size'),('volume_backup_settings','profile_id')):
            self.panel.execute(f'ALTER TABLE {table} DROP COLUMN {column}')
        self.panel.execute('DROP TABLE backup_storage_profiles')

    def test_standalone_v8_snapshot_remains_readable_and_migrates_only_its_copy(self):
        self._downgrade_v9_to_v8()
        self.panel.execute('PRAGMA user_version=8');self.panel.commit();self.panel.close();self.agent.close();self.fix_permissions()
        self.capture();backup._validate_staging(self.destination_fd,self.node_fd)
        restored=self.root/'restored-v8';shutil.copytree(self.dst,restored)
        script="import {Store} from '/app/dist/server/store.js';const s=new Store(process.argv[1]);if(s.db.pragma('user_version',{simple:true})!==9||s.vault.get(process.argv[2])!=='synthetic-secret')process.exit(2);s.close()"
        subprocess.run([NODE,'--input-type=module','-e',script,str(restored),self.ref],check=True,timeout=20)
        for path in (self.src,self.dst):
            with closing(sqlite3.connect(path/'panel.sqlite')) as original:
                self.assertEqual(original.execute('PRAGMA user_version').fetchone()[0],8)

    def test_standalone_v4_capture_has_no_sidecars_and_restores(self):
        for table in ('volume_restores','volume_backups','volume_backup_settings','api_tokens','database_backups','database_backup_settings','backup_storage_profiles','compose_domains','compose_actions','compose_workloads','two_factor_auth','deployment_webhooks'):
            self.panel.execute('DROP TABLE '+table)
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
        script="import {Store} from '/app/dist/server/store.js';const s=new Store(process.argv[1]);if(s.db.pragma('user_version',{simple:true})!==9||s.vault.get(process.argv[2])!=='synthetic-secret')process.exit(2);s.close()"
        subprocess.run([NODE,'--input-type=module','-e',script,str(restored),self.ref],check=True,timeout=20)

    def test_standalone_v6_snapshot_remains_readable_and_migrates_only_its_copy(self):
        self._downgrade_v9_to_v8()
        for table in ('volume_restores','volume_backups','volume_backup_settings'):
            self.panel.execute('DROP TABLE '+table)
        self.panel.execute('PRAGMA user_version=6');self.panel.commit();self.panel.close();self.agent.close();self.fix_permissions()
        self.capture();backup._validate_staging(self.destination_fd,self.node_fd)
        restored=self.root/'restored-v6';shutil.copytree(self.dst,restored)
        script="import {Store} from '/app/dist/server/store.js';const s=new Store(process.argv[1]);if(s.db.pragma('user_version',{simple:true})!==9||s.vault.get(process.argv[2])!=='synthetic-secret')process.exit(2);s.close()"
        subprocess.run([NODE,'--input-type=module','-e',script,str(restored),self.ref],check=True,timeout=20)
        with closing(sqlite3.connect(self.dst/'panel.sqlite')) as snapshot:
            self.assertEqual(snapshot.execute('PRAGMA user_version').fetchone()[0],6)

    def test_standalone_v7_snapshot_remains_readable_and_migrates_only_its_copy(self):
        self._downgrade_v9_to_v8()
        self.panel.execute('PRAGMA user_version=7');self.panel.commit();self.panel.close()
        self.agent.execute('DROP TABLE redis_restore_plans');self.agent.commit();self.agent.close();self.fix_permissions()
        self.capture();backup._validate_staging(self.destination_fd,self.node_fd)
        restored=self.root/'restored-v7';shutil.copytree(self.dst,restored)
        script="import {Store} from '/app/dist/server/store.js';const s=new Store(process.argv[1]);if(s.db.pragma('user_version',{simple:true})!==9||s.vault.get(process.argv[2])!=='synthetic-secret')process.exit(2);s.close()"
        subprocess.run([NODE,'--input-type=module','-e',script,str(restored),self.ref],check=True,timeout=20)
        for path in (self.src,self.dst):
            with closing(sqlite3.connect(path/'panel.sqlite')) as original:
                self.assertEqual(original.execute('PRAGMA user_version').fetchone()[0],7)

    def redis_plan(self):
        ident='a'*32
        source='panel-data-'+UUID+'-database'
        candidate='panel-restore-'+ident
        def specification(volume,operation=None):
            labels={'panel.owner':'self-hosted-panel','panel.service':UUID,'panel.kind':'redis'}
            if operation:labels['panel.restore.operation']=operation
            return {'Name':'panel-app-'+UUID,'Labels':labels,'Mode':{'Replicated':{'Replicas':1}},
                    'UpdateConfig':{'Order':'stop-first'},'TaskTemplate':{'ContainerSpec':{'Image':'redis:7',
                    'Mounts':[{'Type':'volume','Source':volume,'Target':'/data','ReadOnly':False}]}}}
        return {'version':1,'previousBinding':None,'switchPlan':{'version':1,
                'inspection':{'serviceId':UUID,'operationId':ident,'serviceDockerId':'owned-service',
                    'serviceVersion':1,'sourceContainerId':'b'*64,'sourceVolume':source,'candidateContainerId':'c'*64,
                    'candidateVolume':candidate,'imageId':'sha256:'+'d'*64,'nodeId':'owned-node'},
                'previousSpec':specification(source),'targetSpec':specification(candidate,ident)}}

    def add_redis_plan(self,plan=None,phase='completed',sealed=None):
        ident='a'*32;now='2026-11-17T00:00:00.000Z'
        self.panel.execute('UPDATE services SET image=?,port=?,config=? WHERE id=?',('redis:7',6379,json.dumps({'kind':'redis'}),UUID));self.panel.commit()
        if sealed is None:
            script="import {SecretVault} from '/app/dist/shared/secrets.js';const v=new SecretVault(process.argv[1]);process.stdout.write(v.seal(process.argv[2]));"
            sealed=subprocess.check_output([NODE,'--input-type=module','-e',script,str(self.src),json.dumps(plan or self.redis_plan())],text=True,timeout=20)
        self.agent.execute('INSERT INTO restore_operations(id,service_id,kind,archive_sha256,phase,updated_at) VALUES(?,?,?,?,?,?)',
                           (ident,UUID,'redis','b'*64,'completed' if phase=='completed' else 'cancelled',now))
        self.agent.execute('INSERT INTO redis_restore_plans(operation_id,service_id,sealed_plan,phase,updated_at) VALUES(?,?,?,?,?)',
                           (ident,UUID,sealed,phase,now))
        retained='panel-data-'+UUID+'-database' if phase=='completed' else 'panel-restore-'+ident
        self.agent.execute('INSERT INTO restore_retained_volumes(operation_id,service_id,volume_name,reason,created_at) VALUES(?,?,?,?,?)',
                           (ident,UUID,retained,'pre_restore_source' if phase=='completed' else 'rollback_candidate',now))
        if phase=='completed':
            self.agent.execute('INSERT INTO restore_volume_bindings(service_id,operation_id,volume_name,kind,created_at) VALUES(?,?,?,?,?)',
                               (UUID,ident,'panel-restore-'+ident,'redis',now))
        self.agent.commit();self.fix_permissions()

    def test_v8_capture_preserves_completed_redis_plan_and_binding(self):
        self.add_redis_plan();self.capture();backup._validate_staging(self.destination_fd,self.node_fd)
        with closing(sqlite3.connect(self.dst/'agent.sqlite')) as captured:
            self.assertEqual(captured.execute('SELECT phase FROM redis_restore_plans').fetchone(),('completed',))
            self.assertEqual(captured.execute('SELECT kind,volume_name FROM restore_volume_bindings').fetchone(),('redis','panel-restore-'+'a'*32))
        self.assertNotIn('previousSpec',(self.dst/'manifest.json').read_text())

    def test_v8_capture_preserves_rolled_back_redis_plan_and_cancelled_restore(self):
        self.add_redis_plan(phase='rolled_back');self.capture()
        with closing(sqlite3.connect(self.dst/'agent.sqlite')) as captured:
            self.assertEqual(captured.execute('SELECT phase FROM redis_restore_plans').fetchone(),('rolled_back',))
            self.assertEqual(captured.execute('SELECT phase FROM restore_operations').fetchone(),('cancelled',))

    def test_redis_plan_ciphertext_must_authenticate_with_the_installation_key(self):
        import base64
        self.add_redis_plan(sealed='enc:v1:'+base64.b64encode(bytes(28)).decode('ascii'))
        with self.assertRaisesRegex(backup.CaptureError,'Encryption verification failed'):self.capture()
        self.assertFalse((self.dst/'manifest.json').exists())

    def test_sealed_redis_plan_cannot_retarget_another_service(self):
        plan=self.redis_plan();plan['switchPlan']['inspection']['serviceId']='22345678-1234-4123-8123-123456789abc'
        self.add_redis_plan(plan)
        with self.assertRaisesRegex(backup.CaptureError,'Encryption verification failed'):self.capture()
        self.assertFalse((self.dst/'manifest.json').exists())

    def test_sealed_redis_plan_must_preserve_owned_runtime_and_volume_identity(self):
        for mutate in ('owner','volume','replicas','operation','version','container','unknown-field','node'):
            with self.subTest(mutate=mutate):
                plan=self.redis_plan();target=plan['switchPlan']['targetSpec']
                if mutate=='owner':target['Labels']['panel.owner']='foreign'
                elif mutate=='volume':target['TaskTemplate']['ContainerSpec']['Mounts'][0]['Source']='foreign-volume'
                elif mutate=='replicas':target['Mode']['Replicated']['Replicas']=2
                elif mutate=='operation':target['Labels']['panel.restore.operation']='b'*32
                elif mutate=='version':plan['switchPlan']['inspection']['serviceVersion']=0
                elif mutate=='container':plan['switchPlan']['inspection']['candidateContainerId']='untrusted'
                elif mutate=='unknown-field':plan['switchPlan']['inspection']['unexpected']='untrusted'
                else:plan['switchPlan']['inspection']['nodeId']=''
                self.add_redis_plan(plan)
                fresh=self.root/('invalid-redis-'+mutate);fresh.mkdir(mode=0o700);fd=os.open(fresh,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
                try:
                    with self.assertRaisesRegex(backup.CaptureError,'Encryption verification failed'):
                        backup._capture_quiescent(self.source_fd,fd,self.node_fd,source_uid=1000,reader_gid=65534)
                finally:os.close(fd)
                self.assertFalse((fresh/'manifest.json').exists())
                for table in ('restore_volume_bindings','restore_retained_volumes','redis_restore_plans','restore_operations'):
                    self.agent.execute('DELETE FROM '+table)
                self.agent.commit()

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
        for table in ('volume_restores','volume_backups','volume_backup_settings','api_tokens','database_backups','database_backup_settings','backup_storage_profiles','compose_domains','compose_actions','compose_workloads','two_factor_auth','deployment_webhooks'):
            self.panel.execute('DROP TABLE '+table)
        self.panel.execute('ALTER TABLE service_secret_refs DROP COLUMN purpose')
        self.panel.execute('PRAGMA user_version=4');self.panel.commit();self.fix_permissions()
        self.capture()
        restored_dir=self.root/'restored-v4';shutil.copytree(self.dst,restored_dir)
        script="import {Store} from '/app/dist/server/store.js';const s=new Store(process.argv[1]);if(s.db.pragma('user_version',{simple:true})!==9)process.exit(2);s.close()"
        subprocess.run([NODE,'--input-type=module','-e',script,str(restored_dir)],check=True,timeout=20)
        self.assertEqual(self.panel.execute('PRAGMA user_version').fetchone(),(4,))

    def test_v4_capture_stages_verified_restore_and_preserves_source(self):
        for table in ('volume_restores','volume_backups','volume_backup_settings','api_tokens','database_backups','database_backup_settings','backup_storage_profiles','compose_domains','compose_actions','compose_workloads','two_factor_auth','deployment_webhooks'):
            self.panel.execute('DROP TABLE '+table)
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
            script="import {Store} from '/app/dist/server/store.js';const s=new Store(process.argv[1]);if(s.db.pragma('user_version',{simple:true})!==9||s.vault.get(process.argv[2])!=='synthetic-secret')process.exit(2);s.close()"
            subprocess.run([NODE,'--input-type=module','-e',script,destination,self.ref],check=True,timeout=20)
            self.assertEqual(self.panel.execute('PRAGMA user_version').fetchone(),(4,))
            self.assertEqual((pathlib.Path(destination)/'panel.sqlite').stat().st_uid,1000)

    def test_legacy_capture_records_and_verifies_real_snapshot(self):
        def load(name,filename):
            spec=importlib.util.spec_from_file_location(name,ROOT/'apps/updater'/filename)
            module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
        supervisor=load('legacy_capture_supervisor','supervisor.py')
        coordinator=load('legacy_capture_coordinator','update-coordinator.py')
        legacy=load('legacy_capture','legacy-stop.py')
        restore=load('legacy_capture_restore','restore-snapshot.py')
        adoption_module=load('legacy_capture_adoption','adoption-proof.py')
        updater=load('legacy_capture_updater','servus-updater.py')
        with tempfile.TemporaryDirectory(dir='/root') as protected:
            root=pathlib.Path(protected);install=root/'install';install.mkdir(mode=0o700);(install/'install.lock').touch(mode=0o600)
            state=root/'state';state.mkdir(mode=0o700);snapshot=root/'snapshot';snapshot.mkdir(mode=0o700)
            journal=updater.Journal(state);attempt='12345678-1234-4123-8123-123456789abd';prep='12345678-1234-4123-8123-123456789abe'
            image='sha256:'+'a'*64;config='sha256:'+'b'*64;nonce='c'*64;binding=(prep,attempt,nonce,image,config)
            parent=root/'restores';parent.mkdir(mode=0o711)
            approved=SimpleNamespace(install_dir=str(install),data_dir=str(parent/('restore-'+UUID)))
            adoption=SimpleNamespace(_binding=lambda *_:('/policy','/accepted',approved,binding),_check_paths=adoption_module._check_paths)
            old={role:letter*64 for role,letter in zip(('api','worker','agent'),'def')}
            source=os.stat(self.src)
            journal.db.execute('CREATE TABLE legacy_stop_operations(operation_id TEXT PRIMARY KEY,preparation_id TEXT,attempt_id TEXT,nonce TEXT,root_digest TEXT,config_digest TEXT,policy_path TEXT,accepted_env TEXT,active_env TEXT,source TEXT,source_dev INTEGER,source_ino INTEGER,old_image TEXT,old_image_id TEXT,old_ids TEXT,state TEXT)')
            journal.db.execute('INSERT INTO legacy_stop_operations VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',(UUID,*binding,'/policy','/accepted','/active',str(self.src),source.st_dev,source.st_ino,'old','old',json.dumps(old),'stopped'))
            quiet=SimpleNamespace(ensure_host_namespaces=lambda:None,ensure_restart_fenced=lambda *_:None,ensure_no_other_data_mounts=lambda *_,**__:None,
                                  ensure_no_mount_aliases=lambda *_:None,ensure_no_open_data=lambda *_:None,ensure_no_uid_writers=lambda *_:None)
            lock=os.open(install/'install.lock',os.O_RDONLY);fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            try:
                with mock.patch.object(supervisor,'_verify_data_directory'):
                    digest=legacy.capture(journal,UUID,'/active',str(snapshot),self.node_fd,supervisor,object(),adoption,quiet,object(),backup,coordinator,install_lock=lock)
                self.assertEqual(journal.db.execute('SELECT path,digest,state FROM legacy_snapshots').fetchone(),(str(snapshot),digest,'verified'))
                self.assertEqual('sha256:'+hashlib.sha256((snapshot/'manifest.json').read_bytes()).hexdigest(),digest)
                coordinator.verify_snapshot(str(snapshot),digest,backup,self.node_fd,supervisor)
                restore.stage(str(snapshot),digest,str(parent),UUID,backup,self.node_fd,supervisor,coordinator)
                with mock.patch.object(supervisor,'_verify_data_directory'):
                    legacy.protect(journal,UUID,'/active',str(parent),self.node_fd,supervisor,object(),adoption,quiet,object(),backup,coordinator,restore,install_lock=lock)
                self.assertEqual(journal.db.execute('SELECT state FROM legacy_protections').fetchone(),('protected',))
                self.assertEqual((os.stat(self.src).st_uid,os.stat(self.src).st_gid),(0,0))
                self.assertEqual(restore.verify_staged(str(snapshot),digest,str(parent),UUID,backup,self.node_fd,supervisor,coordinator),
                                 (os.stat(approved.data_dir).st_dev,os.stat(approved.data_dir).st_ino))
            finally:os.close(lock);journal.close()

    def test_legacy_transition_with_real_snapshot_and_simulated_docker(self):
        def load(name,filename):
            spec=importlib.util.spec_from_file_location(name,ROOT/'apps/updater'/filename)
            module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
        supervisor=load('transition_real_supervisor','supervisor.py');runtime=load('transition_real_policy','runtime-policy.py')
        coordinator=load('transition_real_coordinator','update-coordinator.py');restore=load('transition_real_restore','restore-snapshot.py')
        adoption=load('transition_real_adoption','adoption-proof.py');updater=load('transition_real_updater','servus-updater.py')
        legacy=load('transition_real_legacy','legacy-stop.py');recovery=load('transition_real_recovery','legacy-recovery.py')
        initial=load('transition_real_initial','initial-generation.py');fence_module=load('transition_real_fence','migration-fence.py')
        transition=load('transition_real_coordinator_entry','legacy-transition.py');quiescence=load('transition_real_quiet','quiescence.py')
        with tempfile.TemporaryDirectory(dir='/root') as protected:
            root=pathlib.Path(protected);install=root/'install';install.mkdir(mode=0o700);(install/'install.lock').touch(mode=0o600)
            state=root/'state';state.mkdir(mode=0o700);docker_config=state/'docker';docker_config.mkdir(mode=0o700)
            snapshot=root/'snapshot';snapshot.mkdir(mode=0o700);recover=root/'recovery';recover.mkdir(mode=0o700)
            parent=root/'restores';parent.mkdir(mode=0o711);gate=root/'gate';gate.mkdir(mode=0o755)
            (gate/'state').write_bytes(b'servus-lifecycle-v1 normal\n');(gate/'state').chmod(0o644)
            stage=state/('servus-install-'+'a'*32);stage.mkdir(mode=0o700);(stage/'deployment').mkdir(mode=0o755)
            compose=stage/'deployment'/'compose-supervised.yaml';compose.write_bytes(b'fixture');compose.chmod(0o644)
            manifest=stage/'manifest.json';manifest.write_bytes(b'fixture');manifest.chmod(0o644)
            old_image='ghcr.io/raxon/servus@sha256:'+'e'*64;old_image_id='sha256:'+'e'*64
            old_env=root/'old.env';old_env.write_text('SERVUS_IMAGE='+old_image+'\nSERVUS_DATA_DIR='+str(self.src)+'\n');old_env.chmod(0o600)
            old_compose=root/'old-compose.yaml';old_compose.write_text('fixture\n');old_compose.chmod(0o644)
            journal=updater.Journal(state);attempt='12345678-1234-4123-8123-123456789abd';prep='12345678-1234-4123-8123-123456789abe'
            image='sha256:'+'a'*64;config='sha256:'+'b'*64;nonce='c'*64
            journal.db.execute('CREATE TABLE policy_approvals(operation_id TEXT,attempt_id TEXT,attempt_nonce TEXT,preparation_id TEXT,root_digest TEXT,image_config_digest TEXT,policy_path TEXT,accepted_env_path TEXT,source_env_path TEXT,state TEXT)')
            journal.db.execute('INSERT INTO operations(id,commit_sha,digest,tag,status,attempt_id,attempt_nonce,config_digest) VALUES(?,?,?,?,?,?,?,?)',(UUID,'d'*40,image,'v1.0.0','verified',attempt,nonce,config))
            journal.db.execute('INSERT INTO preparations VALUES(?,?,?,?,?,?)',(UUID,attempt,nonce,prep,'prepared',str(stage)))
            journal.db.execute('INSERT INTO policy_approvals VALUES(?,?,?,?,?,?,?,?,?,?)',(UUID,attempt,nonce,prep,image,config,'/policy','/accepted','/active','active'))
            approved=SimpleNamespace(install_dir=str(install),data_dir=str(parent/('restore-'+UUID)),gate_dir=str(gate),
                                     control_dir='/control',updater_dir='/updater',image_reference='ghcr.io/raxon/servus@'+image)
            pathlib.Path(approved.data_dir).mkdir(mode=0o700)
            daemon=SimpleNamespace(resolve_active_policy=lambda *_:('/policy','/accepted',approved))
            old_ids={role:letter*64 for role,letter in zip(('api','worker','agent'),'abc')};items={};services={}
            for role,cid in old_ids.items():
                command=['node','dist/'+('server' if role=='api' else role)+'/index.js']
                mounts=[{'Type':'bind','Source':str(self.src),'Destination':str(self.src),'RW':True}]
                volumes=[{'type':'bind','source':str(self.src),'target':str(self.src)}]
                if role=='agent':
                    mounts.append({'Type':'bind','Source':'/var/run/docker.sock','Destination':'/var/run/docker.sock','RW':True})
                    volumes.append({'type':'bind','source':'/var/run/docker.sock','target':'/var/run/docker.sock'})
                items[cid]={'Id':cid,'Image':old_image_id,'Config':{'Image':old_image,'User':'node','Cmd':command,'Env':['PANEL_DATA_DIR='+str(self.src)],
                            'Labels':{'com.docker.compose.project':'servus','com.docker.compose.service':role}},
                            'State':{'Running':True,'Paused':False,'Restarting':False,'ExitCode':0},
                            'HostConfig':{'Privileged':False,'PidMode':'','AutoRemove':False,'RestartPolicy':{'Name':'unless-stopped'}},'Mounts':mounts}
                services[role]={'image':old_image,'command':command,'volumes':volumes,'environment':{'PANEL_DATA_DIR':str(self.src)}}
            def call(*args,**kwargs):
                if args[0]=='ps':return ('\n'.join(items)+('\n' if items else '')).encode()
                if args[0]=='compose':return json.dumps({'services':services}).encode()
                if args[0]=='update':items[args[-1]]['HostConfig']['RestartPolicy']['Name']='no'
                if args[0]=='stop':items[args[-1]]['State']['Running']=False
                if args[0]=='rm':del items[args[-1]]
                return b''
            docker=SimpleNamespace(call=call,inspect=lambda *ids:[items[cid] for cid in ids])
            quiet=SimpleNamespace(ensure_host_namespaces=lambda:None,ensure_restart_fenced=quiescence.ensure_restart_fenced,
                  ensure_no_other_data_mounts=quiescence.ensure_no_other_data_mounts,ensure_no_mount_aliases=lambda *_:None,
                  ensure_no_open_data=lambda *_:None,ensure_no_uid_writers=lambda *_:None,ensure_no_data_mounts=quiescence.ensure_no_data_mounts)
            fence=fence_module.MigrationFence(journal,UUID,'/active',str(self.src),old_ids,supervisor,daemon,adoption,quiet,docker)
            extractor=SimpleNamespace(MANIFEST_LIMIT=4096,MAX_FILE=4096,_manifest_files=lambda _:{'deployment/compose-supervised.yaml':(0o644,7,hashlib.sha256(b'fixture').hexdigest())})
            new_ids={role:{'id':letter*64} for role,letter in zip(('api','worker','agent'),'456')}
            lock=os.open(install/'install.lock',os.O_RDONLY);fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            try:
                trusted_directory=supervisor._trusted_directory
                def fixture_directory(path,mode=None):
                    if path==str(self.src):
                        fd=os.open(path,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
                        info=os.fstat(fd)
                        if (info.st_uid,stat.S_IMODE(info.st_mode))!=(0,mode):os.close(fd);raise ValueError('Unprotected fixture')
                        return fd
                    return trusted_directory(path,mode)
                with mock.patch.object(supervisor,'RuntimePolicy',SimpleNamespace),mock.patch.object(supervisor,'_verify_data_directory'),\
                     mock.patch.object(supervisor,'_trusted_directory',side_effect=fixture_directory),\
                     mock.patch.object(supervisor,'inspect_servus',return_value=new_ids),mock.patch.object(supervisor,'_docker',return_value=b''),\
                     mock.patch.object(runtime,'_docker',return_value=b''):
                    result=transition.transition(journal,UUID,'/active',str(self.src),old_image,old_image_id,old_ids,str(old_env),str(old_compose),
                        str(recover),str(snapshot),str(parent),self.node_fd,str(docker_config),supervisor,daemon,adoption,runtime,quiet,docker,
                        backup,coordinator,restore,recovery,legacy,initial,extractor,fence,install_lock=lock,check=lambda *_:None,updater_check=lambda *_:None)
                self.assertEqual(result,new_ids);self.assertFalse(items)
                self.assertEqual(journal.db.execute('SELECT phase FROM legacy_transitions').fetchone(),('started',))
                self.assertEqual(journal.db.execute('SELECT state FROM initial_adoptions').fetchone(),('consumed',))
                self.assertEqual((os.stat(self.src).st_uid,os.stat(self.src).st_gid),(0,0))
                script="import {Store} from '/app/dist/server/store.js';const s=new Store(process.argv[1]);if(s.vault.get(process.argv[2])!=='synthetic-secret'||!s.db.prepare('SELECT 1 FROM users WHERE id=?').get(process.argv[3])||s.db.prepare('SELECT description FROM projects WHERE id=?').get(process.argv[4])?.description!=='committed-wal')process.exit(2);s.close()"
                subprocess.run([NODE,'--input-type=module','-e',script,approved.data_dir,self.ref,self.actor,UUID],check=True,timeout=20)
            finally:os.close(lock);journal.close()

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

    def test_shared_github_connection_is_included_in_capture(self):
        reference,config=self.add_git_credential()
        config['source']['sharedGithub']=True
        self.panel.execute('UPDATE services SET config=? WHERE id=?',(json.dumps(config),UUID));self.panel.commit()
        script="import {Store} from '/app/dist/server/store.js';const s=new Store(process.argv[1]);s.vault.setGithubConnection('git-user','shared-fixture-token');s.close();"
        subprocess.run([NODE,'--input-type=module','-e',script,str(self.src)],check=True,timeout=20)
        self.fix_permissions();self.capture()
        manifest=json.loads((self.dst/'manifest.json').read_text())
        self.assertIn('secrets/'+reference,manifest['files'])
        self.assertIn('secrets/83b896d9-8e84-41ae-886c-d9026721459a',manifest['files'])
        self.assertNotIn('shared-fixture-token',json.dumps(manifest))
        backup._validate_staging(self.destination_fd,self.node_fd)
        restored=self.root/'restored-github';shutil.copytree(self.dst,restored)
        check="import {Store} from '/app/dist/server/store.js';const s=new Store(process.argv[1]);if(s.vault.githubConnection()?.token!=='shared-fixture-token')process.exit(2);s.close();"
        subprocess.run([NODE,'--input-type=module','-e',check,str(restored)],check=True,timeout=20)

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

    def test_unresolved_restore_is_refused(self):
        for phase in ('reserved','importing','prepared','switching','needs_review'):
            with self.subTest(phase=phase):
                self.agent.execute('DELETE FROM restore_operations')
                self.agent.execute('INSERT INTO restore_operations VALUES(?,?,?,?,?,?)',('a'*32,UUID,'postgres','b'*64,phase,'2026-11-15T00:00:00.000Z'))
                with self.assertRaisesRegex(backup.CaptureError,'Unresolved database restore'): backup._agent_schema(self.agent)
        self.agent.commit();self.fix_permissions()
        with self.assertRaisesRegex(backup.CaptureError,'Unresolved database restore'): self.capture()
        self.assertFalse((self.dst/'manifest.json').exists())

    def test_terminal_restore_journal_is_validated(self):
        self.agent.execute('INSERT INTO restore_operations VALUES(?,?,?,?,?,?)',('a'*32,UUID,'postgres','b'*64,'completed','2026-11-15T00:00:00.000Z'))
        self.agent.commit();self.fix_permissions();self.capture()
        with sqlite3.connect(self.dst/'agent.sqlite') as restored:
            self.assertEqual(restored.execute('SELECT phase FROM restore_operations').fetchone(),('completed',))
        self.agent.execute("UPDATE restore_operations SET phase='cancelled'");backup._agent_schema(self.agent)

    def test_invalid_restore_journal_is_refused(self):
        self.agent.execute('INSERT INTO restore_operations VALUES(?,?,?,?,?,?)',('bad',UUID,'postgres','b'*64,'completed','2026-11-15T00:00:00.000Z'))
        self.agent.commit();self.fix_permissions()
        with self.assertRaisesRegex(backup.CaptureError,'Database restore journal is invalid'): self.capture()
        self.assertFalse((self.dst/'manifest.json').exists())

    def test_legacy_agent_without_restore_table_is_supported(self):
        for table in ('redis_restore_plans','restore_switch_intents','restore_retained_volumes','restore_volume_bindings','restore_upload_locks','restore_review_phases','restore_operations'):
            self.agent.execute(f'DROP TABLE IF EXISTS {table}')
        self.agent.commit();self.fix_permissions();self.capture()
        with sqlite3.connect(self.dst/'agent.sqlite') as restored:
            self.assertIsNone(restored.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='restore_operations'").fetchone())

    def test_restore_tables_without_journal_are_refused(self):
        self.agent.execute('DROP TABLE restore_operations');self.agent.commit();self.fix_permissions()
        with self.assertRaisesRegex(backup.CaptureError,'Unsupported database schema'): self.capture()
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
