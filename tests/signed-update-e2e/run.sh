#!/bin/bash
# Exercise a published signed release on a disposable systemd VM.
set -euo pipefail
umask 077
cd "$(dirname "$0")/../.."
for tool in colima docker openssl python3 git node; do
  command -v "$tool" >/dev/null || { printf 'Missing tool: %s\n' "$tool" >&2; exit 1; }
done
[ "$(uname -m)" = arm64 ] || { printf 'This fixture requires an arm64 host.\n' >&2; exit 1; }
base_version=${SERVUS_TEST_BASE_VERSION:-0.1.52}
target_version=${SERVUS_TEST_TARGET_VERSION:-0.1.53}
base_revision=${SERVUS_TEST_BASE_REVISION:-8f137758abdb7dbece6657201c0667bbb99d1918}
target_revision=${SERVUS_TEST_TARGET_REVISION:-b21b37119145e7cf5e0bc38680f3044814adb27c}
base_schema=${SERVUS_TEST_BASE_SCHEMA:-5}
target_schema=${SERVUS_TEST_TARGET_SCHEMA:-8}
test_port=${SERVUS_TEST_PORT:-43899}
keep_failed=${SERVUS_SIGNED_UPDATE_KEEP_FAILED:-0}
[[ $keep_failed == 0 || $keep_failed == 1 ]] || { printf 'Invalid fixture retention flag.\n' >&2; exit 1; }
[[ $base_version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ && $target_version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ && $base_revision =~ ^[0-9a-f]{40}$ && $target_revision =~ ^[0-9a-f]{40}$ && $base_schema =~ ^[0-9]{1,2}$ && $target_schema =~ ^[0-9]{1,2}$ ]] || { printf 'Invalid test release identity.\n' >&2; exit 1; }
[[ $test_port =~ ^[1-9][0-9]{0,4}$ ]] && ((test_port <= 65535)) || { printf 'Invalid test port.\n' >&2; exit 1; }
profile="servus-update-e2e-$(openssl rand -hex 8)"
context="colima-$profile"
temp_dir=$(mktemp -d /tmp/servus-update-e2e.XXXXXXXX)
created=0
report_dir="$PWD/artifacts/signed-update"
report_path="$report_dir/$profile.json"
cleanup() {
  result=$?
  trap - EXIT
  if [ "$created" = 1 ]; then
    if [ "$result" != 0 ]; then
      mkdir -p "$report_dir"
      colima -p "$profile" ssh -- sudo python3 -I /root/servus-update-fixture/verify.py diagnostics > "$report_dir/$profile-diagnostics.json" 2>/dev/null || true
    fi
    if [ "$result" != 0 ] && [ "$keep_failed" = 1 ]; then
      printf 'Retained owned failed fixture for diagnosis: %s\n' "$profile" >&2
    elif colima delete "$profile" --force --data >/dev/null; then
      if [ -f "$report_path" ]; then
        python3 - "$report_path" <<'PY'
import json,pathlib,sys
p=pathlib.Path(sys.argv[1]); value=json.loads(p.read_text())
value['cleanup']={'status':'completed','ownedVmDeleted':True}
p.write_text(json.dumps(value,indent=2)+'\n')
PY
      fi
    else result=1; fi
  fi
  python3 - "$temp_dir" <<'PY'
import pathlib, shutil, sys
p = pathlib.Path(sys.argv[1])
if p.parent != pathlib.Path('/tmp') or not p.name.startswith('servus-update-e2e.') or p.is_symlink(): raise SystemExit(1)
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
node -e 'const s=require("node:net").createServer();s.once("error",()=>process.exit(1));s.listen(Number(process.argv[1]),"127.0.0.1",()=>s.close())' "$test_port" || { printf 'Test port is occupied.\n' >&2; exit 1; }
[[ $(git rev-parse "v$base_version^{commit}") == "$base_revision" && $(git rev-parse "v$target_version^{commit}") == "$target_revision" ]] || { printf 'Frozen release tags do not match the expected commits.\n' >&2; exit 1; }
mkdir "$temp_dir/source"
git archive "$base_revision" | tar -xf - -C "$temp_dir/source"
cp "$temp_dir/source/apps/updater/discover-release.py" "$temp_dir/discovery-original.py"
python3 tests/signed-update-e2e/pin-baseline.py "$temp_dir/source" "v$base_version"
for version in "$base_version" "$target_version"; do
  python3 -I apps/updater/discover-release.py --release "v$version" > "$temp_dir/release-$version.json"
done
python3 - "$temp_dir" "$base_version" "$base_revision" "$target_version" "$target_revision" <<'PY'
import json,pathlib,sys
root=pathlib.Path(sys.argv[1])
for version,commit in ((sys.argv[2],sys.argv[3]),(sys.argv[4],sys.argv[5])):
    value=json.loads((root/f'release-{version}.json').read_text())
    if value.get('status')!='candidate' or value.get('tag')!='v'+version or value.get('commit')!=commit:
        raise SystemExit('The published candidate differs from the frozen release identity')
print('Frozen both published release commits and registry manifest digests',flush=True)
PY
created=1
colima start "$profile" --activate=false --ssh-config=false --cpus 2 --memory 3 --disk 20 --mount none
guest() { colima -p "$profile" ssh -- "$@"; }
guest sh -c 'test "$(uname -m)" = aarch64 && test ! -e /usr/local/libexec/servus && test ! -e /opt/servus && test ! -e /etc/servus'
guest sudo install -d -m 700 /root/servus-update-fixture
COPYFILE_DISABLE=1 tar --no-xattrs --no-acls --no-fflags -cf - -C "$temp_dir" source | guest sudo tar --warning=no-unknown-keyword --no-same-owner -xf - -C /root/servus-update-fixture
for version in "$base_version" "$target_version"; do
  guest sudo tee "/root/servus-update-fixture/release-$version.json" < "$temp_dir/release-$version.json" >/dev/null
done
guest sudo tee /root/servus-update-fixture/verify.py < tests/signed-update-e2e/verify.py >/dev/null
guest sudo tee /root/servus-update-fixture/security.py < tests/signed-update-e2e/security.py >/dev/null
if [ -n "${SERVUS_TEST_RELEASE_RUN:-}" ]; then
  [[ $SERVUS_TEST_RELEASE_RUN =~ ^[0-9]+$ ]] || { printf 'Invalid release run ID.\n' >&2; exit 1; }
  command -v gh >/dev/null || { printf 'Missing tool: gh\n' >&2; exit 1; }
  gh run watch "$SERVUS_TEST_RELEASE_RUN" --exit-status --interval 20
fi
address=$(guest sh -c "hostname -I | awk '{print \$1}'")
[[ $address =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || { printf 'VM has no usable IPv4 address.\n' >&2; exit 1; }
guest sudo env SERVUS_HOST_DOMAINS_AUTOMATIC=false SERVUS_HOST_DOMAINS_API_URL= bash /root/servus-update-fixture/source/scripts/install.sh --source /root/servus-update-fixture/source --swarm-advertise-addr "$address" --port "$test_port" --ingress-port 18080
# Discovery pinning is only needed for initial installation. Restore the exact
# baseline host component before the normal beta-channel update is requested.
guest sudo tee /usr/local/libexec/servus/discover-release.py < "$temp_dir/discovery-original.py" >/dev/null
guest sudo chmod 644 /usr/local/libexec/servus/discover-release.py
for unit in servus-supervisor.service servus-updater.service servus-updater-socket.service; do
  guest sudo systemctl is-active --quiet "$unit"
  guest sudo systemctl is-enabled --quiet "$unit"
done
guest sudo python3 -I /root/servus-update-fixture/verify.py baseline "$base_version" "$base_schema" "$test_port"
SERVUS_SIGNED_UPDATE_PROOF="$temp_dir/proof.json" node tests/signed-update-e2e/browser.mjs "http://127.0.0.1:$test_port" "$base_version" "$target_version" "$base_revision" "$target_revision"
guest sudo tee /root/servus-update-fixture/proof.json < "$temp_dir/proof.json" >/dev/null
guest sudo /usr/bin/python3 -I - "$target_version" <<'PY'
import sqlite3, sys, time
target='v'+sys.argv[1]
deadline=time.monotonic()+240
while time.monotonic()<deadline:
    with sqlite3.connect('/var/lib/servus-updater/journal.sqlite') as db:
        tables={row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if {'host_stops','host_preparations','host_switches'} <= tables:
            rows=db.execute("SELECT h.status,p.status,s.phase FROM operations o JOIN host_stops h ON h.operation_id=o.id LEFT JOIN host_preparations p ON p.operation_id=o.id LEFT JOIN host_switches s ON s.operation_id=o.id WHERE o.tag=?",(target,)).fetchall()
            if rows==[('completed','completed','completed')]:break
            if len(rows)>1 or any('recovery_required' in row or 'rolled_back' in row for row in rows):
                raise RuntimeError('Host update requires recovery: '+repr(rows))
    time.sleep(2)
else:raise RuntimeError('Host update did not complete')
print('PASS verified host generation was exchanged and started',flush=True)
PY
for unit in servus-updater.service servus-supervisor.service servus-host-update.timer; do
  guest sudo systemctl is-active --quiet "$unit"
done
guest sudo python3 -I /root/servus-update-fixture/verify.py target "$target_version" "$target_schema" "$test_port"
guest sudo python3 -I /root/servus-update-fixture/security.py "$test_port"
colima stop "$profile"
colima start "$profile" --activate=false --ssh-config=false
guest sudo python3 -I /root/servus-update-fixture/verify.py reboot "$target_version" "$target_schema" "$test_port"
mkdir -p "$report_dir"
guest sudo cat /root/servus-update-fixture/result.json > "$report_path"
printf 'PASS real update from v%s to v%s in the browser\n' "$base_version" "$target_version"
