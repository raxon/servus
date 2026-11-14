#!/usr/bin/python3 -I
"""Run a prepared, verified legacy migration through the protected host services."""
import argparse
import importlib.util
import os
import pathlib
import stat
import subprocess
import sys
import time


class MigrationRunError(Exception):
    pass


def command(args,timeout):
    result=subprocess.run(args,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,
                          cwd='/',env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LANG':'C','LC_ALL':'C'},timeout=timeout)
    if result.returncode:raise MigrationRunError('Host operation failed')


def run(operation,old_env,old_compose,recovery_dir,snapshot_dir,supervisor,daemon,initial,*,execute=command,timeout=90):
    """Execute prepared migration; interruption keeps the existing recovery marker."""
    if not supervisor._uuid4(operation) or type(timeout) is not int or not 1<=timeout<=180:
        raise MigrationRunError('Invalid migration request')
    for path in (old_env,old_compose,recovery_dir,snapshot_dir):
        if not isinstance(path,str) or not os.path.isabs(path) or os.path.normpath(path)!=path:
            raise MigrationRunError('Invalid migration path')
    base='/usr/local/libexec/servus';active='/etc/servus/servus.env';journal='/var/lib/servus-updater/journal.sqlite'
    execute(['/usr/bin/python3','-I',base+'/legacy-prepare.py','--operation',operation,'--old-env',old_env],600)
    execute(['/usr/bin/python3','-I',base+'/provision-host.py','--finalize'],180)
    for unit in ('servus-updater-socket.service','servus-supervisor.service','servus-updater.service'):
        execute(['/usr/bin/systemctl','start',unit],45)
    _,_,approved=daemon.resolve_active_policy(journal,active)
    deadline=time.monotonic()+timeout
    while True:
        try:
            initial.check_supervisor(approved.control_dir,supervisor)
            initial.check_updater(approved.updater_dir,supervisor)
            break
        except (OSError,ValueError,supervisor.SupervisorError,initial.InitialGenerationError):
            if time.monotonic()>=deadline:raise MigrationRunError('Host services did not become ready')
            time.sleep(.2)
    execute(['/usr/bin/python3','-I',base+'/legacy-migrate.py','--operation',operation,
             '--old-env',old_env,'--old-compose',old_compose,'--recovery-dir',recovery_dir,'--snapshot-dir',snapshot_dir],600)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    for name in ('operation','old-env','old-compose','recovery-dir','snapshot-dir'):parser.add_argument('--'+name,required=True)
    args=parser.parse_args()
    if sys.platform!='linux' or os.geteuid()!=0 or not sys.flags.isolated:
        print('Migration requires isolated Linux root.',file=sys.stderr);return 1
    os.umask(0o077)
    try:
        base=pathlib.Path(os.path.realpath(__file__)).parent;current=pathlib.Path('/')
        for part in base.parts[1:]:
            current/=part;info=current.lstat()
            if not stat.S_ISDIR(info.st_mode) or info.st_uid!=0 or info.st_mode&0o022:raise MigrationRunError('Untrusted module directory')
        path=base/'initial-generation.py';fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
        try:
            info=os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or (info.st_uid,info.st_gid,stat.S_IMODE(info.st_mode),info.st_nlink)!=(0,0,0o644,1):
                raise MigrationRunError('Untrusted module')
        finally:os.close(fd)
        spec=importlib.util.spec_from_file_location('servus_migration_run_initial',path)
        if not spec or not spec.loader:raise MigrationRunError('Module unavailable')
        initial=importlib.util.module_from_spec(spec);spec.loader.exec_module(initial)
        supervisor,daemon,_,_,_,_=initial.trusted_modules()
        directory=supervisor._trusted_directory(str(base))
        try:
            for name in ('legacy-prepare.py','provision-host.py','legacy-migrate.py'):
                fd=supervisor._open_root_file(directory,name,0o644);os.close(fd)
        finally:os.close(directory)
        run(args.operation,args.old_env,args.old_compose,args.recovery_dir,args.snapshot_dir,supervisor,daemon,initial)
        print('Verified legacy migration completed.')
        return 0
    except Exception as error:
        print('Migration failed or requires recovery: '+type(error).__name__,file=sys.stderr);return 1


if __name__=='__main__':raise SystemExit(main())
