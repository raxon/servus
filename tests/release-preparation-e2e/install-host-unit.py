#!/usr/bin/python3 -I
"""Install updater files in isolated fixture paths on a real systemd host."""
import fcntl
import importlib.util
import os
from pathlib import Path
import stat

if os.geteuid()!=0 or not os.uname().nodename.startswith('colima-servus-release-e2e-'):
    raise SystemExit('A disposable release fixture VM is required')
root=Path('/run/servus-release-fixture');source=root/'source';libexec=root/'test-libexec';units=root/'test-units'
for path in (libexec,units):path.mkdir(mode=0o755);path.chmod(0o755)
spec=importlib.util.spec_from_file_location('fixture_install_host',source/'apps/updater/install-host.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
# The production source extractor normalizes file modes after archive extraction.
for name in module.MODULES:
    (source/'apps/updater'/name).chmod(0o755 if name=='servus-updater.py' else 0o644)
for name in module.UNITS:
    (source/'deployment/systemd'/name).chmod(0o644)
held=os.open('/opt/servus/install.lock',os.O_RDONLY)
try:
    fcntl.flock(held,fcntl.LOCK_EX|fcntl.LOCK_NB)
    args=(str(source),'/opt/servus',str(libexec),str(units))
    module.install(*args,inherited_lock=held)
    inode=(libexec/'servus/supervisor.py').stat().st_ino
    module.install(*args,inherited_lock=held)
    assert (libexec/'servus/supervisor.py').stat().st_ino==inode
    assert {p.name for p in (libexec/'servus').iterdir()}==set(module.MODULES)
    assert {p.name for p in units.iterdir()}==set(module.UNITS)
    for name in module.UNITS:
        info=(units/name).stat()
        assert (info.st_uid,info.st_gid,stat.S_IMODE(info.st_mode))==(0,0,0o644)
    contender=os.open('/opt/servus/install.lock',os.O_RDONLY)
    try:
        try:fcntl.flock(contender,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:pass
        else:raise AssertionError('Installer lock was released')
    finally:os.close(contender)
finally:os.close(held)
print('PASS root host files install safely and idempotently on systemd Linux',flush=True)
