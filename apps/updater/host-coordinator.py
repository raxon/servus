#!/usr/bin/python3 -I
"""Prepare a host runtime from a completed, verified panel update.

This module does not activate a generation, stop services or authorize itself.
The root caller must supply trusted host modules and hold both installation
and updater locks for the complete operation.
"""
import fcntl
import hashlib
import os
import pathlib
import platform
import re
import stat
import subprocess
import sys
import time
from types import SimpleNamespace


class HostPreparationError(Exception):
    pass


def _same_lock(supervisor, parent, name, held):
    supervisor._assert_exclusive_flock(held)
    fd = supervisor._open_root_file(parent, name, 0o600)
    try:
        a, b = os.fstat(fd), os.fstat(held)
        if (a.st_dev, a.st_ino) != (b.st_dev, b.st_ino):
            raise HostPreparationError('An expected lock is not held')
    finally:
        os.close(fd)


def _no_pending(db):
    checks = (
        "SELECT 1 FROM operations WHERE status IN ('accepted','verifying','recovery_required') LIMIT 1",
        "SELECT 1 FROM preparations WHERE status IN ('preparing','prepared','recovery_required') LIMIT 1",
        "SELECT 1 FROM update_transactions WHERE phase != 'completed' LIMIT 1",
        "SELECT 1 FROM apply_requests WHERE state != 'completed' LIMIT 1",
        "SELECT 1 FROM policy_approvals WHERE state IN ('candidate','activating','recovery_required') LIMIT 1",
        "SELECT 1 FROM extraction_probes WHERE status != 'removed' LIMIT 1",
        "SELECT 1 FROM policy_probes WHERE state != 'removed' LIMIT 1",
    )
    if any(db.execute(query).fetchone() for query in checks):
        raise HostPreparationError('Another update requires completion or recovery')



def adopt_verified_units(db, old_operation, active_operation, *, state_dir, active_env,
                         state_fd, install_fd, host_fd, units_fd, host_lock, install_lock,
                         supervisor, daemon, extractor, backup, bundle, install_host, unit_mask):
    """Prepare signed recovery guards and boot-gated units for host adoption.

    This phase does not reload systemd or stop services. The caller must retain
    the old release, enable recovery, and activate the host runtime separately.
    """
    if (sys.platform!='linux' or os.geteuid()!=0 or not sys.flags.isolated or db.in_transaction or
        db.isolation_level is not None or old_operation==active_operation or
        not bundle.OPERATION.fullmatch(old_operation or '') or not bundle.OPERATION.fullmatch(active_operation or '')):
        raise HostPreparationError('Invalid host adoption context')
    journal_path=os.path.join(state_dir,'journal.sqlite')
    staging_parent=os.path.join(state_dir,'staging')
    def load_stage(path, required_units, *, module_names=None):
        stage=supervisor._trusted_directory(path,0o700)
        try:
            fd=supervisor._open_root_file(stage,'manifest.json',0o644)
            try:
                before=os.fstat(fd);raw=backup._read(fd,extractor.MANIFEST_LIMIT);after=os.fstat(fd)
                named=os.stat('manifest.json',dir_fd=stage,follow_symlinks=False)
                identity=lambda item:(item.st_dev,item.st_ino,item.st_size,item.st_mtime_ns,item.st_ctime_ns)
                if identity(before)!=identity(after) or (before.st_dev,before.st_ino)!=(named.st_dev,named.st_ino):
                    raise HostPreparationError('Release manifest changed')
            finally:os.close(fd)
            manifest=extractor._manifest_files(raw)
            units=bundle.collect_units(stage,manifest,required_units)
            modules=bundle.collect(stage,manifest,module_names) if module_names is not None else None
            return units,modules
        finally:os.close(stage)
    def guard_base():
        _same_lock(supervisor,state_fd,'host.lock',host_lock)
        _same_lock(supervisor,install_fd,'install.lock',install_lock)
        fd=supervisor._open_root_file(state_fd,'journal.sqlite',0o600)
        try:
            actual=os.fstat(fd);named=os.stat(db.execute('PRAGMA database_list').fetchone()[2],follow_symlinks=False)
            if (actual.st_dev,actual.st_ino)!=(named.st_dev,named.st_ino):raise HostPreparationError('Journal identity differs')
        finally:os.close(fd)
        _no_pending(db)
        for table,column,finished in (('host_stops','status',('completed',)),('host_preparations','status',('completed','abandoned')),
                                      ('host_switches','phase',('completed','rolled_back')),('host_unit_masks','phase',('restored',))):
            if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",(table,)).fetchone():
                marks=','.join('?' for _ in finished)
                if db.execute('SELECT 1 FROM '+table+' WHERE '+column+' IS NULL OR '+column+' NOT IN ('+marks+') LIMIT 1',finished).fetchone():
                    raise HostPreparationError('Host update requires recovery')
        if daemon.resolve_active_policy(journal_path,active_env)!=(policy_path,accepted_env,policy) or supervisor.inspect_servus(policy)!=identities:
            raise HostPreparationError('Active host identity changed')
        if bundle.completed_update(db,active_operation,staging_parent,policy_path,active_env,policy.image_reference)!=(active_digest,active_stage):
            raise HostPreparationError('Active release changed')
        if bundle.historical_completed_update(db,old_operation,staging_parent,active_env)!=(old_digest,old_stage):
            raise HostPreparationError('Historical release changed')
        states=unit_mask.capture_service_states()
        if any(states[name]!='active' for name in unit_mask.UNITS[:-1]) or states[unit_mask.UNITS[-1]]!='inactive':
            raise HostPreparationError('Host services are not ready')
    def guard():
        guard_base()
        for name in bundle.ADOPTION_GUARDS:
            mode,content=modules[name]
            if install_host.read_file(host_fd,name,mode)!=content:raise HostPreparationError('Host recovery guard differs')
    _same_lock(supervisor,state_fd,'host.lock',host_lock);_same_lock(supervisor,install_fd,'install.lock',install_lock)
    _no_pending(db)
    policy_path,accepted_env,policy=daemon.resolve_active_policy(journal_path,active_env)
    identities=supervisor.inspect_servus(policy)
    active_digest,active_stage=bundle.completed_update(db,active_operation,staging_parent,policy_path,active_env,policy.image_reference)
    old_digest,old_stage=bundle.historical_completed_update(db,old_operation,staging_parent,active_env)
    old_units,old_modules=load_stage(old_stage,unit_mask.UNITS,module_names=('install-host.py',))
    new_units,modules=load_stage(active_stage,install_host.UNITS,module_names=install_host.MODULES)
    if not set(bundle.ADOPTION_GUARDS).issubset(modules):raise HostPreparationError('Host recovery guards are missing')
    guard_base()
    bundle.inspect_unit_adoption(units_fd,old_units,new_units,read_file=install_host.read_file)
    bundle.install_adoption_guards(host_fd,state_fd,old_modules,modules,read_file=install_host.read_file,
                                   publish=install_host.publish,authorize=guard_base)
    guard()
    bundle.apply_unit_adoption(units_fd,old_units,new_units,read_file=install_host.read_file,authorize=guard)


