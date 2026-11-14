#!/usr/bin/python3 -I
"""Verify and activate an initial release, then hand it to the host supervisor.

Host files, verifier group, runtime credentials, an empty data directory and
accepted configuration must already be provisioned. Any interrupted operation
leaves a protected marker for recovery and must not be silently retried.
"""
import argparse
import fcntl
import importlib.util
import os
import pathlib
import re
import socket
import stat
import struct
import subprocess
import sys
import time

MARKER='.bootstrap-verification-v1'


class BootstrapError(Exception):
    pass


def command(args, *, pass_fds=(), timeout=45):
    result=subprocess.run(args,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,
                          cwd='/',env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LANG':'C','LC_ALL':'C'},
                          pass_fds=pass_fds,timeout=timeout)
    if result.returncode:raise BootstrapError('A bootstrap operation failed')


def inactive(unit):
    result=subprocess.run(['/usr/bin/systemctl','show','--property=ActiveState','--value',unit],
                          stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,
                          cwd='/',env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LANG':'C','LC_ALL':'C'},timeout=10)
    return result.returncode==0 and result.stdout==b'inactive\n'


def wait_socket(path, supervisor, timeout=30):
    parent,name=os.path.split(path);directory=supervisor._trusted_directory(parent,0o710)
    try:
        info=os.fstat(directory)
        if info.st_gid!=1000:raise BootstrapError('Unsafe updater directory')
        deadline=time.monotonic()+timeout
        while True:
            try:
                before=os.stat(name,dir_fd=directory,follow_symlinks=False)
                if not stat.S_ISSOCK(before.st_mode) or (before.st_uid,before.st_gid,stat.S_IMODE(before.st_mode))!=(0,1000,0o660):
                    raise BootstrapError('Unsafe updater socket')
                with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as peer:
                    peer.settimeout(2);peer.connect(path)
                    pid,uid,_=struct.unpack('3i',peer.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))
                    after=os.stat(name,dir_fd=directory,follow_symlinks=False)
                    if uid!=0 or pid<=0 or (before.st_dev,before.st_ino)!=(after.st_dev,after.st_ino):
                        raise BootstrapError('Updater identity changed')
                return
            except (FileNotFoundError,ConnectionRefusedError):
                if time.monotonic()>=deadline:raise BootstrapError('Updater did not start')
                time.sleep(.2)
    finally:os.close(directory)


