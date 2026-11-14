#!/bin/bash
# Exercise a published signed release on a disposable systemd VM.
set -euo pipefail
umask 077
cd "$(dirname "$0")/../.."
for tool in colima docker openssl python3 git node; do
  command -v "$tool" >/dev/null || { printf 'Missing tool: %s\n' "$tool" >&2; exit 1; }
done
[ "$(uname -m)" = arm64 ] || { printf 'This fixture requires an arm64 host.\n' >&2; exit 1; }
base_version=${SERVUS_TEST_BASE_VERSION:-0.1.6}
target_version=${SERVUS_TEST_TARGET_VERSION:-0.1.7}
base_revision=${SERVUS_TEST_BASE_REVISION:-313e8be074ce8a9be8832e91f7a841b594724dcb}
test_port=${SERVUS_TEST_PORT:-43899}
[[ $base_version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ && $target_version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ && $base_revision =~ ^[0-9a-f]{40}$ ]] || { printf 'Invalid test release identity.\n' >&2; exit 1; }
[[ $test_port =~ ^[1-9][0-9]{0,4}$ ]] && ((test_port <= 65535)) || { printf 'Invalid test port.\n' >&2; exit 1; }
profile="servus-update-e2e-$(openssl rand -hex 8)"
context="colima-$profile"
temp_dir=$(mktemp -d /tmp/servus-update-e2e.XXXXXXXX)
created=0
cleanup() {
  result=$?
  trap - EXIT
  if [ "$created" = 1 ]; then colima delete "$profile" --force --data >/dev/null || result=1; fi
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
git show HEAD:scripts/install.sh > "$temp_dir/install.sh"
created=1
colima start "$profile" --activate=false --ssh-config=false --cpus 2 --memory 3 --disk 20 --mount none
guest() { colima -p "$profile" ssh -- "$@"; }
guest sh -c 'test "$(uname -m)" = aarch64 && test ! -e /usr/local/libexec/servus && test ! -e /opt/servus && test ! -e /etc/servus'
guest sudo install -d -m 700 /run/servus-update-fixture
guest sudo tee /run/servus-update-fixture/install.sh < "$temp_dir/install.sh" > /dev/null
guest sudo chmod 700 /run/servus-update-fixture/install.sh
if [ -n "${SERVUS_TEST_RELEASE_RUN:-}" ]; then
  [[ $SERVUS_TEST_RELEASE_RUN =~ ^[0-9]+$ ]] || { printf 'Invalid release run ID.\n' >&2; exit 1; }
  command -v gh >/dev/null || { printf 'Missing tool: gh\n' >&2; exit 1; }
  gh run watch "$SERVUS_TEST_RELEASE_RUN" --exit-status --interval 20
fi
address=$(guest sh -c "hostname -I | awk '{print \$1}'")
[[ $address =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || { printf 'VM has no usable IPv4 address.\n' >&2; exit 1; }
guest sudo bash /run/servus-update-fixture/install.sh --swarm-advertise-addr "$address" --port "$test_port" --ingress-port 18080
for unit in servus-supervisor.service servus-updater.service servus-updater-socket.service; do
  guest sudo systemctl is-active --quiet "$unit"
  guest sudo systemctl is-enabled --quiet "$unit"
done
node tests/signed-update-e2e/browser.mjs "http://127.0.0.1:$test_port" "$base_version" "$target_version" "$base_revision"
printf 'PASS real update from v%s to v%s in the browser\n' "$base_version" "$target_version"
