#!/usr/bin/python3 -I
"""Recover an interrupted legacy migration before the new generation starts."""
import argparse
import importlib.util
import os
import pathlib
import stat
import sys


class RollbackError(Exception):
    pass


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--operation',required=True)
    args=parser.parse_args()
    if sys.platform!='linux' or os.geteuid()!=0 or not sys.flags.isolated:
        print('Recovery requires isolated Linux root.',file=sys.stderr);return 1
    os.umask(0o077);journal=lock=node=None
    try:
        base=pathlib.Path(os.path.realpath(__file__)).parent;current=pathlib.Path('/')
        for part in base.parts[1:]:
            current/=part;info=current.lstat()
            if not stat.S_ISDIR(info.st_mode) or info.st_uid!=0 or info.st_mode&0o022:raise RollbackError('Untrusted module directory')
        path=base/'initial-generation.py';fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
        try:
            info=os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or (info.st_uid,info.st_gid,stat.S_IMODE(info.st_mode),info.st_nlink)!=(0,0,0o644,1):
                raise RollbackError('Untrusted module')
        finally:os.close(fd)
        spec=importlib.util.spec_from_file_location('servus_rollback_initial',path)
        if not spec or not spec.loader:raise RollbackError('Module unavailable')
        initial=importlib.util.module_from_spec(spec);spec.loader.exec_module(initial)
        supervisor,daemon,_,backup,policy,updater=initial.trusted_modules()
        if not supervisor._uuid4(args.operation):raise RollbackError('Invalid operation')
        state=updater.trusted_directory('/var/lib/servus-updater',0o700)
        active='/etc/servus/servus.env';journal_path=str(state/'journal.sqlite')
        host=daemon.HostApply('/etc/servus/update-apply.json',journal_path,active,None)
        modules={name:host._load('servus_rollback_'+name.replace('-','_'),name+'.py') for name in
                 ('adoption-proof','update-coordinator','restore-snapshot','legacy-recovery','legacy-transition','migration-fence','quiescence','bootstrap-handoff')}
        install=supervisor._trusted_directory('/opt/servus',0o700)
        try:lock=policy._installation_lock(install,supervisor)
        finally:os.close(install)
        journal=updater.Journal(state);node=host._node()
        row=journal.db.execute("SELECT source,old_ids FROM legacy_stop_operations WHERE operation_id=? AND state='stopped'",(args.operation,)).fetchone()
        if not row:raise RollbackError('Recovery identity is unavailable')
        old_ids=policy._json(row[1])
        _,_,approved=daemon.resolve_active_policy(journal_path,active)
        parent,name=os.path.split(approved.data_dir)
        if name!='restore-'+args.operation:raise RollbackError('Recovery target does not match')
        class Docker:
            def call(self,*values,**kwargs):return policy._docker(host.config['dockerConfig'],*values,**kwargs)
            def inspect(self,*ids):return policy._json(self.call('inspect',*ids))
        docker=Docker();adoption=modules['adoption-proof'];quiet=modules['quiescence']
        fence=modules['migration-fence'].MigrationFence(journal,args.operation,active,row[0],old_ids,supervisor,daemon,adoption,quiet,docker)
        transition=modules['legacy-transition'];coordinator=modules['update-coordinator'];restore=modules['restore-snapshot'];recovery=modules['legacy-recovery']
        values=(journal,args.operation,active,parent,node,supervisor,daemon,adoption,policy,quiet,docker,backup,coordinator,restore,recovery,fence)
        transition.assess_rollback(*values,install_lock=lock)
        root=supervisor._trusted_directory(str(state),0o700);name='legacy-rollback-'+args.operation
        try:
            os.mkdir(name,0o700,dir_fd=root);os.fsync(root)
        finally:os.close(root)
        work=str(state/name)
        transition.rollback_before_start(journal,args.operation,active,parent,work,node,supervisor,daemon,adoption,policy,
            quiet,docker,backup,coordinator,restore,recovery,fence,install_lock=lock,service=modules['bootstrap-handoff'].systemctl)
        print('Legacy generation restored. Migration state remains available for inspection.')
        return 0
    except Exception as error:
        print('Recovery failed or requires manual inspection: '+type(error).__name__,file=sys.stderr);return 1
    finally:
        if node is not None:os.close(node)
        if journal is not None:journal.close()
        if lock is not None:os.close(lock)


if __name__=='__main__':raise SystemExit(main())
