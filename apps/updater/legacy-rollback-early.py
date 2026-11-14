#!/usr/bin/python3 -I
"""Recover an interrupted stop of the original legacy containers."""
import argparse
import fcntl
import importlib.util
import os
import pathlib
import secrets
import stat
import sys


class EarlyRollbackError(Exception):
    pass


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    for name in ('operation','old-env','old-compose'):parser.add_argument('--'+name,required=True)
    args=parser.parse_args()
    if sys.platform!='linux' or os.geteuid()!=0 or not sys.flags.isolated:
        print('Recovery requires isolated Linux root.',file=sys.stderr);return 1
    os.umask(0o077);journal=service_lock=install_lock=None
    try:
        base=pathlib.Path(os.path.realpath(__file__)).parent;current=pathlib.Path('/')
        for part in base.parts[1:]:
            current/=part;info=current.lstat()
            if not stat.S_ISDIR(info.st_mode) or info.st_uid!=0 or info.st_mode&0o022:raise EarlyRollbackError('Untrusted module directory')
        path=base/'bootstrap-policy.py';fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
        try:
            info=os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or (info.st_uid,info.st_gid,stat.S_IMODE(info.st_mode),info.st_nlink)!=(0,0,0o644,1):raise EarlyRollbackError('Untrusted module')
        finally:os.close(fd)
        spec=importlib.util.spec_from_file_location('servus_early_bootstrap_policy',path)
        if not spec or not spec.loader:raise EarlyRollbackError('Module unavailable')
        boot=importlib.util.module_from_spec(spec);spec.loader.exec_module(boot)
        supervisor,updater,policy,_,_,daemon=boot._trusted_modules()
        if not supervisor._uuid4(args.operation):raise EarlyRollbackError('Invalid operation')
        def load(name):
            directory=supervisor._trusted_directory(str(base))
            try:fd=supervisor._open_root_file(directory,name+'.py',0o644);os.close(fd)
            finally:os.close(directory)
            spec=importlib.util.spec_from_file_location('servus_early_'+name.replace('-','_'),base/(name+'.py'))
            if not spec or not spec.loader:raise EarlyRollbackError('Module unavailable')
            module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
        adoption=load('adoption-proof');recovery=load('legacy-early-recovery');quiet=load('quiescence')
        provision=load('provision-host');handoff=load('bootstrap-handoff');backup=load('backup')
        state=updater.trusted_directory('/var/lib/servus-updater',0o700);state_fd=supervisor._trusted_directory(str(state),0o700)
        try:service_lock=supervisor._open_root_file(state_fd,'service.lock',0o600)
        finally:os.close(state_fd)
        fcntl.flock(service_lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        install=supervisor._trusted_directory('/opt/servus',0o700)
        try:install_lock=policy._installation_lock(install,supervisor)
        finally:os.close(install)
        journal=updater.Journal(state);docker_config=str(state/'docker-config')
        class Docker:
            def call(self,*values,**kwargs):return policy._docker(docker_config,*values,**kwargs)
            def inspect(self,*ids):return policy._json(self.call('inspect',*ids))
        docker=Docker();ingress=provision.trusted_ingress(docker_config,policy);ingress=tuple(ingress) if ingress is not None else None
        name='legacy-early-rollback-'+args.operation+'-'+secrets.token_hex(8)
        root=supervisor._trusted_directory(str(state),0o700)
        try:os.mkdir(name,0o700,dir_fd=root);os.fsync(root)
        finally:os.close(root)
        recovery.recover(journal,args.operation,'/etc/servus/servus.env',args.old_env,args.old_compose,str(state/'policies'),str(state/name),
            supervisor,daemon,adoption,policy,quiet,docker,backup,install_lock=install_lock,service=handoff.systemctl,trusted_ingress=ingress)
        print('Original legacy containers restored. Migration state remains available for inspection.')
        return 0
    except Exception as error:
        print('Recovery failed or requires manual inspection: '+type(error).__name__,file=sys.stderr);return 1
    finally:
        if journal is not None:journal.close()
        if install_lock is not None:os.close(install_lock)
        if service_lock is not None:os.close(service_lock)


if __name__=='__main__':raise SystemExit(main())
