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
import sqlite3
import stat
import struct
import subprocess
import sys
import time

MARKER='.bootstrap-verification-v1'


class BootstrapError(Exception):
    pass


def failure_detail(error, initial=None):
    initial_error=getattr(initial,'InitialGenerationError',None)
    known=isinstance(error,BootstrapError) or (isinstance(initial_error,type) and isinstance(error,initial_error))
    return str(error) if known else type(error).__name__


def command(args, *, pass_fds=(), timeout=45):
    handoff=any(item.endswith('/bootstrap-handoff.py') for item in args)
    result=subprocess.run(args,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=None if handoff else subprocess.DEVNULL,
                          cwd='/',env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LANG':'C','LC_ALL':'C'},
                          pass_fds=pass_fds,timeout=timeout)
    if result.returncode:
        step=next((pathlib.Path(item).name for item in args if item.endswith('.py')),pathlib.Path(args[0]).name)
        raise BootstrapError('Bootstrap step '+step+' failed (exit '+str(result.returncode)+')')


def installation_summary(values, ssh_host='YOUR_SERVER_IP'):
    """Print only allowlisted connection hints, never accepted secrets or environment."""
    port=values.get('SERVUS_PORT','4180');bind=values.get('SERVUS_BIND_ADDRESS','127.0.0.1')
    origin=values.get('SERVUS_PUBLIC_URL','http://127.0.0.1:'+port)
    if not port.isascii() or not port.isdigit() or not 1<=int(port)<=65535:
        raise BootstrapError('Invalid summary port')
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9.-]{0,252}',ssh_host) and ssh_host!='YOUR_SERVER_IP':
        raise BootstrapError('Invalid SSH connection hint')
    print('\nServus installation completed.\nConfigured panel origin: '+origin+'\nManagement listener: '+bind+':'+port)
    if bind=='127.0.0.1' and origin.startswith(('http://localhost:','http://127.0.0.1:')):
        print('\nOn your computer, open an SSH tunnel and keep it running:\n  ssh -N -L 127.0.0.1:'+port+':127.0.0.1:'+port+' root@'+ssh_host+'\nThen open: http://127.0.0.1:'+port)
    else:print('\nOpen the configured panel origin: '+origin)
    print('\nFirst visit: enter your email and a password of at least 8 characters, then choose Create administrator.\nOn an existing installation, sign in with your account.')
    manage='sudo docker compose --env-file /etc/servus/servus.env -f /opt/servus/current/deployment/compose.yaml -p servus '
    print('\nService status:\n  '+manage+'ps\nRecent logs:\n  '+manage+'logs --tail=100')
    print('\nHost services:\n  sudo systemctl status servus-supervisor.service servus-updater.service\nConfiguration: /etc/servus/servus.env\nData directory: '+values.get('SERVUS_DATA_DIR','/var/lib/servus'))


