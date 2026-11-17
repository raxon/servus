#!/bin/bash
# Reproduce real host capture/restore without touching another Docker daemon.
set -euo pipefail
umask 077
fixture_root=$(cd "$(dirname "$0")/../.." && pwd -P)
fixture_suffix=$(openssl rand -hex 4)
fixture_profile="servus-installation-backup-e2e-$fixture_suffix"
fixture_context="colima-$fixture_profile"
fixture_base=${SERVUS_BACKUP_E2E_BASE_IMAGE:-servus-parity-v7-check:20261117}
fixture_image="servus-installation-backup-check:$fixture_suffix"
fixture_stage=$(mktemp -d "${TMPDIR:-/tmp}/servus-installation-backup.XXXXXXXX")
fixture_artifacts="$fixture_root/artifacts/installation-backups"
fixture_report="$fixture_artifacts/host-$fixture_suffix.json"
fixture_created=0
cleanup() {
  local result=$?
  trap - EXIT INT TERM
  rm -rf -- "$fixture_stage"
  if [ "$fixture_created" = 1 ]; then
    if [ "$result" != 0 ]; then
      mkdir -p "$fixture_artifacts"
      # Export only the guest's allowlisted state/hints, never credentials,
      # environment, raw container inspection or raw application logs.
      colima ssh --profile "$fixture_profile" -- sudo python3 -I -B \
        /run/servus-installation-backup-fixture/guest.py diagnostics \
        > "$fixture_artifacts/host-$fixture_suffix-diagnostics.json" 2>/dev/null || true
    fi
    if ! colima delete "$fixture_profile" --force --data; then
      printf 'Fixture cleanup failed: %s\n' "$fixture_profile" >&2
      result=1
    elif [ -f "$fixture_report" ]; then
      python3 - "$fixture_report" "$fixture_context" <<'PY'
import json, pathlib, sys
path = pathlib.Path(sys.argv[1])
report = json.loads(path.read_text())
report.update(context=sys.argv[2], cleanup={'status': 'completed', 'ownedVmDeleted': True})
path.write_text(json.dumps(report, indent=2) + '\n')
PY
    fi
  fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
case "$fixture_base" in *[!a-zA-Z0-9_./:@-]*|'') printf 'Invalid local base image.\n' >&2; exit 2;; esac
if [ -e "$HOME/.colima/$fixture_profile" ] || docker context inspect "$fixture_context" >/dev/null 2>&1; then
  printf 'Disposable fixture profile already exists.\n' >&2
  exit 1
fi
docker --context colima-panel-dev image inspect "$fixture_base" nginx:alpine traefik:3.7.13 >/dev/null
(cd "$fixture_root" && npm run build:panel)
mkdir -p "$fixture_stage/scripts"
cp -R "$fixture_root/apps/panel/dist" "$fixture_stage/panel-dist"
cp "$fixture_root/deployment/lifecycle-gate.sh" "$fixture_stage/"
cp "$fixture_root/scripts/servus-client.mjs" "$fixture_root/scripts/servus.mjs" "$fixture_root/scripts/servus-mcp.mjs" "$fixture_stage/scripts/"
cat > "$fixture_stage/Dockerfile" <<EOF
FROM $fixture_base
USER root
COPY panel-dist /app/dist
COPY lifecycle-gate.sh /app/lifecycle-gate.sh
COPY scripts /app/scripts
# The host's private staging umask must not make compiled code root-readable
# only. Keep host files private while allowing the installed node user to read.
RUN chmod -R a+rX /app/dist /app/scripts && chmod 644 /app/lifecycle-gate.sh
USER node
EOF
fixture_created=1
printf 'Creating isolated fixture %s\n' "$fixture_profile"
colima start "$fixture_profile" --activate=false --ssh-config=false --cpus 2 --memory 3 --disk 20 --mount none
docker --context colima-panel-dev save "$fixture_base" nginx:alpine traefik:3.7.13 | docker --context "$fixture_context" load
docker --context "$fixture_context" swarm init >/dev/null
docker --context "$fixture_context" build --network=none --tag "$fixture_image" "$fixture_stage"
fixture_digest=$(docker --context "$fixture_context" image inspect "$fixture_image" --format '{{.Id}}')
case "$fixture_digest" in sha256:*) ;; *) printf 'Missing immutable fixture digest.\n' >&2; exit 1;; esac
fixture_reference="ghcr.io/raxon/servus@$fixture_digest"
# Only add a local content-addressed alias. No registry push or DNS override.
colima ssh --profile "$fixture_profile" -- sudo ctr --address /run/containerd/containerd.sock --namespace moby images tag \
  "docker.io/library/$fixture_image" "$fixture_reference"
docker --context "$fixture_context" image inspect "$fixture_reference" >/dev/null
colima ssh --profile "$fixture_profile" -- sudo install -d -m 700 /run/servus-installation-backup-fixture
COPYFILE_DISABLE=1 tar --no-xattrs --no-acls --no-fflags -C "$fixture_root" --exclude=__pycache__ -cf - apps/updater | \
  colima ssh --profile "$fixture_profile" -- sudo sh -c \
    'mkdir -p /run/servus-installation-backup-fixture/source /usr/local/libexec/servus; tar -xf - -C /run/servus-installation-backup-fixture/source; cp /run/servus-installation-backup-fixture/source/apps/updater/*.py /usr/local/libexec/servus/; chmod 644 /usr/local/libexec/servus/*.py; chmod 755 /usr/local/libexec/servus/servus-updater.py'
colima ssh --profile "$fixture_profile" -- sudo tee /run/servus-installation-backup-fixture/guest.py < "$fixture_root/tests/installation-backups/guest.py" >/dev/null
colima ssh --profile "$fixture_profile" -- sudo tee /run/servus-installation-backup-fixture/compose.yaml < "$fixture_root/deployment/compose.yaml" >/dev/null
colima ssh --profile "$fixture_profile" -- sudo python3 -I -B /run/servus-installation-backup-fixture/guest.py prepare --image "$fixture_reference"
colima ssh --profile "$fixture_profile" -- sudo python3 -I -B /run/servus-installation-backup-fixture/guest.py exercise
mkdir -p "$fixture_artifacts"
colima ssh --profile "$fixture_profile" -- sudo cat /run/servus-installation-backup-fixture/result.json > "$fixture_report"
