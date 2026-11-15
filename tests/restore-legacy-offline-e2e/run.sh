#!/usr/bin/env bash
set -euo pipefail
: "${SERVUS_LOCK_IMAGE:?Set SERVUS_LOCK_IMAGE to the tested Servus image}"
root=$(mktemp -d /tmp/servus-offline-XXXXXXXX)
fixture_id=$(openssl rand -hex 16)
name="servus-offline-$(openssl rand -hex 8)"
runner="$(pwd)/tests/restore-legacy-offline-e2e/runner.mjs"
cleanup(){
  if [[ $(docker inspect --format '{{ index .Config.Labels "servus.test" }}' "$name" 2>/dev/null || true) == "$fixture_id" ]]; then docker rm -f "$name" >/dev/null 2>&1 || true; fi
  rm -rf "$root"
}
trap cleanup EXIT
chmod 700 "$root"
if [[ $(id -u) == 0 ]]; then chown 1000:1000 "$root"; run_user=1000:1000; else run_user="$(id -u):$(id -g)"; fi
active_mounts=()
if [[ -n ${SERVUS_LOCK_DIST:-} ]]; then active_mounts+=(--mount "type=bind,src=$SERVUS_LOCK_DIST,dst=/app/dist,readonly"); fi
docker run --rm --name "$name" --label "servus.test=$fixture_id" --user "$run_user" --network none --read-only \
  --tmpfs /tmp:rw,nosuid,nodev,size=32m --mount "type=bind,src=$root,dst=/fixture" \
  --mount "type=bind,src=$root,dst=/data" \
  --mount "type=bind,src=$runner,dst=/fixture-runner.mjs,readonly" "${active_mounts[@]}" --entrypoint node "$SERVUS_LOCK_IMAGE" /fixture-runner.mjs
