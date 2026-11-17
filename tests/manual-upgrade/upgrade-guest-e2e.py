#!/usr/bin/python3 -I
"""Exercise the actual one-off coordinator on a disposable Swarm VM only."""
import importlib.util
import json
import os
import pathlib
import shutil
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid

if os.geteuid()!=0 or not os.uname().nodename.startswith('colima-servus-upgrade-e2e-'):
    raise SystemExit('Disposable servus-upgrade-e2e VM required')
BASE=pathlib.Path('/run/servus-upgrade-fixture')
spec=importlib.util.spec_from_file_location('manual_upgrade',BASE/'manual-upgrade.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
ENV={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','HOME':'/root','LANG':'C','LC_ALL':'C','DOCKER_HOST':'unix:///var/run/docker.sock','DOCKER_CONFIG':'/dev/null'}
def docker(*args,timeout=120):
    try:return subprocess.check_output(['/usr/bin/docker',*args],env=ENV,stderr=subprocess.PIPE,text=True,timeout=timeout).strip()
    except subprocess.CalledProcessError as error:
        print(error.stderr,file=sys.stderr)
        raise


def wait(description,fun,timeout=240):
    end=time.monotonic()+timeout
    while time.monotonic()<end:
        result=fun()
        if result:return result
        time.sleep(1)
    raise RuntimeError('Timed out: '+description)


def main():
    if sys.argv[1:] not in ([],['--kill-after-switch'],['--recover-after-capture'],['--kill-during-recovery'],['--finish-after-switch'],['--finish-mixed-restart'],['--finish-restart-docker'],['--worker-killed-active'],['--cli-execute'],['--cli-recover-old'],['--cli-recover-new']):raise RuntimeError('Invalid fixture mode')
    fault=sys.argv[1:] in (['--kill-after-switch'],['--finish-after-switch'],['--finish-mixed-restart'],['--finish-restart-docker'],['--worker-killed-active'])
    recovery=sys.argv[1:] in (['--recover-after-capture'],['--kill-during-recovery'])
    fixture_config=BASE/'docker-config';fixture_config.mkdir(mode=0o700)
    ENV['DOCKER_CONFIG']=str(fixture_config)
    if any(pathlib.Path(p).exists() for p in ('/opt/servus','/etc/servus','/var/lib/servus')):
        raise RuntimeError('Fixture requires clean paths')
    for args in (('ps','-aq'),('service','ls','-q'),('volume','ls','-q'),('secret','ls','-q')):
        if docker(*args):raise RuntimeError('Fixture requires an empty Swarm')
    install=pathlib.Path('/opt/servus');release=install/'releases'/'fixture';deployment=release/'deployment'
    deployment.mkdir(mode=0o700,parents=True);os.chmod(install,0o700);os.chmod(install/'releases',0o700);os.chmod(release,0o700)
    shutil.copyfile(BASE/'compose.yaml',deployment/'compose.yaml');os.chmod(deployment/'compose.yaml',0o644)
    (install/'current').symlink_to(release);(install/'install.lock').write_text('');os.chmod(install/'install.lock',0o600)
    etc=pathlib.Path('/etc/servus');etc.mkdir(mode=0o700)
    data=pathlib.Path('/var/lib/servus');data.mkdir(mode=0o700);os.chown(data,1000,1000)
    gid=os.stat('/var/run/docker.sock').st_gid
    contents=(f'SERVUS_IMAGE={module.OLD}\nSERVUS_DATA_DIR={data}\nSERVUS_PORT=4180\nSERVUS_INGRESS_PORT=80\n'
              f'SERVUS_DOCKER_GID={gid}\nSERVUS_BIND_ADDRESS=127.0.0.1\nSERVUS_PUBLIC_URL=https://159.65.115.230\n'
              'SERVUS_ALLOWED_ORIGINS=http://127.0.0.1:4180,https://159.65.115.230\nSERVUS_SECURE_COOKIES=true\nSERVUS_SOURCE_REF=fixture\n')
    env=etc/'servus.env';env.write_text(contents);os.chmod(env,0o600)
    docker('compose','--env-file',str(env),'-f',str(deployment/'compose.yaml'),'-p','servus','up','-d',timeout=180)
    origin='http://127.0.0.1:4180'; cookie=''; csrf=''
    def request(path,method='GET',body=None,idem=None):
        nonlocal cookie,csrf
        headers={'origin':origin,'accept':'application/json'}
        if cookie:headers['cookie']=cookie
        if csrf:headers['x-csrf-token']=csrf
        if idem:headers['idempotency-key']=idem
        payload=None
        if body is not None:payload=json.dumps(body).encode();headers['content-type']='application/json'
        with urllib.request.urlopen(urllib.request.Request(origin+'/api/v1'+path,data=payload,headers=headers,method=method),timeout=8) as response:
            set_cookie=response.headers.get('set-cookie')
            if set_cookie:cookie=set_cookie.split(';',1)[0]
            value=json.load(response)
            if isinstance(value,dict) and value.get('csrfToken'):csrf=value['csrfToken']
            return value
    def ready():
        try:return request('/health').get('status')=='ok'
        except (OSError,ValueError):return False
    wait('old API',ready)
    email='fixture@example.test';password='isolated-fixture-password'
    request('/setup','POST',{'email':email,'password':password})
    project=request('/projects','POST',{'name':'fixture'})
    created=request('/projects/'+project['id']+'/services','POST',{'name':'app','kind':'app','image':'nginx:alpine','port':80,'domains':[],'replicas':1},str(uuid.uuid4()))
    sid=created['service']['id']
    def action_done(action):
        item=request('/actions/'+action)['action']
        if item['status']=='failed':raise RuntimeError('Fixture deployment failed')
        return item['status']=='succeeded'
    wait('first deployment',lambda:action_done(created['action']['id']),timeout=420)
    latest=request('/services/'+sid+'/deploy','POST',{},str(uuid.uuid4()))
    wait('second deployment',lambda:action_done(latest['id']),timeout=420)
    # The isolated ARM host has a different image ID than the pinned production ingress.
    ingress_ids=docker('ps','-q','--filter','label=com.docker.swarm.service.name=panel-ingress').splitlines()
    if len(ingress_ids)!=1:raise RuntimeError('Fixture ingress unavailable')
    module.TRUSTED_INGRESS_IMAGE=json.loads(docker('inspect',ingress_ids[0]))[0]['Image']
    failed=str(uuid.uuid4());jobid=str(uuid.uuid4())
    with sqlite3.connect(data/'panel.sqlite') as panel,sqlite3.connect(data/'agent.sqlite') as agent:
        panel.row_factory=sqlite3.Row;agent.row_factory=sqlite3.Row
        action=panel.execute('SELECT * FROM actions WHERE id=?',(latest['id'],)).fetchone()
        job=panel.execute('SELECT * FROM jobs WHERE action_id=?',(latest['id'],)).fetchone()
        op=agent.execute('SELECT * FROM operations WHERE id=?',(latest['id'],)).fetchone()
        if not action or not job or not op or not op['target_spec']:raise RuntimeError('Fixture journal is incomplete')
        action_values=dict(action);action_values.update(id=failed,status='failed',created_at='2000-01-01T00:00:00.000Z',updated_at='2000-01-01T00:00:01.000Z',finished_at='2000-01-01T00:00:01.000Z')
        job_values=dict(job);job_values.update(id=jobid,action_id=failed,status='failed',created_at='2000-01-01T00:00:00.000Z')
        op_values=dict(op);op_values.update(id=failed,state='failed',operation_stage='rolling_back',previous_spec=op['target_spec'],previous_recorded=1,updated_at='2000-01-01T00:00:01.000Z',response=json.dumps({'error':{'message':'Operation failed; restored the previous runtime configuration.'}}))
        for db,table,values in ((panel,'actions',action_values),(panel,'jobs',job_values),(agent,'operations',op_values)):
            keys=list(values);db.execute('INSERT INTO '+table+' ('+','.join(keys)+') VALUES ('+','.join('?' for _ in keys)+')',[values[key] for key in keys])
    panel.close();agent.close()
    if sys.argv[1:] in (['--cli-execute'],['--cli-recover-old'],['--cli-recover-new']):
        clean_env={'PATH':'/usr/bin:/bin','LANG':'C','LC_ALL':'C'}
        if sys.argv[1:]==['--cli-execute']:
            subprocess.run(['/usr/bin/python3','-I','-B',str(BASE/'manual-upgrade.py'),'--execute'],check=True,timeout=900,env=clean_env)
            expected_phase='complete'
        else:
            checkpoint='ready_to_switch' if sys.argv[1:]==['--cli-recover-old'] else 'verifying'
            subprocess.run(['/usr/bin/python3','-I','-B',str(BASE/'upgrade-cli-trace.py'),checkpoint],check=True,timeout=900,env=clean_env)
            if module.recovery_status(install)['phase']!=checkpoint:raise RuntimeError('CLI checkpoint differs')
            original=env.read_bytes();env.write_bytes(original.replace(b'SERVUS_IMAGE=',b'SERVUS_IMAGE=invalid-'))
            try:
                attempt=subprocess.run(['/usr/bin/python3','-I','-B',str(BASE/'manual-upgrade.py'),'--recover'],timeout=240,env=clean_env)
                if attempt.returncode==0 or module.recovery_status(install)['phase']!=checkpoint:raise RuntimeError('Invalid configuration was accepted')
            finally:env.write_bytes(original)
            if checkpoint=='ready_to_switch':
                hosts=pathlib.Path('/etc/hosts');original_hosts=hosts.read_text()
                hosts.write_text('127.0.0.2 ghcr.io github.com api.github.com\n'+original_hosts)
                try:
                    blocked=subprocess.run(['/usr/bin/python3','-I','-B','/usr/local/libexec/servus/verification-executor.py',
                        '--digest',module.NEW.split('@')[1],'--commit',module.REVISION,'--tag','v0.1.5'],timeout=150,env=clean_env,
                        stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
                    if blocked.returncode==0:raise RuntimeError('Registry outage fixture did not block verification')
                    subprocess.run(['/usr/bin/python3','-I','-B',str(BASE/'manual-upgrade.py'),'--recover'],check=True,timeout=900,env=clean_env)
                finally:hosts.write_text(original_hosts)
                print('PASS old recovery while registry is unavailable',flush=True)
            else:
                subprocess.run(['/usr/bin/python3','-I','-B',str(BASE/'manual-upgrade.py'),'--recover'],check=True,timeout=900,env=clean_env)
            expected_phase='recovered' if checkpoint=='ready_to_switch' else 'complete'
        if module.recovery_status(install)['phase']!=expected_phase:raise RuntimeError('CLI did not complete')
        cookie='';csrf='';request('/auth/login','POST',{'email':email,'password':password})
        history=request('/services/'+sid+'/actions')
        if not any(row.get('id')==failed and row.get('status')=='failed' for row in history):raise RuntimeError('History changed')
        subsequent=request('/services/'+sid+'/deploy','POST',{},str(uuid.uuid4()))
        wait('CLI post-upgrade deployment',lambda:action_done(subsequent['id']),timeout=420)
        print('PASS actual CLI '+sys.argv[1]+' with real attestation, local TLS, retained history and new deployment')
        return
    # The host is ARM; a native Node binary is used only for this test's backup
    # validator. The signed amd64 release remains the image under test.
    original_tools=module.release_tools
    def fixture_tools(client,target,**kwargs):
        original_tools(client,target,**kwargs)
        if os.uname().machine in ('aarch64','arm64'):
            cid=client.call('create','--pull=never','--platform=linux/arm64','--entrypoint=/bin/false','node:24-bookworm-slim').decode().strip()
            try:
                (target/'node').unlink()
                client.call('cp',cid+':/usr/local/bin/node',str(target/'node'),timeout=120)
                os.chown(target/'node',0,0);os.chmod(target/'node',0o755)
            finally:client.call('rm','-f',cid)
    module.release_tools=fixture_tools
    original_load=module.load_backup
    def diagnostic_load(path):
        backup=original_load(path);reader=backup._reader
        def diagnostic_reader(*args):
            try: return reader(*args)
            except BaseException as error:
                detail=str(error) if isinstance(error,backup.CaptureError) else 'errno='+str(getattr(error,'errno',None))+' sqlite='+str(getattr(error,'sqlite_errorname',None))
                print('Fixture reader failed:',type(error).__name__,detail,file=sys.stderr,flush=True)
                raise
        backup._reader=diagnostic_reader
        return backup
    module.load_backup=diagnostic_load
    def fixture_health(_url,version,revision,**kwargs):
        return module.health_check(origin+'/api/v1/health',version,revision,**kwargs)
    if recovery:
        child=os.fork()
        if child==0:
            original_marker=module.set_marker
            def terminate_after_checkpoint(path,operation,phase,**details):
                original_marker(path,operation,phase,**details)
                if phase=='ready_to_switch':os.kill(os.getpid(),__import__('signal').SIGKILL)
            module.set_marker=terminate_after_checkpoint
            module.run_upgrade(health=fixture_health)
            os._exit(1)
        _,status=os.waitpid(child,0)
        if not os.WIFSIGNALED(status) or os.WTERMSIG(status)!=9:raise RuntimeError('Fault was not injected')
        if module.recovery_status(install)['phase']!='ready_to_switch':raise RuntimeError('Unexpected recovery phase')
        if sys.argv[1:]==['--kill-during-recovery']:
            child=os.fork()
            if child==0:
                def kill_recovery(*_args,**_kwargs):os.kill(os.getpid(),__import__('signal').SIGKILL)
                module.recover_old(health=kill_recovery)
                os._exit(1)
            _,status=os.waitpid(child,0)
            if not os.WIFSIGNALED(status) or os.WTERMSIG(status)!=9:raise RuntimeError('Recovery fault was not injected')
            if module.recovery_status(install)['phase']!='recovery_verifying':raise RuntimeError('Unexpected recovery marker')
            subprocess.run(['/usr/bin/systemctl','restart','docker'],check=True,timeout=90,env=ENV)
            def daemon_ready():
                try:docker('info');return True
                except (OSError,subprocess.SubprocessError):return False
            wait('Docker restart',daemon_ready,timeout=90)
            components=module.container_ids(module.Docker(fixture_config))
            if any(item['State']['Running'] or item['HostConfig']['RestartPolicy']['Name']!='no' for item in components.values()):
                raise RuntimeError('Panel restarted after interrupted recovery')
            try:module.recover_old(health=fixture_health)
            except module.UpgradeError:pass
            else:raise RuntimeError('Interrupted recovery was not blocked')
            print('PASS SIGKILL during recovery, restart disabled and retry refused')
            return
        module.recover_old(health=fixture_health)
        if module.recovery_status(install)['phase']!='recovered':raise RuntimeError('Recovery did not complete')
        cookie='';csrf='';request('/auth/login','POST',{'email':email,'password':password})
        history=request('/services/'+sid+'/actions')
        if not any(row.get('id')==failed and row.get('status')=='failed' for row in history):raise RuntimeError('Live failure history changed')
        print('PASS SIGKILL after capture, resumed old version and preserved history and login')
        return
    if fault:
        child=os.fork()
        if child==0:
            if sys.argv[1:]==['--finish-mixed-restart']:
                original_call=module.Docker.call
                def terminate_after_update(client,*args,**kwargs):
                    result=original_call(client,*args,**kwargs)
                    if args[:2]==('update','--restart=unless-stopped'):os.kill(os.getpid(),__import__('signal').SIGKILL)
                    return result
                module.Docker.call=terminate_after_update
                module.run_upgrade(health=fixture_health)
            else:
                def terminate_after_switch(_url,_version,_revision,**_kwargs):
                    os.kill(os.getpid(),__import__('signal').SIGKILL)
                module.run_upgrade(health=terminate_after_switch)
            os._exit(1)
        _,status=os.waitpid(child,0)
        if not os.WIFSIGNALED(status) or os.WTERMSIG(status)!=9:raise RuntimeError('Fault was not injected')
        marker=json.loads((install/'manual-upgrade-state.json').read_text())
        if marker['phase']!='verifying' or not pathlib.Path(marker['backup'],'snapshot','manifest.json').is_file():
            raise RuntimeError('Recovery marker or snapshot is missing')
        if sys.argv[1:]==['--worker-killed-active']:
            client=module.Docker(fixture_config);current=module.container_ids(client)
            docker('pause',current['agent']['Id'])
            action=request('/services/'+sid+'/deploy','POST',{},str(uuid.uuid4()))
            def job_running():
                with sqlite3.connect(data/'panel.sqlite') as db:
                    row=db.execute('SELECT status FROM jobs WHERE action_id=?',(action['id'],)).fetchone()
                return row and row[0]=='running'
            wait('Worker to claim job',job_running,timeout=90)
            docker('kill','--signal=KILL',current['worker']['Id'])
            docker('stop','--time','30',current['api']['Id'])
            docker('unpause',current['agent']['Id']);docker('stop','--time','30',current['agent']['Id'])
            if json.loads(docker('inspect',current['worker']['Id']))[0]['State']['ExitCode']!=137:
                raise RuntimeError('Worker was not killed during the active job')
            try:module.finish_verified(health=fixture_health)
            except module.UpgradeError:pass
            else:raise RuntimeError('Killed worker was accepted')
            if module.recovery_status(install)['phase']!='verifying':raise RuntimeError('Recovery marker changed')
            print('PASS killed worker during an active job; recovery refused')
            return
        if sys.argv[1:] in (['--finish-after-switch'],['--finish-mixed-restart'],['--finish-restart-docker']):
            if sys.argv[1:]==['--finish-mixed-restart']:
                current=module.container_ids(module.Docker(fixture_config))
                policies=sorted(item['HostConfig']['RestartPolicy']['Name'] for item in current.values())
                if policies!=['no','no','unless-stopped']:raise RuntimeError('Mixed policy state was not reached')
                worker=current['worker']['Id'];docker('pause',worker)
                try:
                    try:module.finish_verified(health=fixture_health)
                    except module.UpgradeError:pass
                    else:raise RuntimeError('Paused worker was accepted')
                    if module.recovery_status(install)['phase']!='verifying':raise RuntimeError('Paused worker changed recovery marker')
                finally:docker('unpause',worker)
            if sys.argv[1:]==['--finish-restart-docker']:
                subprocess.run(['/usr/bin/systemctl','restart','docker'],check=True,timeout=90,env=ENV)
                def daemon_ready():
                    try:docker('info');return True
                    except (OSError,subprocess.SubprocessError):return False
                wait('Docker restart',daemon_ready,timeout=90)
                current=module.container_ids(module.Docker(fixture_config))
                if any(item['State']['Running'] for item in current.values()):raise RuntimeError('Panel did not remain stopped')
                print('Stopped role states:',{role:{key:item['State'].get(key) for key in ('Status','ExitCode','Paused','Restarting')} for role,item in current.items()},flush=True)
                client=module.Docker(fixture_config)
                def swarm_reconciled():
                    try:return module.reconciled_failure(pathlib.Path(marker['backup'])/'snapshot',client)==failed
                    except module.UpgradeError:return False
                wait('Swarm reconciliation',swarm_reconciled,timeout=180)
                with sqlite3.connect(data/'panel.sqlite') as db:
                    db.execute("UPDATE jobs SET status='running' WHERE action_id=?",(latest['id'],))
                try:
                    try:module.finish_verified(health=fixture_health)
                    except module.UpgradeError as error:
                        if str(error)!='Live operation journal requires manual investigation':raise
                    else:raise RuntimeError('Active job was accepted')
                    if module.recovery_status(install)['phase']!='verifying':raise RuntimeError('Active job changed recovery marker')
                finally:
                    with sqlite3.connect(data/'panel.sqlite') as db:
                        db.execute("UPDATE jobs SET status='succeeded' WHERE action_id=?",(latest['id'],))
            module.finish_verified(health=fixture_health)
            if module.recovery_status(install)['phase']!='complete':raise RuntimeError('Switch did not complete')
            cookie='';csrf='';request('/auth/login','POST',{'email':email,'password':password})
            history=request('/services/'+sid+'/actions')
            if not any(row.get('id')==failed and row.get('status')=='failed' for row in history):raise RuntimeError('History changed')
            subsequent=request('/services/'+sid+'/deploy','POST',{},str(uuid.uuid4()))
            wait('Post-recovery deployment',lambda:action_done(subsequent['id']),timeout=420)
            history=request('/services/'+sid+'/actions')
            if not any(row.get('id')==failed and row.get('status')=='failed' for row in history):raise RuntimeError('History changed after deployment')
            if not any(row.get('id')==subsequent['id'] and row.get('status')=='succeeded' for row in history):raise RuntimeError('Post-recovery deployment is missing')
            print('PASS SIGKILL after switch, resumed new version, preserved history and processed a new deployment')
            return
        client=module.Docker(fixture_config)
        before=module.container_ids(client)
        if any((item.get('HostConfig',{}).get('RestartPolicy') or {}).get('Name')!='no' for item in before.values()):
            raise RuntimeError('Automatic restart was enabled before verification')
        subprocess.run(['/usr/bin/systemctl','restart','docker'],check=True,timeout=90,env=ENV)
        def daemon_ready():
            try:docker('info');return True
            except (OSError,subprocess.SubprocessError):return False
        wait('Docker restart',daemon_ready,timeout=90)
        after=module.container_ids(client)
        if any(item.get('State',{}).get('Running') is not False or (item.get('HostConfig',{}).get('RestartPolicy') or {}).get('Name')!='no' for item in after.values()):
            raise RuntimeError('Panel restarted after interrupted upgrade')
        try:module.run_upgrade(health=fixture_health)
        except module.UpgradeError:pass
        else:raise RuntimeError('Recovery marker did not block retry')
        print('PASS SIGKILL after switching, retained snapshot and marker, no automatic restart after Docker restart')
        return
    backup=module.run_upgrade(health=fixture_health)
    marker=json.loads((install/'manual-upgrade-state.json').read_text())
    if marker['phase']!='complete':raise RuntimeError('Upgrade did not complete')
    with sqlite3.connect(backup/'snapshot'/'panel.sqlite') as panel:
        if panel.execute('SELECT status FROM actions WHERE id=?',(failed,)).fetchone()!=('failed',):raise RuntimeError('Failure history changed')
    cookie='';csrf='';request('/auth/login','POST',{'email':email,'password':password})
    history=request('/services/'+sid+'/actions')
    if not any(row.get('id')==failed and row.get('status')=='failed' for row in history):raise RuntimeError('Live failure history changed')
    print('PASS real Docker upgrade, retained historical failure and local login; public HTTPS and registry attestation are separately verified')


if __name__=='__main__':
    try:main()
    except BaseException:
        marker=pathlib.Path('/opt/servus/manual-upgrade-state.json')
        if marker.is_file():
            try:print('Fixture recovery phase:',json.loads(marker.read_text()).get('phase'),file=sys.stderr)
            except (OSError,ValueError):pass
        raise
