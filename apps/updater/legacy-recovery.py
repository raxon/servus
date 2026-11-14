#!/usr/bin/python3 -I
"""Preserve legacy Compose configuration for a later recovery coordinator.

This records recovery inputs only. It does not start, remove, or replace any
container, and the caller must maintain the migration's durable writer fence.
"""
import hashlib
import os
import re
import stat
import sys


class RecoveryError(Exception):
    pass


def capture(journal,operation,active_env,old_env,compose_path,destination,supervisor,daemon,adoption,policy,backup,quiescence,docker,
            *,install_lock,trusted_ingress=None):
    if sys.platform!='linux' or os.geteuid()!=0 or not sys.flags.isolated or not supervisor._uuid4(operation):
        raise RecoveryError('Isolated Linux root is required')
    policy_path,accepted,approved,binding=adoption._binding(journal,operation,active_env,supervisor,daemon)
    directory=supervisor._trusted_directory(approved.install_dir,0o700)
    try:
        expected=supervisor._open_root_file(directory,'install.lock',0o600)
        try:
            held,named=os.fstat(install_lock),os.fstat(expected)
            if (held.st_dev,held.st_ino)!=(named.st_dev,named.st_ino):raise RecoveryError('Installation lock does not match')
            supervisor._assert_exclusive_flock(install_lock)
        finally:os.close(expected)
    finally:os.close(directory)
    db=journal.db
    row=db.execute('SELECT preparation_id,attempt_id,nonce,root_digest,config_digest,policy_path,accepted_env,active_env,source,source_dev,source_ino,old_image,old_image_id,old_ids,state FROM legacy_stop_operations WHERE operation_id=?',(operation,)).fetchone()
    if not row or row[:8]!=(*binding,policy_path,accepted,active_env) or row[-1]!='stopped':raise RecoveryError('Stopped installation does not match')
    source,dev,ino,old_image,old_image_id=row[8:13]
    try:old_ids=policy._json(row[13])
    except (ValueError,TypeError) as error:raise RecoveryError('Legacy identity is invalid') from error
    if (not isinstance(old_ids,dict) or set(old_ids)!={'api','worker','agent'} or
        any(not isinstance(value,str) or not re.fullmatch(r'[a-f0-9]{64}',value) for value in old_ids.values()) or len(set(old_ids.values()))!=3 or
        not all(isinstance(path,str) and path.startswith('/') and os.path.normpath(path)==path for path in (old_env,compose_path,destination)) or
        any(path==source or path.startswith(source+'/') or source.startswith(path+'/') for path in (old_env,compose_path,destination))):
        raise RecoveryError('Recovery input paths are invalid')
    destination_fd=supervisor._trusted_directory(destination,0o700)
    try:
        if os.fstat(destination_fd).st_gid!=0 or os.listdir(destination_fd):raise RecoveryError('Recovery directory is not empty and protected')
        def inputs():
            environment=policy._read_private_file(old_env,65536);values=policy._env(environment)
            if values.get('SERVUS_IMAGE')!=old_image or values.get('SERVUS_DATA_DIR')!=source:raise RecoveryError('Legacy configuration does not match')
            parent,name=os.path.split(compose_path);fd=supervisor._trusted_directory(parent)
            try:
                entry=supervisor._open_root_file(fd,name,0o644)
                try:
                    before=os.fstat(entry);content=backup._read(entry,1024*1024);after=os.fstat(entry);named=os.stat(name,dir_fd=fd,follow_symlinks=False)
                    if ((before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns,before.st_ctime_ns)!=
                        (after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns) or
                        (before.st_dev,before.st_ino)!=(named.st_dev,named.st_ino)):raise RecoveryError('Legacy Compose file changed')
                finally:os.close(entry)
            finally:os.close(fd)
            return environment,content
        def check():
            supervisor._assert_exclusive_flock(install_lock)
            current=os.stat(source,follow_symlinks=False)
            if (current.st_dev,current.st_ino)!=(dev,ino) or (current.st_uid,current.st_gid,stat.S_IMODE(current.st_mode)) not in ((1000,1000,0o700),(0,0,0o700)):
                raise RecoveryError('Legacy data identity changed')
            if adoption._binding(journal,operation,active_env,supervisor,daemon)!=(policy_path,accepted,approved,binding):raise RecoveryError('Approved release changed')
            if db.execute('SELECT preparation_id,attempt_id,nonce,root_digest,config_digest,policy_path,accepted_env,active_env,source,source_dev,source_ino,old_image,old_image_id,old_ids,state FROM legacy_stop_operations WHERE operation_id=?',(operation,)).fetchone()!=row:
                raise RecoveryError('Legacy stop state changed')
            quiescence.ensure_host_namespaces()
            quiescence.ensure_restart_fenced(docker,set(old_ids.values()))
            quiescence.ensure_no_other_data_mounts(docker,set(old_ids.values()),source,trusted_ingress=trusted_ingress)
            quiescence.ensure_no_mount_aliases(docker,source)
            quiescence.ensure_no_open_data(source)
            quiescence.ensure_no_uid_writers(1000)
        check();environment,content=inputs()
        try:rendered=policy._json(docker.call('compose','--env-file',old_env,'-f',compose_path,'-p','servus','config','--format','json',timeout=60))
        except (ValueError,TypeError) as error:raise RecoveryError('Legacy Compose configuration is unavailable') from error
        services=rendered.get('services') if isinstance(rendered,dict) else None
        if not isinstance(services,dict) or set(services)!=set(old_ids):raise RecoveryError('Legacy Compose configuration differs')
        items=docker.inspect(*sorted(old_ids.values()))
        if not isinstance(items,list) or len(items)!=3 or any(not isinstance(item,dict) for item in items) or {item.get('Id') for item in items}!=set(old_ids.values()):
            raise RecoveryError('Legacy container inspection failed')
        for role,cid in old_ids.items():
            item=next(item for item in items if item['Id']==cid);config=item.get('Config');service=services[role]
            if not isinstance(config,dict) or not isinstance(service,dict) or item.get('Image')!=old_image_id or config.get('Image')!=old_image or service.get('image')!=old_image:
                raise RecoveryError('Legacy image differs')
            command=['node','dist/'+('server' if role=='api' else role)+'/index.js']
            volumes=service.get('volumes')
            expected_mounts={('bind',source,source,False)}
            if role=='agent':expected_mounts.add(('bind','/var/run/docker.sock','/var/run/docker.sock',False))
            if (config.get('Cmd')!=command or service.get('command')!=command or not isinstance(volumes,list) or
                any(not isinstance(volume,dict) for volume in volumes) or len(volumes)!=len(expected_mounts) or
                {(volume.get('type'),volume.get('source'),volume.get('target'),volume.get('read_only',False)) for volume in volumes}!=expected_mounts):
                raise RecoveryError('Legacy runtime configuration differs')
            env=config.get('Env');expected_env=service.get('environment')
            if not isinstance(env,list) or not all(isinstance(value,str) and '=' in value for value in env) or not isinstance(expected_env,dict):
                raise RecoveryError('Legacy environment is unavailable')
            pairs=[value.split('=',1) for value in env]
            if len({key for key,_ in pairs})!=len(pairs) or any(not isinstance(key,str) or not isinstance(value,str) or dict(pairs).get(key)!=value for key,value in expected_env.items()):
                raise RecoveryError('Legacy environment differs')
        check()
        if inputs()!=(environment,content):raise RecoveryError('Recovery input changed')
        env_hash='sha256:'+hashlib.sha256(environment).hexdigest();compose_hash='sha256:'+hashlib.sha256(content).hexdigest()
        db.execute('BEGIN IMMEDIATE')
        try:
            check()
            db.execute("CREATE TABLE IF NOT EXISTS legacy_recovery(operation_id TEXT PRIMARY KEY,path TEXT NOT NULL,env_digest TEXT NOT NULL,compose_digest TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('capturing','verified','recovery_required'))) ")
            if db.execute('SELECT 1 FROM legacy_recovery LIMIT 1').fetchone():raise RecoveryError('Existing recovery inputs require inspection')
            db.execute("INSERT INTO legacy_recovery VALUES(?,?,?,?,'capturing')",(operation,destination,env_hash,compose_hash))
            db.execute('COMMIT')
        except BaseException:
            if db.in_transaction:db.execute('ROLLBACK')
            raise
        try:
            policy._publish_private(destination_fd,'legacy.env',environment)
            policy._publish_private(destination_fd,'compose.yaml',content)
            check()
            if inputs()!=(environment,content):raise RecoveryError('Recovery input changed')
            for name,expected in (('legacy.env',environment),('compose.yaml',content)):
                fd=supervisor._open_root_file(destination_fd,name,0o600)
                try:
                    if backup._read(fd,1024*1024)!=expected:raise RecoveryError('Recovery copy changed')
                finally:os.close(fd)
            if db.execute("UPDATE legacy_recovery SET state='verified' WHERE operation_id=? AND state='capturing'",(operation,)).rowcount!=1:
                raise RecoveryError('Recovery state changed')
            return env_hash,compose_hash
        except BaseException:
            try:db.execute("UPDATE legacy_recovery SET state='recovery_required' WHERE operation_id=? AND state='capturing'",(operation,))
            except BaseException:pass
            raise
    finally:os.close(destination_fd)


