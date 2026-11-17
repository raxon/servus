#!/usr/bin/python3 -I
"""Test marker and Docker restart behavior on a disposable native ARM VM."""
import importlib.util
import json
import os
import pathlib
import signal
import subprocess
import time

if os.geteuid()!=0 or not os.uname().nodename.startswith('colima-servus-upgrade-e2e-'):
    raise SystemExit('Disposable test VM required')
spec=importlib.util.spec_from_file_location('manual_upgrade','/run/servus-upgrade-fixture/manual-upgrade.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
root=pathlib.Path('/run/servus-upgrade-fixture');marker=root/'manual-upgrade-state.json'
def docker(*args):
    return subprocess.check_output(['/usr/bin/docker',*args],stderr=subprocess.PIPE,text=True,timeout=90).strip()
names=['fault-api','fault-worker','fault-agent']
for name in names:
    docker('run','-d','--name',name,'--restart=unless-stopped','--network=none','nginx:alpine')
operation='a'*32
module.write_new(marker,(json.dumps({'phase':'intent'})+'\n').encode())
child=os.fork()
if child==0:
    module.set_marker(marker,operation,'preventing_restart')
    for name in names:docker('update','--restart=no',name)
    module.set_marker(marker,operation,'verifying')
    os.kill(os.getpid(),signal.SIGKILL)
_,status=os.waitpid(child,0)
if not os.WIFSIGNALED(status) or os.WTERMSIG(status)!=signal.SIGKILL:raise RuntimeError('Fault not injected')
if json.loads(marker.read_text())['phase']!='verifying':raise RuntimeError('Marker missing')
subprocess.run(['/usr/bin/systemctl','restart','docker'],check=True,timeout=90)
deadline=time.monotonic()+90
while True:
    try:docker('info');break
    except subprocess.SubprocessError:
        if time.monotonic()>deadline:raise
        time.sleep(1)
for name in names:
    item=json.loads(docker('inspect',name))[0]
    if item['State']['Running'] or item['HostConfig']['RestartPolicy']['Name']!='no':raise RuntimeError('Unexpected restart')
print('PASS native ARM marker and restart policy after SIGKILL and Docker restart')
