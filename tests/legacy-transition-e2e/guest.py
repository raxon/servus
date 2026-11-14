#!/usr/bin/python3 -I
"""Exercise legacy data migration on a disposable VM with real Docker.

The new generation's startup and release approval are simulated. Its image is
subsequently run offline against the staged data to check the real migration.
"""
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
from types import SimpleNamespace
import urllib.request
import uuid
from unittest import mock

if os.geteuid()!=0 or not os.uname().nodename.startswith('colima-servus-legacy-e2e-'):
    raise SystemExit('A disposable legacy fixture VM is required')
BASE=Path('/run/servus-legacy-fixture')
sys.path.insert(0,str(BASE/'apps/updater'))
import supervisor

def load(name,filename):
    spec=importlib.util.spec_from_file_location(name,BASE/'apps/updater'/filename)
    module=importlib.util.module_from_spec(spec);sys.modules[name]=module;spec.loader.exec_module(module);return module

runtime=load('fixture_runtime','runtime-policy.py');backup=load('fixture_backup','backup.py')
coordinator=load('fixture_coordinator','update-coordinator.py');restore=load('fixture_restore','restore-snapshot.py')
adoption=load('fixture_adoption','adoption-proof.py');updater=load('fixture_updater','servus-updater.py')
legacy=load('fixture_legacy','legacy-stop.py');recovery=load('fixture_recovery','legacy-recovery.py')
transition=load('fixture_transition','legacy-transition.py');fence_module=load('fixture_fence','migration-fence.py')
quiet=load('fixture_quiet','quiescence.py')
OLD='ghcr.io/raxon/servus@sha256:32f7cccf97841716ffae6bbff4f4234d5c3575e3b3ad9daa61dcf5afba72a13c'
NEW='ghcr.io/raxon/servus@sha256:68e56744e3a81249154e90012a7440041f87b965686f1c52e5e31bf3be0113c4'

