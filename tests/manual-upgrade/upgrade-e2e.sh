#!/bin/bash
# Run only against a new, disposable VM and remove it when finished.
set -euo pipefail
umask 077
if [ "$#" -gt 1 ] || { [ "$#" = 1 ] && [ "$1" != '--kill-after-switch' ] && [ "$1" != '--recover-after-capture' ] && [ "$1" != '--kill-during-recovery' ] && [ "$1" != '--finish-after-switch' ] && [ "$1" != '--finish-mixed-restart' ] && [ "$1" != '--finish-restart-docker' ] && [ "$1" != '--worker-killed-active' ] && [ "$1" != '--cli-execute' ] && [ "$1" != '--cli-recover-old' ] && [ "$1" != '--cli-recover-new' ]; }; then
  printf 'Invalid fixture option\n' >&2
  exit 2
fi
root=$(cd "$(dirname "$0")/../.." && pwd -P)
suffix=$(openssl rand -hex 8)
profile="servus-upgrade-e2e-$suffix"
context="colima-$profile"
created=0
tmp=''
cleanup() {
  local result=$?
  trap - EXIT INT TERM
  if [ -n "$tmp" ]; then rm -rf "$tmp"; fi
  if [ "$created" = 1 ]; then
    if ! colima delete "$profile" --force --data; then
      printf 'Remove disposable profile manually: %s\n' "$profile" >&2
      result=1
    fi
  fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
if [ -e "$HOME/.colima/$profile" ] || docker context inspect "$context" >/dev/null 2>&1; then
  printf 'Disposable profile already exists.\n' >&2
  exit 1
fi
created=1
printf 'Creating disposable profile %s\n' "$profile"
colima start "$profile" --activate=false --ssh-config=false --cpus 2 --memory 3 --disk 20 --mount none
docker --context "$context" swarm init >/dev/null
if docker --context colima-panel-dev image inspect \
  ghcr.io/raxon/servus@sha256:466654f228cf3adb4e13369ce85b047458fa7eb64e20c46c222df2326c293370 \
  ghcr.io/raxon/servus@sha256:32f7cccf97841716ffae6bbff4f4234d5c3575e3b3ad9daa61dcf5afba72a13c \
  node:24-bookworm-slim nginx:alpine >/dev/null 2>&1; then
  docker --context colima-panel-dev save \
    ghcr.io/raxon/servus@sha256:466654f228cf3adb4e13369ce85b047458fa7eb64e20c46c222df2326c293370 \
    ghcr.io/raxon/servus@sha256:32f7cccf97841716ffae6bbff4f4234d5c3575e3b3ad9daa61dcf5afba72a13c \
    node:24-bookworm-slim nginx:alpine | docker --context "$context" load >/dev/null
fi
docker --context "$context" pull --platform linux/amd64 ghcr.io/raxon/servus@sha256:466654f228cf3adb4e13369ce85b047458fa7eb64e20c46c222df2326c293370 >/dev/null
docker --context "$context" pull --platform linux/amd64 ghcr.io/raxon/servus@sha256:32f7cccf97841716ffae6bbff4f4234d5c3575e3b3ad9daa61dcf5afba72a13c >/dev/null
docker --context "$context" pull node:24-bookworm-slim >/dev/null
docker --context "$context" pull nginx:alpine >/dev/null
colima -p "$profile" ssh -- sudo install -d -m 700 /run/servus-upgrade-fixture
colima -p "$profile" ssh -- sudo tee /run/servus-upgrade-fixture/manual-upgrade.py < "$root/scripts/manual-upgrade.py" >/dev/null
colima -p "$profile" ssh -- sudo tee /run/servus-upgrade-fixture/upgrade-guest-e2e.py < "$root/tests/manual-upgrade/upgrade-guest-e2e.py" >/dev/null
git -C "$root" show v0.1.4:deployment/compose.yaml | colima -p "$profile" ssh -- sudo tee /run/servus-upgrade-fixture/compose.yaml >/dev/null
if [[ "${1:-}" = --cli-* ]]; then
  tmp=$(mktemp -d)
  ssh -o BatchMode=yes -o ConnectTimeout=8 root@159.65.115.230 'cat /usr/local/bin/gh' > "$tmp/gh"
  printf '%s  %s\n' fca7ac8a8386e3ad65c9a96a96cbf272d1dcc4f76de174dae91d54e50729e240 "$tmp/gh" | shasum -a 256 -c >/dev/null
  colima -p "$profile" ssh -- sudo tee /usr/local/bin/gh < "$tmp/gh" >/dev/null
  rm -rf "$tmp"
  colima -p "$profile" ssh -- sudo chmod 755 /usr/local/bin/gh
  colima -p "$profile" ssh -- sudo install -d -m 755 /usr/local/libexec/servus
  for name in verification-executor.py verify-release.py; do
    colima -p "$profile" ssh -- sudo tee "/usr/local/libexec/servus/$name" < "$root/apps/updater/$name" >/dev/null
    colima -p "$profile" ssh -- sudo chmod 644 "/usr/local/libexec/servus/$name"
  done
  colima -p "$profile" ssh -- sudo tee /run/servus-upgrade-fixture/upgrade-test-tls.py < "$root/tests/manual-upgrade/upgrade-test-tls.py" >/dev/null
  colima -p "$profile" ssh -- sudo tee /run/servus-upgrade-fixture/upgrade-cli-trace.py < "$root/tests/manual-upgrade/upgrade-cli-trace.py" >/dev/null
  colima -p "$profile" ssh -- sudo bash -c 'set -e; cid=$(docker create --pull=never --platform=linux/amd64 --entrypoint=/bin/false ghcr.io/raxon/servus@sha256:32f7cccf97841716ffae6bbff4f4234d5c3575e3b3ad9daa61dcf5afba72a13c); trap "docker rm -f $cid >/dev/null" EXIT; docker cp "$cid:/usr/lib/x86_64-linux-gnu" /usr/lib/; mkdir -p /usr/lib64; ln -s /lib/x86_64-linux-gnu/ld-linux-x86-64.so.2 /usr/lib64/ld-linux-x86-64.so.2; ln -s /usr/lib64 /lib64'
  colima -p "$profile" ssh -- sudo bash -c 'ip address add 159.65.115.230/32 dev lo; openssl req -x509 -newkey rsa:2048 -nodes -keyout /run/servus-upgrade-fixture/server.key -out /run/servus-upgrade-fixture/server.crt -days 1 -subj /CN=servus-fixture -addext subjectAltName=IP:159.65.115.230 >/dev/null 2>&1; cat /run/servus-upgrade-fixture/server.crt >> /etc/ssl/certs/ca-certificates.crt; systemd-run --quiet --unit=servus-fixture-tls /usr/bin/python3 -I -B /run/servus-upgrade-fixture/upgrade-test-tls.py'
fi
colima -p "$profile" ssh -- sudo systemd-run --quiet --scope --property=MemoryAccounting=yes /usr/bin/python3 -I -B /run/servus-upgrade-fixture/upgrade-guest-e2e.py "$@"
