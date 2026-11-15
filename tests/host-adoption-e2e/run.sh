#!/bin/bash
# Exercise systemd adoption and reboot recovery on an isolated disposable VM.
set -euo pipefail
cd "$(dirname "$0")/../.."
for tool in colima openssl python3; do
  command -v "$tool" >/dev/null || { printf 'Missing tool: %s\n' "$tool" >&2; exit 1; }
done
[ "$(uname -m)" = arm64 ] || { printf 'This fixture requires an arm64 host.\n' >&2; exit 1; }
profile="servus-adoption-e2e-$(openssl rand -hex 8)"
created=0
cleanup() {
  result=$?
  trap - EXIT
  if [ "$created" = 1 ]; then colima delete "$profile" --force --data >/dev/null || result=1; fi
  exit "$result"
}
trap cleanup EXIT
if colima list --json | python3 -c 'import json,sys; name=sys.argv[1]; sys.exit(0 if any(json.loads(line).get("name")==name for line in sys.stdin if line.strip()) else 1)' "$profile"; then
  printf 'Test profile already exists.\n' >&2; exit 1
fi
for path in "$HOME/.colima/$profile" "$HOME/.colima/_lima/colima-$profile" "$HOME/.colima/_lima/_disks/colima-$profile"; do
  if [ -e "$path" ] || [ -L "$path" ]; then printf 'Test profile path already exists.\n' >&2; exit 1; fi
done
created=1
colima start "$profile" --activate=false --ssh-config=false --cpus 2 --memory 2 --disk 20 --mount none
guest() { colima -p "$profile" ssh -- "$@"; }
guest sudo install -d -m 700 /run/servus-adoption-fixture
for file in host-bundle.py install-host.py; do
  guest sudo tee "/run/servus-adoption-fixture/$file" < "apps/updater/$file" >/dev/null
done
guest sudo tee /run/servus-adoption-fixture/fixture.py < tests/host-adoption-e2e/fixture.py >/dev/null
guest sudo /usr/bin/python3 -I -B /run/servus-adoption-fixture/fixture.py prepare
colima stop "$profile"
colima start "$profile" --activate=false --ssh-config=false
guest sudo install -d -m 700 /run/servus-adoption-fixture
for file in host-bundle.py install-host.py; do
  guest sudo tee "/run/servus-adoption-fixture/$file" < "apps/updater/$file" >/dev/null
done
guest sudo tee /run/servus-adoption-fixture/fixture.py < tests/host-adoption-e2e/fixture.py >/dev/null
guest sudo /usr/bin/python3 -I -B /run/servus-adoption-fixture/fixture.py resume
colima stop "$profile"
colima start "$profile" --activate=false --ssh-config=false
guest sudo install -d -m 700 /run/servus-adoption-fixture
for file in host-bundle.py install-host.py; do
  guest sudo tee "/run/servus-adoption-fixture/$file" < "apps/updater/$file" >/dev/null
done
guest sudo tee /run/servus-adoption-fixture/fixture.py < tests/host-adoption-e2e/fixture.py >/dev/null
guest sudo /usr/bin/python3 -I -B /run/servus-adoption-fixture/fixture.py verify
