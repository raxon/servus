#!/usr/bin/python3 -I
"""Recover an interrupted host exchange under protected host locks.

The caller must load this module and its dependencies from an authenticated
recovery snapshot. Boot scheduling and snapshot loading are separate steps.
"""
import fcntl
import os
import sqlite3
import sys


class HostRecoveryError(Exception):
    pass


def recover(operation_id, image_digest, *, modules, paths, prepare_only):
    """Restore the previous runtime, then prepare or finish service restart."""
    supervisor=modules['supervisor'];coordinator=modules['coordinator'];mask=modules['unit_mask']
    switch=modules['switch'];bundle=modules['bundle'];exchange=modules['exchange']
    if (sys.platform!='linux' or os.geteuid()!=0 or not sys.flags.isolated or type(prepare_only) is not bool or
        not isinstance(operation_id,str) or not bundle.OPERATION.fullmatch(operation_id) or
        not isinstance(image_digest,str) or not bundle.DIGEST.fullmatch(image_digest)):
        raise HostRecoveryError('Invalid host recovery request')
    state=install=units=active=candidates=host_lock=install_lock=service_lock=db=None
    try:
        state=supervisor._trusted_directory(paths['state'],0o700);install=supervisor._trusted_directory(paths['install'],0o700)
        units=supervisor._trusted_directory(paths['units'],0o755);active=supervisor._trusted_directory(paths['parent'],0o755)
        candidates=supervisor._trusted_directory(paths['candidates'],0o700)
        host_lock=supervisor._open_root_file(state,'host.lock',0o600);install_lock=supervisor._open_root_file(install,'install.lock',0o600)
        for fd in (host_lock,install_lock):fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        journal=supervisor._open_root_file(state,'journal.sqlite',0o600);os.close(journal)
        db=sqlite3.connect(paths['state']+'/journal.sqlite',isolation_level=None,timeout=5)
        row=db.execute('SELECT image_digest,status FROM host_stops WHERE operation_id=?',(operation_id,)).fetchone()
        if not row or row[0]!=image_digest or row[1] not in ('stopping','stopped','starting','restarting'):
            raise HostRecoveryError('Host stop is not eligible for recovery')
        def exists(table):return db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",(table,)).fetchone() is not None
        switched=db.execute('SELECT image_digest,phase FROM host_switches WHERE operation_id=?',(operation_id,)).fetchone() if exists('host_switches') else None
        unitrow=db.execute('SELECT image_digest,backup_digest,phase FROM host_unit_masks WHERE operation_id=?',(operation_id,)).fetchone() if exists('host_unit_masks') else None
        if switched and (switched[0]!=image_digest or switched[1] not in ('intent','exchanged','rolled_back')):
            raise HostRecoveryError('Host exchange cannot be recovered')
        if unitrow and unitrow[0]!=image_digest:raise HostRecoveryError('Host unit identity differs')
        if row[1]!='restarting':
            service_lock=supervisor._open_root_file(state,'service.lock',0o600);fcntl.flock(service_lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            if switched:
                def fence():modules['fence'].assert_fenced(paths['active'],modules['quiescence'])
                coordinator.recover_exchange(db,operation_id,image_digest,state_fd=state,install_fd=install,units_fd=units,
                    active_parent=active,candidate_parent=candidates,host_lock=host_lock,service_lock=service_lock,install_lock=install_lock,
                    supervisor=supervisor,unit_mask=mask,host_switch=switch,bundle=bundle,exchange=exchange,fence=fence)
            elif unitrow and unitrow[2]!='restored':
                unit_args=dict(state=state,install=install,units=units,service_lock=service_lock,install_lock=install_lock,
                               supervisor=supervisor,coordinator=coordinator)
                if unitrow[2]=='intent':
                    originals={name:modules['install_host'].read_file(units,name,0o644) for name in mask.UNITS}
                    expected={name:('inactive' if name=='servus-updater-bootstrap.service' else 'active') for name in mask.UNITS}
                    mask.reconcile_unmasked_intent(db,operation_id,image_digest,originals,expected,**unit_args)
                else:
                    mask.remask_for_recovery(db,operation_id,image_digest,host_lock=host_lock,**unit_args)
                    def fence():modules['fence'].assert_fenced(paths['active'],modules['quiescence'])
                    mask.stop_masked_units(db,operation_id,image_digest,host_lock=host_lock,fence=fence,**unit_args)
                    mask.restore_from_journal(db,operation_id,image_digest,**unit_args)
            if service_lock is not None:fcntl.flock(service_lock,fcntl.LOCK_UN);os.close(service_lock);service_lock=None
        unitrow=db.execute('SELECT image_digest,backup_digest,phase FROM host_unit_masks WHERE operation_id=?',(operation_id,)).fetchone() if exists('host_unit_masks') else None
        if unitrow and unitrow[1] is not None:
            originals,_=mask.load_verified_backup(db,operation_id,image_digest,state)
        else:originals={name:modules['install_host'].read_file(units,name,0o644) for name in mask.UNITS}
        fcntl.flock(install_lock,fcntl.LOCK_UN)
        def ready():switch.assert_supervisor_normal_ready(paths['socket'],supervisor=supervisor)
        coordinator.recover_stopped_updater(db,operation_id,image_digest,originals,state_fd=state,install_fd=install,units_fd=units,
            host_lock=host_lock,supervisor=supervisor,unit_mask=mask,bundle=bundle,ready=ready,prepare_only=prepare_only,
            host_switch=switch,exchange=exchange,active_parent=active,candidate_parent=candidates)
    finally:
        if db is not None:db.close()
        for fd in (service_lock,install_lock,host_lock,candidates,active,units,install,state):
            if fd is not None:os.close(fd)
