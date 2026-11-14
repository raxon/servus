#!/bin/bash
# Run the legacy migration fixture only on a new disposable Colima VM.
set -euo pipefail
umask 077
[ "$#" -eq 0 ] || { [ "$#" -eq 1 ] && { [ "$1" = '--full' ] || [ "$1" = '--recover-check' ] || [ "$1" = '--early-recover' ] || [ "$1" = '--orchestrated' ] || [ "$1" = '--bootstrap-migrate' ] || [ "$1" = '--bootstrap-fail' ] || [ "$1" = '--host-bootstrap' ]; }; }
cd "$(dirname "$0")/../.."
for tool in colima docker openssl git; do command -v "$tool" >/dev/null; done
profile="servus-legacy-e2e-$(openssl rand -hex 8)"
context="colima-$profile"
created=0
cleanup() {
  result=$?
  trap - EXIT
  if [ "$created" = 1 ]; then colima delete "$profile" --force --data >/dev/null || result=1; fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
if docker context inspect "$context" >/dev/null 2>&1 || [ -e "$HOME/.colima/$profile" ]; then exit 1; fi
created=1
colima start "$profile" --activate=false --ssh-config=false --cpus 2 --memory 3 --disk 20 --mount none
guest() { colima -p "$profile" ssh -- "$@"; }
guest sudo install -d -m 700 /run/servus-legacy-fixture
git archive HEAD apps/updater deployment/systemd | guest sudo tar -x -C /run/servus-legacy-fixture
guest sudo chmod 755 /run/servus-legacy-fixture/apps /run/servus-legacy-fixture/apps/updater /run/servus-legacy-fixture/deployment /run/servus-legacy-fixture/deployment/systemd
guest sudo find /run/servus-legacy-fixture/apps/updater /run/servus-legacy-fixture/deployment/systemd -type f -exec chmod 644 '{}' +
guest sudo chmod 755 /run/servus-legacy-fixture/apps/updater/servus-updater.py
git show v0.1.4:deployment/compose.yaml | guest sudo tee /run/servus-legacy-fixture/compose.yaml >/dev/null
guest sudo tee /run/servus-legacy-fixture/guest.py < tests/legacy-transition-e2e/guest.py >/dev/null
guest sudo docker swarm init >/dev/null
for image in \
  ghcr.io/raxon/servus@sha256:32f7cccf97841716ffae6bbff4f4234d5c3575e3b3ad9daa61dcf5afba72a13c \
  ghcr.io/raxon/servus@sha256:68e56744e3a81249154e90012a7440041f87b965686f1c52e5e31bf3be0113c4 \
  node:24-bookworm-slim; do
  cached=$image
  if ! docker --context colima-panel-dev image inspect "$cached" >/dev/null 2>&1 && [[ $image == *@sha256:* ]]; then cached=${image#*@}; fi
  if docker --context colima-panel-dev image inspect "$cached" >/dev/null 2>&1; then
    docker --context colima-panel-dev save "$cached" | docker --context "$context" load >/dev/null
  fi
done
guest sudo docker pull --platform linux/amd64 ghcr.io/raxon/servus@sha256:32f7cccf97841716ffae6bbff4f4234d5c3575e3b3ad9daa61dcf5afba72a13c >/dev/null
guest sudo docker pull --platform linux/amd64 ghcr.io/raxon/servus@sha256:68e56744e3a81249154e90012a7440041f87b965686f1c52e5e31bf3be0113c4 >/dev/null
guest sudo docker pull node:24-bookworm-slim >/dev/null
guest sudo sh -c 'set -e; id=$(docker create --pull=never --entrypoint=/bin/false node:24-bookworm-slim); trap "docker rm $id >/dev/null" EXIT; docker cp "$id:/usr/local/bin/node" /run/servus-legacy-fixture/node; chmod 755 /run/servus-legacy-fixture/node'
if [ "${1:-}" = '--bootstrap-migrate' ] || [ "${1:-}" = '--bootstrap-fail' ] || [ "${1:-}" = '--host-bootstrap' ]; then
  guest sudo install -d -m 755 /usr/local/libexec/servus
  for name in verification-executor.py verify-release.py; do
    git show "v0.1.5:apps/updater/$name" | guest sudo tee "/usr/local/libexec/servus/$name" >/dev/null
    guest sudo chmod 755 "/usr/local/libexec/servus/$name"
  done
fi
guest sudo systemd-run --quiet --scope --property=MemoryAccounting=yes /usr/bin/python3 -I -B /run/servus-legacy-fixture/guest.py "$@"
if [ "${1:-}" = '--full' ]; then
  before=$(guest cat /proc/sys/kernel/random/boot_id)
  guest sudo systemctl reboot >/dev/null 2>&1 || true
  changed=0
  for _ in $(seq 1 90); do
    current=$(guest cat /proc/sys/kernel/random/boot_id 2>/dev/null || true)
    if [ -n "$current" ] && [ "$current" != "$before" ]; then changed=1; break; fi
    sleep 2
  done
  [ "$changed" = 1 ] || { printf 'Test VM did not reboot.\n' >&2; exit 1; }
  guest sudo /usr/bin/python3 -I -B /var/lib/servus-test-fixture/guest.py --after-reboot
fi
