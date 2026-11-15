#!/usr/bin/env bash
set -euo pipefail
: "${SERVUS_LOCK_IMAGE:?Set SERVUS_LOCK_IMAGE to a Servus image with Node and dependencies}"
root=$(mktemp -d /tmp/servus-upload-lock-XXXXXXXX)
name="servus-upload-lock-$(openssl rand -hex 8)"
operation=$(openssl rand -hex 16)
service=$(python3 -c 'import uuid; print(uuid.uuid4())')
runner="$(pwd)/tests/restore-upload-lock-e2e/runner.mjs"
cleanup(){ docker rm -f "$name" >/dev/null 2>&1 || true; rm -rf "$root"; }
trap cleanup EXIT
common=(--user 0:0 --network none --read-only --tmpfs /tmp:rw,nosuid,nodev,size=32m --mount "type=bind,src=$root,dst=/fixture" --mount "type=bind,src=$runner,dst=/fixture-runner.mjs,readonly" -e "TEST_OPERATION=$operation" -e "TEST_SERVICE=$service" --entrypoint node)
if [[ -n ${SERVUS_LOCK_DIST:-} ]]; then common+=(--mount "type=bind,src=$SERVUS_LOCK_DIST,dst=/app/dist,readonly"); fi
docker run -d --name "$name" "${common[@]}" -e TEST_MODE=writer "$SERVUS_LOCK_IMAGE" /fixture-runner.mjs >/dev/null
for _ in {1..100}; do [[ -f "$root/ready" ]] && break; sleep 0.1; done
[[ -f "$root/ready" ]] || { docker logs "$name"; exit 1; }
docker run --rm "${common[@]}" -e TEST_MODE=live "$SERVUS_LOCK_IMAGE" /fixture-runner.mjs
docker kill "$name" >/dev/null
docker run --rm "${common[@]}" -e TEST_MODE=dead "$SERVUS_LOCK_IMAGE" /fixture-runner.mjs
echo 'PASS interrupted upload lock across containers'
