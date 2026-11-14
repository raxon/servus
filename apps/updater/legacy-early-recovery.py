#!/usr/bin/python3 -I
"""Recover original containers interrupted before legacy data capture."""
import os
import re
import stat
import sys
import time


class EarlyRecoveryError(Exception):
    pass


def recover(journal,operation,active_env,old_env,compose_path,policy_root,work_dir,supervisor,daemon,adoption,policy,
            quiet,docker,backup,*,install_lock,service,trusted_ingress=None,timeout=180):
    """Restart only recorded legacy containers; never replay an interrupted recovery."""
    if sys.platform!='linux' or os.geteuid()!=0 or not sys.flags.isolated or not supervisor._uuid4(operation):
        raise EarlyRecoveryError('Isolated Linux root is required')
    if type(timeout) is not int or not 1<=timeout<=300:raise EarlyRecoveryError('Invalid recovery timeout')
    db=journal.db
    row=db.execute('SELECT preparation_id,attempt_id,nonce,root_digest,config_digest,policy_path,accepted_env,active_env,source,source_dev,source_ino,old_image,old_image_id,old_ids,state FROM legacy_stop_operations WHERE operation_id=?',(operation,)).fetchone()
    if not row or row[-1] not in ('stopping','stopped','recovery_required'):raise EarlyRecoveryError('Legacy stop evidence is unavailable')
    source,dev,ino,image,image_id=row[8:13];ids=policy._json(row[13])
    if (not isinstance(ids,dict) or set(ids)!={'agent','api','worker'} or
        any(not isinstance(value,str) or not supervisor.CONTAINER.fullmatch(value) for value in ids.values()) or len(set(ids.values()))!=3):
        raise EarlyRecoveryError('Legacy container identity is invalid')
    approval=db.execute('SELECT state FROM policy_approvals WHERE operation_id=?',(operation,)).fetchone()
    if approval==('candidate',):binding=lambda:adoption.prepared_binding(journal,operation,active_env,policy_root,supervisor,policy)
    elif approval==('active',):binding=lambda:adoption._binding(journal,operation,active_env,supervisor,daemon)
    else:raise EarlyRecoveryError('Policy state requires inspection')
    path,accepted,approved,proof=binding()
    if row[:8]!=(*proof,path,accepted,active_env):raise EarlyRecoveryError('Legacy policy binding differs')
    install=supervisor._trusted_directory(approved.install_dir,0o700)
    try:
        named=supervisor._open_root_file(install,'install.lock',0o600)
        try:
            held,expected=os.fstat(install_lock),os.fstat(named)
            if (held.st_dev,held.st_ino)!=(expected.st_dev,expected.st_ino):raise EarlyRecoveryError('Installation lock differs')
            supervisor._assert_exclusive_flock(install_lock)
        finally:os.close(named)
        marker=supervisor._open_root_file(install,'.legacy-migration-v1',0o600)
        try:
            value=('servus-legacy-migration-v1 '+operation+'\n').encode('ascii')
            if os.read(marker,len(value)+1)!=value:raise EarlyRecoveryError('Migration marker differs')
        finally:os.close(marker)
        if db.execute('SELECT operation_id,phase FROM legacy_transitions').fetchall() not in ([(operation,'stopped')],[(operation,'recovery_required')],[(operation,'starting')]):
            raise EarlyRecoveryError('Migration phase requires inspection')
        for table in ('initial_generations','legacy_snapshots','legacy_protections','legacy_removals','initial_adoptions'):
            if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",(table,)).fetchone() and db.execute('SELECT 1 FROM '+table+' LIMIT 1').fetchone():
                raise EarlyRecoveryError('Data transition has already started')
        if any(service('is-active',unit)!=(3,'inactive') for unit in ('servus-supervisor.service','servus-updater.service','servus-updater-bootstrap.service','servus-updater-socket.service')):
            raise EarlyRecoveryError('Host services must be stopped')
        environment=policy._read_private_file(old_env,65536);values=policy._env(environment)
        if values.get('SERVUS_IMAGE')!=image or values.get('SERVUS_DATA_DIR')!=source:raise EarlyRecoveryError('Legacy configuration differs')
        parent,name=os.path.split(compose_path);directory=supervisor._trusted_directory(parent)
        try:
            fd=supervisor._open_root_file(directory,name,0o644)
            try:compose=backup._read(fd,1024*1024)
            finally:os.close(fd)
        finally:os.close(directory)
        rendered=policy._json(docker.call('compose','--env-file',old_env,'-f',compose_path,'-p','servus','config','--format','json',timeout=60))
        services=rendered.get('services') if isinstance(rendered,dict) else None
        if not isinstance(services,dict) or set(services)!=set(ids):raise EarlyRecoveryError('Legacy Compose configuration differs')
        def inspect():
            supervisor._assert_exclusive_flock(install_lock)
            if binding()!=(path,accepted,approved,proof):raise EarlyRecoveryError('Policy changed')
            supervisor._verify_data_directory(source)
            source_info=os.stat(source,follow_symlinks=False)
            if (source_info.st_dev,source_info.st_ino,source_info.st_uid,source_info.st_gid,stat.S_IMODE(source_info.st_mode))!=(dev,ino,1000,1000,0o700):
                raise EarlyRecoveryError('Legacy data identity differs')
            quiet.ensure_host_namespaces()
            quiet.ensure_no_other_data_mounts(docker,set(ids.values()),source,trusted_ingress=trusted_ingress,allow_running_expected=True)
            records=docker.inspect(*sorted(ids.values()))
            if not isinstance(records,list) or len(records)!=3 or {item.get('Id') for item in records if isinstance(item,dict)}!=set(ids.values()):
                raise EarlyRecoveryError('Legacy inventory differs')
            for role,cid in ids.items():
                item=next(item for item in records if item['Id']==cid);config=item.get('Config') or {};host=item.get('HostConfig') or {};state=item.get('State') or {};svc=services[role]
                labels=config.get('Labels') or {};mounts=item.get('Mounts');volumes=svc.get('volumes') if isinstance(svc,dict) else None
                expected={(source,source,True)};compose_mounts={('bind',source,source,False)}
                if role=='agent':expected.add(('/var/run/docker.sock','/var/run/docker.sock',True));compose_mounts.add(('bind','/var/run/docker.sock','/var/run/docker.sock',False))
                command=['node','dist/'+('server' if role=='api' else role)+'/index.js'];env=config.get('Env');service_env=svc.get('environment')
                if (item.get('Image')!=image_id or config.get('Image')!=image or svc.get('image')!=image or config.get('User')!='node' or
                    config.get('Cmd')!=command or svc.get('command')!=command or labels.get('com.docker.compose.project')!='servus' or
                    labels.get('com.docker.compose.service')!=role or any(key.startswith('com.docker.swarm.') for key in labels) or
                    host.get('Privileged') is not False or host.get('PidMode')!='' or host.get('AutoRemove') is not False or
                    (host.get('RestartPolicy') or {}).get('Name') not in ('no','unless-stopped') or
                    type(state.get('Running')) is not bool or state.get('Paused') is not False or state.get('Restarting') is not False or
                    not isinstance(mounts,list) or any(not isinstance(m,dict) or m.get('Type')!='bind' for m in mounts) or
                    len(mounts)!=len(expected) or {(m.get('Source'),m.get('Destination'),m.get('RW')) for m in mounts}!=expected or
                    not isinstance(volumes,list) or any(not isinstance(v,dict) for v in volumes) or len(volumes)!=len(compose_mounts) or
                    {(v.get('type'),v.get('source'),v.get('target'),v.get('read_only',False)) for v in volumes}!=compose_mounts or
                    not isinstance(env,list) or not all(isinstance(v,str) and '=' in v for v in env) or not isinstance(service_env,dict)):
                    raise EarlyRecoveryError('Legacy runtime differs')
                pairs=[v.split('=',1) for v in env]
                if len({key for key,_ in pairs})!=len(pairs) or any(not isinstance(k,str) or not isinstance(v,str) or dict(pairs).get(k)!=v for k,v in service_env.items()):
                    raise EarlyRecoveryError('Legacy environment differs')
            return {item['Id']:item for item in records}
        images=policy._json(docker.call('image','inspect',image,timeout=30))
        if not isinstance(images,list) or len(images)!=1 or (images[0] or {}).get('Id')!=image_id:raise EarlyRecoveryError('Legacy image differs')
        labels=((images[0].get('Config') or {}).get('Labels') or {});version=labels.get('org.opencontainers.image.version');revision=labels.get('org.opencontainers.image.revision')
        if not isinstance(version,str) or not version.startswith('v') or not isinstance(revision,str) or not re.fullmatch(r'[a-f0-9]{40}',revision):
            raise EarlyRecoveryError('Legacy image metadata differs')
        inspect();current=policy._read_private_file(active_env,65536)
        work=supervisor._trusted_directory(work_dir,0o700)
        try:
            if os.fstat(work).st_gid!=0 or os.listdir(work):raise EarlyRecoveryError('Recovery work directory is not empty')
            db.execute("CREATE TABLE IF NOT EXISTS legacy_early_rollbacks(operation_id TEXT PRIMARY KEY,phase TEXT NOT NULL CHECK(phase IN ('intent','stopped','starting','healthy','recovery_required'))) ")
            if db.execute('SELECT 1 FROM legacy_early_rollbacks LIMIT 1').fetchone():raise EarlyRecoveryError('Existing recovery requires inspection')
            db.execute("INSERT INTO legacy_early_rollbacks VALUES(?,'intent')",(operation,));phase='intent'
            def advance(next_phase):
                nonlocal phase
                if db.execute('UPDATE legacy_early_rollbacks SET phase=? WHERE operation_id=? AND phase=?',(next_phase,operation,phase)).rowcount!=1:
                    raise EarlyRecoveryError('Recovery state changed')
                phase=next_phase
            try:
                policy._publish_private(work,'previous-active.env',current)
                for role in ('api','worker','agent'):
                    inspect();docker.call('update','--restart=no',ids[role],timeout=30)
                for role in ('api','worker','agent'):
                    state=inspect()[ids[role]]['State']
                    if state['Running']:docker.call('stop','--time','180',ids[role],timeout=200)
                inspect();quiet.ensure_restart_fenced(docker,set(ids.values()))
                quiet.ensure_no_other_data_mounts(docker,set(ids.values()),source,trusted_ingress=trusted_ingress)
                quiet.ensure_no_mount_aliases(docker,source);quiet.ensure_no_open_data(source);quiet.ensure_no_uid_writers(1000)
                if policy._read_private_file(old_env,65536)!=environment or policy._read_private_file(active_env,65536)!=current:
                    raise EarlyRecoveryError('Configuration changed')
                directory=supervisor._trusted_directory(os.path.dirname(compose_path))
                try:
                    fd=supervisor._open_root_file(directory,os.path.basename(compose_path),0o644)
                    try:
                        if backup._read(fd,1024*1024)!=compose:raise EarlyRecoveryError('Compose configuration changed')
                    finally:os.close(fd)
                finally:os.close(directory)
                advance('stopped')
                config=supervisor._trusted_directory(os.path.dirname(active_env),0o700)
                try:policy._replace_private(config,os.path.basename(active_env),environment)
                finally:os.close(config)
                advance('starting');deadline=time.monotonic()+timeout
                for role in ('agent','api','worker'):
                    docker.call('start',ids[role],timeout=60)
                    while True:
                        item=docker.inspect(ids[role]);state=item[0].get('State') if isinstance(item,list) and len(item)==1 else None
                        if not isinstance(state,dict) or state.get('Running') is not True:raise EarlyRecoveryError('Legacy component failed to start')
                        health=state.get('Health');status=health.get('Status') if isinstance(health,dict) else None
                        if role=='worker' or status=='healthy':break
                        if status=='unhealthy' or time.monotonic()>=deadline:raise EarlyRecoveryError('Legacy component is unhealthy')
                        time.sleep(1)
                script="fetch('http://127.0.0.1:4180/api/v1/health').then(r=>r.json()).then(v=>process.exit(v.status==='ok'&&v.version===process.argv[1]&&v.revision===process.argv[2]?0:1)).catch(()=>process.exit(1))"
                docker.call('exec',ids['api'],'node','-e',script,version[1:],revision,timeout=30)
                for role in ('agent','api','worker'):docker.call('update','--restart=unless-stopped',ids[role],timeout=30)
                records=docker.inspect(*ids.values())
                if not isinstance(records,list) or len(records)!=3 or {item.get('Id') for item in records if isinstance(item,dict)}!=set(ids.values()):
                    raise EarlyRecoveryError('Recovered container inventory differs')
                for item in records:
                    if (item.get('Image')!=image_id or (item.get('State') or {}).get('Running') is not True or
                        ((item.get('HostConfig') or {}).get('RestartPolicy') or {}).get('Name')!='unless-stopped'):
                        raise EarlyRecoveryError('Recovered container is not ready for restart')
                advance('healthy');return ids
            except BaseException:
                try:db.execute("UPDATE legacy_early_rollbacks SET phase='recovery_required' WHERE operation_id=? AND phase=?",(operation,phase))
                except BaseException:pass
                raise
        finally:os.close(work)
    finally:os.close(install)
