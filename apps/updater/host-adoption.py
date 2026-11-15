#!/usr/bin/python3 -I
"""Orchestrate a root-authorized transition from legacy host services.

The caller must load this module and its dependencies from a separately
verified, root-owned source. The active and historical releases are rebound to
the protected updater journal by the coordinator before any unit changes.
"""
import argparse
from contextlib import closing
import fcntl
import hashlib
import json
import os
import re
import sqlite3
import stat
import subprocess
import sys
import types
import urllib.parse


class HostAdoptionError(Exception):
    pass


MODULE_FILES = {
    'supervisor':'supervisor.py', 'daemon':'supervisor-daemon.py', 'bundle':'host-bundle.py',
    'coordinator':'host-coordinator.py', 'unit_mask':'host-unit-mask.py', 'switch':'host-switch.py',
    'exchange':'host-exchange.py', 'fence':'host-fence.py', 'quiescence':'quiescence.py',
    'recovery':'host-recovery.py', 'extractor':'extract-install.py', 'backup':'backup.py',
    'install_host':'install-host.py', 'install_gh':'install-gh.py', 'runner':'host-runner.py',
    'provisioner':'provision-host.py',
}
UUID=re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
STAGE=re.compile(r'^servus-install-[a-f0-9]{32}$')


def _directory(path, mode):
    if not isinstance(path,str) or not os.path.isabs(path) or os.path.normpath(path)!=path:
        raise HostAdoptionError('Invalid protected directory')
    fd=os.open('/',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:
        for name in path.split('/')[1:]:
            if not name:continue
            child=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
            os.close(fd);fd=child;info=os.fstat(fd)
            if info.st_uid!=0 or info.st_gid!=0 or info.st_mode&0o022:raise HostAdoptionError('Untrusted directory')
        if stat.S_IMODE(os.fstat(fd).st_mode)!=mode:raise HostAdoptionError('Unexpected directory mode')
        return fd
    except BaseException:
        os.close(fd);raise


def _read(directory,name,mode,limit):
    fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC,dir_fd=directory)
    try:
        before=os.fstat(fd);named=os.stat(name,dir_fd=directory,follow_symlinks=False)
        if (not stat.S_ISREG(before.st_mode) or before.st_uid!=0 or before.st_gid!=0 or before.st_nlink!=1 or
            stat.S_IMODE(before.st_mode)!=mode or before.st_size>limit or
            (before.st_dev,before.st_ino)!=(named.st_dev,named.st_ino)):
            raise HostAdoptionError('Untrusted release file')
        data=bytearray()
        while len(data)<=limit:
            chunk=os.read(fd,min(65536,limit+1-len(data)))
            if not chunk:break
            data.extend(chunk)
        after=os.fstat(fd);named=os.stat(name,dir_fd=directory,follow_symlinks=False)
        identity=lambda item:(item.st_dev,item.st_ino,item.st_size,item.st_mtime_ns,item.st_ctime_ns)
        if len(data)!=before.st_size or identity(before)!=identity(after) or (before.st_dev,before.st_ino)!=(named.st_dev,named.st_ino):
            raise HostAdoptionError('Release file changed')
        return bytes(data)
    finally:os.close(fd)


def _check_journal(directory):
    """Validate the journal without affecting existing SQLite locks."""
    fd=os.open('journal.sqlite',os.O_PATH|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=directory)
    try:
        info=os.fstat(fd);named=os.stat('journal.sqlite',dir_fd=directory,follow_symlinks=False)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or info.st_gid!=0 or info.st_nlink!=1 or
            stat.S_IMODE(info.st_mode)!=0o600 or info.st_size>64*1024*1024 or
            (info.st_dev,info.st_ino)!=(named.st_dev,named.st_ino)):
            raise HostAdoptionError('Untrusted journal')
    finally:os.close(fd)


