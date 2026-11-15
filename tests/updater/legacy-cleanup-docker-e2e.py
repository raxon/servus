"""Disposable Docker fixture for the host-to-worker call, not a quiescence proof."""
import importlib.util
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import tempfile
from types import SimpleNamespace
from unittest import mock
import uuid

ROOT=Path(__file__).resolve().parents[2]
def load(name,path):
    spec=importlib.util.spec_from_file_location(name,ROOT/path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
supervisor=load('fixture_supervisor','apps/updater/supervisor.py')
coordinator=load('fixture_coordinator','apps/updater/update-coordinator.py')
image=os.environ.get('SERVUS_RECOVERY_IMAGE','');dist=os.environ.get('SERVUS_RECOVERY_DIST','')
if (os.geteuid()!=0 or os.environ.get('SERVUS_RECOVERY_FIXTURE')!='1' or
    not re.fullmatch(r'sha256:[a-f0-9]{64}',image) or not os.path.isabs(dist) or
    not (Path(dist)/'agent/restore-legacy-worker.js').is_file()):
    raise SystemExit('A disposable root Docker fixture and built worker are required')

operation=str(uuid.uuid4());restore='a'*32;service=str(uuid.uuid4());name='servus-recovery-'+operation
try:
    with tempfile.TemporaryDirectory(prefix='servus-host-worker-',dir='/tmp') as root:
        root=Path(root);data=root/'data';state=root/'state';data.mkdir(mode=0o700);state.mkdir(mode=0o700)
        os.chown(data,1000,1000)
        database=data/'agent.sqlite'
        with sqlite3.connect(database) as db:
            db.executescript("""
                CREATE TABLE operations(id TEXT PRIMARY KEY,request_hash TEXT,state TEXT,response TEXT,updated_at TEXT,previous_spec TEXT,previous_recorded INTEGER,target_spec TEXT,operation_stage TEXT,previous_error TEXT,service_id TEXT);
                CREATE TABLE restore_operations(id TEXT PRIMARY KEY,service_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('postgres','mariadb','redis')),archive_sha256 TEXT NOT NULL,phase TEXT NOT NULL CHECK(phase IN ('uploading','reserved','discarding','discarding_candidate','importing','prepared','switching','needs_review','completed','cancelled')),updated_at TEXT NOT NULL);
                CREATE UNIQUE INDEX restore_one_active_per_service ON restore_operations(service_id) WHERE phase NOT IN ('completed','cancelled');
                CREATE TABLE restore_switch_intents(id TEXT PRIMARY KEY,service_id TEXT NOT NULL,service_version INTEGER NOT NULL,sealed_plan TEXT NOT NULL,created_at TEXT NOT NULL,stage TEXT NOT NULL DEFAULT 'pending' CHECK(stage IN ('pending','candidate_stop','candidate_detached','applying','applied','rolling_back','rolled_back')));
                CREATE TABLE restore_retained_volumes(operation_id TEXT PRIMARY KEY,service_id TEXT NOT NULL,volume_name TEXT NOT NULL UNIQUE,reason TEXT NOT NULL CHECK(reason IN ('rollback_candidate','pre_restore_source')),created_at TEXT NOT NULL);
                CREATE TABLE restore_volume_bindings(service_id TEXT PRIMARY KEY,operation_id TEXT NOT NULL UNIQUE,volume_name TEXT NOT NULL UNIQUE,kind TEXT NOT NULL CHECK(kind IN ('postgres','mariadb')),created_at TEXT NOT NULL);
            """)
            db.execute("INSERT INTO restore_operations VALUES(?,?,? ,?,'uploading',?)",(restore,service,'postgres','0'*64,'2026-11-15T00:00:00.000Z'))
        database.chmod(0o600);os.chown(database,1000,1000)
        archives=data/'restore-archives';archives.mkdir(mode=0o700);os.chown(archives,1000,1000)
        pending=archives/('.pending-'+restore+'-'+'b'*32);pending.write_text('encrypted fixture');pending.chmod(0o600);os.chown(pending,1000,1000)
        source=data/'source-database';source.write_text('source fixture');source.chmod(0o600);os.chown(source,1000,1000)
        directory=os.open(state,os.O_RDONLY|os.O_DIRECTORY)
        try:
            lease=object.__new__(supervisor.DrainLease);lease._legacy_upload_id=restore;lease._policy_binding=('/root/policy','sha256:'+'1'*64,'sha256:'+'2'*64);lease._owner=SimpleNamespace(journal=directory)
            hub=mock.create_autospec(supervisor.DrainHub,instance=True);hub.used=True;hub.expected_uid=1000
            hub.identities={role:{'id':char*64} for role,char in zip(supervisor.ROLES,'abc')}
            hub.policy=mock.create_autospec(supervisor.RuntimePolicy,instance=True);hub.policy.data_dir=str(data);hub.policy.image_id=image;lease._hub=hub
            actual_docker=supervisor._docker
            def docker(*args,**kwargs):
                if args[0]!='run':raise AssertionError('Unexpected Docker call')
                index=args.index('--entrypoint');args=(*args[:index],'--mount','type=bind,src='+dist+',dst=/app/dist,readonly',*args[index:])
                return actual_docker(*args,**kwargs)
            with mock.patch.object(lease,'assert_locked'),mock.patch.object(supervisor,'_verify_data_directory'),mock.patch.object(supervisor,'_docker',side_effect=docker):
                result=coordinator.cleanup_stopped_legacy_upload(operation,restore,service,lease,supervisor,mock.Mock())
            assert result=={'operationId':restore,'phase':'cancelled'}
            with sqlite3.connect(database) as db:assert db.execute('SELECT phase FROM restore_operations WHERE id=?',(restore,)).fetchone()==('cancelled',)
            assert not pending.exists() and source.read_text()=='source fixture'
            assert '"state":"cleaned"' in (state/'legacy-upload-recovery.json').read_text()
        finally:os.close(directory)
finally:
    inspect=subprocess.run(['/usr/bin/docker','inspect','--format','{{ index .Config.Labels "servus.recovery" }}',name],capture_output=True,text=True,check=False)
    if inspect.returncode==0 and inspect.stdout.strip()==operation:
        subprocess.run(['/usr/bin/docker','rm','-f',name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,check=False)
print('PASS host dispatch to restricted worker; host quiescence checks were mocked')
