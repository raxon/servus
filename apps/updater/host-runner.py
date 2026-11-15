#!/usr/bin/python3 -I
"""Run a root-authorized host update for one completed signed release.

The scheduled entry point runs only after the host recovery service. Explicit
operation IDs are reserved for a root operator.
"""
import argparse
import fcntl
import importlib.util
import os
import sqlite3
import stat
import sys
import types


class HostRunnerError(Exception):
    pass


PATHS = {
    'state': '/var/lib/servus-updater', 'install': '/opt/servus',
    'gate': '/etc/servus/lifecycle', 'active': '/usr/local/libexec/servus',
    'parent': '/usr/local/libexec', 'candidates': '/var/lib/servus-updater/host-generations',
    'units': '/etc/systemd/system', 'active_env': '/etc/servus/servus.env',
    'socket': '/etc/servus/supervisor-control/command',
}


def activate(operation_id, *, modules, paths=PATHS):
    """Authorize the active release, then stage and activate its host runtime."""
    supervisor=modules['supervisor'];daemon=modules['daemon'];bundle=modules['bundle']
    coordinator=modules['coordinator'];unit_mask=modules['unit_mask'];switch=modules['switch']
    if (sys.platform!='linux' or os.geteuid()!=0 or not sys.flags.isolated or
        not isinstance(operation_id,str) or not bundle.OPERATION.fullmatch(operation_id)):
        raise HostRunnerError('Invalid host activation request')
    state=install=units=active=runtime=candidates=host_lock=install_lock=service_lock=db=None
    try:
        state=supervisor._trusted_directory(paths['state'],0o700)
        install=supervisor._trusted_directory(paths['install'],0o700)
        units=supervisor._trusted_directory(paths['units'],0o755)
        active=supervisor._trusted_directory(paths['parent'],0o755)
        runtime=supervisor._trusted_directory(paths['active'],0o755)
        candidates=supervisor._trusted_directory(paths['candidates'],0o700)
        host_lock=supervisor._open_root_file(state,'host.lock',0o600)
        install_lock=supervisor._open_root_file(install,'install.lock',0o600)
        for fd in (host_lock,install_lock):fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        dbpath=paths['state']+'/journal.sqlite';fd=supervisor._open_root_file(state,'journal.sqlite',0o600);os.close(fd)
        db=sqlite3.connect(dbpath,isolation_level=None,timeout=5)
        policy_path,accepted_env,policy=daemon.resolve_active_policy(dbpath,paths['active_env'])
        identities=supervisor.inspect_servus(policy)
        digest,stage=bundle.completed_update(db,operation_id,paths['state']+'/staging',policy_path,paths['active_env'],policy.image_reference)
        def authorize():
            if (daemon.resolve_active_policy(dbpath,paths['active_env']) != (policy_path,accepted_env,policy) or
                supervisor.inspect_servus(policy) != identities or
                bundle.completed_update(db,operation_id,paths['state']+'/staging',policy_path,paths['active_env'],policy.image_reference)!=(digest,stage)):
                raise HostRunnerError('Active update changed')
        originals={name:modules['install_host'].read_file(units,name,0o644) for name in unit_mask.UNITS}
        service_lock,initial=coordinator.stop_updater(db,operation_id,digest,state_fd=state,install_fd=install,
            host_lock=host_lock,install_lock=install_lock,supervisor=supervisor,unit_mask=unit_mask,bundle=bundle,authorize=authorize)
        generation,prepared_digest,contents,cli,pin=coordinator.prepare_completed(db,operation_id,
            state_dir=paths['state'],install_dir=paths['install'],gate_dir=paths['gate'],candidate_parent=paths['candidates'],
            host_dir=paths['active'],active_env=paths['active_env'],service_lock=service_lock,install_lock=install_lock,
            supervisor=supervisor,daemon=daemon,extractor=modules['extractor'],backup=modules['backup'],bundle=bundle,
            install_host=modules['install_host'],install_gh=modules['install_gh'],include_material=True)
        if generation!='runtime-'+operation_id or prepared_digest!=digest:raise HostRunnerError('Prepared release differs')
        coordinator.prepare_recovery_snapshot(db,operation_id,digest,state_fd=state,install_fd=install,active_fd=runtime,
            candidate_parent=candidates,host_lock=host_lock,service_lock=service_lock,install_lock=install_lock,
            supervisor=supervisor,bundle=bundle,install_host=modules['install_host'])
        def fence():modules['fence'].assert_fenced(paths['active'],modules['quiescence'])
        coordinator.activate_prepared(db,operation_id,digest,originals,initial,contents,cli,pin,state_fd=state,install_fd=install,
            units_fd=units,active_parent=active,candidate_parent=candidates,host_lock=host_lock,service_lock=service_lock,
            install_lock=install_lock,supervisor=supervisor,unit_mask=unit_mask,host_switch=switch,bundle=bundle,
            exchange=modules['exchange'],fence=fence,authorize=authorize,supervisor_socket=paths['socket'])
    finally:
        if db is not None:db.close()
        for fd in (service_lock,install_lock,host_lock,candidates,runtime,active,units,install,state):
            if fd is not None:os.close(fd)


