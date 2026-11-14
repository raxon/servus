#!/usr/bin/python3 -I
"""Install protected updater files at real paths in a disposable systemd VM."""
import importlib.util
import os
from pathlib import Path
import stat

if os.geteuid()!=0 or not os.uname().nodename.startswith('colima-servus-release-e2e-'):
    raise SystemExit('A disposable release fixture VM is required')
root=Path('/run/servus-release-fixture');source=root/'source'
spec=importlib.util.spec_from_file_location('fixture_install_host',source/'apps/updater/install-host.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
for name in module.MODULES:
    (source/'apps/updater'/name).chmod(0o755 if name=='servus-updater.py' else 0o644)
for name in module.UNITS:(source/'deployment/systemd'/name).chmod(0o644)
module.install(str(source),'/opt/servus','/usr/local/libexec','/etc/systemd/system')
for name in module.MODULES:
    info=(Path('/usr/local/libexec/servus')/name).stat()
    expected=0o755 if name=='servus-updater.py' else 0o644
    assert (info.st_uid,info.st_gid,stat.S_IMODE(info.st_mode))==(0,0,expected)
print('PASS installed exact protected host files at real Linux paths',flush=True)
