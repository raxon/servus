#!/usr/bin/python3 -I
"""Orchestrate a root-authorized transition from legacy host services.

The caller must load this module and its dependencies from a separately
verified, root-owned source. The active and historical releases are rebound to
the protected updater journal by the coordinator before any unit changes.
"""
import fcntl
import os
import subprocess
import sys


class HostAdoptionError(Exception):
    pass


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
        fd=supervisor._open_root_file(state,'journal.sqlite',0o600);os.close(fd)
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
