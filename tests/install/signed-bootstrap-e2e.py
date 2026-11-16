#!/usr/bin/env python3
"""Exercise the signed installer bridge in a disposable, networkless container."""
import json
import os
from pathlib import Path
import subprocess
import tempfile

if os.geteuid() != 0 or not Path('/.dockerenv').is_file():
    raise SystemExit('Run this fixture only as root in a disposable Docker container')
for path in ('/opt/servus', '/etc/servus', '/usr/local/libexec/servus'):
    if os.path.lexists(path):
        raise SystemExit('Fixture paths must not already exist')

root = Path(tempfile.mkdtemp(prefix='servus-bootstrap-', dir='/root'))
source = root / 'source/apps/updater'
source.mkdir(parents=True)
Path('/opt/servus').mkdir(mode=0o700)
Path('/etc/servus').mkdir(mode=0o700)
data = root / 'data'
data.mkdir(mode=0o700)
os.chown(data, 1000, 1000)
lock = Path('/opt/servus/install.lock')
lock.touch(mode=0o600)
trace = root / 'trace'
(source / 'discover-release.py').write_text('import os\nprint(os.environ["FIXTURE_CANDIDATE"])\n')
(source / 'install-host.py').write_text('''import os, pathlib, shutil
root=pathlib.Path(os.environ['FIXTURE_ROOT']); target=pathlib.Path('/usr/local/libexec/servus')
target.mkdir(parents=True)
for name in ('install-gh.py','provision-host.py','provision-verifier-group.py','bootstrap-initial.py'):
    shutil.copyfile(root / name, target / name)
with open(root/'trace','a') as stream: stream.write('install-host\\n')
''')
common = '''import os, pathlib, sys
root=pathlib.Path(os.environ['FIXTURE_ROOT'])
with open(root/'trace','a') as stream: stream.write(pathlib.Path(__file__).name + ' ' + ' '.join(sys.argv[1:]) + '\\n')
'''
for name in ('install-gh.py', 'provision-host.py', 'provision-verifier-group.py'):
    (root / name).write_text(common)
(root / 'bootstrap-initial.py').write_text(common + '''
import fcntl, json, stat
fd=9
assert os.fstat(fd).st_ino == os.stat('/opt/servus/install.lock').st_ino
other=os.open('/opt/servus/install.lock', os.O_RDONLY)
try:
    try: fcntl.flock(other, fcntl.LOCK_EX|fcntl.LOCK_NB)
    except BlockingIOError: pass
    else: raise AssertionError('Installer lock was released')
finally: os.close(other)
path=pathlib.Path('/etc/servus/servus.env'); info=path.stat()
assert (info.st_uid,info.st_gid,stat.S_IMODE(info.st_mode),info.st_nlink)==(0,0,0o600,1)
values=dict(line.split('=',1) for line in path.read_text().splitlines())
assert values['SERVUS_IMAGE']=='ghcr.io/raxon/servus@sha256:'+'b'*64
assert values['SERVUS_SOURCE_REF']=='v0.1.6'
assert values['SERVUS_DATA_DIR']==str(root/'data')
assert '--take-install-lock-fd' in sys.argv
print('PASS signed bootstrap bridge retains lock and publishes configuration')
''')
script = '''set -Eeuo pipefail
source /workspace/scripts/signed-bootstrap.sh
fail() { printf 'Servus: %s\\n' "$*" >&2; return 1; }
log() { printf 'Servus: %s\\n' "$*"; }
cleanup_staging() { rm -rf -- "$servus_staging"; }
install_dir=/opt/servus config_dir=/etc/servus data_dir="$FIXTURE_ROOT/data"
config_file=/etc/servus/servus.env
port=4180 ingress_port=80 socket_gid=999 bind_address=127.0.0.1
public_url=http://localhost:4180 allowed_origins=http://localhost:4180 secure_cookies=false proxy_secret=
servus_staging="$FIXTURE_ROOT/staging"; mkdir "$servus_staging"
exec 9>/opt/servus/install.lock; flock -n 9
bootstrap_signed_install "$FIXTURE_ROOT/source" "$servus_staging"
'''

def run(candidate):
    env={**os.environ, 'FIXTURE_ROOT':str(root), 'FIXTURE_CANDIDATE':candidate}
    return subprocess.run(['/bin/bash','-c',script], env=env, text=True, capture_output=True, timeout=30)

invalid = [
    '{"status":"candidate","status":"candidate"}',
    json.dumps({'status':'release_pending','verified':False,'tag':'v0.1.6','commit':'a'*40,'digest':'sha256:'+'b'*64}),
    json.dumps({'status':'candidate','verified':True,'tag':'v0.1.6','commit':'a'*40,'digest':'sha256:'+'b'*64}),
    json.dumps({'status':'candidate','verified':False,'tag':'v0.1.5','commit':'a'*40,'digest':'sha256:32f7cccf97841716ffae6bbff4f4234d5c3575e3b3ad9daa61dcf5afba72a13c'}),
]
existing = Path('/etc/servus/servus.env')
existing.write_text('existing configuration\n')
result = run('{}')
assert result.returncode != 0 and 'requires a verified migration' in result.stderr
assert existing.read_text() == 'existing configuration\n'
existing.unlink()
(root / 'staging').rmdir()
item = data / 'panel.sqlite'
item.write_text('existing data')
result = run('{}')
assert result.returncode != 0 and 'Existing data requires a verified migration' in result.stderr
assert item.read_text() == 'existing data'
item.unlink()
(root / 'staging').rmdir()
for candidate in invalid:
    result = run(candidate)
    assert result.returncode != 0 and 'No compatible signed release candidate' in result.stderr, (result.stdout, result.stderr)
    assert not Path('/usr/local/libexec/servus').exists() and not Path('/etc/servus/servus.env').exists()
    (root / 'staging' / 'release-candidate.json').unlink()
    (root / 'staging').rmdir()
valid=json.dumps({'status':'candidate','verified':False,'tag':'v0.1.6','commit':'a'*40,'digest':'sha256:'+'b'*64})
result=run(valid)
assert result.returncode == 0, (result.stdout,result.stderr)
assert 'SERVUS_HOST_DOMAINS_API_URL=https://api.servus.run\n' in Path('/etc/servus/servus.env').read_text()
assert 'SERVUS_HOST_DOMAINS_AUTOMATIC=true\n' in Path('/etc/servus/servus.env').read_text()
assert 'PASS signed bootstrap bridge' in result.stdout
lines=trace.read_text().splitlines()
assert [line.split()[0] for line in lines] == ['install-host','install-gh.py','provision-host.py','provision-host.py','provision-verifier-group.py','bootstrap-initial.py'], lines
assert not (root/'staging').exists()
print(result.stdout.strip())
print('PASS existing data and malformed, pending or incompatible candidates are preserved or rejected before host installation')
