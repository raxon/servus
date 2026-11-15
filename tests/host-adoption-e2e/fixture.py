#!/usr/bin/python3 -I
"""Exercise interrupted systemd unit adoption on a disposable Linux VM."""
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
from unittest import mock

if os.geteuid()!=0 or not os.uname().nodename.startswith('colima-servus-adoption-e2e-'):
    raise SystemExit('A disposable adoption fixture VM is required')
root=Path('/run/servus-adoption-fixture')
def load(name):
    spec=importlib.util.spec_from_file_location(name.replace('-','_'),root/(name+'.py'))
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
bundle=load('host-bundle');installer=load('install-host')
names=('servus-fixture-a.service','servus-fixture-b.service')
old_content=b'[Unit]\nDescription=Adoption fixture\n[Service]\nType=oneshot\nRemainAfterExit=yes\nExecStart=/bin/true\n[Install]\nWantedBy=multi-user.target\n'
new_content=old_content.replace(b'ExecStart=/bin/true',b'ExecStartPre=/usr/bin/test -f /usr/local/libexec/servus-adoption-guard\nExecStart=/bin/true')
old={name:(0o644,old_content) for name in names};new={name:(0o644,new_content) for name in names}
directory=Path('/etc/systemd/system');fd=os.open(directory,os.O_RDONLY|os.O_DIRECTORY)
def command(*args):subprocess.run(['/usr/bin/systemctl',*args],check=True,timeout=30,stdout=subprocess.DEVNULL)
try:
    if sys.argv[1]=='prepare':
        Path('/usr/local/libexec').mkdir(mode=0o755,parents=True,exist_ok=True)
        Path('/usr/local/libexec/servus-adoption-guard').write_text('fixture\n')
        for name in names:
            path=directory/name
            if path.exists() or path.is_symlink():raise RuntimeError('Fixture unit already exists')
            path.write_bytes(old_content);path.chmod(0o644)
        command('daemon-reload');command('enable','--now',*names)
        original=os.replace;count=0
        def interrupted(*args,**kwargs):
            global count
            count+=1
            if count==2:raise OSError('Injected interruption')
            return original(*args,**kwargs)
        with mock.patch.object(bundle.os,'replace',side_effect=interrupted):
            try:bundle.apply_unit_adoption(fd,old,new,read_file=installer.read_file,authorize=lambda:None)
            except OSError:pass
            else:raise RuntimeError('Interruption was not injected')
        assert (directory/names[0]).read_bytes()==new_content
        assert (directory/names[1]).read_bytes()==old_content
        print('PASS interrupted after first atomic replacement',flush=True)
    elif sys.argv[1]=='resume':
        for name in names:command('is-active','--quiet',name)
        bundle.apply_unit_adoption(fd,old,new,read_file=installer.read_file,authorize=lambda:None)
        assert all((directory/name).read_bytes()==new_content for name in names)
        command('daemon-reload')
        print('PASS resumed unit adoption after reboot',flush=True)
    elif sys.argv[1]=='verify':
        for name in names:
            command('is-active','--quiet',name)
            assert (directory/name).read_bytes()==new_content
        print('PASS both adopted units started after reboot',flush=True)
    else:raise SystemExit('Unknown fixture phase')
finally:os.close(fd)
