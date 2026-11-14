#!/usr/bin/python3 -I
"""Test the actual verification-only systemd unit inside the disposable VM."""
import json
import os
from pathlib import Path
import socket
import stat
import subprocess
import time
import uuid

if os.geteuid() != 0 or not os.uname().nodename.startswith('colima-servus-release-e2e-'):
    raise SystemExit('A disposable release fixture VM is required')
control = Path('/run/servus-updater/control')
info = control.lstat()
if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_gid != 65534 or stat.S_IMODE(info.st_mode) != 0o710:
    raise SystemExit('Unexpected old fixture socket directory')
control.rmdir()

def command(*arguments, timeout=30):
    return subprocess.run(arguments, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          cwd='/', env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LANG':'C'}, timeout=timeout, check=True)

client = '''import json,socket,sys\ns=socket.socket(socket.AF_UNIX);s.settimeout(5);s.connect(sys.argv[1]);s.sendall((sys.argv[2]+"\\n").encode());b=bytearray()\nwhile not b.endswith(b"\\n"):\n c=s.recv(4096)\n if not c:break\n b.extend(c)\nsys.stdout.buffer.write(b)'''
try:
    command('/usr/bin/systemctl','daemon-reload')
    command('/usr/bin/systemctl','start','servus-updater-socket.service')
    command('/usr/bin/systemctl','start','servus-updater-bootstrap.service')
    path = control/'updater.sock'
    for _ in range(100):
        if path.is_socket(): break
        time.sleep(.1)
    else: raise RuntimeError('Bootstrap updater socket did not start')
    def request(action):
        payload=json.dumps({'version':1,'action':action,'operationId':str(uuid.uuid4())},separators=(',',':'))
        result=command('/usr/bin/setpriv','--reuid=1000','--regid=1000','--clear-groups',
                       '/usr/bin/python3','-I','-c',client,str(path),payload)
        return json.loads(result.stdout)
    if request('status') != {'ok':False,'error':'not_found'}: raise RuntimeError('Unexpected updater status')
    if request('apply') != {'ok':False,'error':'unavailable'}: raise RuntimeError('Bootstrap updater allowed apply')
    command('/usr/bin/systemctl','is-active','--quiet','servus-updater-bootstrap.service')
    print('PASS real systemd bootstrap unit, socket identity, and disabled apply',flush=True)
finally:
    subprocess.run(['/usr/bin/systemctl','stop','servus-updater-bootstrap.service'],stdin=subprocess.DEVNULL,
                   stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=30,check=False)
