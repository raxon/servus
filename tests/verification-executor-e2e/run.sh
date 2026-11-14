#!/bin/bash
# Run the verifier against a disposable Colima VM. The VM is removed on exit.
set -euo pipefail
umask 077
cd "$(dirname "$0")/../.."

for tool in colima docker curl shasum openssl tar; do
  command -v "$tool" >/dev/null || { printf 'Missing required tool: %s\n' "$tool" >&2; exit 1; }
done
[ "$(uname -m)" = arm64 ] || { printf 'This fixture requires an arm64 host.\n' >&2; exit 1; }
profile="servus-verify-e2e-$(openssl rand -hex 8)"
context="colima-$profile"
tmpdir_path=$(mktemp -d /tmp/servus-verify-e2e.XXXXXXXX)
created=0
cleanup() {
  if [ "$created" = 1 ]; then
    colima delete "$profile" --force --data >/dev/null || printf 'Remove test profile %s manually.\n' "$profile" >&2
  fi
  rm -rf "$tmpdir_path"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
[ ! -e "$HOME/.colima/$profile" ] && [ ! -L "$HOME/.colima/$profile" ] || { printf 'Test profile already exists.\n' >&2; exit 1; }
if docker context inspect "$context" >/dev/null 2>&1; then printf 'Test context already exists.\n' >&2; exit 1; fi

# Digest from the official cli/cli v2.104.0 release asset metadata.
curl --fail --location --silent --show-error --max-time 180 --max-filesize 40000000 \
  --proto '=https' --proto-redir '=https' \
  https://github.com/cli/cli/releases/download/v2.104.0/gh_2.104.0_linux_arm64.tar.gz \
  -o "$tmpdir_path/gh.tar.gz"
printf '%s  %s\n' cb34cefc6f4e77b90731374a2b737516bb8f3033c6ca46aa949e5344f68069e3 "$tmpdir_path/gh.tar.gz" | shasum -a 256 -c
tar -xzf "$tmpdir_path/gh.tar.gz" -C "$tmpdir_path" gh_2.104.0_linux_arm64/bin/gh

created=1
colima start "$profile" --activate=false --ssh-config=false --cpus 2 --memory 2 --disk 12 --mount none
guest() { colima -p "$profile" ssh -- "$@"; }
guest sh -c 'test "$(uname -m)" = aarch64 && test -x /usr/bin/python3 && test ! -e /usr/bin/gh && test ! -e /usr/local/libexec/servus && test ! -e /opt/servus && test ! -e /var/lib/servus-updater && test ! -e /run/servus-updater'
guest sudo install -d -m 755 /usr/local/libexec/servus
guest sudo tee /usr/bin/gh < "$tmpdir_path/gh_2.104.0_linux_arm64/bin/gh" > /dev/null
guest sudo tee /usr/local/libexec/servus/verify-release.py < apps/updater/verify-release.py > /dev/null
guest sudo tee /usr/local/libexec/servus/verification-executor.py < apps/updater/verification-executor.py > /dev/null
for component in guarded-verifier.py verification-fence.py provision-verifier-group.py servus-updater.py; do
  guest sudo tee "/usr/local/libexec/servus/$component" < "apps/updater/$component" > /dev/null
done
guest sudo chmod 755 /usr/bin/gh
for component in verify-release.py verification-executor.py guarded-verifier.py verification-fence.py provision-verifier-group.py servus-updater.py; do
  guest sudo chmod 755 "/usr/local/libexec/servus/$component"
done
guest sudo /usr/bin/python3 -I - < tests/verification-executor-e2e/verify.py
guest sudo /usr/bin/python3 -I - < tests/verification-executor-e2e/flow.py
