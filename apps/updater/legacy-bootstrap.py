#!/usr/bin/python3 -I
"""Verify a release and bootstrap a prepared legacy migration on this host."""
import argparse
import importlib.util
import os
import pathlib
import re
import stat
import subprocess
import sys


class BootstrapError(Exception):
    pass


def run(args,timeout):
    result=subprocess.run(args,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,
                          cwd='/',env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LANG':'C','LC_ALL':'C'},timeout=timeout)
    if result.returncode:raise BootstrapError('A bootstrap operation failed')


def bootstrap(operation,commit,digest,tag,old_compose,supervisor,daemon,policy,updater,initial_bootstrap,*,execute=run):
    if (not supervisor._uuid4(operation) or not isinstance(commit,str) or not re.fullmatch(r'[a-f0-9]{40}',commit) or
        not isinstance(digest,str) or not re.fullmatch(r'sha256:[a-f0-9]{64}',digest) or
        not isinstance(tag,str) or len(tag)>64 or not re.fullmatch(r'v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)',tag) or
        not isinstance(old_compose,str) or not os.path.isabs(old_compose) or os.path.normpath(old_compose)!=old_compose):
        raise BootstrapError('Invalid migration request')
    base='/usr/local/libexec/servus';active='/etc/servus/servus.env';state='/var/lib/servus-updater'
    install=supervisor._trusted_directory('/opt/servus',0o700);lock=None;verification_started=False
    marker_name='.bootstrap-verification-v1';marker=('servus-bootstrap-verification-v1 '+operation+'\n').encode('ascii');identity=None
    try:
        lock=policy._installation_lock(install,supervisor)
        for name in (marker_name,'.legacy-migration-v1','.initial-handoff-v1'):
            try:os.stat(name,dir_fd=install,follow_symlinks=False)
            except FileNotFoundError:pass
            else:raise BootstrapError('Existing migration requires inspection')
        old=policy._read_private_file(active,65536);values=policy._env(old)
        source=values.get('SERVUS_DATA_DIR');image=values.get('SERVUS_IMAGE')
        if (not isinstance(source,str) or not os.path.isabs(source) or os.path.normpath(source)!=source or source=='/' or
            not isinstance(image,str) or not re.fullmatch(r'ghcr\.io/raxon/servus@sha256:[a-f0-9]{64}',image) or image.endswith(digest)):
            raise BootstrapError('Legacy installation configuration is invalid')
        supervisor._verify_data_directory(source)
        parent,name=os.path.split(old_compose);directory=supervisor._trusted_directory(parent)
        try:fd=supervisor._open_root_file(directory,name,0o644);os.close(fd)
        finally:os.close(directory)
        for unit in ('servus-supervisor.service','servus-updater.service','servus-updater-bootstrap.service'):
            if not initial_bootstrap.inactive(unit):raise BootstrapError('Existing updater service requires inspection')
        fd=os.open(marker_name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=install)
        try:
            os.fchmod(fd,0o600)
            with os.fdopen(fd,'wb',closefd=False) as output:output.write(marker);output.flush();os.fsync(fd)
            info=os.fstat(fd);identity=(info.st_dev,info.st_ino)
        finally:os.close(fd)
        os.fsync(install)
        execute(['/usr/bin/systemctl','daemon-reload'],45)
        execute(['/usr/bin/systemctl','start','servus-updater-socket.service'],45)
        execute(['/usr/bin/systemctl','start','servus-updater-bootstrap.service'],45);verification_started=True
        initial_bootstrap.wait_socket('/run/servus-updater/control/updater.sock',supervisor)
        execute(['/usr/bin/setpriv','--reuid=1000','--regid=1000','--clear-groups','/usr/bin/python3','-I',base+'/bootstrap-release.py',
                 '--operation',operation,'--commit',commit,'--digest',digest,'--tag',tag],960)
        execute(['/usr/bin/systemctl','stop','servus-updater-bootstrap.service'],45);verification_started=False
        if policy._read_private_file(active,65536)!=old:raise BootstrapError('Legacy configuration changed')
        config=supervisor._trusted_directory('/etc/servus',0o700)
        try:policy._publish_private(config,'legacy-'+operation+'.env',old)
        finally:os.close(config)
        data_parent='/var/lib/servus-migration';varlib=supervisor._trusted_directory('/var/lib')
        try:
            try:os.mkdir('servus-migration',0o711,dir_fd=varlib);os.fsync(varlib)
            except FileExistsError:pass
        finally:os.close(varlib)
        parent_fd=supervisor._trusted_directory(data_parent,0o711)
        try:
            if os.fstat(parent_fd).st_gid!=0:raise BootstrapError('Unsafe migration data parent')
            os.mkdir('restore-'+operation,0o700,dir_fd=parent_fd);os.fsync(parent_fd)
        finally:os.close(parent_fd)
        state_fd=supervisor._trusted_directory(state,0o700)
        try:
            for name in ('legacy-recovery-'+operation,'legacy-snapshot-'+operation):os.mkdir(name,0o700,dir_fd=state_fd)
            os.fsync(state_fd)
        finally:os.close(state_fd)
        values.update({'SERVUS_IMAGE':'ghcr.io/raxon/servus@'+digest,'SERVUS_DATA_DIR':data_parent+'/restore-'+operation,
                       'SERVUS_SOURCE_REF':tag,'SERVUS_LIFECYCLE_DIR':'/etc/servus/lifecycle',
                       'SERVUS_SUPERVISOR_CONTROL_DIR':'/etc/servus/supervisor-control',
                       'SERVUS_SUPERVISOR_SECRET_DIR':'/etc/servus/supervisor-secrets',
                       'SERVUS_UPDATER_SOCKET_DIR':'/run/servus-updater/control'})
        new=''.join(key+'='+value+'\n' for key,value in values.items()).encode('ascii')
        config=supervisor._trusted_directory('/etc/servus',0o700)
        try:
            if policy._read_private_file(active,65536)!=old:raise BootstrapError('Legacy configuration changed')
            policy._replace_private(config,'servus.env',new)
        finally:os.close(config)
        os.close(lock);lock=None
        execute(['/usr/bin/python3','-I',base+'/legacy-run.py','--operation',operation,'--old-env','/etc/servus/legacy-'+operation+'.env',
                 '--old-compose',old_compose,'--recovery-dir',state+'/legacy-recovery-'+operation,
                 '--snapshot-dir',state+'/legacy-snapshot-'+operation],1200)
        lock=policy._installation_lock(install,supervisor)
        journal=updater.Journal(pathlib.Path(state))
        try:
            if (journal.db.execute('SELECT phase FROM legacy_transitions WHERE operation_id=?',(operation,)).fetchone()!=('completed',) or
                journal.db.execute('SELECT status FROM preparations WHERE operation_id=?',(operation,)).fetchone()!=('completed',)):
                raise BootstrapError('Migration did not finish')
        finally:journal.close()
        daemon.resolve_active_policy(state+'/journal.sqlite',active)
        fd=supervisor._open_root_file(install,marker_name,0o600)
        try:
            opened=os.fstat(fd);named=os.stat(marker_name,dir_fd=install,follow_symlinks=False)
            if ((opened.st_dev,opened.st_ino)!=identity or (named.st_dev,named.st_ino)!=identity or
                os.read(fd,len(marker)+1)!=marker):raise BootstrapError('Bootstrap marker changed')
        finally:os.close(fd)
        os.unlink(marker_name,dir_fd=install);os.fsync(install)
    finally:
        if verification_started:
            try:execute(['/usr/bin/systemctl','stop','servus-updater-bootstrap.service'],45)
            except Exception:pass
        if lock is not None:os.close(lock)
        os.close(install)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    for name in ('operation','commit','digest','tag','old-compose'):parser.add_argument('--'+name,required=True)
    args=parser.parse_args()
    if sys.platform!='linux' or os.geteuid()!=0 or not sys.flags.isolated:
        print('Migration bootstrap requires isolated Linux root.',file=sys.stderr);return 1
    os.umask(0o077)
    try:
        base=pathlib.Path(os.path.realpath(__file__)).parent;current=pathlib.Path('/')
        for part in base.parts[1:]:
            current/=part;info=current.lstat()
            if not stat.S_ISDIR(info.st_mode) or info.st_uid!=0 or info.st_mode&0o022:raise BootstrapError('Untrusted module directory')
        def load(name):
            path=base/(name+'.py');fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
            try:
                info=os.fstat(fd)
                if not stat.S_ISREG(info.st_mode) or (info.st_uid,info.st_gid,stat.S_IMODE(info.st_mode),info.st_nlink)!=(0,0,0o644,1):raise BootstrapError('Untrusted module')
            finally:os.close(fd)
            spec=importlib.util.spec_from_file_location('servus_legacy_bootstrap_'+name.replace('-','_'),path)
            if not spec or not spec.loader:raise BootstrapError('Module unavailable')
            module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
        initial=load('initial-generation');initial_bootstrap=load('bootstrap-initial')
        supervisor,daemon,_,_,policy,updater=initial.trusted_modules()
        directory=supervisor._trusted_directory(str(base))
        try:
            for name in ('bootstrap-release.py','legacy-run.py'):
                fd=supervisor._open_root_file(directory,name,0o644);os.close(fd)
        finally:os.close(directory)
        bootstrap(args.operation,args.commit,args.digest,args.tag,args.old_compose,supervisor,daemon,policy,updater,initial_bootstrap)
        print('Signed legacy migration completed.')
        return 0
    except Exception as error:
        print('Migration bootstrap failed or requires recovery: '+type(error).__name__,file=sys.stderr);return 1


if __name__=='__main__':raise SystemExit(main())
