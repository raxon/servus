#!/bin/bash
# Run a real signed-release preparation on a disposable Linux VM.
set -euo pipefail
umask 077
cd "$(dirname "$0")/../.."
for tool in colima docker curl shasum openssl tar git python3; do
  command -v "$tool" >/dev/null || { printf 'Missing tool: %s\n' "$tool" >&2; exit 1; }
done
[ "$(uname -m)" = arm64 ] || { printf 'This fixture requires an arm64 host.\n' >&2; exit 1; }
commit=$(git rev-parse --verify 'v0.1.5^{commit}')
[ "$commit" = 7c2013b081b4c26244a52c75b51e6ca2226c8a5a ] || { printf 'Unexpected release tag.\n' >&2; exit 1; }
profile="servus-release-e2e-$(openssl rand -hex 8)"
context="colima-$profile"
temp_dir=$(mktemp -d /tmp/servus-release-e2e.XXXXXXXX)
created=0
cleanup() {
  result=$?
  trap - EXIT
  if [ "$created" = 1 ]; then
    colima delete "$profile" --force --data >/dev/null || result=1
  fi
  python3 - "$temp_dir" <<'PY'
import os, pathlib, shutil, sys
p=pathlib.Path(sys.argv[1])
if p.parent != pathlib.Path('/tmp') or not p.name.startswith('servus-release-e2e.') or p.is_symlink(): raise SystemExit(1)
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
existing=$(colima list --json | python3 -c 'import json,sys; print(int(any(json.loads(line).get("name")==sys.argv[1] for line in sys.stdin if line.strip())))' "$profile")
[ "$existing" = 0 ] || { printf 'Test profile already exists.\n' >&2; exit 1; }
mkdir "$temp_dir/tag" "$temp_dir/head"
git archive v0.1.5 | tar -xf - -C "$temp_dir/tag"
git archive HEAD | tar -xf - -C "$temp_dir/head"
release_mode=head
if [ "${SERVUS_TEST_WORKTREE:-0}" = 1 ]; then
  release_mode=worktree
  for component in extract-install.py prepare-verified.py provision-host.py bootstrap-handoff.py bootstrap-initial.py provision-verifier-group.py provision-socket.py install-gh.py install-host.py verification-executor.py verify-release.py; do
    cp "apps/updater/$component" "$temp_dir/head/apps/updater/$component"
  done
fi
python3 - "$temp_dir/tag" > "$temp_dir/manifest.json" <<'PY'
import hashlib,json,pathlib,sys
root=pathlib.Path(sys.argv[1]); out={}
for line in (root/'scripts/release-install-files.txt').read_text().splitlines():
    mode,path=line.split(' ',1); data=(root/path).read_bytes()
    out[path]={'mode':int(mode[-3:],8),'sha256':hashlib.sha256(data).hexdigest()}
print(json.dumps(out,sort_keys=True))
PY
# The expected hash is pinned to the official CLI release asset.
curl --fail --location --silent --show-error --max-time 180 --max-filesize 40000000 \
  --proto '=https' --proto-redir '=https' \
  https://github.com/cli/cli/releases/download/v2.104.0/gh_2.104.0_linux_arm64.tar.gz \
  -o "$temp_dir/gh.tar.gz"
printf '%s  %s\n' cb34cefc6f4e77b90731374a2b737516bb8f3033c6ca46aa949e5344f68069e3 "$temp_dir/gh.tar.gz" | shasum -a 256 -c
tar -xzf "$temp_dir/gh.tar.gz" -C "$temp_dir" gh_2.104.0_linux_arm64/bin/gh
created=1
colima start "$profile" --activate=false --ssh-config=false --cpus 2 --memory 3 --disk 20 --mount none
guest() { colima -p "$profile" ssh -- "$@"; }
guest sh -c 'test "$(uname -m)" = aarch64 && test ! -e /usr/bin/gh && test ! -e /usr/local/libexec/servus && test ! -e /opt/servus && test ! -e /run/servus-updater'
guest sudo install -d -m 755 /usr/local/libexec/servus
guest sudo install -d -m 700 /etc/servus
guest sudo tee /usr/local/libexec/servus/provision-host.py < "$temp_dir/head/apps/updater/provision-host.py" > /dev/null
guest sudo chmod 644 /usr/local/libexec/servus/provision-host.py
guest sudo tee /usr/local/libexec/servus/servus-updater.py < "$temp_dir/tag/apps/updater/servus-updater.py" > /dev/null
guest sudo chmod 755 /usr/local/libexec/servus/servus-updater.py
guest sudo /usr/bin/python3 -I /usr/local/libexec/servus/provision-host.py
guest sudo /usr/bin/python3 -I /usr/local/libexec/servus/provision-host.py
guest sudo test -f /etc/servus/updater.env
guest sudo install -d -m 700 /run/servus-release-fixture
guest sudo tee /usr/bin/gh < "$temp_dir/gh_2.104.0_linux_arm64/bin/gh" > /dev/null
guest sudo chmod 755 /usr/bin/gh
guest sudo tee /run/servus-release-fixture/manifest.json < "$temp_dir/manifest.json" > /dev/null
guest sudo tee /run/servus-release-fixture/flow.py < tests/release-preparation-e2e/flow.py > /dev/null
components='verify-release.py verification-executor.py guarded-verifier.py verification-fence.py provision-verifier-group.py servus-updater.py prepare-verified.py preparation-fence.py extract-install.py'
install_modules() {
  for component in $components; do
    guest sudo tee "/usr/local/libexec/servus/$component" < "$temp_dir/$1/apps/updater/$component" > /dev/null
    guest sudo chmod 755 "/usr/local/libexec/servus/$component"
  done
}
install_modules tag
guest sudo /usr/bin/python3 -I -B /run/servus-release-fixture/flow.py tag
guest sh -c 'test ! -e /usr/local/libexec/servus-legacy-fixture'
guest sudo mv /usr/local/libexec/servus /usr/local/libexec/servus-legacy-fixture
guest sudo chmod 700 /opt/servus
guest sudo install -d -m 700 /run/servus-release-fixture/source
COPYFILE_DISABLE=1 tar -cf - -C "$temp_dir/head" apps/updater deployment/systemd | guest sudo tar --warning=no-unknown-keyword --no-same-owner -xf - -C /run/servus-release-fixture/source
guest sudo tee /run/servus-release-fixture/install-real-host.py < tests/release-preparation-e2e/install-real-host.py > /dev/null
guest sudo /usr/bin/python3 -I /run/servus-release-fixture/install-real-host.py
guest sudo /usr/bin/python3 -I /usr/local/libexec/servus/install-gh.py
guest sudo /usr/bin/python3 -I /usr/local/libexec/servus/install-gh.py
guest sudo mv /usr/bin/gh /usr/bin/gh-legacy-fixture
guest sudo /usr/local/libexec/servus/bin/gh --version
guest sudo /usr/bin/python3 -I -B /run/servus-release-fixture/flow.py "$release_mode"
guest sudo /usr/bin/python3 -I -B -c 'import importlib.util,pathlib; s=importlib.util.spec_from_file_location("updater", "/usr/local/libexec/servus/servus-updater.py"); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); j=m.Journal(pathlib.Path("/var/lib/servus-updater")); j.close()'
guest sudo tee /usr/local/libexec/servus/provision-socket.py < "$temp_dir/head/apps/updater/provision-socket.py" > /dev/null
guest sudo chmod 644 /usr/local/libexec/servus/provision-socket.py
for unit in servus-updater-socket.service servus-updater-bootstrap.service; do
  guest sudo tee "/etc/systemd/system/$unit" < "$temp_dir/head/deployment/systemd/$unit" > /dev/null
  guest sudo chmod 644 "/etc/systemd/system/$unit"
done
guest sudo tee /run/servus-release-fixture/bootstrap-unit.py < tests/release-preparation-e2e/bootstrap-unit.py > /dev/null
guest sudo /usr/bin/python3 -I /run/servus-release-fixture/bootstrap-unit.py
guest sudo tee /run/servus-release-fixture/bootstrap-initial-unit.py < tests/release-preparation-e2e/bootstrap-initial-unit.py > /dev/null
guest sudo /usr/bin/python3 -I /run/servus-release-fixture/bootstrap-initial-unit.py
# Provision only in the disposable VM after the updater fixture has stopped.
for component in supervisor.py supervisor-daemon.py backup.py runtime-policy.py; do
  guest sudo tee "/usr/local/libexec/servus/$component" < "$temp_dir/head/apps/updater/$component" > /dev/null
  guest sudo chmod 644 "/usr/local/libexec/servus/$component"
done
guest sudo chmod 700 /opt/servus
guest sudo /usr/bin/python3 -I /usr/local/libexec/servus/provision-host.py --runtime
guest sudo /usr/bin/python3 -I /usr/local/libexec/servus/provision-host.py --runtime
guest sudo test -f /etc/servus/.supervisor-enabled-v1
guest sudo test -f /opt/servus/.lifecycle-enabled-v1
printf 'PASS first runtime provisioning and safe rerun on Linux\n'
guest sudo tee /run/servus-release-fixture/install-host-unit.py < tests/release-preparation-e2e/install-host-unit.py > /dev/null
guest sudo /usr/bin/python3 -I /run/servus-release-fixture/install-host-unit.py
guest sudo tee /usr/local/libexec/servus/bootstrap-handoff.py < "$temp_dir/head/apps/updater/bootstrap-handoff.py" > /dev/null
guest sudo chmod 644 /usr/local/libexec/servus/bootstrap-handoff.py
guest sudo tee /run/servus-release-fixture/handoff-unit.py < tests/release-preparation-e2e/handoff-unit.py > /dev/null
guest sudo /usr/bin/python3 -I /run/servus-release-fixture/handoff-unit.py