def pending_activation(db, policy_path, active_env, image_reference, staging_parent, *, bundle):
    """Select only the completed update backing the currently active policy."""
    rows=db.execute("SELECT a.operation_id FROM policy_approvals a "
        "JOIN update_transactions t ON t.operation_id=a.operation_id "
        "JOIN apply_requests r ON r.operation_id=a.operation_id "
        "WHERE a.state='active' AND a.policy_path=? AND a.source_env_path=? "
        "AND t.phase='completed' AND r.state='completed'",(policy_path,active_env)).fetchall()
    if len(rows)>1:raise HostRunnerError('Active update is ambiguous')
    if not rows:return None
    operation_id=rows[0][0]
    bundle.completed_update(db,operation_id,staging_parent,policy_path,active_env,image_reference)
    if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='host_stops'").fetchone():
        if db.execute("SELECT 1 FROM host_stops WHERE status!='completed' OR status IS NULL LIMIT 1").fetchone():
            raise HostRunnerError('Host update requires recovery')
        previous=db.execute('SELECT status FROM host_stops WHERE operation_id=?',(operation_id,)).fetchone()
        if previous:
            if previous[0]=='completed':return None
            raise HostRunnerError('Host update requires recovery')
    return operation_id


def activate_current(*, modules, paths=PATHS):
    """Activate the current completed release once; activation rechecks trust."""
    supervisor=modules['supervisor'];daemon=modules['daemon']
    state=supervisor._trusted_directory(paths['state'],0o700)
    try:
        fd=supervisor._open_root_file(state,'journal.sqlite',0o600)
        try:
            named=os.stat(paths['state']+'/journal.sqlite',follow_symlinks=False);opened=os.fstat(fd)
            if (named.st_dev,named.st_ino)!=(opened.st_dev,opened.st_ino):raise HostRunnerError('Journal identity differs')
        finally:os.close(fd)
        dbpath=paths['state']+'/journal.sqlite'
        policy_path,_,policy=daemon.resolve_active_policy(dbpath,paths['active_env'])
        db=sqlite3.connect(dbpath,isolation_level=None,timeout=5)
        try:
            operation_id=pending_activation(db,policy_path,paths['active_env'],policy.image_reference,
                paths['state']+'/staging',bundle=modules['bundle'])
        finally:db.close()
    finally:os.close(state)
    if operation_id is not None:activate(operation_id,modules=modules,paths=paths)


