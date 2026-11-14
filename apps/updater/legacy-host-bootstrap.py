#!/usr/bin/python3 -I
"""Prepare a trusted legacy host and run its verified migration.

The caller must explicitly trust the root-owned source tree used to install the
host verifier. The release image is independently verified before activation.
"""
import argparse
import fcntl
import importlib.util
import os
import pathlib
import re
import stat
import subprocess
import sys


class HostBootstrapError(Exception):
    pass


def command(args,timeout,*,pass_fds=()):
    result=subprocess.run(args,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,
                          cwd='/',env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LANG':'C','LC_ALL':'C','DEBIAN_FRONTEND':'noninteractive'},
                          timeout=timeout,pass_fds=pass_fds)
    if result.returncode:raise HostBootstrapError('A host operation failed')


def steps(source,operation,commit,digest,tag,old_compose,lock,*,needs_node,execute=command):
    if (not isinstance(operation,str) or not re.fullmatch(r'[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}',operation) or
        not isinstance(commit,str) or not re.fullmatch(r'[a-f0-9]{40}',commit) or
        not isinstance(digest,str) or not re.fullmatch(r'sha256:[a-f0-9]{64}',digest) or
        not isinstance(tag,str) or len(tag)>64 or not re.fullmatch(r'v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)',tag) or
        any(not isinstance(path,str) or not os.path.isabs(path) or os.path.normpath(path)!=path for path in (source,old_compose)) or
        type(lock) is not int or lock<3 or type(needs_node) is not bool):raise HostBootstrapError('Invalid host migration request')
    if needs_node:
        execute(['/usr/bin/apt-get','update'],300)
        execute(['/usr/bin/apt-get','install','-y','nodejs'],600)
    base='/usr/local/libexec/servus';held=(lock,)
    execute(['/usr/bin/python3','-I',source+'/apps/updater/install-host.py','--source',source,'--install-dir','/opt/servus',
             '--install-lock-fd',str(lock),'--adopt-legacy-verifier'],180,pass_fds=held)
    execute(['/usr/bin/python3','-I',base+'/install-gh.py','--install-dir','/opt/servus','--install-lock-fd',str(lock)],300,pass_fds=held)
    execute(['/usr/bin/python3','-I',base+'/provision-host.py'],180)
    execute(['/usr/bin/python3','-I',base+'/provision-host.py','--runtime','--legacy','--install-lock-fd',str(lock)],180,pass_fds=held)
    execute(['/usr/bin/python3','-I',base+'/provision-verifier-group.py','--install-lock-fd',str(lock)],180,pass_fds=held)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    for name in ('source','operation','commit','digest','tag','old-compose'):parser.add_argument('--'+name,required=True)
    args=parser.parse_args()
    if sys.platform!='linux' or os.geteuid()!=0 or not sys.flags.isolated:
        print('Host migration requires isolated Linux root.',file=sys.stderr);return 1
    os.umask(0o077);lock=None
    try:
        base=pathlib.Path(os.path.realpath(__file__)).parent;current=pathlib.Path('/')
        if str(base)!=os.path.join(args.source,'apps/updater'):raise HostBootstrapError('Source path differs')
        for part in base.parts[1:]:
            current/=part;info=current.lstat()
            if not stat.S_ISDIR(info.st_mode) or info.st_uid!=0 or info.st_mode&0o022:raise HostBootstrapError('Untrusted source directory')
        path=base/'provision-host.py';fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
        try:
            info=os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or (info.st_uid,info.st_gid,stat.S_IMODE(info.st_mode),info.st_nlink)!=(0,0,0o644,1):
                raise HostBootstrapError('Untrusted source module')
        finally:os.close(fd)
        spec=importlib.util.spec_from_file_location('servus_host_bootstrap_provision',path)
        if not spec or not spec.loader:raise HostBootstrapError('Source module unavailable')
        provision=importlib.util.module_from_spec(spec);spec.loader.exec_module(provision)
        supervisor,_,_,policy=provision.trusted_modules()
        install=supervisor._trusted_directory('/opt/servus',0o700)
        try:
            lock=supervisor._open_root_file(install,'install.lock',0o600);fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            provision.validate_legacy_runtime('/etc/servus',install,supervisor,policy,'/dev/null')
        finally:os.close(install)
        try:node=os.open('/usr/bin/node',os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
        except FileNotFoundError:needs_node=True
        else:
            try:
                info=os.fstat(node)
                if not stat.S_ISREG(info.st_mode) or (info.st_uid,info.st_gid,stat.S_IMODE(info.st_mode),info.st_nlink)!=(0,0,0o755,1):
                    raise HostBootstrapError('Host Node executable is unsafe')
                needs_node=False
            finally:os.close(node)
        steps(args.source,args.operation,args.commit,args.digest,args.tag,args.old_compose,lock,needs_node=needs_node)
        node=os.open('/usr/bin/node',os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
        try:
            info=os.fstat(node)
            if not stat.S_ISREG(info.st_mode) or (info.st_uid,info.st_gid,stat.S_IMODE(info.st_mode),info.st_nlink)!=(0,0,0o755,1):
                raise HostBootstrapError('Host Node executable is unsafe')
        finally:os.close(node)
        os.close(lock);lock=None
        command(['/usr/bin/python3','-I','/usr/local/libexec/servus/legacy-bootstrap.py','--operation',args.operation,'--commit',args.commit,
                 '--digest',args.digest,'--tag',args.tag,'--old-compose',args.old_compose],1500)
        print('Host prepared and signed legacy migration completed.')
        return 0
    except Exception as error:
        print('Host migration failed or requires recovery: '+type(error).__name__,file=sys.stderr);return 1
    finally:
        if lock is not None:os.close(lock)


if __name__=='__main__':raise SystemExit(main())
