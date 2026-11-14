#!/usr/bin/python3 -I
"""Durably stop a validated legacy control plane before snapshot capture.

This module neither creates a snapshot nor permits starting a new generation.
The coordinator must protect the original data and implement explicit recovery.
"""
import json
import os
import re
import stat
import sys


class LegacyStopError(Exception):
    pass


def stop(journal,operation,active_env,source,old_image,old_image_id,old_ids,supervisor,daemon,adoption,quiescence,docker,
         *,install_lock,trusted_ingress=None):
    """Stop only the recorded legacy containers, leaving durable recovery state."""
    if sys.platform!='linux' or os.geteuid()!=0 or not sys.flags.isolated:raise LegacyStopError('Isolated Linux root is required')
    if (not supervisor._uuid4(operation) or not isinstance(source,str) or not source.startswith('/') or source=='/' or os.path.normpath(source)!=source or
        not isinstance(old_image,str) or not re.fullmatch(r'ghcr\.io/raxon/servus@sha256:[a-f0-9]{64}',old_image) or
        not isinstance(old_image_id,str) or not re.fullmatch(r'sha256:[a-f0-9]{64}',old_image_id) or
        not isinstance(old_ids,dict) or set(old_ids)!={'api','worker','agent'} or
        any(not isinstance(value,str) or not re.fullmatch(r'[a-f0-9]{64}',value) for value in old_ids.values()) or len(set(old_ids.values()))!=3):
        raise LegacyStopError('Invalid legacy installation identity')
    policy_path,accepted,approved,binding=adoption._binding(journal,operation,active_env,supervisor,daemon)
    if source==approved.data_dir or source.startswith(approved.data_dir+'/') or approved.data_dir.startswith(source+'/'):
        raise LegacyStopError('Migration data paths overlap')
    install=supervisor._trusted_directory(approved.install_dir,0o700)
    try:
        expected=supervisor._open_root_file(install,'install.lock',0o600)
        try:
            held,named=os.fstat(install_lock),os.fstat(expected)
            if (held.st_dev,held.st_ino)!=(named.st_dev,named.st_ino):raise LegacyStopError('Installation lock does not match')
            supervisor._assert_exclusive_flock(install_lock)
        finally:os.close(expected)
    finally:os.close(install)
    quiescence.ensure_host_namespaces()
    supervisor._verify_data_directory(source)
    source_fd=os.open(source,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:
        info=os.fstat(source_fd)
        if (info.st_uid,info.st_gid,stat.S_IMODE(info.st_mode))!=(1000,1000,0o700):raise LegacyStopError('Legacy data permissions are invalid')
        identity=(info.st_dev,info.st_ino)
        def inspect(*,initial=False):
            try:ids=docker.call('ps','-aq','--no-trunc','--filter','label=com.docker.compose.project=servus').decode('ascii').splitlines()
            except (UnicodeError,ValueError):raise LegacyStopError('Container inventory is invalid') from None
            if len(ids)!=3 or len(set(ids))!=3 or set(ids)!=set(old_ids.values()):raise LegacyStopError('Legacy container inventory changed')
            records=docker.inspect(*sorted(ids))
            if not isinstance(records,list) or len(records)!=3 or any(not isinstance(item,dict) for item in records) or {item.get('Id') for item in records}!=set(ids):
                raise LegacyStopError('Legacy container inspection failed')
            for item in records:
                config,state,host,mounts=item.get('Config'),item.get('State'),item.get('HostConfig'),item.get('Mounts')
                if not all(isinstance(value,dict) for value in (config,state,host)) or not isinstance(mounts,list):raise LegacyStopError('Legacy container inspection failed')
                labels=config.get('Labels') or {};role=labels.get('com.docker.compose.service') if isinstance(labels,dict) else None
                if (role not in old_ids or old_ids[role]!=item['Id'] or labels.get('com.docker.compose.project')!='servus' or
                    any(key.startswith('com.docker.swarm.') for key in labels) or item.get('Image')!=old_image_id or
                    config.get('Image')!=old_image or config.get('User')!='node' or
                    config.get('Cmd')!=['node','dist/'+('server' if role=='api' else role)+'/index.js'] or
                    host.get('Privileged') is not False or host.get('PidMode')!='' or host.get('AutoRemove') is not False or
                    not isinstance(host.get('RestartPolicy'),dict) or host['RestartPolicy'].get('Name') not in ('unless-stopped','no') or
                    state.get('Paused') is not False or state.get('Restarting') is not False or type(state.get('Running')) is not bool):
                    raise LegacyStopError('Legacy container identity changed')
                if initial and (state.get('Running') is not True or host['RestartPolicy']['Name']!='unless-stopped'):
                    raise LegacyStopError('Legacy control plane is not running normally')
                expected_mounts={(source,source,True)}
                if role=='agent':expected_mounts.add(('/var/run/docker.sock','/var/run/docker.sock',True))
                if (any(not isinstance(mount,dict) or mount.get('Type')!='bind' for mount in mounts) or len(mounts)!=len(expected_mounts) or
                    {(mount.get('Source'),mount.get('Destination'),mount.get('RW')) for mount in mounts}!=expected_mounts):
                    raise LegacyStopError('Legacy container mounts changed')
            named=os.stat(source,follow_symlinks=False);current=os.fstat(source_fd)
            if (named.st_dev,named.st_ino)!=(current.st_dev,current.st_ino) or (current.st_dev,current.st_ino)!=identity or (current.st_uid,current.st_gid,stat.S_IMODE(current.st_mode))!=(1000,1000,0o700):
                raise LegacyStopError('Legacy data directory changed')
            if adoption._binding(journal,operation,active_env,supervisor,daemon)!=(policy_path,accepted,approved,binding):raise LegacyStopError('Approved release changed')
            return {item['Id']:item for item in records}
        inspect(initial=True)
        db=journal.db;db.execute('BEGIN IMMEDIATE')
        try:
            inspect(initial=True)
            db.execute("CREATE TABLE IF NOT EXISTS legacy_stop_operations (operation_id TEXT PRIMARY KEY, preparation_id TEXT NOT NULL, attempt_id TEXT NOT NULL, nonce TEXT NOT NULL, root_digest TEXT NOT NULL, config_digest TEXT NOT NULL, policy_path TEXT NOT NULL, accepted_env TEXT NOT NULL, active_env TEXT NOT NULL, source TEXT NOT NULL, source_dev INTEGER NOT NULL, source_ino INTEGER NOT NULL, old_image TEXT NOT NULL, old_image_id TEXT NOT NULL, old_ids TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('stopping','stopped','recovery_required'))) ")
            if db.execute('SELECT 1 FROM legacy_stop_operations LIMIT 1').fetchone():raise LegacyStopError('Existing legacy stop requires recovery')
            db.execute("INSERT INTO legacy_stop_operations VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'stopping')",(operation,*binding,policy_path,accepted,active_env,source,*identity,old_image,old_image_id,json.dumps(old_ids,sort_keys=True,separators=(',',':'))))
            db.execute('COMMIT')
        except BaseException:
            if db.in_transaction:db.execute('ROLLBACK')
            raise
        try:
            for role in ('api','worker','agent'):
                inspect();docker.call('update','--restart=no',old_ids[role],timeout=30)
            for role in ('api','worker','agent'):
                inspect();docker.call('stop','--time','180',old_ids[role],timeout=200)
                state=inspect()[old_ids[role]]['State']
                if state.get('Running') is not False or state.get('ExitCode') not in ((0,143) if role=='worker' else (0,)):
                    raise LegacyStopError('Legacy component did not stop cleanly')
            inspect();quiescence.ensure_restart_fenced(docker,set(old_ids.values()))
            quiescence.ensure_no_other_data_mounts(docker,set(old_ids.values()),source,trusted_ingress=trusted_ingress)
            quiescence.ensure_no_mount_aliases(docker,source)
            quiescence.ensure_no_open_data(source)
            quiescence.ensure_no_uid_writers(1000)
            inspect();quiescence.ensure_restart_fenced(docker,set(old_ids.values()))
            if db.execute("UPDATE legacy_stop_operations SET state='stopped' WHERE operation_id=? AND state='stopping'",(operation,)).rowcount!=1:
                raise LegacyStopError('Legacy stop state changed')
        except BaseException:
            try:db.execute("UPDATE legacy_stop_operations SET state='recovery_required' WHERE operation_id=? AND state='stopping'",(operation,))
            except BaseException:pass
            raise
        return identity
    finally:os.close(source_fd)
