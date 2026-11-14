#!/usr/bin/python3 -I
"""Exercise legacy data migration on a disposable VM with real Docker.

By default startup and release approval are simulated. The --full mode uses the
real verification services, runtime policy and supervisor on the disposable VM.
"""
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
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
BASE=Path('/var/lib/servus-test-fixture' if sys.argv[1:]==['--after-reboot'] else '/run/servus-legacy-fixture')
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
early=load('fixture_early','legacy-early-recovery.py')
quiet=load('fixture_quiet','quiescence.py')
initial_module=load('fixture_initial','initial-generation.py');extractor=load('fixture_extractor','extract-install.py')
daemon_module=load('fixture_daemon','supervisor-daemon.py')
bootstrap_module=load('fixture_bootstrap','bootstrap-initial.py')
handoff_module=load('fixture_handoff','bootstrap-handoff.py')
verifier=load('fixture_verifier','verify-release.py')
OLD='ghcr.io/raxon/servus@sha256:32f7cccf97841716ffae6bbff4f4234d5c3575e3b3ad9daa61dcf5afba72a13c'
NEW='ghcr.io/raxon/servus@sha256:68e56744e3a81249154e90012a7440041f87b965686f1c52e5e31bf3be0113c4'

def after_reboot():
    info=json.loads((BASE/'post-reboot.json').read_text());origin='http://127.0.0.1:4180';cookie='';csrf=''
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
    end=time.monotonic()+240
    while True:
        try:
            if request('/health').get('version')=='0.1.7':break
        except (OSError,ValueError):pass
        if time.monotonic()>=end:raise RuntimeError('Migrated API did not recover after reboot')
        time.sleep(1)
    request('/auth/login','POST',{'email':'fixture@example.test','password':'isolated-fixture-password'})
    if not any(item.get('id')==info['project'] for item in request('/projects')):raise RuntimeError('Project was not retained after reboot')
    if request('/updates').get('applyAvailable') is not True:raise RuntimeError('Updater is unavailable after reboot')
    for unit in ('servus-supervisor.service','servus-updater.service','servus-updater-socket.service'):
        subprocess.run(['/usr/bin/systemctl','is-active','--quiet',unit],check=True,timeout=15)
    print('PASS reboot preserved login, project, supervisor and updater',flush=True)


