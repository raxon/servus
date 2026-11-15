#!/usr/bin/python3 -I
"""Interrupt a signed adoption before exchange and recover its services."""
import os
import signal
import sqlite3
import subprocess
import time

if os.geteuid()!=0 or not os.uname().nodename.startswith('colima-servus-legacy-e2e-'):
    raise SystemExit('A disposable legacy fixture VM is required')
path='/var/lib/servus-updater/journal.sqlite'
with sqlite3.connect(path) as db:
    old=db.execute("SELECT o.id FROM operations o JOIN policy_approvals a ON a.operation_id=o.id WHERE o.tag='v0.1.14' AND a.state='superseded'").fetchall()
    active=db.execute("SELECT o.id,p.staging_path FROM operations o JOIN policy_approvals a ON a.operation_id=o.id JOIN preparations p ON p.operation_id=o.id WHERE o.tag='v0.1.19' AND a.state='active'").fetchall()
assert len(old)==1 and len(active)==1,(old,active)
operation,stage=active[0]
entry=os.path.join(stage,'apps/updater/host-adoption.py')
process=subprocess.Popen(['/usr/bin/python3','-I','-B',entry,'--old-operation',old[0][0],'--active-operation',operation])
deadline=time.monotonic()+180;interrupted=False
while time.monotonic()<deadline and process.poll() is None:
    with sqlite3.connect('file:'+path+'?mode=ro',uri=True,timeout=1) as db:
        if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='host_stops'").fetchone():
            row=db.execute('SELECT status FROM host_stops WHERE operation_id=?',(operation,)).fetchone()
            if row and row[0]=='stopping':
                os.kill(process.pid,signal.SIGKILL);interrupted=True;break
    time.sleep(.005)
if not interrupted:
    process.terminate();process.wait(timeout=10)
    raise RuntimeError('Could not interrupt the intended adoption stage')
process.wait(timeout=10)
# The journal can become visible before the adoption process invokes systemctl.
# Explicitly stop the updater to reproduce the interrupted production state.
subprocess.run(['/usr/bin/systemctl','stop','servus-updater.service'],check=True,timeout=180)
if subprocess.run(['/usr/bin/systemctl','is-active','--quiet','servus-updater.service']).returncode==0:
    raise RuntimeError('Updater did not stop after interruption')
with sqlite3.connect(path) as db:
    tables={row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    if 'host_preparations' in tables and db.execute('SELECT 1 FROM host_preparations WHERE operation_id=?',(operation,)).fetchone():
        raise RuntimeError('Interruption occurred after preparation')
for unit in ('servus-host-recovery.service','servus-host-recovery-finish.service'):
    subprocess.run(['/usr/bin/systemctl','start',unit],check=True,timeout=180)
with sqlite3.connect(path) as db:
    row=db.execute('SELECT status FROM host_stops WHERE operation_id=?',(operation,)).fetchone()
    assert row==('completed',),row
subprocess.run(['/usr/bin/systemctl','is-active','--quiet','servus-updater.service'],check=True)
print('PASS interrupted legacy adoption recovered before host exchange',flush=True)