def main():
    for path in ('/opt/servus','/etc/servus','/var/lib/servus','/var/lib/servus-updater'):
        if Path(path).exists():raise RuntimeError('Fixture requires an empty host')
    install=Path('/opt/servus');install.mkdir(mode=0o700);(install/'install.lock').touch(mode=0o600)
    config=Path('/etc/servus');config.mkdir(mode=0o700)
    data=Path('/var/lib/servus');data.mkdir(mode=0o700);os.chown(data,1000,1000)
    state=Path('/var/lib/servus-updater');state.mkdir(mode=0o700);docker_config=state/'docker-config';docker_config.mkdir(mode=0o700)
    parent=Path('/var/lib/servus-migration');parent.mkdir(mode=0o711)
    snapshot=state/'snapshot';snapshot.mkdir(mode=0o700);recovery_dir=state/'recovery';recovery_dir.mkdir(mode=0o700)
    compose=install/'compose.yaml';shutil.copyfile(BASE/'compose.yaml',compose);compose.chmod(0o644)
    old_env=config/'old.env';gid=os.stat('/var/run/docker.sock').st_gid
    old_env.write_text(f'SERVUS_IMAGE={OLD}\nSERVUS_DATA_DIR={data}\nSERVUS_PORT=4180\nSERVUS_INGRESS_PORT=18080\n'
        f'SERVUS_DOCKER_GID={gid}\nSERVUS_BIND_ADDRESS=127.0.0.1\nSERVUS_PUBLIC_URL=http://127.0.0.1:4180\n'
        'SERVUS_ALLOWED_ORIGINS=http://127.0.0.1:4180\nSERVUS_SECURE_COOKIES=false\nSERVUS_SOURCE_REF=fixture\n');old_env.chmod(0o600)
    def command(*args,timeout=120):return runtime._docker(str(docker_config),*args,timeout=timeout)
    class Docker:
        def call(self,*args,**kwargs):return command(*args,**kwargs)
        def inspect(self,*ids):return json.loads(command('inspect',*ids))
    docker=Docker()
    if command('ps','-aq').strip():raise RuntimeError('Fixture Docker is not empty')
    command('compose','--env-file',str(old_env),'-f',str(compose),'-p','servus','up','-d',timeout=300)
    origin='http://127.0.0.1:4180';cookie='';csrf=''
    def request(path,method='GET',body=None):
        nonlocal cookie,csrf
        headers={'origin':origin,'accept':'application/json'}
        if cookie:headers['cookie']=cookie
        if csrf:headers['x-csrf-token']=csrf
        payload=None
        if body is not None:payload=json.dumps(body).encode();headers['content-type']='application/json'
        with urllib.request.urlopen(urllib.request.Request(origin+'/api/v1'+path,data=payload,headers=headers,method=method),timeout=8) as response:
            value=json.load(response);new_cookie=response.headers.get('set-cookie')
            if new_cookie:cookie=new_cookie.split(';',1)[0]
            if isinstance(value,dict) and value.get('csrfToken'):csrf=value['csrfToken']
            return value
    end=time.monotonic()+180
    while True:
        try:
            if request('/health').get('status')=='ok':break
        except (OSError,ValueError):pass
        if time.monotonic()>=end:raise RuntimeError('Legacy API did not start')
        time.sleep(1)
    request('/setup','POST',{'email':'fixture@example.test','password':'isolated-fixture-password'})
    project=request('/projects','POST',{'name':'legacy-fixture'})['id']
    ids=command('ps','-aq','--no-trunc','--filter','label=com.docker.compose.project=servus').decode().splitlines()
    items=docker.inspect(*ids);old_ids={item['Config']['Labels']['com.docker.compose.service']:item['Id'] for item in items}
    if set(old_ids)!={'api','worker','agent'}:raise RuntimeError('Unexpected legacy fixture')
    old_image_id=items[0]['Image']
    ingress=command('ps','-q','--no-trunc','--filter','label=com.docker.swarm.service.name=panel-ingress').decode().splitlines()
    trusted=None
    if ingress:
        if len(ingress)!=1:raise RuntimeError('Unexpected fixture ingress')
        item=docker.inspect(ingress[0])[0];trusted=(item['Id'],'panel-ingress',item['Config']['Image'],item['Image'])
    op=str(uuid.uuid4());attempt=str(uuid.uuid4());prep=str(uuid.uuid4());nonce='c'*64
    root_digest=NEW.split('@')[1];config_digest='sha256:'+'b'*64
    journal=updater.Journal(state)
    journal.db.execute('CREATE TABLE policy_approvals(operation_id TEXT,attempt_id TEXT,attempt_nonce TEXT,preparation_id TEXT,root_digest TEXT,image_config_digest TEXT,policy_path TEXT,accepted_env_path TEXT,source_env_path TEXT,state TEXT)')
    journal.db.execute('INSERT INTO operations(id,commit_sha,digest,tag,status,attempt_id,attempt_nonce,config_digest) VALUES(?,?,?,?,?,?,?,?)',(op,'d'*40,root_digest,'v0.1.7','verified',attempt,nonce,config_digest))
    journal.db.execute('INSERT INTO preparations VALUES(?,?,?,?,?,?)',(op,attempt,nonce,prep,'prepared','/fixture'))
    journal.db.execute('INSERT INTO policy_approvals VALUES(?,?,?,?,?,?,?,?,?,?)',(op,attempt,nonce,prep,root_digest,config_digest,'/policy','/accepted','/active','active'))
    approved=SimpleNamespace(install_dir=str(install),data_dir=str(parent/('restore-'+op)),control_dir='/control',updater_dir='/updater',image_reference=NEW)
    Path(approved.data_dir).mkdir(mode=0o700)
    daemon=SimpleNamespace(resolve_active_policy=lambda *_:('/policy','/accepted',approved))
    fence=fence_module.MigrationFence(journal,op,'/active',str(data),old_ids,supervisor,daemon,adoption,quiet,docker)
    node_fd=os.open(BASE/'node',os.O_RDONLY|os.O_NOFOLLOW);lock=os.open(install/'install.lock',os.O_RDONLY)
    fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    def start(*args,**kwargs):
        kwargs['migration'].fence.assert_locked(op,lock)
        adoption.claim(journal,op,'/active',backup,node_fd,supervisor,daemon,coordinator,restore,quiet,install_lock=lock)
        if journal.db.execute("UPDATE initial_generations SET phase='started' WHERE operation_id=? AND phase='starting'",(op,)).rowcount!=1:
            raise RuntimeError('Simulated start failed')
        return 'simulated'
    initial=SimpleNamespace(launch=start)
    try:
        with mock.patch.object(supervisor,'RuntimePolicy',SimpleNamespace):
            result=transition.transition(journal,op,'/active',str(data),OLD,old_image_id,old_ids,str(old_env),str(compose),str(recovery_dir),str(snapshot),str(parent),node_fd,
                str(docker_config),supervisor,daemon,adoption,runtime,quiet,docker,backup,coordinator,restore,recovery,legacy,initial,object(),fence,
                install_lock=lock,trusted_ingress=trusted,check=lambda *_:None,updater_check=lambda *_:None)
        if result!='simulated' or journal.db.execute('SELECT phase FROM legacy_transitions').fetchone()!=('started',):raise RuntimeError('Transition failed')
        if command('ps','-aq','--filter','label=com.docker.compose.project=servus').strip():raise RuntimeError('Legacy containers remain')
        if os.stat(data).st_uid!=0:raise RuntimeError('Original data is not protected')
        script="import {Store} from '/app/dist/server/store.js';const s=new Store('/fixture');if(!s.db.prepare('SELECT 1 FROM projects WHERE id=?').get(process.argv[1]))process.exit(2);s.close()"
        command('run','--rm','--network','none','--platform','linux/amd64','--user','node','--mount','type=bind,src='+approved.data_dir+',dst=/fixture',
                '--entrypoint','node',NEW,'--input-type=module','-e',script,project,timeout=180)
        print('PASS real legacy containers, capture, protection and offline data migration; startup approval simulated',flush=True)
    finally:os.close(lock);os.close(node_fd);journal.close()

if __name__=='__main__':main()
