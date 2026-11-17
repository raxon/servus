#!/bin/bash
# Exercise the real release verifier on an isolated Linux/systemd VM.
set -euo pipefail
umask 077
root=$(cd "$(dirname "$0")/../.." && pwd -P)
profile="servus-upgrade-e2e-$(openssl rand -hex 8)"
tmp=$(mktemp -d)
cleanup() { local result=$?; trap - EXIT; colima delete "$profile" --force --data || result=1; rm -rf "$tmp"; exit "$result"; }
trap cleanup EXIT
ssh -o BatchMode=yes -o ConnectTimeout=8 root@159.65.115.230 'cat /usr/local/bin/gh' > "$tmp/gh"
printf '%s  %s\n' fca7ac8a8386e3ad65c9a96a96cbf272d1dcc4f76de174dae91d54e50729e240 "$tmp/gh" | shasum -a 256 -c >/dev/null
colima start "$profile" --activate=false --ssh-config=false --cpus 2 --memory 3 --disk 20 --mount none
colima -p "$profile" ssh -- sudo install -d -m 755 /usr/local/libexec/servus
colima -p "$profile" ssh -- sudo tee /usr/local/bin/gh < "$tmp/gh" >/dev/null
colima -p "$profile" ssh -- sudo chmod 755 /usr/local/bin/gh
for name in verification-executor.py verify-release.py; do
  colima -p "$profile" ssh -- sudo tee "/usr/local/libexec/servus/$name" < "$root/apps/updater/$name" >/dev/null
  colima -p "$profile" ssh -- sudo chmod 644 "/usr/local/libexec/servus/$name"
done
colima -p "$profile" ssh -- sudo install -d -m 700 /run/servus-upgrade-fixture
colima -p "$profile" ssh -- sudo tee /run/servus-upgrade-fixture/manual-upgrade.py < "$root/scripts/manual-upgrade.py" >/dev/null
colima -p "$profile" ssh -- sudo systemd-run --quiet --scope /usr/bin/python3 -I -B -c \
  "import importlib.util; s=importlib.util.spec_from_file_location('upgrade','/run/servus-upgrade-fixture/manual-upgrade.py'); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); m.verify_release_attestation(); print('PASS real OCI attestation gate')"
if colima -p "$profile" ssh -- sudo systemd-run --quiet --scope /usr/bin/python3 -I -B \
  /usr/local/libexec/servus/verification-executor.py --digest sha256:32f7cccf97841716ffae6bbff4f4234d5c3575e3b3ad9daa61dcf5afba72a13c \
  --commit ffffffffffffffffffffffffffffffffffffffff --tag v0.1.5; then
  printf 'Unexpected acceptance of wrong attestation identity\n' >&2
  exit 1
fi
printf 'PASS wrong source identity rejected\n'
