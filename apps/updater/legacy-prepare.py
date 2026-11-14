#!/usr/bin/python3 -I
"""Stop a verified legacy generation and activate a prepared release policy."""
import argparse
import fcntl
import importlib.util
import os
import pathlib
import stat
import sys
import time


class PrepareError(Exception):
    pass


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--operation',required=True)
    parser.add_argument('--old-env',required=True)
    args=parser.parse_args()
    if sys.platform!='linux' or os.geteuid()!=0 or not sys.flags.isolated:
        print('Migration preparation requires isolated Linux root.',file=sys.stderr);return 1
    os.umask(0o077);journal=service_lock=install_lock=None
    try:
        base=pathlib.Path(os.path.realpath(__file__)).parent;current=pathlib.Path('/')
        for part in base.parts[1:]:
            current/=part;info=current.lstat()
            if not stat.S_ISDIR(info.st_mode) or info.st_uid!=0 or info.st_mode&0o022:raise PrepareError('Untrusted module directory')
        path=base/'bootstrap-policy.py';fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
        try:
            info=os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or (info.st_uid,info.st_gid,stat.S_IMODE(info.st_mode),info.st_nlink)!=(0,0,0o644,1):
                raise PrepareError('Untrusted module')
        finally:os.close(fd)
        spec=importlib.util.spec_from_file_location('servus_legacy_bootstrap_policy',path)
        if not spec or not spec.loader:raise PrepareError('Module unavailable')
        boot=importlib.util.module_from_spec(spec);spec.loader.exec_module(boot)
        supervisor,updater,policy,extractor,verifier,daemon=boot._trusted_modules()
        if not supervisor._uuid4(args.operation):raise PrepareError('Invalid operation')
        def load(name):
            directory=supervisor._trusted_directory(str(base))
            try:fd=supervisor._open_root_file(directory,name+'.py',0o644);os.close(fd)
            finally:os.close(directory)
            spec=importlib.util.spec_from_file_location('servus_legacy_'+name.replace('-','_'),base/(name+'.py'))
            if not spec or not spec.loader:raise PrepareError('Module unavailable')
            module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
        adoption=load('adoption-proof');legacy=load('legacy-stop');transition=load('legacy-transition')
        quiet=load('quiescence');provision=load('provision-host')
        state=updater.trusted_directory('/var/lib/servus-updater',0o700);state_fd=supervisor._trusted_directory(str(state),0o700)
        try:service_lock=supervisor._open_root_file(state_fd,'service.lock',0o600)
        finally:os.close(state_fd)
        fcntl.flock(service_lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        install=supervisor._trusted_directory('/opt/servus',0o700)
        try:install_lock=policy._installation_lock(install,supervisor)
        finally:os.close(install)
        journal=updater.Journal(state);active='/etc/servus/servus.env';policies=str(state/'policies');docker_config=str(state/'docker-config')
        old=policy._read_private_file(args.old_env,65536);values=policy._env(old)
        source=values.get('SERVUS_DATA_DIR');image=values.get('SERVUS_IMAGE')
        if not isinstance(source,str) or not isinstance(image,str):raise PrepareError('Legacy configuration is incomplete')
        class Docker:
            def call(self,*values,**kwargs):return policy._docker(docker_config,*values,**kwargs)
            def inspect(self,*ids):return policy._json(self.call('inspect',*ids))
        docker=Docker()
        ids=docker.call('ps','-aq','--no-trunc','--filter','label=com.docker.compose.project=servus').decode('ascii').splitlines()
        if len(ids)!=3 or len(set(ids))!=3:raise PrepareError('Legacy container inventory is unavailable')
        records=docker.inspect(*ids)
        if not isinstance(records,list) or len(records)!=3 or any(not isinstance(item,dict) for item in records):
            raise PrepareError('Legacy container inspection failed')
        old_ids={};image_ids=set()
        for item in records:
            config=item.get('Config') or {};role=(config.get('Labels') or {}).get('com.docker.compose.service')
            if role not in ('api','agent','worker') or role in old_ids or item.get('Id') not in ids:raise PrepareError('Legacy identity differs')
            mounts=item.get('Mounts')
            if (config.get('Image')!=image or not isinstance(mounts,list) or
                not any(isinstance(mount,dict) and mount.get('Type')=='bind' and mount.get('Source')==source and
                        mount.get('Destination')==source and mount.get('RW') is True for mount in mounts)):
                raise PrepareError('Legacy configuration differs from running containers')
            old_ids[role]=item['Id'];image_ids.add(item.get('Image'))
        if len(image_ids)!=1:raise PrepareError('Legacy images differ')
        image_id=image_ids.pop()
        ingress=provision.trusted_ingress(docker_config,policy);ingress=tuple(ingress) if ingress is not None else None
        row=journal.db.execute("SELECT preparation_id,staging_path FROM preparations WHERE operation_id=? AND status='prepared'",(args.operation,)).fetchone()
        if not row or not supervisor._uuid4(row[0]) or not isinstance(row[1],str) or not os.path.isabs(row[1]) or os.path.normpath(row[1])!=row[1]:
            raise PrepareError('Verified preparation is unavailable')
        candidate=os.path.join(policies,'candidate-'+row[0]+'.json');active_policy=os.path.join(policies,'policy-'+args.operation+'.json')
        def resolve_child(root,config):
            registry=verifier.Registry(time.monotonic()+verifier.TOTAL_SECONDS);registry.authenticate()
            return verifier.revalidate_amd64_identity(registry,root,config)
        policy.produce(journal,args.operation,os.path.dirname(row[1]),active,'/opt/servus',candidate,extractor,supervisor,
                       resolve_child=resolve_child,inherited_lock=install_lock)
        if policy._read_private_file(args.old_env,65536)!=old:raise PrepareError('Legacy configuration changed')
        transition.prepare_stop(journal,args.operation,active,policies,source,image,image_id,old_ids,supervisor,daemon,adoption,policy,quiet,docker,legacy,
                                install_lock=install_lock,trusted_ingress=ingress)
        policy.activate(journal,args.operation,active,candidate,active_policy,'/opt/servus','/etc/servus/supervisor-control',
                        extractor,supervisor,inherited_lock=install_lock)
        print('Legacy generation stopped and verified policy activated.')
        return 0
    except Exception as error:
        print('Migration preparation failed or requires recovery: '+type(error).__name__,file=sys.stderr);return 1
    finally:
        if journal is not None:journal.close()
        if install_lock is not None:os.close(install_lock)
        if service_lock is not None:os.close(service_lock)


if __name__=='__main__':raise SystemExit(main())
