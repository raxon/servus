#!/usr/bin/python3 -I
"""Exercise handoff lock ordering using real systemd units in the disposable VM."""
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace
import uuid

if os.geteuid()!=0 or not os.uname().nodename.startswith('colima-servus-release-e2e-'):
    raise SystemExit('A disposable release fixture VM is required')
base=Path('/usr/local/libexec/servus')
sys.path.insert(0,str(base))
import supervisor

def load(name,filename):
    spec=importlib.util.spec_from_file_location(name,base/filename)
    module=importlib.util.module_from_spec(spec);sys.modules[name]=module;spec.loader.exec_module(module);return module

handoff=load('fixture_handoff','bootstrap-handoff.py')
updater=load('fixture_updater','servus-updater.py')
policy=load('fixture_policy','runtime-policy.py')
root=Path('/run/servus-release-fixture');state=root/'handoff-state';state.mkdir(mode=0o700)
install=Path('/opt/servus'); assert (install/'install.lock').is_file()
units=Path('/etc/systemd/system')
for name in ('servus-supervisor.service','servus-updater.service'):
    path=units/name
    if path.exists() or path.is_symlink():raise SystemExit('Fixture service already exists')
    path.write_text('[Unit]\nDescription=Isolated Servus handoff test\n[Service]\nType=oneshot\nRemainAfterExit=yes\nExecStart=/usr/bin/flock -n /opt/servus/install.lock /bin/true\n[Install]\nWantedBy=multi-user.target\n')
    path.chmod(0o644)
subprocess.run(['/usr/bin/systemctl','daemon-reload'],check=True,timeout=30)
journal=updater.Journal(state)
try:
    op,attempt,prep=(str(uuid.uuid4()) for _ in range(3));nonce='c'*64;digest='sha256:'+'b'*64
    journal.db.execute('CREATE TABLE policy_approvals(operation_id TEXT,state TEXT,policy_path TEXT,accepted_env_path TEXT,source_env_path TEXT)')
    journal.db.execute('INSERT INTO operations(id,commit_sha,digest,tag,status,attempt_id,attempt_nonce,config_digest) VALUES(?,?,?,?,?,?,?,?)',(op,'a'*40,digest,'v1.0.0','verified',attempt,nonce,digest))
    journal.db.execute('INSERT INTO preparations VALUES(?,?,?,?,?,?)',(op,attempt,nonce,prep,'prepared','/root/stage'))
    journal.db.execute('INSERT INTO policy_approvals VALUES(?,?,?,?,?)',(op,'active','/root/policy','/root/snapshot','/root/env'))
    approved=SimpleNamespace(install_dir=str(install),control_dir='/root/control',updater_dir='/run/servus-updater/control')
    daemon=SimpleNamespace(resolve_active_policy=lambda *_:('/root/policy','/root/snapshot',approved))
    def launch(*_args,**_kwargs):
        assert (install/handoff.MARKER).is_file()
        journal.db.execute("UPDATE preparations SET status='completed' WHERE operation_id=?",(op,))
    initial=SimpleNamespace(check_supervisor=lambda *_:None,check_updater=lambda *_:None,launch=launch,InitialGenerationError=ValueError)
    supervisor.RuntimePolicy=SimpleNamespace
    handoff.handoff(journal,op,'/root/env',str(state),supervisor,daemon,policy,initial,object(),object(),timeout=30)
    assert not (install/handoff.MARKER).exists()
    for name in ('servus-supervisor.service','servus-updater.service'):
        subprocess.run(['/usr/bin/systemctl','is-active','--quiet',name],check=True,timeout=10)
    print('PASS real systemd starts services after installation lock is released',flush=True)
finally:
    journal.close()