def main():
    if sys.argv[1:] not in ([],['--full'],['--recover-check'],['--early-recover'],['--orchestrated'],['--bootstrap-migrate'],['--bootstrap-fail'],['--host-bootstrap'],['--after-reboot']):raise RuntimeError('Invalid fixture mode')
    if sys.argv[1:]==['--after-reboot']:return after_reboot()
    recover_check=sys.argv[1:]==['--recover-check']
    early_check=sys.argv[1:]==['--early-recover']
    orchestrated=sys.argv[1:]==['--orchestrated']
    bootstrap_fail=sys.argv[1:]==['--bootstrap-fail']
    host_bootstrap=sys.argv[1:]==['--host-bootstrap']
    bootstrap_migrate=sys.argv[1:] in (['--bootstrap-migrate'],['--bootstrap-fail'],['--host-bootstrap'])
    full=sys.argv[1:] in (['--full'],['--recover-check'],['--early-recover'],['--orchestrated'],['--bootstrap-migrate'],['--bootstrap-fail'],['--host-bootstrap'])
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
    target=parent/('restore-'+op)
    if not bootstrap_migrate:target.mkdir(mode=0o700)
    active='/active'
    if full:
        def run(*args,timeout=180):subprocess.run(args,check=True,timeout=timeout,stdin=subprocess.DEVNULL)
        if host_bootstrap:
            (install/'.servus-install').write_text('servus-installer-v1\n');(install/'.servus-install').chmod(0o600)
            active=str(config/'servus.env');shutil.copyfile(old_env,active);os.chmod(active,0o600)
            if Path('/usr/bin/node').exists():raise RuntimeError('Host fixture must begin without Node')
            args=['/usr/bin/python3','-I',str(BASE/'apps/updater/legacy-host-bootstrap.py'),'--source',str(BASE),
                  '--operation',op,'--commit','5c82968ef6ab05d416d95d301078d37c9d11cc36','--digest',root_digest,
                  '--tag','v0.1.7','--old-compose',str(compose)]
            invalid=args.copy();invalid[6]='invalid'
            rejected=subprocess.run(invalid,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=30)
            if rejected.returncode==0 or request('/health').get('version')!='0.1.5':raise RuntimeError('Invalid host bootstrap changed panel')
            run(*args,timeout=2400)
            if not Path('/usr/bin/node').is_file() or request('/health').get('version')!='0.1.7':raise RuntimeError('Host bootstrap did not finish')
            cookie='';csrf='';request('/auth/login','POST',{'email':'fixture@example.test','password':'isolated-fixture-password'})
            if not any(item.get('id')==project for item in request('/projects')):raise RuntimeError('Project was not retained')
            if request('/updates').get('applyAvailable') is not True:raise RuntimeError('Updater is unavailable')
            for name,digest in (('verification-executor.py','1b7cd6b9932008cf20ab57cee11a8b3bd8b79e58171308bcf8e180326415d71f'),
                                ('verify-release.py','84c3c5f1b643aafad0e79cefe2678c871322c0fbe5532c8fb5f0efa934cf0c02')):
                if hashlib.sha256((install/'legacy-verifier-v0.1.5'/name).read_bytes()).hexdigest()!=digest:raise RuntimeError('Legacy verifier backup differs')
            print('PASS host dependencies and signed migration retained the legacy project',flush=True)
            return
        host_args=['/usr/bin/python3','-I',str(BASE/'apps/updater/install-host.py'),'--source',str(BASE),'--install-dir',str(install)]
        if bootstrap_migrate:host_args.append('--adopt-legacy-verifier')
        run(*host_args)
        if bootstrap_migrate:
            for name,digest in (('verification-executor.py','1b7cd6b9932008cf20ab57cee11a8b3bd8b79e58171308bcf8e180326415d71f'),
                                ('verify-release.py','84c3c5f1b643aafad0e79cefe2678c871322c0fbe5532c8fb5f0efa934cf0c02')):
                if hashlib.sha256((install/'legacy-verifier-v0.1.5'/name).read_bytes()).hexdigest()!=digest:
                    raise RuntimeError('Legacy verifier backup differs')
        run('/usr/bin/python3','-I','/usr/local/libexec/servus/install-gh.py','--install-dir',str(install),timeout=240)
        run('/usr/bin/python3','-I','/usr/local/libexec/servus/provision-host.py')
        run('/usr/bin/python3','-I','/usr/local/libexec/servus/provision-host.py','--runtime')
        run('/usr/bin/python3','-I','/usr/local/libexec/servus/provision-verifier-group.py')
        shutil.copyfile(BASE/'node','/usr/bin/node');os.chmod('/usr/bin/node',0o755)
        active=str(config/'servus.env')
        if bootstrap_migrate:
            shutil.copyfile(old_env,active);os.chmod(active,0o600)
            run('/usr/bin/systemctl','daemon-reload')
            args=['/usr/bin/python3','-I','/usr/local/libexec/servus/legacy-bootstrap.py','--operation',op,'--commit',
                  '5c82968ef6ab05d416d95d301078d37c9d11cc36','--digest',root_digest,'--tag','v0.1.7','--old-compose',str(compose)]
            invalid=args.copy();invalid[4]='invalid'
            rejected=subprocess.run(invalid,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=30)
            if rejected.returncode==0 or request('/health').get('version')!='0.1.5':raise RuntimeError('Invalid bootstrap changed the panel')
            if bootstrap_fail:
                invalid=args.copy();invalid[6]='0'*40
                rejected=subprocess.run(invalid,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=1100)
                if rejected.returncode==0 or request('/health').get('version')!='0.1.5':raise RuntimeError('Unverified release changed the panel')
                if Path(active).read_bytes()!=old_env.read_bytes() or target.exists() or not (install/'.bootstrap-verification-v1').is_file():
                    raise RuntimeError('Failed verification did not preserve legacy state')
                status=subprocess.run(['/usr/bin/systemctl','is-active','--quiet','servus-updater-bootstrap.service'],timeout=30)
                if status.returncode==0:raise RuntimeError('Failed verifier remains active')
                print('PASS unverified release preserved legacy panel and configuration',flush=True)
                return
            run(*args,timeout=1500)
            if request('/health').get('version')!='0.1.7':raise RuntimeError('Bootstrapped API is unavailable')
            cookie='';csrf='';request('/auth/login','POST',{'email':'fixture@example.test','password':'isolated-fixture-password'})
            if not any(item.get('id')==project for item in request('/projects')):raise RuntimeError('Project was not retained')
            if request('/updates').get('applyAvailable') is not True:raise RuntimeError('Updater is unavailable')
            if (install/'.bootstrap-verification-v1').exists() or (install/transition.MARKER).exists():raise RuntimeError('Migration marker remains')
            if (config/('legacy-'+op+'.env')).read_bytes()!=old_env.read_bytes():raise RuntimeError('Original configuration was not retained')
            print('PASS bootstrap verified signed release and migrated the legacy panel',flush=True)
            return
        Path(active).write_text(f'SERVUS_IMAGE={NEW}\nSERVUS_DATA_DIR={target}\nSERVUS_PORT=4180\nSERVUS_INGRESS_PORT=18080\n'
            f'SERVUS_DOCKER_GID={gid}\nSERVUS_BIND_ADDRESS=127.0.0.1\nSERVUS_PUBLIC_URL=http://127.0.0.1:4180\n'
            'SERVUS_ALLOWED_ORIGINS=http://127.0.0.1:4180\nSERVUS_SECURE_COOKIES=false\nSERVUS_SOURCE_REF=v0.1.7\n'
            f'SERVUS_LIFECYCLE_DIR={config}/lifecycle\nSERVUS_SUPERVISOR_CONTROL_DIR={config}/supervisor-control\n'
            f'SERVUS_SUPERVISOR_SECRET_DIR={config}/supervisor-secrets\nSERVUS_UPDATER_SOCKET_DIR=/run/servus-updater/control\n')
        os.chmod(active,0o600)
        run('/usr/bin/systemctl','daemon-reload')
        run('/usr/bin/systemctl','start','servus-updater-socket.service')
        run('/usr/bin/systemctl','start','servus-updater-bootstrap.service')
        bootstrap_module.wait_socket('/run/servus-updater/control/updater.sock',supervisor)
        run('/usr/bin/setpriv','--reuid=1000','--regid=1000','--clear-groups','/usr/bin/python3','-I',
            '/usr/local/libexec/servus/bootstrap-release.py','--operation',op,'--commit','5c82968ef6ab05d416d95d301078d37c9d11cc36',
            '--digest',root_digest,'--tag','v0.1.7',timeout=960)
        run('/usr/bin/systemctl','stop','servus-updater-bootstrap.service')
        if orchestrated:
            args=['/usr/bin/python3','-I','/usr/local/libexec/servus/legacy-run.py','--operation',op,'--old-env',str(old_env),
                  '--old-compose',str(compose),'--recovery-dir',str(recovery_dir),'--snapshot-dir',str(snapshot)]
            rejected=args.copy();rejected[4]=str(uuid.uuid4())
            invalid=subprocess.run(rejected,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=60)
            if invalid.returncode==0 or request('/health').get('version')!='0.1.5':raise RuntimeError('Unknown migration changed the legacy panel')
            run(*args,timeout=1200)
            if request('/health').get('version')!='0.1.7':raise RuntimeError('Migrated API is unavailable')
            cookie='';csrf='';request('/auth/login','POST',{'email':'fixture@example.test','password':'isolated-fixture-password'})
            if not any(item.get('id')==project for item in request('/projects')):raise RuntimeError('Project was not retained')
            if request('/updates').get('applyAvailable') is not True:raise RuntimeError('Updater is unavailable')
            if (install/transition.MARKER).exists():raise RuntimeError('Migration marker remains')
            for unit in ('servus-supervisor.service','servus-updater.service','servus-updater-socket.service'):
                run('/usr/bin/systemctl','is-enabled','--quiet',unit)
            print('PASS orchestrated signed migration retained login and project with updater enabled',flush=True)
            return
        if early_check:
            run('/usr/bin/systemctl','stop','servus-updater-socket.service')
            service_lock=os.open(state/'service.lock',os.O_RDONLY|os.O_NOFOLLOW);fcntl.flock(service_lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            policy_journal=updater.Journal(state)
            transition_lock=os.open(install/'install.lock',os.O_RDONLY);fcntl.flock(transition_lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            try:
                def resolve_child(root_digest,expected_config):
                    registry=verifier.Registry(time.monotonic()+verifier.TOTAL_SECONDS);registry.authenticate()
                    return verifier.revalidate_amd64_identity(registry,root_digest,expected_config)
                row=policy_journal.db.execute("SELECT preparation_id,staging_path FROM preparations WHERE operation_id=? AND status='prepared'",(op,)).fetchone()
                candidate=state/'policies'/('candidate-'+row[0]+'.json')
                runtime.produce(policy_journal,op,str(Path(row[1]).parent),active,str(install),str(candidate),extractor,supervisor,
                                resolve_child=resolve_child,inherited_lock=transition_lock)
                class InterruptDocker(Docker):
                    stops=0
                    def call(self,*args,**kwargs):
                        if args[0]=='stop':
                            self.stops+=1
                            if self.stops==2:raise RuntimeError('fixture stop interruption')
                        return super().call(*args,**kwargs)
                try:
                    transition.prepare_stop(policy_journal,op,active,str(state/'policies'),str(data),OLD,old_image_id,old_ids,
                        supervisor,daemon_module,adoption,runtime,quiet,InterruptDocker(),legacy,install_lock=transition_lock,trusted_ingress=trusted)
                except RuntimeError as error:
                    if str(error)!='fixture stop interruption':raise
                else:raise RuntimeError('Stop interruption was not injected')
                os.close(transition_lock);transition_lock=None;os.close(service_lock);service_lock=None
                policy_journal.db.execute("CREATE TABLE IF NOT EXISTS initial_generations(operation_id TEXT PRIMARY KEY,phase TEXT NOT NULL)")
                policy_journal.db.execute("INSERT INTO initial_generations VALUES(?,'starting')",(op,))
                args=['/usr/bin/python3','-I','/usr/local/libexec/servus/legacy-rollback-early.py','--operation',op,
                      '--old-env',str(old_env),'--old-compose',str(compose)]
                denied=subprocess.run(args,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=30)
                if denied.returncode==0 or docker.inspect(old_ids['api'])[0]['State']['Running'] is not False:
                    raise RuntimeError('Started generation did not block early recovery')
                policy_journal.db.execute('DELETE FROM initial_generations')
                run(*args,timeout=300)
                if policy_journal.db.execute('SELECT phase FROM legacy_early_rollbacks').fetchone()!=('healthy',):raise RuntimeError('Early recovery failed')
                repeated=subprocess.run(args,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=30)
                if repeated.returncode==0:raise RuntimeError('Early recovery was replayed')
                if request('/health').get('version')!='0.1.5':raise RuntimeError('Legacy API was not recovered')
                cookie='';csrf='';request('/auth/login','POST',{'email':'fixture@example.test','password':'isolated-fixture-password'})
                if not any(item.get('id')==project for item in request('/projects')):raise RuntimeError('Legacy project was not retained')
                print('PASS partial legacy stop restored original containers, login and project',flush=True)
                return
            finally:
                policy_journal.close()
                if transition_lock is not None:os.close(transition_lock)
                if service_lock is not None:os.close(service_lock)
        invalid=subprocess.run(['/usr/bin/python3','-I','/usr/local/libexec/servus/legacy-prepare.py','--operation',str(uuid.uuid4()),'--old-env',str(old_env)],
            stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=30)
        if invalid.returncode==0 or request('/health').get('version')!='0.1.5':raise RuntimeError('Unknown preparation stopped the legacy panel')
        wrong_env=config/'wrong-old.env';wrong_env.write_text(old_env.read_text().replace(OLD,'ghcr.io/raxon/servus@sha256:'+'0'*64));wrong_env.chmod(0o600)
        invalid=subprocess.run(['/usr/bin/python3','-I','/usr/local/libexec/servus/legacy-prepare.py','--operation',op,'--old-env',str(wrong_env)],
            stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=30)
        if invalid.returncode==0 or request('/health').get('version')!='0.1.5':raise RuntimeError('Wrong legacy image was accepted')
        run('/usr/bin/python3','-I','/usr/local/libexec/servus/legacy-prepare.py','--operation',op,'--old-env',str(old_env),timeout=600)
        run('/usr/bin/python3','-I','/usr/local/libexec/servus/provision-host.py','--finalize',timeout=180)
        run('/usr/bin/systemctl','start','servus-supervisor.service')
        run('/usr/bin/systemctl','start','servus-updater.service')
        journal=updater.Journal(state);daemon=daemon_module
        _,_,approved=daemon.resolve_active_policy(str(state/'journal.sqlite'),active)
        end=time.monotonic()+45
        while True:
            try:
                initial_module.check_supervisor(approved.control_dir,supervisor);initial_module.check_updater(approved.updater_dir,supervisor);break
            except (OSError,ValueError,supervisor.SupervisorError,initial_module.InitialGenerationError):
                if time.monotonic()>=end:raise
                time.sleep(.2)
    else:
        journal=updater.Journal(state)
        journal.db.execute('CREATE TABLE policy_approvals(operation_id TEXT,attempt_id TEXT,attempt_nonce TEXT,preparation_id TEXT,root_digest TEXT,image_config_digest TEXT,policy_path TEXT,accepted_env_path TEXT,source_env_path TEXT,state TEXT)')
        journal.db.execute('INSERT INTO operations(id,commit_sha,digest,tag,status,attempt_id,attempt_nonce,config_digest) VALUES(?,?,?,?,?,?,?,?)',(op,'d'*40,root_digest,'v0.1.7','verified',attempt,nonce,config_digest))
        journal.db.execute('INSERT INTO preparations VALUES(?,?,?,?,?,?)',(op,attempt,nonce,prep,'prepared','/fixture'))
        journal.db.execute('INSERT INTO policy_approvals VALUES(?,?,?,?,?,?,?,?,?,?)',(op,attempt,nonce,prep,root_digest,config_digest,'/policy','/accepted',active,'active'))
        approved=SimpleNamespace(install_dir=str(install),data_dir=str(target),control_dir='/control',updater_dir='/updater',image_reference=NEW)
        daemon=SimpleNamespace(resolve_active_policy=lambda *_:('/policy','/accepted',approved))
    fence=fence_module.MigrationFence(journal,op,active,str(data),old_ids,supervisor,daemon,adoption,quiet,docker)
    node_fd=os.open(BASE/'node',os.O_RDONLY|os.O_NOFOLLOW);lock=os.open(install/'install.lock',os.O_RDONLY)
    deadline=time.monotonic()+30
    while True:
        try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB);break
        except BlockingIOError:
            if time.monotonic()>=deadline:raise RuntimeError('Installation lock remained busy')
            time.sleep(.1)
    def start(*args,**kwargs):
        kwargs['migration'].fence.assert_locked(op,lock)
        adoption.claim(journal,op,'/active',backup,node_fd,supervisor,daemon,coordinator,restore,quiet,install_lock=lock)
        if journal.db.execute("UPDATE initial_generations SET phase='started' WHERE operation_id=? AND phase='starting'",(op,)).rowcount!=1:
            raise RuntimeError('Simulated start failed')
        return 'simulated'
    initial=initial_module if full else SimpleNamespace(launch=start)
    try:
        def execute():
            options={} if full else {'check':lambda *_:None,'updater_check':lambda *_:None}
            return transition.transition(journal,op,active,str(data),OLD,old_image_id,old_ids,str(old_env),str(compose),str(recovery_dir),str(snapshot),str(parent),node_fd,
                str(docker_config),supervisor,daemon,adoption,runtime,quiet,docker,backup,coordinator,restore,recovery,legacy,initial,extractor,fence,
                install_lock=lock,trusted_ingress=trusted,**options)
        if recover_check:
            with mock.patch.object(adoption,'record',side_effect=RuntimeError('fixture interruption')):
                try:execute()
                except RuntimeError as error:
                    if str(error)!='fixture interruption':raise
                else:raise RuntimeError('Interruption was not injected')
            transition.assess_rollback(journal,op,active,str(parent),node_fd,supervisor,daemon,adoption,runtime,
                quiet,docker,backup,coordinator,restore,recovery,fence,install_lock=lock)
            if journal.db.execute('SELECT phase FROM legacy_transitions').fetchone()!=('recovery_required',):
                raise RuntimeError('Interrupted migration was not preserved')
            os.close(lock);lock=None
            rejected=subprocess.run(['/usr/bin/python3','-I','/usr/local/libexec/servus/legacy-rollback.py','--operation',str(uuid.uuid4())],
                                    stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=30)
            if rejected.returncode==0 or list(state.glob('legacy-rollback-*')):raise RuntimeError('Unknown recovery operation was accepted')
            run('/usr/bin/python3','-I','/usr/local/libexec/servus/legacy-rollback.py','--operation',op,timeout=300)
            if journal.db.execute('SELECT phase FROM legacy_rollbacks').fetchone()!=('healthy',):raise RuntimeError('Rollback did not finish')
            repeated=subprocess.run(['/usr/bin/python3','-I','/usr/local/libexec/servus/legacy-rollback.py','--operation',op],
                                    stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=30)
            if repeated.returncode==0:raise RuntimeError('Completed recovery was replayed')
            if request('/health').get('version')!='0.1.5':raise RuntimeError('Legacy API was not restored')
            cookie='';csrf='';request('/auth/login','POST',{'email':'fixture@example.test','password':'isolated-fixture-password'})
            if not any(item.get('id')==project for item in request('/projects')):raise RuntimeError('Legacy project was not retained')
            print('PASS interrupted signed migration restored legacy login and project',flush=True)
            return
        if full:
            os.close(lock);lock=None
            invalid=subprocess.run(['/usr/bin/python3','-I','/usr/local/libexec/servus/legacy-migrate.py','--operation',str(uuid.uuid4()),
                '--old-env',str(old_env),'--old-compose',str(compose),'--recovery-dir',str(recovery_dir),'--snapshot-dir',str(snapshot)],
                stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=30)
            if invalid.returncode==0 or journal.db.execute('SELECT phase FROM legacy_transitions').fetchone()!=('stopped',):
                raise RuntimeError('Unknown migration was accepted')
            run('/usr/bin/python3','-I','/usr/local/libexec/servus/legacy-migrate.py','--operation',op,
                '--old-env',str(old_env),'--old-compose',str(compose),'--recovery-dir',str(recovery_dir),
                '--snapshot-dir',str(snapshot),timeout=600)
            result='completed'
        else:
            with mock.patch.object(supervisor,'RuntimePolicy',SimpleNamespace):result=execute()
        if (not full and result!='simulated') or journal.db.execute('SELECT phase FROM legacy_transitions').fetchone()!=('completed' if full else 'started',):raise RuntimeError('Transition failed')
        observed=set(command('ps','-aq','--no-trunc','--filter','label=com.docker.compose.project=servus').decode().splitlines())
        if observed.intersection(old_ids.values()) or (not full and observed):raise RuntimeError('Legacy containers remain')
        if os.stat(data).st_uid!=0:raise RuntimeError('Original data is not protected')
        if full:
            end=time.monotonic()+240
            while True:
                try:
                    health=request('/health')
                    if health.get('version')=='0.1.7':break
                except (OSError,ValueError):pass
                if time.monotonic()>=end:raise RuntimeError('New API did not become healthy')
                time.sleep(1)
            cookie='';csrf='';request('/auth/login','POST',{'email':'fixture@example.test','password':'isolated-fixture-password'})
            if not any(item.get('id')==project for item in request('/projects')):raise RuntimeError('Project was not retained')
            if request('/updates').get('applyAvailable') is not True:raise RuntimeError('Updater is not enabled in the panel')
            end=time.monotonic()+180
            while journal.db.execute('SELECT status FROM preparations WHERE operation_id=?',(op,)).fetchone()!=('completed',):
                if time.monotonic()>=end:raise RuntimeError('Supervisor did not finalize the initial generation')
                time.sleep(1)
            discovery=request('/updates/discovery')
            if not isinstance(discovery.get('discovery'),dict):raise RuntimeError('Updater discovery is unavailable')
            if (install/transition.MARKER).exists() or journal.db.execute('SELECT phase FROM legacy_transitions').fetchone()!=('completed',):
                raise RuntimeError('Migration was not finalized')
            for unit in ('servus-supervisor.service','servus-updater.service','servus-updater-socket.service'):
                run('/usr/bin/systemctl','is-enabled','--quiet',unit)
            # Colima installs the amd64 emulator transiently and its cloud-init
            # reprovisioning stops Docker at every boot. Restore those fixture
            # prerequisites before checking the application's own autostart.
            entry=Path('/proc/sys/fs/binfmt_misc/qemu-x86_64').read_text().splitlines()
            details=dict(line.split(' ',1) for line in entry if ' ' in line)
            magic,mask=details.get('magic'),details.get('mask')
            if (details.get('interpreter')!='/usr/bin/qemu-x86_64' or not isinstance(magic,str) or not isinstance(mask,str) or
                not re.fullmatch(r'[0-9a-f]+',magic) or not re.fullmatch(r'[0-9a-f]+',mask) or len(magic)!=len(mask) or len(magic)%2):
                raise RuntimeError('Fixture emulator identity is unavailable')
            def escape(value):return ''.join('\\x'+value[index:index+2] for index in range(0,len(value),2))
            Path('/etc/binfmt.d/servus-fixture-x86_64.conf').write_text(':qemu-x86_64:M::'+escape(magic)+':'+escape(mask)+':/usr/bin/qemu-x86_64:POCF\n')
            Path('/etc/systemd/system/servus-fixture-docker.service').write_text('[Unit]\nAfter=cloud-final.service\n[Service]\nType=oneshot\nExecStart=/usr/bin/systemctl start docker.service\n[Install]\nWantedBy=cloud-final.service\n')
            run('/usr/bin/systemctl','daemon-reload')
            run('/usr/bin/systemctl','enable','servus-fixture-docker.service')
            persistent=Path('/var/lib/servus-test-fixture');shutil.copytree(BASE,persistent)
            (persistent/'post-reboot.json').write_text(json.dumps({'project':project}));os.chmod(persistent/'post-reboot.json',0o600)
            print('PASS signed release, supervisor completion, updater discovery, service enablement and retained login',flush=True)
            return
        script="import {Store} from '/app/dist/server/store.js';const s=new Store('/fixture');if(!s.db.prepare('SELECT 1 FROM projects WHERE id=?').get(process.argv[1]))process.exit(2);s.close()"
        command('run','--rm','--network','none','--platform','linux/amd64','--user','node','--mount','type=bind,src='+approved.data_dir+',dst=/fixture',
                '--entrypoint','node',NEW,'--input-type=module','-e',script,project,timeout=180)
        print('PASS real legacy containers, capture, protection and offline data migration; startup approval simulated',flush=True)
    finally:
        if lock is not None:os.close(lock)
        os.close(node_fd);journal.close()

if __name__=='__main__':main()
