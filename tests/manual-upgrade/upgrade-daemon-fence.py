#!/usr/bin/python3 -I
"""Demonstrate Docker daemon requests can survive a killed systemd client."""
import json
import os
import subprocess
import time

if os.geteuid()!=0 or not os.uname().nodename.startswith('colima-servus-upgrade-e2e-'):
    raise SystemExit('Disposable VM required')
def command(*args):
    return subprocess.check_output(args,stderr=subprocess.PIPE,text=True,timeout=30).strip()
cid=command('docker','run','-d','--network=none','--name','daemon-fence-proof','node:24-bookworm-slim',
            'node','-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)")
time.sleep(2)
command('systemd-run','--unit=servus-fence-proof','--property=Type=exec',
        '--property=KillMode=control-group','/usr/bin/docker','stop','--time','10',cid)
deadline=time.monotonic()+10
while time.monotonic()<deadline:
    output=command('docker','events','--since','30s','--until','1s','--filter','container='+cid,'--filter','event=kill','--format','{{.Action}}')
    if output:break
    time.sleep(.2)
else:raise RuntimeError('Daemon did not receive stop')
subprocess.run(['systemctl','stop','servus-fence-proof.service'],check=True,timeout=30)
state=json.loads(command('docker','inspect',cid))[0]['State']
if not state['Running']:raise RuntimeError('Container stopped before client termination')
deadline=time.monotonic()+20
while time.monotonic()<deadline:
    if not json.loads(command('docker','inspect',cid))[0]['State']['Running']:
        print('PASS daemon completed stop after fenced Docker CLI was terminated')
        break
    time.sleep(.5)
else:raise RuntimeError('Daemon did not complete pending stop')