def load_modules():
    """Load only protected root-owned installed modules before the exchange."""
    directory=PATHS['active']
    fd=os.open('/',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:
        for component in directory.split('/')[1:]:
            child=os.open(component,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
            os.close(fd);fd=child
            info=os.fstat(fd)
            if info.st_uid!=0 or info.st_mode & 0o022:raise HostRunnerError('Host module path is unsafe')
        info=os.fstat(fd)
        if info.st_gid!=0 or stat.S_IMODE(info.st_mode)!=0o755:raise HostRunnerError('Host module directory is unsafe')
        item=os.open('supervisor.py',os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=fd)
        try:
            info=os.fstat(item);named=os.stat('supervisor.py',dir_fd=fd,follow_symlinks=False)
            if (not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or info.st_gid!=0 or info.st_nlink!=1 or
                stat.S_IMODE(info.st_mode)!=0o644 or (info.st_dev,info.st_ino)!=(named.st_dev,named.st_ino)):
                raise HostRunnerError('Host supervisor module is unsafe')
        finally:os.close(item)
    finally:os.close(fd)
    import supervisor
    fd=supervisor._trusted_directory(directory,0o755)
    try:
        names={'daemon':'supervisor-daemon','bundle':'host-bundle','coordinator':'host-coordinator',
               'unit_mask':'host-unit-mask','switch':'host-switch','exchange':'host-exchange',
               'fence':'host-fence','quiescence':'quiescence','recovery':'host-recovery','extractor':'extract-install',
               'backup':'backup','install_host':'install-host','install_gh':'install-gh'}
        result={'supervisor':supervisor}
        for key,name in names.items():
            item=supervisor._open_root_file(fd,name+'.py',0o644);os.close(item)
            spec=importlib.util.spec_from_file_location('servus_host_'+name.replace('-','_'),directory+'/'+name+'.py')
            if not spec or not spec.loader:raise HostRunnerError('Host module is unavailable')
            module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);result[key]=module
        return result
    finally:os.close(fd)



def load_recovery_snapshot(db, operation_id, image_digest, candidate_parent, *, bundle):
    """Load executable recovery modules only after checking the saved generation."""
    row=db.execute('SELECT image_digest,metadata_size,metadata_digest,status FROM host_recovery_snapshots WHERE operation_id=?',(operation_id,)).fetchone()
    if not row or row[0]!=image_digest or row[3] not in ('prepared','abandoned'):
        raise HostRunnerError('Recovery snapshot is unavailable')
    names={'supervisor':'supervisor.py','coordinator':'host-coordinator.py','unit_mask':'host-unit-mask.py',
           'switch':'host-switch.py','bundle':'host-bundle.py','exchange':'host-exchange.py','fence':'host-fence.py',
           'quiescence':'quiescence.py','install_host':'install-host.py','recovery':'host-recovery.py'}
    contents=bundle.load_generation(candidate_parent,operation_id,image_digest,row[1],row[2],tuple(names.values()))
    result={}
    previous=sys.modules.get('supervisor')
    try:
        for key,filename in names.items():
            name='supervisor' if key=='supervisor' else 'servus_saved_'+key
            module=types.ModuleType(name);module.__file__='<verified-host-recovery>/' + filename
            sys.modules[name]=module
            exec(compile(contents[filename][1],module.__file__,'exec'),module.__dict__)
            result[key]=module
        return result
    except BaseException:
        if previous is None:sys.modules.pop('supervisor',None)
        else:sys.modules['supervisor']=previous
        for key in names:
            if key!='supervisor':sys.modules.pop('servus_saved_'+key,None)
        raise


def recover_pending(*, modules, paths=PATHS, prepare_only):
    """Resolve the sole unfinished host operation and invoke verified recovery."""
    supervisor=modules['supervisor'];bundle=modules['bundle']
    if sys.platform!='linux' or os.geteuid()!=0 or not sys.flags.isolated or type(prepare_only) is not bool:
        raise HostRunnerError('Invalid host recovery context')
    state=supervisor._trusted_directory(paths['state'],0o700);candidates=None;db=None
    try:
        fd=supervisor._open_root_file(state,'journal.sqlite',0o600)
        try:
            named=os.stat(paths['state']+'/journal.sqlite',follow_symlinks=False);opened=os.fstat(fd)
            if (named.st_dev,named.st_ino)!=(opened.st_dev,opened.st_ino):raise HostRunnerError('Journal identity differs')
        finally:os.close(fd)
        db=sqlite3.connect(paths['state']+'/journal.sqlite',isolation_level=None,timeout=5)
        if not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='host_stops'").fetchone():return
        rows=db.execute("SELECT operation_id,image_digest,status FROM host_stops WHERE status!='completed' OR status IS NULL").fetchall()
        if not rows:return
        if (len(rows)!=1 or not isinstance(rows[0][0],str) or not bundle.OPERATION.fullmatch(rows[0][0]) or
            not isinstance(rows[0][1],str) or not bundle.DIGEST.fullmatch(rows[0][1]) or
            rows[0][2] not in ('stopping','stopped','starting','restarting')):
            raise HostRunnerError('Host recovery journal is ambiguous')
        operation_id,image_digest,_=rows[0]
        has_snapshot=db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='host_recovery_snapshots'").fetchone()
        snapshot=db.execute('SELECT status FROM host_recovery_snapshots WHERE operation_id=?',(operation_id,)).fetchone() if has_snapshot else None
        if snapshot and snapshot[0] in ('prepared','abandoned'):
            candidates=supervisor._trusted_directory(paths['candidates'],0o700)
            chosen=load_recovery_snapshot(db,operation_id,image_digest,candidates,bundle=bundle)
        else:
            has_switch=db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='host_switches'").fetchone()
            if has_switch and db.execute('SELECT 1 FROM host_switches WHERE operation_id=?',(operation_id,)).fetchone():
                raise HostRunnerError('Recovery snapshot is required after host exchange')
            chosen=modules
        recovery=chosen.get('recovery')
        if recovery is None:raise HostRunnerError('Recovery module is unavailable')
    finally:
        if db is not None:db.close()
        if candidates is not None:os.close(candidates)
        os.close(state)
    recovery.recover(operation_id,image_digest,modules=chosen,paths=paths,prepare_only=prepare_only)

def main():
    parser=argparse.ArgumentParser();parser.add_argument('operation_id',nargs='?')
    choice=parser.add_mutually_exclusive_group();choice.add_argument('--recover-prepare',action='store_true');choice.add_argument('--recover-finish',action='store_true');choice.add_argument('--activate-current',action='store_true')
    args=parser.parse_args()
    if sys.platform!='linux' or os.geteuid()!=0 or not sys.flags.isolated:raise HostRunnerError('Isolated root is required')
    if bool(args.operation_id)==bool(args.recover_prepare or args.recover_finish or args.activate_current):parser.error('Select an operation or one mode')
    sys.path.insert(0,PATHS['active']);modules=load_modules()
    if args.operation_id:activate(args.operation_id,modules=modules)
    elif args.activate_current:activate_current(modules=modules)
    else:recover_pending(modules=modules,prepare_only=args.recover_prepare)


if __name__=='__main__':main()
