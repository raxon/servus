#!/bin/bash
# Run this proof only on a disposable VM.
set -euo pipefail
umask 077
root=$(cd "$(dirname "$0")/../.." && pwd -P)
profile="servus-upgrade-e2e-$(openssl rand -hex 8)"
cleanup() { local result=$?; trap - EXIT; colima delete "$profile" --force --data || result=1; exit "$result"; }
trap cleanup EXIT
colima start "$profile" --activate=false --ssh-config=false --cpus 2 --memory 3 --disk 20 --mount none
docker --context "colima-$profile" pull --platform linux/arm64 node:24-bookworm-slim >/dev/null
colima -p "$profile" ssh -- sudo install -d -m 700 /run/servus-upgrade-fixture
colima -p "$profile" ssh -- sudo tee /run/servus-upgrade-fixture/upgrade-daemon-fence.py < "$root/tests/manual-upgrade/upgrade-daemon-fence.py" >/dev/null
colima -p "$profile" ssh -- sudo python3 -I -B /run/servus-upgrade-fixture/upgrade-daemon-fence.py
