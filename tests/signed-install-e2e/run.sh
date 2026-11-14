#!/bin/bash
# Exercise a published signed release on a disposable systemd VM.
set -euo pipefail
umask 077
cd "$(dirname "$0")/../.."
for tool in colima docker openssl python3 git; do
  command -v "$tool" >/dev/null || { printf 'Missing tool: %s\n' "$tool" >&2; exit 1; }
done
[ "$(uname -m)" = arm64 ] || { printf 'This fixture requires an arm64 host.\n' >&2; exit 1; }
profile="servus-signed-e2e-$(openssl rand -hex 8)"
context="colima-$profile"
temp_dir=$(mktemp -d /tmp/servus-signed-e2e.XXXXXXXX)
created=0
cleanup() {
  result=$?
  trap - EXIT
  if [ "$created" = 1 ]; then colima delete "$profile" --force --data >/dev/null || result=1; fi
  python3 - "$temp_dir" <<'PY'
import pathlib, shutil, sys
p = pathlib.Path(sys.argv[1])
if p.parent != pathlib.Path('/tmp') or not p.name.startswith('servus-signed-e2e.') or p.is_symlink(): raise SystemExit(1)
shutil.rmtree(p)
PY
  exit "$result"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
if docker context inspect "$context" >/dev/null 2>&1; then printf 'Test context already exists.\n' >&2; exit 1; fi
for path in "$HOME/.colima/$profile" "$HOME/.colima/_lima/colima-$profile" "$HOME/.colima/_lima/_disks/colima-$profile"; do
  if [ -e "$path" ] || [ -L "$path" ]; then printf 'Test profile path already exists.\n' >&2; exit 1; fi
done
git show HEAD:scripts/install.sh > "$temp_dir/install.sh"
created=1
colima start "$profile" --activate=false --ssh-config=false --cpus 2 --memory 3 --disk 20 --mount none
guest() { colima -p "$profile" ssh -- "$@"; }
guest sh -c 'test "$(uname -m)" = aarch64 && test ! -e /usr/local/libexec/servus && test ! -e /opt/servus && test ! -e /etc/servus'
guest sudo install -d -m 700 /run/servus-signed-fixture
guest sudo tee /run/servus-signed-fixture/install.sh < "$temp_dir/install.sh" > /dev/null
guest sudo chmod 700 /run/servus-signed-fixture/install.sh
if [ -n "${SERVUS_TEST_RELEASE_RUN:-}" ]; then
  [[ $SERVUS_TEST_RELEASE_RUN =~ ^[0-9]+$ ]] || { printf 'Invalid release run ID.\n' >&2; exit 1; }
  command -v gh >/dev/null || { printf 'Missing tool: gh\n' >&2; exit 1; }
  gh run watch "$SERVUS_TEST_RELEASE_RUN" --exit-status --interval 20
fi
address=$(guest sh -c "hostname -I | awk '{print \$1}'")
[[ $address =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || { printf 'VM has no usable IPv4 address.\n' >&2; exit 1; }
guest sudo bash /run/servus-signed-fixture/install.sh --swarm-advertise-addr "$address" --ingress-port 18080
for unit in servus-supervisor.service servus-updater.service servus-updater-socket.service; do
  guest sudo systemctl is-active --quiet "$unit"
  guest sudo systemctl is-enabled --quiet "$unit"
done
guest sudo /usr/bin/python3 -I - <<'PY'
import json, time, urllib.request
base='http://127.0.0.1:4180'
with urllib.request.urlopen(base+'/api/v1/health',timeout=10) as response:
    health=json.load(response)
assert health.get('status')=='ok' and health.get('version')=='0.1.6', health
request=urllib.request.Request(base+'/api/v1/setup',data=json.dumps({'email':'signed-e2e@example.test','password':'signed-e2e-passphrase'}).encode(),headers={'Content-Type':'application/json','Origin':base})
with urllib.request.urlopen(request,timeout=20) as response:
    cookie=response.headers.get('Set-Cookie')
    assert response.status==200 and cookie
request=urllib.request.Request(base+'/api/v1/auth/session',headers={'Cookie':cookie.split(';',1)[0]})
with urllib.request.urlopen(request,timeout=10) as response:
    assert json.load(response)['user']['email']=='signed-e2e@example.test'
request=urllib.request.Request(base+'/api/v1/updates',headers={'Cookie':cookie.split(';',1)[0]})
with urllib.request.urlopen(request,timeout=10) as response:
    assert json.load(response)=={'applyAvailable':True,'verificationStatusConfigured':True}
deadline=time.monotonic()+60
while True:
    request=urllib.request.Request(base+'/api/v1/updates/discovery',headers={'Cookie':cookie.split(';',1)[0]})
    with urllib.request.urlopen(request,timeout=10) as response:
        discovery=json.load(response)['discovery']
    if discovery.get('status') != 'checking': break
    assert time.monotonic() < deadline, discovery
    time.sleep(2)
assert discovery.get('current')=='v0.1.6' and discovery.get('status') in ('no_newer_version','ahead'), discovery
print('PASS signed first installation, account setup, session and update discovery',flush=True)
PY
printf 'PASS real supervised first installation on disposable systemd VM\n'
