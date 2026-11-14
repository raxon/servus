#!/usr/bin/python3 -I
"""Exercise initial orchestration with a real signed release and systemd verifier."""
import fcntl
import importlib.util
import os
from pathlib import Path
import sys

if os.geteuid()!=0 or not os.uname().nodename.startswith('colima-servus-release-e2e-'):
    raise SystemExit('A disposable release fixture VM is required')
base=Path('/usr/local/libexec/servus');sys.path.insert(0,str(base))
import supervisor

def load(name,filename):
    spec=importlib.util.spec_from_file_location(name,base/filename)
    module=importlib.util.module_from_spec(spec);sys.modules[name]=module;spec.loader.exec_module(module);return module

bootstrap=load('fixture_bootstrap_initial','bootstrap-initial.py')
policy=load('fixture_bootstrap_policy','runtime-policy.py')
root=Path('/run/servus-release-fixture');config=root/'bootstrap-config';data=root/'bootstrap-data'
config.mkdir(mode=0o700);data.mkdir(mode=0o700);os.chown(data,1000,1000)
state=Path('/var/lib/servus-updater');install=Path('/opt/servus')
op='029f678e-52dc-4529-9fa4-3140ce64d12e'
commit='7c2013b081b4c26244a52c75b51e6ca2226c8a5a';digest='sha256:32f7cccf97841716ffae6bbff4f4234d5c3575e3b3ad9daa61dcf5afba72a13c'
env={'SERVUS_IMAGE':'ghcr.io/raxon/servus@'+digest,'SERVUS_DATA_DIR':str(data),
     'SERVUS_LIFECYCLE_DIR':str(config/'lifecycle'),'SERVUS_SUPERVISOR_CONTROL_DIR':str(config/'supervisor-control'),
     'SERVUS_SUPERVISOR_SECRET_DIR':str(config/'supervisor-secrets'),'SERVUS_UPDATER_SOCKET_DIR':'/run/servus-updater/control'}
path=config/'servus.env';path.write_text(''.join(k+'='+v+'\n' for k,v in env.items()));path.chmod(0o600)
events=[]
def run(args,**kwargs):
    if args[0]=='/usr/bin/python3' and Path(args[2]).name in ('bootstrap-policy.py','provision-host.py','bootstrap-handoff.py'):
        name=Path(args[2]).name;events.append(name)
        if name=='bootstrap-handoff.py':
            fd=os.open(install/'install.lock',os.O_RDONLY)
            try:fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
            finally:os.close(fd)
            assert (install/bootstrap.MARKER).is_file()
        return
    return bootstrap.command(args,**kwargs)
bootstrap.bootstrap(op,commit,digest,'v0.1.5',str(install),str(config),str(state),supervisor,policy,run=run)
assert events==['bootstrap-policy.py','provision-host.py','bootstrap-handoff.py']
assert not (install/bootstrap.MARKER).exists()
print('PASS real systemd bootstrap verified and prepared signed release before policy handoff',flush=True)
