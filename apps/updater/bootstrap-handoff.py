#!/usr/bin/python3 -I
"""Start approved host services and the first generation after policy activation."""
import argparse
import fcntl
import importlib.util
import os
import pathlib
import stat
import subprocess
import sys
import time

MARKER = '.initial-handoff-v1'


class HandoffError(Exception):
    pass


def systemctl(*args, timeout=30):
    result=subprocess.run(['/usr/bin/systemctl',*args],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,
                          stderr=subprocess.DEVNULL,cwd='/',env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LANG':'C'},timeout=timeout)
    return result.returncode,result.stdout.decode('ascii','strict').strip()


def handoff(journal, operation, active_env, state_dir, supervisor, daemon, policy, initial, extractor, backup,
            *, service=systemctl, timeout=180):
    """Serialize the handoff with a persistent marker across daemon startup."""
    if sys.platform != 'linux' or os.geteuid() != 0 or not sys.flags.isolated or not supervisor._uuid4(operation):
        raise HandoffError('An isolated root operation is required')
    if type(timeout) is not int or not 1 <= timeout <= 300: raise HandoffError('Invalid handoff timeout')
    database=journal.db.execute('PRAGMA database_list').fetchone()
    if not database or database[2] != os.path.join(state_dir,'journal.sqlite'): raise HandoffError('Invalid updater journal')
    path,snapshot,approved=daemon.resolve_active_policy(database[2],active_env)
    if not isinstance(approved,supervisor.RuntimePolicy): raise HandoffError('Invalid approved policy')
    install=supervisor._trusted_directory(approved.install_dir,0o700)
    lock=None; marker_identity=None
    marker=('servus-initial-handoff-v1 '+operation+'\n').encode('ascii')
    deadline=time.monotonic()+timeout
    def acquire():
        end=min(deadline,time.monotonic()+30)
        while True:
            try:return policy._installation_lock(install,supervisor)
            except BlockingIOError:
                if time.monotonic() >= end:raise HandoffError('Installation lock is unavailable')
                time.sleep(.1)
    def verify_marker():
        fd=supervisor._open_root_file(install,MARKER,0o600)
        try:
            info=os.fstat(fd);named=os.stat(MARKER,dir_fd=install,follow_symlinks=False)
            if ((info.st_dev,info.st_ino) != marker_identity or (named.st_dev,named.st_ino) != marker_identity or
                os.read(fd,len(marker)+1) != marker):raise HandoffError('Handoff marker changed')
        finally:os.close(fd)
    try:
        lock=acquire()
        if daemon.resolve_active_policy(database[2],active_env) != (path,snapshot,approved):raise HandoffError('Active policy changed')
        row=journal.db.execute("SELECT p.status FROM preparations p JOIN policy_approvals a ON a.operation_id=p.operation_id WHERE p.operation_id=? AND a.state='active' AND a.policy_path=? AND a.accepted_env_path=? AND a.source_env_path=?",(operation,path,snapshot,active_env)).fetchone()
        if row != ('prepared',):raise HandoffError('Initial generation is not prepared')
        if service('is-active','servus-updater-bootstrap.service') != (3,'inactive'):
            raise HandoffError('Verification service must be stopped')
        fd=os.open(MARKER,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=install)
        try:
            os.fchmod(fd,0o600)
            with os.fdopen(fd,'wb',closefd=False) as stream:
                stream.write(marker);stream.flush();os.fsync(fd)
            info=os.fstat(fd);marker_identity=(info.st_dev,info.st_ino)
        finally:os.close(fd)
        os.fsync(install)
        os.close(lock);lock=None
        for unit in ('servus-supervisor.service','servus-updater.service'):
            if service('start',unit,timeout=45)[0] != 0:raise HandoffError('Host service failed to start')
        while True:
            try:
                initial.check_supervisor(approved.control_dir,supervisor)
                initial.check_updater(approved.updater_dir,supervisor)
                break
            except (OSError,ValueError,initial.InitialGenerationError,supervisor.SupervisorError):
                if time.monotonic() >= deadline:raise HandoffError('Host services did not become ready')
                time.sleep(.2)
        lock=acquire();verify_marker()
        if daemon.resolve_active_policy(database[2],active_env) != (path,snapshot,approved):raise HandoffError('Active policy changed')
        initial.launch(journal,operation,active_env,os.path.join(state_dir,'docker-config'),supervisor,daemon,extractor,backup,policy,inherited_lock=lock)
        os.close(lock);lock=None
        while True:
            row=journal.db.execute('SELECT status FROM preparations WHERE operation_id=?',(operation,)).fetchone()
            if row == ('completed',):break
            if row != ('prepared',):raise HandoffError('Initial preparation requires recovery')
            if time.monotonic() >= deadline:raise HandoffError('Initial generation did not become healthy')
            time.sleep(.5)
        if service('enable','servus-supervisor.service','servus-updater.service','servus-updater-socket.service',timeout=45)[0] != 0:
            raise HandoffError('Host services could not be enabled')
        lock=acquire();verify_marker()
        if daemon.resolve_active_policy(database[2],active_env) != (path,snapshot,approved):raise HandoffError('Active policy changed')
        if journal.db.execute('SELECT status FROM preparations WHERE operation_id=?',(operation,)).fetchone() != ('completed',):
            raise HandoffError('Initial preparation changed')
        os.unlink(MARKER,dir_fd=install);os.fsync(install)
    finally:
        if lock is not None:os.close(lock)
        os.close(install)


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--operation',required=True);args=parser.parse_args()
    if sys.platform != 'linux' or os.geteuid() != 0 or not sys.flags.isolated:
        print('Initial handoff requires isolated Linux root.',file=sys.stderr);return 1
    journal=None
    try:
        base=pathlib.Path(os.path.realpath(__file__)).parent
        current=pathlib.Path('/')
        for part in base.parts[1:]:
            current /= part; info=current.lstat()
            if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
                raise HandoffError('Untrusted updater directory')
        helper=base/'initial-generation.py'
        fd=os.open(helper,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
        try:
            info=os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_gid != 0 or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o644:
                raise HandoffError('Untrusted initial generation helper')
        finally:os.close(fd)
        spec=importlib.util.spec_from_file_location('servus_initial_generation',helper)
        if not spec or not spec.loader:raise HandoffError('Initial generation helper is unavailable')
        initial=importlib.util.module_from_spec(spec);spec.loader.exec_module(initial)
        supervisor,daemon,extractor,backup,policy,updater=initial.trusted_modules()
        state=updater.trusted_directory('/var/lib/servus-updater',0o700);journal=updater.Journal(state)
        handoff(journal,args.operation,'/etc/servus/servus.env',str(state),supervisor,daemon,policy,initial,extractor,backup)
        return 0
    except Exception:
        print('Initial handoff failed or requires recovery.',file=sys.stderr);return 1
    finally:
        if journal is not None:journal.close()


if __name__=='__main__':raise SystemExit(main())
