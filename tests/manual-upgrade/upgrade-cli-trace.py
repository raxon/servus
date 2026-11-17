#!/usr/bin/python3 -I
"""Kill the real CLI immediately after a selected durable marker fsync."""
import ctypes
import json
import os
import pathlib
import signal
import sys

if os.geteuid()!=0 or not os.uname().nodename.startswith('colima-servus-upgrade-e2e-') or os.uname().machine!='aarch64':
    raise SystemExit('Disposable ARM fixture required')
if sys.argv[1:] not in (['ready_to_switch'],['verifying']):raise SystemExit('Invalid fixture phase')
target=sys.argv[1];libc=ctypes.CDLL(None,use_errno=True)
libc.ptrace.restype=ctypes.c_long
class Iovec(ctypes.Structure):
    _fields_=[('base',ctypes.c_void_p),('length',ctypes.c_size_t)]
def trace(request,pid,address=0,data=0):
    result=libc.ptrace(ctypes.c_ulong(request),ctypes.c_int(pid),ctypes.c_void_p(address),ctypes.c_void_p(data))
    if result==-1:
        error=ctypes.get_errno();raise OSError(error,os.strerror(error))
    return result
child=os.fork()
if child==0:
    trace(0,0);os.kill(os.getpid(),signal.SIGSTOP)
    os.execve('/usr/bin/python3',['python3','-I','-B','/run/servus-upgrade-fixture/manual-upgrade.py','--execute'],
              {'PATH':'/usr/bin:/bin','LANG':'C','LC_ALL':'C'})
_,status=os.waitpid(child,0)
if not os.WIFSTOPPED(status):raise RuntimeError('CLI tracing did not start')
trace(0x4200,child,0,1)
marker=pathlib.Path('/opt/servus/manual-upgrade-state.json')
try:
    deliver=0
    while True:
        trace(24,child,0,deliver);deliver=0
        _,status=os.waitpid(child,0)
        if os.WIFEXITED(status) or os.WIFSIGNALED(status):raise RuntimeError('CLI exited before selected checkpoint')
        if not os.WIFSTOPPED(status):raise RuntimeError('Unexpected traced CLI state')
        if os.WSTOPSIG(status)!=(signal.SIGTRAP|0x80):
            deliver=0 if os.WSTOPSIG(status)==signal.SIGTRAP else os.WSTOPSIG(status)
            continue
        registers=(ctypes.c_uint64*34)();iov=Iovec(ctypes.addressof(registers),ctypes.sizeof(registers))
        trace(0x4204,child,1,ctypes.addressof(iov))
        if registers[8]==82 and registers[0]==0:
            try: phase=json.loads(marker.read_text())['phase']
            except (OSError,ValueError,KeyError):continue
            if phase==target:
                os.kill(child,signal.SIGKILL);_,status=os.waitpid(child,0)
                if not os.WIFSIGNALED(status) or os.WTERMSIG(status)!=signal.SIGKILL:raise RuntimeError('CLI was not killed')
                print('PASS real CLI killed after fsynced '+target,flush=True)
                break
finally:
    try:os.kill(child,signal.SIGKILL)
    except ProcessLookupError:pass