def verify(journal,operation,active_env,supervisor,daemon,adoption,policy,backup,*,install_lock):
    """Revalidate the protected recovery files under the installation lock."""
    if sys.platform!='linux' or os.geteuid()!=0 or not sys.flags.isolated or not supervisor._uuid4(operation):
        raise RecoveryError('Isolated Linux root is required')
    path,accepted,approved,binding=adoption._binding(journal,operation,active_env,supervisor,daemon)
    install=supervisor._trusted_directory(approved.install_dir,0o700)
    try:
        expected=supervisor._open_root_file(install,'install.lock',0o600)
        try:
            held,named=os.fstat(install_lock),os.fstat(expected)
            if (held.st_dev,held.st_ino)!=(named.st_dev,named.st_ino):raise RecoveryError('Installation lock does not match')
            supervisor._assert_exclusive_flock(install_lock)
        finally:os.close(expected)
    finally:os.close(install)
    row=journal.db.execute('SELECT preparation_id,attempt_id,nonce,root_digest,config_digest,policy_path,accepted_env,active_env,source,old_image,state FROM legacy_stop_operations WHERE operation_id=?',(operation,)).fetchone()
    evidence=journal.db.execute('SELECT path,env_digest,compose_digest,state FROM legacy_recovery WHERE operation_id=?',(operation,)).fetchone()
    if not row or row[:8]!=(*binding,path,accepted,active_env) or row[-1]!='stopped' or not evidence or evidence[-1]!='verified':
        raise RecoveryError('Recovery evidence does not match')
    recovery_path,env_digest,compose_digest,_=evidence
    if any(not isinstance(value,str) or not re.fullmatch(r'sha256:[a-f0-9]{64}',value) for value in (env_digest,compose_digest)):
        raise RecoveryError('Recovery digest is invalid')
    directory=supervisor._trusted_directory(recovery_path,0o700)
    try:
        if os.fstat(directory).st_gid!=0 or set(os.listdir(directory))!={'legacy.env','compose.yaml'}:raise RecoveryError('Recovery inventory differs')
        content={}
        for name,digest in (('legacy.env',env_digest),('compose.yaml',compose_digest)):
            fd=supervisor._open_root_file(directory,name,0o600)
            try:
                before=os.fstat(fd);value=backup._read(fd,1024*1024);after=os.fstat(fd);named=os.stat(name,dir_fd=directory,follow_symlinks=False)
                if ((before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns,before.st_ctime_ns)!=
                    (after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns) or
                    (before.st_dev,before.st_ino)!=(named.st_dev,named.st_ino) or 'sha256:'+hashlib.sha256(value).hexdigest()!=digest):
                    raise RecoveryError('Recovery file changed')
                content[name]=value
            finally:os.close(fd)
        values=policy._env(content['legacy.env'])
        if values.get('SERVUS_IMAGE')!=row[9] or values.get('SERVUS_DATA_DIR')!=row[8]:raise RecoveryError('Recovery configuration differs')
        if adoption._binding(journal,operation,active_env,supervisor,daemon)!=(path,accepted,approved,binding) or journal.db.execute('SELECT path,env_digest,compose_digest,state FROM legacy_recovery WHERE operation_id=?',(operation,)).fetchone()!=evidence:
            raise RecoveryError('Recovery evidence changed')
        return evidence[:3]
    finally:os.close(directory)
