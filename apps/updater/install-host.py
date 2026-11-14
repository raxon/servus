#!/usr/bin/python3 -I
"""Install initial updater files from an explicitly trusted root-owned source tree.

This bootstraps the verifier itself. The caller is responsible for trusting the
source and separately verifying the release before activating it. Existing
files are never replaced; an interrupted identical installation can be retried.
"""
import argparse
import fcntl
import os
import secrets
import stat
import sys

MODULES = (
    'backup.py','bootstrap-handoff.py','bootstrap-policy.py','bootstrap-release.py',
    'discover-release.py','extract-install.py','guarded-verifier.py','initial-generation.py',
    'install-host.py','preflight.py','prepare-verified.py','preparation-fence.py',
    'provision-verifier-group.py','provision-socket.py','provision-host.py','quiescence.py',
    'runtime-policy.py','servus-updater.py','supervisor-daemon.py','supervisor.py',
    'update-coordinator.py','validate-compose.py','verification-executor.py',
    'verification-fence.py','verify-release.py',
)
UNITS = ('servus-supervisor.service','servus-updater.service',
         'servus-updater-bootstrap.service','servus-updater-socket.service')
MAX_FILE = 4 * 1024 * 1024


class InstallHostError(Exception):
    pass


def directory(path, mode=None):
    if not isinstance(path,str) or not path.startswith('/') or os.path.normpath(path)!=path:
        raise InstallHostError('Invalid directory')
    fd=os.open('/',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:
        for name in path.split('/')[1:]:
            if not name:continue
            child=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
            os.close(fd);fd=child
            info=os.fstat(fd)
            if info.st_uid!=0 or info.st_mode & 0o022:raise InstallHostError('Untrusted directory')
        info=os.fstat(fd)
        if info.st_gid!=0 or (mode is not None and stat.S_IMODE(info.st_mode)!=mode):
            raise InstallHostError('Unexpected directory ownership or mode')
        return fd
    except BaseException:
        os.close(fd);raise


def read_file(parent, name, mode):
    fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=parent)
    try:
        info=os.fstat(fd);named=os.stat(name,dir_fd=parent,follow_symlinks=False)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or info.st_gid!=0 or info.st_nlink!=1 or
            stat.S_IMODE(info.st_mode)!=mode or info.st_size>MAX_FILE or
            (info.st_dev,info.st_ino)!=(named.st_dev,named.st_ino)):
            raise InstallHostError('Unsafe host file')
        with os.fdopen(fd,'rb',closefd=False) as source:data=source.read(MAX_FILE+1)
        final=os.fstat(fd)
        if (len(data)!=info.st_size or (info.st_dev,info.st_ino,info.st_size,info.st_mtime_ns,info.st_ctime_ns)!=
            (final.st_dev,final.st_ino,final.st_size,final.st_mtime_ns,final.st_ctime_ns)):
            raise InstallHostError('Host file changed')
        return data
    finally:os.close(fd)


def child(parent,name,mode):
    try:os.mkdir(name,mode,dir_fd=parent)
    except FileExistsError:created=False
    else:created=True
    fd=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent)
    try:
        if created:os.fchown(fd,0,0);os.fchmod(fd,mode);os.fsync(fd);os.fsync(parent)
        info=os.fstat(fd);named=os.stat(name,dir_fd=parent,follow_symlinks=False)
        if ((info.st_uid,info.st_gid,stat.S_IMODE(info.st_mode))!=(0,0,mode) or
            (info.st_dev,info.st_ino)!=(named.st_dev,named.st_ino)):
            raise InstallHostError('Unsafe host directory')
        return fd
    except BaseException:os.close(fd);raise