def stop_updater(db, operation_id, image_digest, *, state_fd, install_fd, host_lock, install_lock,
                 supervisor, unit_mask, bundle, authorize, run=subprocess.run):
    """Journal and stop the updater before taking its service lock.

    The caller holds host and installation locks and authorizes the completed
    signed update. The returned service lock remains held by the caller.
    """
    if (sys.platform != 'linux' or os.geteuid() != 0 or not sys.flags.isolated or
        db.in_transaction or db.isolation_level is not None or db.execute('PRAGMA synchronous').fetchone()[0] < 2 or
        not isinstance(operation_id, str) or not bundle.OPERATION.fullmatch(operation_id) or
        not isinstance(image_digest, str) or not bundle.DIGEST.fullmatch(image_digest) or not callable(authorize)):
        raise HostPreparationError('Invalid updater stop context')
    _same_lock(supervisor, state_fd, 'host.lock', host_lock)
    _same_lock(supervisor, install_fd, 'install.lock', install_lock)
    fd = supervisor._open_root_file(state_fd, 'journal.sqlite', 0o600)
    try:
        named = os.stat(db.execute('PRAGMA database_list').fetchone()[2], follow_symlinks=False)
        opened = os.fstat(fd)
        if (named.st_dev, named.st_ino) != (opened.st_dev, opened.st_ino):
            raise HostPreparationError('The journal identity differs')
    finally: os.close(fd)
    states = unit_mask.capture_service_states()
    if any(states[name] != 'active' for name in unit_mask.UNITS[:-1]):
        raise HostPreparationError('Host services are not ready for update')
    if authorize() is not None: raise HostPreparationError('Update authorization failed')
    db.execute('BEGIN IMMEDIATE')
    try:
        _no_pending(db)
        db.execute("CREATE TABLE IF NOT EXISTS host_stops (operation_id TEXT PRIMARY KEY,image_digest TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('stopping','stopped','starting','restarting','completed','recovery_required'))) ")
        db.execute("CREATE UNIQUE INDEX IF NOT EXISTS one_active_host_stop ON host_stops ((1)) WHERE status != 'completed'")
        db.execute("INSERT INTO host_stops VALUES(?,?,'stopping')", (operation_id,image_digest))
        db.execute('COMMIT')
    except BaseException:
        if db.in_transaction: db.execute('ROLLBACK')
        raise
    _same_lock(supervisor, state_fd, 'host.lock', host_lock)
    _same_lock(supervisor, install_fd, 'install.lock', install_lock)
    if authorize() is not None: raise HostPreparationError('Update authorization failed')
    try:
        run(['/usr/bin/systemctl','stop','servus-updater.service'], stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, cwd='/',
            env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LANG':'C','LC_ALL':'C'},timeout=60,check=True)
    except (OSError, subprocess.SubprocessError) as error:
        raise HostPreparationError('Updater stop requires recovery') from error
    lock = supervisor._open_root_file(state_fd, 'service.lock', 0o600)
    try:
        try: fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error: raise HostPreparationError('Updater service lock remains held') from error
        expected = dict(states);expected['servus-updater.service'] = 'inactive'
        if unit_mask.capture_service_states() != expected: raise HostPreparationError('Host service states changed during stop')
        _same_lock(supervisor, state_fd, 'host.lock', host_lock)
        _same_lock(supervisor, install_fd, 'install.lock', install_lock)
        if db.execute("UPDATE host_stops SET status='stopped' WHERE operation_id=? AND image_digest=? AND status='stopping'", (operation_id,image_digest)).rowcount != 1:
            raise HostPreparationError('Updater stop journal changed')
        return lock, states
    except BaseException:
        os.close(lock)
        raise


def recover_stopped_updater(db, operation_id, image_digest, originals, *, state_fd, install_fd, units_fd,
                            host_lock, supervisor, unit_mask, bundle, ready, run=subprocess.run,
                            host_switch=None, exchange=None, active_parent=None, candidate_parent=None, readiness_timeout=60, prepare_only=False):
    """Recover a journaled stop before exchange or after verified rollback.

    The caller holds the host operation lock, supplies independently verified
    original unit bytes, and checks the authenticated control-plane readiness.
    The installation lock must be released so the supervisor can start.
    """
    if (sys.platform != 'linux' or os.geteuid() != 0 or not sys.flags.isolated or
        db.in_transaction or db.isolation_level is not None or db.execute('PRAGMA synchronous').fetchone()[0] < 2 or
        not isinstance(operation_id,str) or not bundle.OPERATION.fullmatch(operation_id) or
        not isinstance(image_digest,str) or not bundle.DIGEST.fullmatch(image_digest) or not callable(ready) or
        type(readiness_timeout) not in (int,float) or not 0 <= readiness_timeout <= 300 or type(prepare_only) is not bool):
        raise HostPreparationError('Invalid updater recovery context')
    _same_lock(supervisor, state_fd, 'host.lock', host_lock)
    fd = supervisor._open_root_file(state_fd, 'journal.sqlite', 0o600)
    try:
        named=os.stat(db.execute('PRAGMA database_list').fetchone()[2],follow_symlinks=False);opened=os.fstat(fd)
        if (named.st_dev,named.st_ino)!=(opened.st_dev,opened.st_ino):
            raise HostPreparationError('The journal identity differs')
    finally: os.close(fd)
    unit_mask._directory(units_fd,0o755)
    expected={name:('inactive' if name=='servus-updater-bootstrap.service' else 'active') for name in unit_mask.UNITS}
    unit_mask._metadata(operation_id,image_digest,originals,expected)
    def verify():
        _same_lock(supervisor,state_fd,'host.lock',host_lock)
        row=db.execute('SELECT image_digest,status FROM host_stops WHERE operation_id=?',(operation_id,)).fetchone()
        if not row or row[0]!=image_digest or row[1] not in ('stopping','stopped','starting','restarting'):
            raise HostPreparationError('Updater stop is not eligible for recovery')
        if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='host_switches'").fetchone():
            switched=db.execute('SELECT image_digest,phase FROM host_switches WHERE operation_id=?',(operation_id,)).fetchone()
            if switched:
                if (switched!=(image_digest,'rolled_back') or host_switch is None or exchange is None or
                    active_parent is None or candidate_parent is None or
                    host_switch.inspect_exchange(db,operation_id,active_parent,candidate_parent,exchange,bundle)!='original'):
                    raise HostPreparationError('Host exchange requires recovery')
        if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='host_unit_masks'").fetchone():
            mask=db.execute('SELECT image_digest,phase FROM host_unit_masks WHERE operation_id=?',(operation_id,)).fetchone()
            if mask and mask != (image_digest,'restored'):
                raise HostPreparationError('Host unit restoration is incomplete')
        if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='host_preparations'").fetchone():
            preparation=db.execute('SELECT image_digest,status FROM host_preparations WHERE operation_id=?',(operation_id,)).fetchone()
            if preparation and (preparation[0]!=image_digest or preparation[1] not in (('abandoned',) if row[1]=='restarting' else ('intent','prepared','recovery_required'))):
                raise HostPreparationError('Host preparation is not eligible for recovery')
        for name in unit_mask.UNITS: unit_mask._read(units_fd,name,0o644,originals[name])
    verify()
    fd=supervisor._open_root_file(install_fd,'install.lock',0o600)
    try:
        try:fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError as error:raise HostPreparationError('Installation lock is still held') from error
        fcntl.flock(fd,fcntl.LOCK_UN)
    finally:os.close(fd)
    try:
        _same_lock(supervisor,state_fd,'host.lock',host_lock)
        for command in (['/usr/bin/systemctl','daemon-reload'],
                        ['/usr/bin/systemctl','reset-failed','servus-updater-socket.service','servus-supervisor.service','servus-updater.service']):
            _same_lock(supervisor,state_fd,'host.lock',host_lock)
            run(command,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,cwd='/',
                env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LANG':'C','LC_ALL':'C'},timeout=60,check=True)
    except (OSError,subprocess.SubprocessError) as error:
        raise HostPreparationError('Systemd reload requires recovery') from error
    states=unit_mask.capture_service_states()
    if states['servus-updater.service']=='inactive':
        fd=supervisor._open_root_file(state_fd,'service.lock',0o600)
        try:
            try:fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
            except BlockingIOError as error:raise HostPreparationError('Updater lock is still held') from error
            fcntl.flock(fd,fcntl.LOCK_UN)
        finally:os.close(fd)
    if states['servus-updater-bootstrap.service'] != 'inactive':
        raise HostPreparationError('Bootstrap service is active during recovery')
    db.execute('BEGIN IMMEDIATE')
    try:
        verify()
        if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='host_preparations'").fetchone():
            db.execute("UPDATE host_preparations SET status='abandoned' WHERE operation_id=? AND image_digest=? AND status IN ('intent','prepared','recovery_required')",(operation_id,image_digest))
        if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='host_recovery_snapshots'").fetchone():
            snapshot=db.execute('SELECT image_digest,status FROM host_recovery_snapshots WHERE operation_id=?',(operation_id,)).fetchone()
            if snapshot and (snapshot[0]!=image_digest or snapshot[1] not in ('intent','prepared','recovery_required','abandoned')):
                raise HostPreparationError('Recovery snapshot is not eligible for abandonment')
            db.execute("UPDATE host_recovery_snapshots SET status='abandoned' WHERE operation_id=? AND image_digest=? AND status IN ('intent','prepared','recovery_required')",(operation_id,image_digest))
        if db.execute("UPDATE host_stops SET status='restarting' WHERE operation_id=? AND image_digest=? AND status IN ('stopping','stopped','starting','restarting')",(operation_id,image_digest)).rowcount!=1:
            raise HostPreparationError('Updater restart journal changed')
        db.execute('COMMIT')
    except BaseException:
        if db.in_transaction:db.execute('ROLLBACK')
        raise
    if prepare_only:
        return
    try:
        for command in (['/usr/bin/systemctl','start','servus-updater-socket.service'],
                        ['/usr/bin/systemctl','start','servus-supervisor.service'],
                        ['/usr/bin/systemctl','start','servus-updater.service']):
            _same_lock(supervisor,state_fd,'host.lock',host_lock)
            run(command,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,cwd='/',
                env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LANG':'C','LC_ALL':'C'},timeout=60,check=True)
    except (OSError,subprocess.SubprocessError) as error:
        raise HostPreparationError('Updater restart requires recovery') from error
    deadline=time.monotonic()+readiness_timeout
    while True:
        verify()
        try:
            if unit_mask.capture_service_states()!=expected or ready() is not None:
                raise RuntimeError('Control plane is not ready')
        except (OSError,RuntimeError,unit_mask.UnitMaskError) as error:
            if time.monotonic()>=deadline:raise HostPreparationError('Control plane is not ready') from error
            time.sleep(min(0.5,max(0,deadline-time.monotonic())))
        else:break
    db.execute('BEGIN IMMEDIATE')
    try:
        verify()
        if db.execute("UPDATE host_stops SET status='completed' WHERE operation_id=? AND image_digest=? AND status='restarting'",(operation_id,image_digest)).rowcount!=1:
            raise HostPreparationError('Updater stop journal changed')
        db.execute('COMMIT')
    except BaseException:
        if db.in_transaction:db.execute('ROLLBACK')
        raise




def prepare_recovery_snapshot(db, operation_id, image_digest, *, state_fd, install_fd, active_fd,
                              candidate_parent, host_lock, service_lock, install_lock,
                              supervisor, bundle, install_host):
    """Save the trusted current host modules outside the exchanged runtime."""
    if (sys.platform!='linux' or os.geteuid()!=0 or not sys.flags.isolated or db.in_transaction or
        db.isolation_level is not None or db.execute('PRAGMA synchronous').fetchone()[0]<2 or
        not isinstance(operation_id,str) or not bundle.OPERATION.fullmatch(operation_id) or
        not isinstance(image_digest,str) or not bundle.DIGEST.fullmatch(image_digest)):
        raise HostPreparationError('Invalid recovery snapshot context')
    def guard():
        _same_lock(supervisor,state_fd,'host.lock',host_lock)
        _same_lock(supervisor,state_fd,'service.lock',service_lock)
        _same_lock(supervisor,install_fd,'install.lock',install_lock)
        fd=supervisor._open_root_file(state_fd,'journal.sqlite',0o600)
        try:
            named=os.stat(db.execute('PRAGMA database_list').fetchone()[2],follow_symlinks=False);opened=os.fstat(fd)
            if (named.st_dev,named.st_ino)!=(opened.st_dev,opened.st_ino):raise HostPreparationError('The journal identity differs')
        finally:os.close(fd)
    guard()
    if db.execute("SELECT 1 FROM host_preparations p JOIN host_stops s ON s.operation_id=p.operation_id AND s.image_digest=p.image_digest WHERE p.operation_id=? AND p.image_digest=? AND p.status='prepared' AND s.status='stopped'",(operation_id,image_digest)).fetchone() is None:
        raise HostPreparationError('Host preparation is not ready')
    names=install_host.MODULES
    modules={name:((0o755 if name=='servus-updater.py' else 0o644),
                   install_host.read_file(active_fd,name,0o755 if name=='servus-updater.py' else 0o644)) for name in names}
    _,_,metadata=bundle._generation_metadata(candidate_parent,operation_id,image_digest,modules)
    metadata_digest=hashlib.sha256(metadata).hexdigest()
    guard();db.execute('BEGIN IMMEDIATE')
    try:
        db.execute("CREATE TABLE IF NOT EXISTS host_recovery_snapshots(operation_id TEXT PRIMARY KEY,image_digest TEXT NOT NULL,metadata_size INTEGER NOT NULL,metadata_digest TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('intent','prepared','recovery_required','completed','abandoned'))) ")
        db.execute("INSERT INTO host_recovery_snapshots VALUES(?,?,?,?,'intent')",(operation_id,image_digest,len(metadata),metadata_digest))
        db.execute('COMMIT')
    except BaseException:
        if db.in_transaction:db.execute('ROLLBACK')
        raise
    try:
        name=bundle.stage_generation(candidate_parent,operation_id,image_digest,modules)
        guard()
        for item,(mode,content) in modules.items():
            if install_host.read_file(active_fd,item,mode)!=content:raise HostPreparationError('Active host modules changed')
        if bundle.load_generation(candidate_parent,operation_id,image_digest,len(metadata),metadata_digest,names)!=modules:
            raise HostPreparationError('Recovery snapshot changed')
        if db.execute("UPDATE host_recovery_snapshots SET status='prepared' WHERE operation_id=? AND image_digest=? AND status='intent'",(operation_id,image_digest)).rowcount!=1:
            raise HostPreparationError('Recovery snapshot journal changed')
        return name
    except BaseException:
        try:db.execute("UPDATE host_recovery_snapshots SET status='recovery_required' WHERE operation_id=? AND status='intent'",(operation_id,))
        except BaseException:pass
        raise

def recover_exchange(db, operation_id, image_digest, *, state_fd, install_fd, units_fd, active_parent,
                     candidate_parent, host_lock, service_lock, install_lock, supervisor, unit_mask,
                     host_switch, bundle, exchange, fence, run=subprocess.run):
    """Restore the previous runtime and unit files after an interrupted exchange.

    The caller owns all three locks. Services remain stopped at return; their
    restart and authenticated readiness are separate recovery steps.
    """
    _same_lock(supervisor,state_fd,'host.lock',host_lock)
    coordinator=SimpleNamespace(_same_lock=_same_lock)
    args=dict(state=state_fd,install=install_fd,units=units_fd,host_lock=host_lock,service_lock=service_lock,
              install_lock=install_lock,supervisor=supervisor,coordinator=coordinator)
    row=db.execute('SELECT image_digest,phase FROM host_switches WHERE operation_id=?',(operation_id,)).fetchone()
    if not row or row[0]!=image_digest or row[1] not in ('intent','exchanged','rolled_back'):
        raise HostPreparationError('Host exchange is not eligible for recovery')
    unit_mask.remask_for_recovery(db,operation_id,image_digest,**args)
    unit_mask.stop_masked_units(db,operation_id,image_digest,fence=fence,run=run,**args)
    switch_args=dict(state_fd=state_fd,install_fd=install_fd,service_lock=service_lock,install_lock=install_lock,
                     active_parent=active_parent,candidate_parent=candidate_parent,supervisor=supervisor,
                     coordinator=coordinator,bundle=bundle,exchange=exchange,fence=fence)
    position=host_switch.inspect_exchange(db,operation_id,active_parent,candidate_parent,exchange,bundle)
    row=db.execute('SELECT image_digest,phase FROM host_switches WHERE operation_id=?',(operation_id,)).fetchone()
    if row is None or row[0]!=image_digest:raise HostPreparationError('Host exchange journal changed')
    if row[1]=='rolled_back':
        if position!='original':raise HostPreparationError('Previous runtime is unavailable')
    elif position=='exchanged':host_switch.rollback_exchanged(db,operation_id,**switch_args)
    elif position=='original':host_switch.reconcile_original(db,operation_id,**switch_args)
    else:raise HostPreparationError('Host exchange position is unknown')
    _same_lock(supervisor,state_fd,'host.lock',host_lock)
    unit_mask.restore_from_journal(db,operation_id,image_digest,state=state_fd,install=install_fd,units=units_fd,
        service_lock=service_lock,install_lock=install_lock,supervisor=supervisor,coordinator=coordinator)


def authorize_same_boot_start(db, operation_id, image_digest, *, state_fd, install_fd, units_fd,
                              active_parent, candidate_parent, host_lock, service_lock, install_lock,
                              supervisor, unit_mask, host_switch, bundle, exchange):
    """Allow a verified exchanged runtime to start only during this boot."""
    coordinator=SimpleNamespace(_same_lock=_same_lock)
    unit_mask._guard(db,state_fd,install_fd,service_lock,install_lock,supervisor,coordinator)
    _same_lock(supervisor,state_fd,'host.lock',host_lock)
    if host_switch.inspect_exchange(db,operation_id,active_parent,candidate_parent,exchange,bundle)!='exchanged':
        raise HostPreparationError('Exchanged host runtime is unavailable')
    originals,_=unit_mask.load_verified_backup(db,operation_id,image_digest,state_fd)
    for name in unit_mask.UNITS:unit_mask._read(units_fd,name,0o644,originals[name])
    try:
        with open('/proc/sys/kernel/random/boot_id',encoding='ascii') as source:boot_id=source.read(64).strip()
    except OSError as error:raise HostPreparationError('Boot identity is unavailable') from error
    if not re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}',boot_id):
        raise HostPreparationError('Boot identity is invalid')
    db.execute('BEGIN IMMEDIATE')
    try:
        if host_switch.inspect_exchange(db,operation_id,active_parent,candidate_parent,exchange,bundle)!='exchanged':
            raise HostPreparationError('Exchanged host runtime changed')
        row=db.execute("SELECT 1 FROM host_switches s JOIN host_preparations p ON p.operation_id=s.operation_id AND p.image_digest=s.image_digest JOIN host_unit_masks m ON m.operation_id=s.operation_id AND m.image_digest=s.image_digest WHERE s.operation_id=? AND s.image_digest=? AND s.phase='exchanged' AND p.status='prepared' AND m.phase='restored'",(operation_id,image_digest)).fetchone()
        if not row:raise HostPreparationError('Host activation journal is incomplete')
        db.execute('CREATE TABLE IF NOT EXISTS host_boot_authorizations(operation_id TEXT PRIMARY KEY,image_digest TEXT NOT NULL,boot_id TEXT NOT NULL)')
        db.execute('INSERT INTO host_boot_authorizations VALUES(?,?,?)',(operation_id,image_digest,boot_id))
        if db.execute("UPDATE host_stops SET status='starting' WHERE operation_id=? AND image_digest=? AND status='stopped'",(operation_id,image_digest)).rowcount!=1:
            raise HostPreparationError('Host stop journal changed')
        db.execute('COMMIT')
    except BaseException:
        if db.in_transaction:db.execute('ROLLBACK')
        raise

def activate_prepared(db, operation_id, image_digest, originals, initial_states, modules, cli, pin, *,
                      state_fd, install_fd, units_fd, active_parent, candidate_parent, host_lock, service_lock,
                      install_lock, supervisor, unit_mask, host_switch, bundle, exchange, fence, authorize,
                      supervisor_socket, run=subprocess.run, timeout=60):
    """Activate a verified host candidate using the already acquired locks.

    A trusted caller must hold host, service and installation locks and supply
    bytes re-read from the authenticated release. The host lock remains held.
    On failure the journal and masks are retained for explicit recovery.
    """
    if not callable(authorize) or not callable(fence) or not 1 <= timeout <= 300:
        raise HostPreparationError('Invalid host activation context')
    _same_lock(supervisor,state_fd,'host.lock',host_lock)
    _same_lock(supervisor,state_fd,'service.lock',service_lock)
    _same_lock(supervisor,install_fd,'install.lock',install_lock)
    if authorize() is not None: raise HostPreparationError('Update authorization failed')
    if db.execute("SELECT 1 FROM host_recovery_snapshots WHERE operation_id=? AND image_digest=? AND status='prepared'",(operation_id,image_digest)).fetchone() is None:
        raise HostPreparationError('Recovery snapshot is not prepared')
    coordinator=SimpleNamespace(_same_lock=_same_lock)
    unit_args=dict(state=state_fd,install=install_fd,units=units_fd,service_lock=service_lock,
                   install_lock=install_lock,supervisor=supervisor,coordinator=coordinator)
    unit_mask.mask_units(db,operation_id,image_digest,originals,initial_states=initial_states,host_lock=host_lock,**unit_args)
    unit_mask.stop_masked_units(db,operation_id,image_digest,host_lock=host_lock,fence=fence,run=run,**unit_args)
    if authorize() is not None: raise HostPreparationError('Update authorization failed')
    host_switch.exchange_prepared(db,operation_id,image_digest,modules,cli,pin,state_fd=state_fd,install_fd=install_fd,
        service_lock=service_lock,install_lock=install_lock,active_parent=active_parent,candidate_parent=candidate_parent,
        supervisor=supervisor,coordinator=coordinator,bundle=bundle,exchange=exchange,fence=fence)
    unit_mask.restore_from_journal(db,operation_id,image_digest,**unit_args)
    authorize_same_boot_start(db,operation_id,image_digest,state_fd=state_fd,install_fd=install_fd,units_fd=units_fd,
        active_parent=active_parent,candidate_parent=candidate_parent,host_lock=host_lock,service_lock=service_lock,
        install_lock=install_lock,supervisor=supervisor,unit_mask=unit_mask,host_switch=host_switch,bundle=bundle,exchange=exchange)
    fcntl.flock(service_lock,fcntl.LOCK_UN)
    fcntl.flock(install_lock,fcntl.LOCK_UN)
    host_switch.start_restored(db,operation_id,state_fd=state_fd,install_fd=install_fd,host_lock=host_lock,
        active_parent=active_parent,candidate_parent=candidate_parent,units_fd=units_fd,supervisor=supervisor,
        coordinator=coordinator,bundle=bundle,exchange=exchange,unit_mask=unit_mask,run=run)
    deadline=time.monotonic()+timeout
    while True:
        _same_lock(supervisor,state_fd,'host.lock',host_lock)
        try: host_switch.assert_supervisor_ready(supervisor_socket,operation_id,supervisor=supervisor,bundle=bundle)
        except (host_switch.HostSwitchError,OSError):
            if time.monotonic()>=deadline: raise HostPreparationError('Host readiness requires recovery') from None
            time.sleep(min(0.5,max(0,deadline-time.monotonic())))
        else: break
    try: fcntl.flock(install_lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    except BlockingIOError as error: raise HostPreparationError('Installation lock requires recovery') from error
    host_switch.complete_exchange(db,operation_id,state_fd=state_fd,install_fd=install_fd,host_lock=host_lock,
        install_lock=install_lock,active_parent=active_parent,candidate_parent=candidate_parent,supervisor=supervisor,
        coordinator=coordinator,bundle=bundle,exchange=exchange,unit_mask=unit_mask,units_fd=units_fd,
        supervisor_socket=supervisor_socket)

def prepare_completed(db, operation_id, *, state_dir, install_dir, gate_dir,
                      candidate_parent, host_dir, active_env, service_lock, install_lock,
                      supervisor, daemon, extractor, backup, bundle, install_host, install_gh, include_material=False):
    """Stage a candidate and record durable intent before writing its files."""
    if sys.platform != 'linux' or os.geteuid() != 0 or not sys.flags.isolated:
        raise HostPreparationError('An isolated Linux root coordinator is required')
    if db.in_transaction or db.isolation_level is not None:
        raise HostPreparationError('An autocommit journal connection is required')
    paths = (state_dir, install_dir, gate_dir, candidate_parent, host_dir, active_env)
    if any(not isinstance(path, str) or not os.path.isabs(path) or os.path.normpath(path) != path for path in paths):
        raise HostPreparationError('A protected path is invalid')
    state = install = gate = candidates = host = staging = None
    inserted = False
    try:
        state = supervisor._trusted_directory(state_dir, 0o700)
        install = supervisor._trusted_directory(install_dir, 0o700)
        gate = supervisor._trusted_directory(gate_dir, 0o755)
        candidates = supervisor._trusted_directory(candidate_parent, 0o700)
        host = supervisor._trusted_directory(host_dir, 0o755)
        if os.fstat(candidates).st_dev != os.fstat(host).st_dev:
            raise HostPreparationError('Host generations must share a filesystem')
        _same_lock(supervisor, state, 'service.lock', service_lock)
        _same_lock(supervisor, install, 'install.lock', install_lock)
        database = db.execute('PRAGMA database_list').fetchone()
        journal_path = os.path.join(state_dir, 'journal.sqlite')
        if not database or os.path.realpath(database[2]) != os.path.realpath(journal_path):
            raise HostPreparationError('The journal identity differs')
        fd = supervisor._open_root_file(state, 'journal.sqlite', 0o600)
        os.close(fd)
        maintenance = supervisor._trusted_directory(os.path.join(state_dir, 'maintenance'), 0o700)
        try:
            try: os.stat('maintenance.json', dir_fd=maintenance, follow_symlinks=False)
            except FileNotFoundError: pass
            else: raise HostPreparationError('Maintenance requires recovery')
        finally: os.close(maintenance)
        fd = supervisor._open_root_file(gate, 'state', 0o644)
        try:
            if os.read(fd, 64) != b'servus-lifecycle-v1 normal\n':
                raise HostPreparationError('Lifecycle gate is not open')
        finally: os.close(fd)
        _no_pending(db)
        policy_path, accepted_env, policy = daemon.resolve_active_policy(journal_path, active_env)
        identities = supervisor.inspect_servus(policy)
        digest, stage_path = bundle.completed_update(db, operation_id, os.path.join(state_dir, 'staging'),
                                                     policy_path, active_env, policy.image_reference)
        staging = supervisor._trusted_directory(stage_path, 0o700)
        fd = supervisor._open_root_file(staging, 'manifest.json', 0o644)
        try:
            before = os.fstat(fd)
            raw = backup._read(fd, extractor.MANIFEST_LIMIT)
            after = os.fstat(fd)
            named = os.stat('manifest.json', dir_fd=staging, follow_symlinks=False)
            identity = lambda item: (item.st_dev, item.st_ino, item.st_size, item.st_mtime_ns, item.st_ctime_ns)
            if identity(before) != identity(after) or (named.st_dev, named.st_ino) != (before.st_dev, before.st_ino):
                raise HostPreparationError('Release manifest changed')
        finally: os.close(fd)
        manifest = extractor._manifest_files(raw)
        modules = bundle.collect(staging, manifest, install_host.MODULES)
        bundle.collect_units(staging, manifest, install_host.UNITS)
        arch = {'x86_64': 'amd64', 'aarch64': 'arm64'}.get(platform.machine())
        if arch not in install_gh.PINNED:
            raise HostPreparationError('Host architecture is unsupported')
        pin = install_gh.PINNED[arch]
        bundle.check_cli_compatibility(modules, arch, pin)
        cli = bundle.read_pinned_cli(host, pin)
        _same_lock(supervisor, state, 'service.lock', service_lock)
        _same_lock(supervisor, install, 'install.lock', install_lock)
        if (daemon.resolve_active_policy(journal_path, active_env) != (policy_path, accepted_env, policy) or
            supervisor.inspect_servus(policy) != identities or
            bundle.completed_update(db, operation_id, os.path.join(state_dir, 'staging'),
                                    policy_path, active_env, policy.image_reference) != (digest, stage_path)):
            raise HostPreparationError('Active update changed during preparation')
        _no_pending(db)
        db.execute('BEGIN IMMEDIATE')
        try:
            db.execute("CREATE TABLE IF NOT EXISTS host_preparations (operation_id TEXT PRIMARY KEY, image_digest TEXT NOT NULL, generation TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('intent','prepared','recovery_required','completed','abandoned'))) ")
            db.execute("CREATE UNIQUE INDEX IF NOT EXISTS one_active_host_preparation ON host_preparations ((1)) WHERE status IN ('intent','prepared','recovery_required')")
            db.execute("INSERT INTO host_preparations VALUES(?,?,?,'intent')", (operation_id, digest, 'runtime-' + operation_id))
            db.execute('COMMIT'); inserted = True
        except BaseException:
            if db.in_transaction: db.execute('ROLLBACK')
            raise
        generation = bundle.stage_runtime_tree(candidates, operation_id, digest, modules, cli, pin)
        _same_lock(supervisor, state, 'service.lock', service_lock)
        _same_lock(supervisor, install, 'install.lock', install_lock)
        if (daemon.resolve_active_policy(journal_path, active_env) != (policy_path, accepted_env, policy) or
            supervisor.inspect_servus(policy) != identities or
            bundle.completed_update(db, operation_id, os.path.join(state_dir, 'staging'),
                                    policy_path, active_env, policy.image_reference) != (digest, stage_path)):
            raise HostPreparationError('Active update changed during preparation')
        bundle.verify_runtime_tree(candidates, operation_id, digest, modules, cli, pin)
        if db.execute("UPDATE host_preparations SET status='prepared' WHERE operation_id=? AND image_digest=? AND generation=? AND status='intent'",
                      (operation_id, digest, generation)).rowcount != 1:
            raise HostPreparationError('Host preparation journal changed')
        return (generation, digest, modules, cli, pin) if include_material else generation
    except BaseException:
        if inserted:
            try: db.execute("UPDATE host_preparations SET status='recovery_required' WHERE operation_id=? AND status='intent'", (operation_id,))
            except BaseException: pass
        raise
    finally:
        for fd in (staging, host, candidates, gate, install, state):
            if fd is not None: os.close(fd)
