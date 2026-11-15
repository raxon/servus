#!/bin/bash
# Install signed legacy releases and exercise host adoption on a disposable VM.
set -euo pipefail
umask 077
cd "$(dirname "$0")/../.."
for tool in colima docker openssl python3 git node; do
  command -v "$tool" >/dev/null || { printf 'Missing tool: %s\n' "$tool" >&2; exit 1; }
done
[ "$(uname -m)" = arm64 ] || { printf 'This fixture requires an arm64 host.\n' >&2; exit 1; }
base=77ae63cde15fb78cd01afcf1b716ef8e2dd97634
intermediate=e433ff118b6eb1cbf6894a5c895c703be90ffe6a
target=${SERVUS_TEST_TARGET_VERSION:-0.1.19}
target_commit=${SERVUS_TEST_TARGET_REVISION:-$(git rev-parse "v${target}^{commit}")}
port=${SERVUS_TEST_PORT:-45401}
[[ $target =~ ^[0-9]+\.[0-9]+\.[0-9]+$ && $target_commit =~ ^[0-9a-f]{40}$ && $port =~ ^[1-9][0-9]{0,4}$ ]] && ((port<=65535)) || { printf 'Invalid fixture target.\n' >&2; exit 1; }
[[ $(git rev-parse 'v0.1.13^{commit}') == "$base" && $(git rev-parse 'v0.1.14^{commit}') == "$intermediate" ]] || { printf 'Unexpected baseline tags.\n' >&2; exit 1; }
profile="servus-legacy-e2e-$(openssl rand -hex 8)"
context="colima-$profile"
temp_dir=$(mktemp -d /tmp/servus-legacy-e2e.XXXXXXXX)
created=0
cleanup() {
  result=$?
  trap - EXIT
  if [ "$created" = 1 ]; then colima delete "$profile" --force --data >/dev/null || result=1; fi
  python3 - "$temp_dir" <<'PY'
import pathlib, shutil, sys
p=pathlib.Path(sys.argv[1])
if p.parent!=pathlib.Path('/tmp') or not p.name.startswith('servus-legacy-e2e.') or p.is_symlink():raise SystemExit(1)
shutil.rmtree(p)
PY
  exit "$result"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
if docker context inspect "$context" >/dev/null 2>&1; then printf 'Fixture context exists.\n' >&2; exit 1; fi
for path in "$HOME/.colima/$profile" "$HOME/.colima/_lima/colima-$profile" "$HOME/.colima/_lima/_disks/colima-$profile"; do
  if [ -e "$path" ] || [ -L "$path" ]; then printf 'Fixture path exists.\n' >&2; exit 1; fi
done
node -e 'const s=require("node:net").createServer();s.once("error",()=>process.exit(1));s.listen(Number(process.argv[1]),"127.0.0.1",()=>s.close())' "$port" || { printf 'Fixture port is occupied.\n' >&2; exit 1; }
mkdir "$temp_dir/source"
git archive v0.1.13 | tar -xf - -C "$temp_dir/source"
cp "$temp_dir/source/apps/updater/discover-release.py" "$temp_dir/discovery-original.py"
python3 tests/legacy-host-adoption-e2e/pin-discovery.py "$temp_dir/source/apps/updater/discover-release.py" v0.1.13 "$base"
python3 - "$temp_dir/source/scripts/install.sh" <<'PY'
from pathlib import Path
import sys
p=Path(sys.argv[1]);s=p.read_text();old='if [[ -z $source_dir && -z $image_ref && $ref_explicit == 0 && $ref == main ]]; then'
new='if [[ -z $image_ref && $ref_explicit == 0 && $ref == main ]]; then'
if s.count(old)!=1:raise SystemExit('Unsupported legacy installer fixture')
p.write_text(s.replace(old,new,1))
PY
created=1
colima start "$profile" --activate=false --ssh-config=false --cpus 2 --memory 3 --disk 20 --mount none
guest() { colima -p "$profile" ssh -- "$@"; }
guest sh -c 'test ! -e /usr/local/libexec/servus && test ! -e /opt/servus && test ! -e /etc/servus'
guest sudo install -d -m 700 /run/servus-legacy-fixture
COPYFILE_DISABLE=1 tar -cf - -C "$temp_dir" source | guest sudo tar --warning=no-unknown-keyword --no-same-owner -xf - -C /run/servus-legacy-fixture
address=$(guest sh -c "hostname -I | awk '{print \$1}'")
[[ $address =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || { printf 'Fixture VM has no IPv4 address.\n' >&2; exit 1; }
guest sudo bash /run/servus-legacy-fixture/source/scripts/install.sh --source /run/servus-legacy-fixture/source --swarm-advertise-addr "$address" --port "$port" --ingress-port 18080
cp "$temp_dir/discovery-original.py" "$temp_dir/discovery-14.py"
python3 tests/legacy-host-adoption-e2e/pin-discovery.py "$temp_dir/discovery-14.py" v0.1.14 "$intermediate"
guest sudo tee /usr/local/libexec/servus/discover-release.py < "$temp_dir/discovery-14.py" >/dev/null
guest sudo chmod 644 /usr/local/libexec/servus/discover-release.py
node tests/signed-update-e2e/browser.mjs "http://127.0.0.1:$port" 0.1.13 0.1.14 "$base"
old_tag=v0.1.14
if [ "${SERVUS_TEST_INTERRUPTED_ADOPTION:-0}" = 1 ]; then
  recovery_commit=$(git rev-parse 'v0.1.19^{commit}')
  cp "$temp_dir/discovery-original.py" "$temp_dir/discovery-recovery.py"
  python3 tests/legacy-host-adoption-e2e/pin-discovery.py "$temp_dir/discovery-recovery.py" v0.1.19 "$recovery_commit"
  guest sudo tee /usr/local/libexec/servus/discover-release.py < "$temp_dir/discovery-recovery.py" >/dev/null
  guest sudo chmod 644 /usr/local/libexec/servus/discover-release.py
  guest sudo tee /run/servus-legacy-fixture/upgrade.py < tests/legacy-host-adoption-e2e/upgrade.py >/dev/null
  guest sudo /usr/bin/python3 -I -B /run/servus-legacy-fixture/upgrade.py 0.1.19 "$port"
  guest sudo tee /run/servus-legacy-fixture/interrupt.py < tests/legacy-host-adoption-e2e/interrupt.py >/dev/null
  guest sudo /usr/bin/python3 -I -B /run/servus-legacy-fixture/interrupt.py
  old_tag=v0.1.19
fi
cp "$temp_dir/discovery-original.py" "$temp_dir/discovery-target.py"
python3 tests/legacy-host-adoption-e2e/pin-discovery.py "$temp_dir/discovery-target.py" "v$target" "$target_commit"
guest sudo tee /usr/local/libexec/servus/discover-release.py < "$temp_dir/discovery-target.py" >/dev/null
guest sudo chmod 644 /usr/local/libexec/servus/discover-release.py
guest sudo tee /run/servus-legacy-fixture/upgrade.py < tests/legacy-host-adoption-e2e/upgrade.py >/dev/null
printf 'READY legacy host v0.1.14; waiting for signed v%s\n' "$target"
guest sudo /usr/bin/python3 -I -B /run/servus-legacy-fixture/upgrade.py "$target" "$port"
guest sudo /usr/bin/python3 -I - "$target" "$port" "$old_tag" <<'PY'
import os,sqlite3,subprocess,sys
target='v'+sys.argv[1];db=sqlite3.connect('/var/lib/servus-updater/journal.sqlite')
old=db.execute("SELECT o.id FROM operations o JOIN policy_approvals a ON a.operation_id=o.id WHERE o.tag=? AND a.state='superseded'",(sys.argv[3],)).fetchall()
active=db.execute("SELECT o.id,p.staging_path FROM operations o JOIN policy_approvals a ON a.operation_id=o.id JOIN preparations p ON p.operation_id=o.id WHERE o.tag=? AND a.state='active'",(target,)).fetchall()
assert len(old)==1 and len(active)==1,(old,active)
entry=os.path.join(active[0][1],'apps/updater/host-adoption.py')
subprocess.run(['/usr/bin/python3','-I','-B',entry,'--old-operation',old[0][0],'--active-operation',active[0][0]],check=True,timeout=900)
row=db.execute('SELECT status FROM host_stops WHERE operation_id=?',(active[0][0],)).fetchone();assert row==('completed',),row
print('PASS verified legacy host adoption',flush=True)
PY
for unit in servus-updater.service servus-supervisor.service servus-host-update.timer; do guest sudo systemctl is-active --quiet "$unit"; done
colima stop "$profile"
colima start "$profile" --activate=false --ssh-config=false
for unit in servus-updater.service servus-supervisor.service servus-host-update.timer; do guest sudo systemctl is-active --quiet "$unit"; done
guest sudo /usr/bin/python3 -I - "$target" "$port" <<'PY'
import json,sys,time,urllib.error,urllib.request
deadline=time.monotonic()+120
while time.monotonic()<deadline:
    try:
        with urllib.request.urlopen('http://127.0.0.1:'+sys.argv[2]+'/api/v1/health',timeout=10) as response:health=json.load(response)
        if health.get('status')=='ok' and health.get('version')==sys.argv[1]:break
    except (OSError,urllib.error.URLError,ValueError):pass
    time.sleep(2)
else:raise RuntimeError('Panel did not become healthy after reboot')
print('PASS adopted host started after reboot',flush=True)
PY
