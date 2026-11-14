#!/usr/bin/python3 -I
"""Complete a prepared legacy migration using verified local evidence."""
import argparse
import importlib.util
import os
import pathlib
import stat
import sys
import time


class MigrationError(Exception):
    pass


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    for name in ('operation','old-env','old-compose','recovery-dir','snapshot-dir'):
        parser.add_argument('--'+name,required=True)
    args=parser.parse_args()
    if sys.platform!='linux' or os.geteuid()!=0 or not sys.flags.isolated:
        print('Migration requires isolated Linux root.',file=sys.stderr);return 1
    os.umask(0o077);journal=lock=node=None
    try:
        base=pathlib.Path(os.path.realpath(__file__)).parent;current=pathlib.Path('/')
        for part in base.parts[1:]:
            current/=part;info=current.lstat()
            if not stat.S_ISDIR(info.st_mode) or info.st_uid!=0 or info.st_mode&0o022:raise MigrationError('Untrusted module directory')
        path=base/'initial-generation.py';fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
        try:
            info=os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or (info.st_uid,info.st_gid,stat.S_IMODE(info.st_mode),info.st_nlink)!=(0,0,0o644,1):
                raise MigrationError('Untrusted module')
        finally:os.close(fd)
        spec=importlib.util.spec_from_file_location('servus_migration_initial',path)
        if not spec or not spec.loader:raise MigrationError('Module unavailable')
        initial=importlib.util.module_from_spec(spec);spec.loader.exec_module(initial)
        supervisor,daemon,extractor,backup,policy,updater=initial.trusted_modules()
        if not supervisor._uuid4(args.operation):raise MigrationError('Invalid operation')
        state=updater.trusted_directory('/var/lib/servus-updater',0o700)
        active='/etc/servus/servus.env';journal_path=str(state/'journal.sqlite')
        host=daemon.HostApply('/etc/servus/update-apply.json',journal_path,active,None)
        modules={name:host._load('servus_migration_'+name.replace('-','_'),name+'.py') for name in
                 ('adoption-proof','update-coordinator','restore-snapshot','legacy-recovery','legacy-transition','legacy-stop',
                  'migration-fence','quiescence','bootstrap-handoff')}
        install=supervisor._trusted_directory('/opt/servus',0o700)
        try:lock=policy._installation_lock(install,supervisor)
        finally:os.close(install)
        journal=updater.Journal(state);node=host._node()
        row=journal.db.execute("SELECT source,old_image,old_image_id,old_ids FROM legacy_stop_operations WHERE operation_id=? AND state='stopped'",(args.operation,)).fetchone()
        if not row:raise MigrationError('Stopped legacy installation is unavailable')
        source,image,image_id,raw_ids=row;old_ids=policy._json(raw_ids)
        _,_,approved=daemon.resolve_active_policy(journal_path,active)
        parent,name=os.path.split(approved.data_dir)
        if name!='restore-'+args.operation:raise MigrationError('Migration target does not match')
        class Docker:
            def call(self,*values,**kwargs):return policy._docker(host.config['dockerConfig'],*values,**kwargs)
            def inspect(self,*ids):return policy._json(self.call('inspect',*ids))
        docker=Docker();adoption=modules['adoption-proof'];quiet=modules['quiescence']
        fence=modules['migration-fence'].MigrationFence(journal,args.operation,active,source,old_ids,supervisor,daemon,adoption,quiet,docker)
        ingress=host.config['trustedIngress'];ingress=tuple(ingress) if ingress is not None else None
        transition=modules['legacy-transition'];coordinator=modules['update-coordinator']
        transition.transition(journal,args.operation,active,source,image,image_id,old_ids,args.old_env,args.old_compose,
            args.recovery_dir,args.snapshot_dir,parent,node,host.config['dockerConfig'],supervisor,daemon,adoption,policy,quiet,docker,
            backup,coordinator,modules['restore-snapshot'],modules['legacy-recovery'],modules['legacy-stop'],initial,extractor,fence,
            install_lock=lock,trusted_ingress=ingress)
        os.close(lock);lock=None
        deadline=time.monotonic()+240
        while True:
            result=journal.db.execute('SELECT status FROM preparations WHERE operation_id=?',(args.operation,)).fetchone()
            if result==('completed',):break
            if result!=('prepared',) or time.monotonic()>=deadline:raise MigrationError('Supervisor did not finalize the generation')
            time.sleep(1)
        transition.complete(journal,args.operation,active,node,supervisor,daemon,policy,initial,backup,coordinator,
                            service=modules['bootstrap-handoff'].systemctl)
        print('Legacy migration completed.')
        return 0
    except Exception as error:
        print('Migration failed or requires recovery: '+type(error).__name__,file=sys.stderr);return 1
    finally:
        if node is not None:os.close(node)
        if journal is not None:journal.close()
        if lock is not None:os.close(lock)


if __name__=='__main__':raise SystemExit(main())