def recover_bootstrap(operation,install_dir,config_dir,state_dir,supervisor,policy,initial,daemon,*,run=command):
    """Resume an approved pre-launch handoff or finalize its authenticated healthy result."""
    if sys.platform!='linux' or os.geteuid()!=0 or not sys.flags.isolated or not supervisor._uuid4(operation):
        raise BootstrapError('Invalid initial recovery operation')
    install=supervisor._trusted_directory(install_dir,0o700);lock=None
    marker=('servus-bootstrap-verification-v1 '+operation+'\n').encode('ascii')
    active=config_dir+'/servus.env';journal=pathlib.Path(state_dir)/'journal.sqlite'
    def acquire():
        deadline=time.monotonic()+30
        while True:
            try:return policy._installation_lock(install,supervisor)
            except BlockingIOError:
                if time.monotonic()>=deadline:raise BootstrapError('Installation lock is unavailable')
                time.sleep(.1)
    def marker_identity():
        fd=supervisor._open_root_file(install,MARKER,0o600)
        try:
            info=os.fstat(fd);named=os.stat(MARKER,dir_fd=install,follow_symlinks=False)
            if (info.st_dev,info.st_ino)!=(named.st_dev,named.st_ino) or os.read(fd,len(marker)+1)!=marker:
                raise BootstrapError('Bootstrap recovery marker changed')
            return info.st_dev,info.st_ino
        finally:os.close(fd)
    def status():
        with sqlite3.connect('file:'+str(journal)+'?mode=ro',uri=True) as db:
            row=db.execute("SELECT p.status FROM operations o JOIN preparations p ON p.operation_id=o.id JOIN policy_approvals a ON a.operation_id=o.id WHERE o.id=? AND o.status='verified' AND a.state='active' AND a.source_env_path=?",(operation,active)).fetchone()
            tables={item[0] for item in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            generations=db.execute('SELECT operation_id,phase FROM initial_generations').fetchall() if 'initial_generations' in tables else []
        if row is None:raise BootstrapError('Initial recovery is not bound to an approved verified operation')
        return row[0],generations
    try:
        lock=acquire()
        identity=marker_identity();approved=daemon.resolve_active_policy(str(journal),active)
        phase,generations=status()
        if phase=='prepared' and not generations:
            os.close(lock);lock=None
            run(['/usr/bin/python3','-I','/usr/local/libexec/servus/bootstrap-handoff.py','--recover','--operation',operation],timeout=300)
            lock=acquire()
        elif phase!='completed' or generations!=[(operation,'started')]:
            raise BootstrapError('Initial generation is uncertain and requires operator recovery')
        if daemon.resolve_active_policy(str(journal),active)!=approved or marker_identity()!=identity:
            raise BootstrapError('Initial recovery policy or marker changed')
        if status()!=('completed',[(operation,'started')]):
            raise BootstrapError('Recovered generation has not completed startup')
        try:os.stat('.initial-handoff-v1',dir_fd=install,follow_symlinks=False)
        except FileNotFoundError:pass
        else:raise BootstrapError('Initial handoff still requires recovery')
        # Status handlers inspect the runtime under the installation lock too.
        # Probe without holding it, then revalidate every durable binding before
        # removing the bootstrap fence.
        os.close(lock);lock=None
        initial.check_supervisor(approved[2].control_dir,supervisor,expected='ready')
        initial.check_updater(approved[2].updater_dir,supervisor)
        run(['/usr/bin/systemctl','start','servus-host-update.timer'],timeout=45)
        lock=acquire()
        if daemon.resolve_active_policy(str(journal),active)!=approved or marker_identity()!=identity or status()!=('completed',[(operation,'started')]):
            raise BootstrapError('Initial recovery changed during readiness verification')
        try:os.stat('.initial-handoff-v1',dir_fd=install,follow_symlinks=False)
        except FileNotFoundError:pass
        else:raise BootstrapError('Initial handoff still requires recovery')
        os.unlink(MARKER,dir_fd=install);os.fsync(install)
    finally:
        if lock is not None:os.close(lock)
        os.close(install)


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
        try:os.stat('.legacy-migration-v1',dir_fd=install,follow_symlinks=False)
        except FileNotFoundError:pass
        else:raise BootstrapError('A legacy migration requires recovery')
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
    parser.add_argument('--operation',required=True)
    for name in ('commit','digest','tag'):parser.add_argument('--'+name)
    parser.add_argument('--recover',action='store_true',help='Resume a prepared initial handoff or finalize its healthy result')
    parser.add_argument('--ssh-host',default='YOUR_SERVER_IP',help='Address to display in the SSH setup instructions')
    parser.add_argument('--take-install-lock-fd',type=int,help='Take ownership of the installation lock passed by an exec')
    args=parser.parse_args()
    if sys.platform!='linux' or os.geteuid()!=0 or not sys.flags.isolated:
        print('Initial bootstrap requires isolated Linux root.',file=sys.stderr);return 1
    initial=None
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
        supervisor,daemon,_,_,policy,_=initial.trusted_modules()
        if args.recover:
            if args.take_install_lock_fd is not None or any((args.commit,args.digest,args.tag)):
                raise BootstrapError('Recovery accepts an operation ID without a new release or inherited lock')
            recover_bootstrap(args.operation,'/opt/servus','/etc/servus','/var/lib/servus-updater',supervisor,policy,initial,daemon)
        else:
            if any(value is None for value in (args.commit,args.digest,args.tag)):
                raise BootstrapError('Initial installation requires commit, digest and tag')
            bootstrap(args.operation,args.commit,args.digest,args.tag,'/opt/servus','/etc/servus','/var/lib/servus-updater',supervisor,policy,take_lock_fd=args.take_install_lock_fd)
        values=policy._env(policy._read_private_file('/etc/servus/servus.env',65536))
        installation_summary(values,args.ssh_host)
        return 0
    except Exception as error:
        detail=failure_detail(error,initial)
        print('Initial bootstrap failed or requires recovery: '+detail+'.',file=sys.stderr)
        print('Inspect: sudo journalctl -u servus-supervisor.service -u servus-updater.service --since "15 minutes ago"\nOperation: '+args.operation,file=sys.stderr)
        return 1


if __name__=='__main__':raise SystemExit(main())