def publish(parent,name,data,mode):
    try:existing=read_file(parent,name,mode)
    except FileNotFoundError:existing=None
    if existing is not None:
        if existing!=data:raise InstallHostError('Existing host file differs')
        return
    temporary='.servus-host-'+secrets.token_hex(16)
    fd=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,mode,dir_fd=parent)
    try:
        os.fchown(fd,0,0);os.fchmod(fd,mode)
        with os.fdopen(fd,'wb',closefd=False) as target:
            target.write(data);target.flush();os.fsync(fd)
        try:os.link(temporary,name,src_dir_fd=parent,dst_dir_fd=parent,follow_symlinks=False)
        except FileExistsError:
            if read_file(parent,name,mode)!=data:raise InstallHostError('Existing host file differs')
        else:os.fsync(parent)
    finally:
        os.close(fd);os.unlink(temporary,dir_fd=parent);os.fsync(parent)


def install(source,install_dir,libexec_parent,unit_dir,*,inherited_lock=None):
    if sys.platform!='linux' or os.geteuid()!=0 or not sys.flags.isolated:
        raise InstallHostError('Isolated Linux root is required')
    install_fd=directory(install_dir,0o700);lock=src=modules=units=base=parent=dest=unit_target=None
    try:
        lock=os.open('install.lock',os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=install_fd)
        info=os.fstat(lock);named=os.stat('install.lock',dir_fd=install_fd,follow_symlinks=False)
        if (not stat.S_ISREG(info.st_mode) or (info.st_uid,info.st_gid,stat.S_IMODE(info.st_mode),info.st_nlink)!=(0,0,0o600,1) or
            (info.st_dev,info.st_ino)!=(named.st_dev,named.st_ino)):
            raise InstallHostError('Unsafe installation lock')
        if inherited_lock is not None:
            if type(inherited_lock) is not int or inherited_lock<3:raise InstallHostError('Invalid inherited lock')
            held=os.fstat(inherited_lock)
            if (held.st_dev,held.st_ino)!=(info.st_dev,info.st_ino):raise InstallHostError('Inherited lock does not match')
            duplicate=os.dup(inherited_lock);os.close(lock);lock=duplicate
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        src=directory(source)
        modules=directory(source+'/apps/updater');units=directory(source+'/deployment/systemd')
        module_data={name:read_file(modules,name,0o755 if name=='servus-updater.py' else 0o644) for name in MODULES}
        unit_data={name:read_file(units,name,0o644) for name in UNITS}
        if not isinstance(libexec_parent,str) or not libexec_parent.startswith('/') or os.path.normpath(libexec_parent)!=libexec_parent:
            raise InstallHostError('Invalid libexec directory')
        base_path,name=os.path.split(libexec_parent)
        if not name or name in ('.','..'):raise InstallHostError('Invalid libexec directory')
        base=directory(base_path);parent=child(base,name,0o755);unit_target=directory(unit_dir,0o755)
        # Refuse conflicting units before creating or modifying our directory.
        for name,data in unit_data.items():
            try:existing=read_file(unit_target,name,0o644)
            except FileNotFoundError:continue
            if existing!=data:raise InstallHostError('Existing systemd unit differs')
        dest=child(parent,'servus',0o755)
        for name,data in module_data.items():
            try:existing=read_file(dest,name,0o755 if name=='servus-updater.py' else 0o644)
            except FileNotFoundError:continue
            if existing!=data:raise InstallHostError('Existing updater module differs')
        for name,data in module_data.items():publish(dest,name,data,0o755 if name=='servus-updater.py' else 0o644)
        for name,data in unit_data.items():publish(unit_target,name,data,0o644)
    finally:
        for fd in (dest,unit_target,parent,base,units,modules,src,lock,install_fd):
            if fd is not None:os.close(fd)


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--source',required=True)
    parser.add_argument('--install-dir',default='/opt/servus');parser.add_argument('--install-lock-fd',type=int)
    args=parser.parse_args();os.umask(0o077)
    try:install(args.source,args.install_dir,'/usr/local/libexec','/etc/systemd/system',inherited_lock=args.install_lock_fd)
    except Exception:
        print('Updater host files could not be installed safely.',file=sys.stderr);return 1
    return 0


if __name__=='__main__':raise SystemExit(main())