def load_verified_modules(operation_id, *, state_dir, active_env, source_file):
    """Verify the active stage and all dependency bytes before executing any."""
    if (sys.platform!='linux' or os.geteuid()!=0 or not sys.flags.isolated or
        not isinstance(operation_id,str) or not UUID.fullmatch(operation_id) or
        not isinstance(active_env,str) or not os.path.isabs(active_env) or os.path.normpath(active_env)!=active_env):
        raise HostAdoptionError('Invalid adoption bootstrap')
    state=_directory(state_dir,0o700);stage_fd=apps_fd=module_fd=None
    try:
        journal=os.path.join(state_dir,'journal.sqlite')
        _check_journal(state)
        uri='file:'+urllib.parse.quote(journal,safe='/')+'?mode=ro'
        with closing(sqlite3.connect(uri,uri=True,timeout=5)) as db:
            rows=db.execute("SELECT p.staging_path FROM operations o JOIN preparations p ON p.operation_id=o.id "
                "JOIN update_transactions t ON t.operation_id=o.id JOIN apply_requests r ON r.operation_id=o.id "
                "JOIN policy_approvals a ON a.operation_id=o.id WHERE o.id=? AND o.status='verified' "
                "AND p.status='completed' AND t.phase='completed' AND r.state='completed' AND a.state='active' "
                "AND a.source_env_path=? AND o.digest=t.root_digest AND o.digest=a.root_digest "
                "AND o.config_digest=a.image_config_digest AND o.attempt_id=p.attempt_id AND o.attempt_id=t.attempt_id "
                "AND o.attempt_id=a.attempt_id AND o.attempt_nonce=p.attempt_nonce AND o.attempt_nonce=t.attempt_nonce "
                "AND o.attempt_nonce=a.attempt_nonce AND p.preparation_id=t.preparation_id AND p.preparation_id=a.preparation_id",
                (operation_id,active_env)).fetchall()
        if len(rows)!=1 or not isinstance(rows[0][0],str):raise HostAdoptionError('Active release is unavailable')
        stage=rows[0][0];parent=os.path.join(state_dir,'staging')
        if (not os.path.isabs(stage) or os.path.normpath(stage)!=stage or os.path.dirname(stage)!=parent or
            not STAGE.fullmatch(os.path.basename(stage)) or source_file!=os.path.join(stage,'apps/updater/host-adoption.py')):
            raise HostAdoptionError('Adoption source is not the active release')
        stage_fd=_directory(stage,0o700)
        raw=_read(stage_fd,'manifest.json',0o644,262144)
        def unique(pairs):
            result={}
            for key,value in pairs:
                if key in result:raise HostAdoptionError('Duplicate manifest field')
                result[key]=value
            return result
        try:document=json.loads(raw,object_pairs_hook=unique)
        except (ValueError,UnicodeError,RecursionError) as error:raise HostAdoptionError('Invalid release manifest') from error
        if (not isinstance(document,dict) or set(document)!={'schema','minimumUpdaterAbi','files'} or
            type(document['schema']) is not int or document['schema']!=1 or
            type(document['minimumUpdaterAbi']) is not int or document['minimumUpdaterAbi']!=1 or
            not isinstance(document['files'],list) or not 1<=len(document['files'])<=256):
            raise HostAdoptionError('Unsupported release manifest')
        records={}
        for entry in document['files']:
            if not isinstance(entry,dict) or not isinstance(entry.get('path'),str) or entry['path'] in records:
                raise HostAdoptionError('Invalid manifest record')
            records[entry['path']]=entry
        apps_fd=os.open('apps',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=stage_fd)
        module_fd=os.open('updater',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=apps_fd)
        for fd in (apps_fd,module_fd):
            info=os.fstat(fd)
            if info.st_uid!=0 or info.st_gid!=0 or stat.S_IMODE(info.st_mode)!=0o755 or info.st_dev!=os.fstat(stage_fd).st_dev:
                raise HostAdoptionError('Unsafe release module directory')
        contents={}
        for name in set(MODULE_FILES.values())|{'host-adoption.py'}:
            record=records.get('apps/updater/'+name)
            if (not isinstance(record,dict) or set(record)!={'path','type','mode','size','sha256'} or record['type']!='file' or
                type(record['mode']) is not int or record['mode']!=0o644 or type(record['size']) is not int or
                not 0<=record['size']<=4*1024*1024 or not isinstance(record['sha256'],str) or
                not re.fullmatch(r'[a-f0-9]{64}',record['sha256'])):
                raise HostAdoptionError('Invalid dependency record')
            data=_read(module_fd,name,0o644,4*1024*1024)
            if len(data)!=record['size'] or hashlib.sha256(data).hexdigest()!=record['sha256']:
                raise HostAdoptionError('Release dependency differs')
            contents[name]=data
        _check_journal(state)
        result={}
        for key,name in MODULE_FILES.items():
            module_name='supervisor' if key=='supervisor' else 'servus_adoption_'+key
            module=types.ModuleType(module_name);module.__file__=os.path.join(stage,'apps/updater',name)
            sys.modules[module_name]=module
            exec(compile(contents[name],module.__file__,'exec'),module.__dict__)
            result[key]=module
        return result
    finally:
        for fd in (module_fd,apps_fd,stage_fd,state):
            if fd is not None:os.close(fd)