def bootstrap(operation,commit,digest,tag,install_dir,config_dir,state_dir,supervisor,policy,*,run=command,ready=wait_socket,is_inactive=inactive,take_lock_fd=None):
    """Execute one verified first-install transition with durable exclusion."""
    if (sys.platform!='linux' or os.geteuid()!=0 or not sys.flags.isolated or not supervisor._uuid4(operation) or
        not isinstance(commit,str) or not re.fullmatch(r'[a-f0-9]{40}',commit) or
        not isinstance(digest,str) or not re.fullmatch(r'sha256:[a-f0-9]{64}',digest) or
        not isinstance(tag,str) or len(tag)>64 or not re.fullmatch(r'v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)',tag)):
        raise BootstrapError('Invalid initial release')
    install=supervisor._trusted_directory(install_dir,0o700);lock=None;service_started=False
    marker=('servus-bootstrap-verification-v1 '+operation+'\n').encode('ascii');identity=None
    base='/usr/local/libexec/servus';active=config_dir+'/servus.env'
    try:
        lock=policy._installation_lock(install,supervisor,take_lock_fd)
        # Ownership must be transferred by an exec, not by a parent retaining
        # another copy of this open file description. Handoff later releases it.
        if take_lock_fd is not None:os.close(take_lock_fd)
        config=policy._read_private_file(active,65536);env=policy._env(config)
        if env.get('SERVUS_IMAGE')!='ghcr.io/raxon/servus@'+digest:
            raise BootstrapError('Accepted image does not match the release')
        expected={'SERVUS_LIFECYCLE_DIR':config_dir+'/lifecycle',
                  'SERVUS_SUPERVISOR_CONTROL_DIR':config_dir+'/supervisor-control',
                  'SERVUS_SUPERVISOR_SECRET_DIR':config_dir+'/supervisor-secrets',
                  'SERVUS_UPDATER_SOCKET_DIR':'/run/servus-updater/control'}
        if any(env.get(key)!=value for key,value in expected.items()):
            raise BootstrapError('Accepted runtime paths do not match')
        data=env.get('SERVUS_DATA_DIR')
        if not isinstance(data,str) or not data.startswith('/') or os.path.normpath(data)!=data:
            raise BootstrapError('Invalid data directory')
        supervisor._verify_data_directory(data)
        fd=os.open(data,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
        try:
            if os.listdir(fd):raise BootstrapError('Existing data requires a verified migration')
        finally:os.close(fd)
        docker_config=state_dir+'/docker-config';fd=supervisor._trusted_directory(docker_config,0o700)
        try:
            if os.listdir(fd):raise BootstrapError('Docker configuration is not empty')
        finally:os.close(fd)
        if policy._docker(docker_config,'ps','-aq','--filter','label=com.docker.compose.project=servus','--no-trunc').strip():
            raise BootstrapError('Existing Servus containers require migration')
        run(['/usr/bin/systemctl','daemon-reload'])
        if not all(is_inactive(unit) for unit in ('servus-supervisor.service','servus-updater.service','servus-updater-bootstrap.service')):
            raise BootstrapError('Existing updater services require recovery')
        try:os.stat('.initial-handoff-v1',dir_fd=install,follow_symlinks=False)
        except FileNotFoundError:pass
        else:raise BootstrapError('A previous handoff requires recovery')
        fd=os.open(MARKER,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=install)
        try:
            os.fchmod(fd,0o600)
            with os.fdopen(fd,'wb',closefd=False) as output:
                output.write(marker);output.flush();os.fsync(fd)
            info=os.fstat(fd);identity=(info.st_dev,info.st_ino)
        finally:os.close(fd)
        os.fsync(install)
        run(['/usr/bin/systemctl','start','servus-updater-socket.service'])
        run(['/usr/bin/systemctl','start','servus-updater-bootstrap.service']);service_started=True
        ready('/run/servus-updater/control/updater.sock',supervisor)
        run(['/usr/bin/setpriv','--reuid=1000','--regid=1000','--clear-groups','/usr/bin/python3','-I',base+'/bootstrap-release.py',
             '--operation',operation,'--commit',commit,'--digest',digest,'--tag',tag],timeout=960)
        run(['/usr/bin/systemctl','stop','servus-updater-bootstrap.service']);service_started=False
        run(['/usr/bin/python3','-I',base+'/bootstrap-policy.py','--operation',operation,'--state-dir',state_dir,
             '--accepted-env',active,'--install-dir',install_dir,'--control-dir',config_dir+'/supervisor-control',
             '--policy-dir',state_dir+'/policies','--install-lock-fd',str(lock)],pass_fds=(lock,),timeout=960)
        run(['/usr/bin/python3','-I',base+'/provision-host.py','--finalize','--install-lock-fd',str(lock)],pass_fds=(lock,),timeout=180)
        os.close(lock);lock=None
        run(['/usr/bin/python3','-I',base+'/bootstrap-handoff.py','--operation',operation],timeout=300)
        lock=policy._installation_lock(install,supervisor)
        fd=supervisor._open_root_file(install,MARKER,0o600)
        try:
            current=os.fstat(fd);named=os.stat(MARKER,dir_fd=install,follow_symlinks=False)
            if ((current.st_dev,current.st_ino)!=identity or (named.st_dev,named.st_ino)!=identity or
                os.read(fd,len(marker)+1)!=marker):raise BootstrapError('Bootstrap marker changed')
        finally:os.close(fd)
        os.unlink(MARKER,dir_fd=install);os.fsync(install)
    finally:
        if service_started:
            try:run(['/usr/bin/systemctl','stop','servus-updater-bootstrap.service'])
            except Exception:pass
        if lock is not None:os.close(lock)
        os.close(install)


def main():
    parser=argparse.ArgumentParser()
    for name in ('operation','commit','digest','tag'):parser.add_argument('--'+name,required=True)
    parser.add_argument('--take-install-lock-fd',type=int,help='Take ownership of the installation lock passed by an exec')
    args=parser.parse_args()
    if sys.platform!='linux' or os.geteuid()!=0 or not sys.flags.isolated:
        print('Initial bootstrap requires isolated Linux root.',file=sys.stderr);return 1
    try:
        base=pathlib.Path(os.path.realpath(__file__)).parent;current=pathlib.Path('/')
        for part in base.parts[1:]:
            current/=part;info=current.lstat()
            if not stat.S_ISDIR(info.st_mode) or info.st_uid!=0 or info.st_mode & 0o022:raise BootstrapError('Untrusted module directory')
        path=base/'initial-generation.py';fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
        try:
            info=os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or (info.st_uid,info.st_gid,stat.S_IMODE(info.st_mode),info.st_nlink)!=(0,0,0o644,1):raise BootstrapError('Untrusted module')
        finally:os.close(fd)
        spec=importlib.util.spec_from_file_location('servus_initial_generation',path)
        if not spec or not spec.loader:raise BootstrapError('Module unavailable')
        initial=importlib.util.module_from_spec(spec);spec.loader.exec_module(initial)
        supervisor,_,_,_,policy,_=initial.trusted_modules()
        bootstrap(args.operation,args.commit,args.digest,args.tag,'/opt/servus','/etc/servus','/var/lib/servus-updater',supervisor,policy,take_lock_fd=args.take_install_lock_fd)
        return 0
    except Exception:
        print('Initial bootstrap failed or requires recovery.',file=sys.stderr);return 1


if __name__=='__main__':raise SystemExit(main())