def systemctl(*arguments):
    try:
        subprocess.run(['/usr/bin/systemctl',*arguments],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL,cwd='/',env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LANG':'C','LC_ALL':'C'},
                       timeout=60,check=True)
    except (OSError,subprocess.SubprocessError) as error:
        raise HostAdoptionError('Systemd operation failed') from error


def adopt(old_operation, active_operation, *, modules, paths, service=systemctl):
    """Prepare boot recovery, exchange the active host runtime, then enable its timer."""
    supervisor=modules['supervisor'];bundle=modules['bundle'];installer=modules['install_host']
    coordinator=modules['coordinator'];runner=modules['runner'];provisioner=modules['provisioner']
    if (sys.platform!='linux' or os.geteuid()!=0 or not sys.flags.isolated or not callable(service) or
        not isinstance(old_operation,str) or not bundle.OPERATION.fullmatch(old_operation) or
        not isinstance(active_operation,str) or not bundle.OPERATION.fullmatch(active_operation) or
        old_operation==active_operation):
        raise HostAdoptionError('Invalid host adoption request')
    state=install=host=units=host_lock=install_lock=db=candidates=None
    try:
        state=supervisor._trusted_directory(paths['state'],0o700)
        install=supervisor._trusted_directory(paths['install'],0o700)
        host=supervisor._trusted_directory(paths['active'],0o755)
        units=supervisor._trusted_directory(paths['units'],0o755)
        install_lock=supervisor._open_root_file(install,'install.lock',0o600)
        fcntl.flock(install_lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        installer.publish(state,'host.lock',b'',0o600)
        host_lock=supervisor._open_root_file(state,'host.lock',0o600)
        fcntl.flock(host_lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        candidates=provisioner.child_directory(state,'host-generations')
        if os.fstat(candidates).st_dev!=os.fstat(host).st_dev:
            raise HostAdoptionError('Host generations must share a filesystem')
        fd=supervisor._open_root_file(state, 'journal.sqlite', 0o600, path_only=True);os.close(fd)
        import sqlite3
        db=sqlite3.connect(os.path.join(paths['state'],'journal.sqlite'),isolation_level=None,timeout=5)
        coordinator.adopt_verified_units(db,old_operation,active_operation,state_dir=paths['state'],active_env=paths['active_env'],
            state_fd=state,install_fd=install,host_fd=host,units_fd=units,host_lock=host_lock,install_lock=install_lock,
            supervisor=supervisor,daemon=modules['daemon'],extractor=modules['extractor'],backup=modules['backup'],
            bundle=bundle,install_host=installer,unit_mask=modules['unit_mask'])
    finally:
        if db is not None:db.close()
        for fd in (candidates,host_lock,install_lock,units,host,install,state):
            if fd is not None:os.close(fd)
    service('daemon-reload')
    service('enable','servus-host-recovery.service','servus-host-recovery-finish.service')
    runner.activate(active_operation,modules=modules,paths=paths)
    service('enable','--now','servus-host-update.timer')


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--old-operation',required=True)
    parser.add_argument('--active-operation',required=True)
    args=parser.parse_args()
    paths={'state':'/var/lib/servus-updater','install':'/opt/servus','gate':'/etc/servus/lifecycle',
           'active':'/usr/local/libexec/servus','parent':'/usr/local/libexec',
           'candidates':'/var/lib/servus-updater/host-generations','units':'/etc/systemd/system',
           'active_env':'/etc/servus/servus.env','socket':'/etc/servus/supervisor-control/command'}
    try:
        modules=load_verified_modules(args.active_operation,state_dir=paths['state'],active_env=paths['active_env'],
                                      source_file=os.path.abspath(__file__))
        adopt(args.old_operation,args.active_operation,modules=modules,paths=paths)
    except (HostAdoptionError,OSError,ValueError,RuntimeError,sqlite3.Error,subprocess.SubprocessError):
        print('Host adoption did not complete; inspect the host before retrying.',file=sys.stderr)
        return 1
    print('Verified host adoption completed.')
    return 0


if __name__=='__main__':sys.exit(main())
