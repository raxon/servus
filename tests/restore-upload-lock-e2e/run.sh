#!/usr/bin/env bash
set -euo pipefail
: "${SERVUS_LOCK_IMAGE:?Set SERVUS_LOCK_IMAGE to a Servus image with Node and dependencies}"
root=$(mktemp -d /tmp/servus-upload-lock-XXXXXXXX)
fixture_id=$(openssl rand -hex 16)
name="servus-upload-lock-$(openssl rand -hex 8)"
legacy_name="servus-upload-legacy-$(openssl rand -hex 8)"
compat_name="servus-upload-compat-$(openssl rand -hex 8)"
gap_name="servus-upload-gap-$(openssl rand -hex 8)"
gap_legacy_name="servus-upload-gap-legacy-$(openssl rand -hex 8)"
operation=$(openssl rand -hex 16)
service=$(python3 -c 'import uuid; print(uuid.uuid4())')
runner="$(pwd)/tests/restore-upload-lock-e2e/runner.mjs"
cleanup(){
  for container in "$name" "$legacy_name" "$compat_name" "$gap_name" "$gap_legacy_name"; do
    if [[ $(docker inspect --format '{{ index .Config.Labels "servus.test" }}' "$container" 2>/dev/null || true) == "$fixture_id" ]]; then docker rm -f "$container" >/dev/null 2>&1 || true; fi
  done
  rm -rf "$root"
}
trap cleanup EXIT
common=(--label "servus.test=$fixture_id" --user "$(id -u):$(id -g)" --network none --read-only --tmpfs /tmp:rw,nosuid,nodev,size=32m --mount "type=bind,src=$root,dst=/fixture" --mount "type=bind,src=$runner,dst=/fixture-runner.mjs,readonly" -e "TEST_OPERATION=$operation" -e "TEST_SERVICE=$service" --entrypoint node)
previous_common=("${common[@]}")
if [[ -n ${SERVUS_LOCK_DIST:-} ]]; then common+=(--mount "type=bind,src=$SERVUS_LOCK_DIST,dst=/app/dist,readonly"); fi
docker run -d --name "$name" "${common[@]}" -e TEST_MODE=writer "$SERVUS_LOCK_IMAGE" /fixture-runner.mjs >/dev/null
for _ in {1..100}; do [[ -f "$root/ready" ]] && break; sleep 0.1; done
[[ -f "$root/ready" ]] || { docker logs "$name"; exit 1; }
docker run --rm "${common[@]}" -e TEST_MODE=live "$SERVUS_LOCK_IMAGE" /fixture-runner.mjs
if [[ -n ${SERVUS_LOCK_PREVIOUS_IMAGE:-} ]]; then
  docker run --rm "${previous_common[@]}" -e TEST_MODE=old_live "$SERVUS_LOCK_PREVIOUS_IMAGE" /fixture-runner.mjs
fi
docker kill "$name" >/dev/null
if [[ -n ${SERVUS_LOCK_PREVIOUS_IMAGE:-} ]]; then
  docker run --rm "${previous_common[@]}" -e TEST_MODE=old_dead "$SERVUS_LOCK_PREVIOUS_IMAGE" /fixture-runner.mjs
  echo 'PASS previous agent leaves new-format upload fenced'
fi
docker run --rm "${common[@]}" -e TEST_MODE=dead "$SERVUS_LOCK_IMAGE" /fixture-runner.mjs
echo 'PASS interrupted upload lock across containers'
mkdir -m 700 "$root/legacy"
legacy_operation=$(openssl rand -hex 16)
legacy_service=$(python3 -c 'import uuid; print(uuid.uuid4())')
legacy_common=(--label "servus.test=$fixture_id" --user "$(id -u):$(id -g)" --network none --read-only --tmpfs /tmp:rw,nosuid,nodev,size=32m --mount "type=bind,src=$root/legacy,dst=/fixture" --mount "type=bind,src=$runner,dst=/fixture-runner.mjs,readonly" -e "TEST_OPERATION=$legacy_operation" -e "TEST_SERVICE=$legacy_service" --entrypoint node)
if [[ -n ${SERVUS_LOCK_DIST:-} ]]; then legacy_common+=(--mount "type=bind,src=$SERVUS_LOCK_DIST,dst=/app/dist,readonly"); fi
docker run -d --name "$legacy_name" "${legacy_common[@]}" -e TEST_MODE=legacy_writer "$SERVUS_LOCK_IMAGE" /fixture-runner.mjs >/dev/null
for _ in {1..100}; do [[ -f "$root/legacy/ready" ]] && break; sleep 0.1; done
[[ -f "$root/legacy/ready" ]] || { docker logs "$legacy_name"; exit 1; }
docker run --rm "${legacy_common[@]}" -e TEST_MODE=legacy_live "$SERVUS_LOCK_IMAGE" /fixture-runner.mjs
docker kill "$legacy_name" >/dev/null
docker run --rm "${legacy_common[@]}" -e TEST_MODE=legacy_dead "$SERVUS_LOCK_IMAGE" /fixture-runner.mjs
echo 'PASS legacy upload remains fenced without a process lock'
mkdir -m 700 "$root/compat"
compat_operation=$(openssl rand -hex 16)
compat_service=$(python3 -c 'import uuid; print(uuid.uuid4())')
compat_common=(--label "servus.test=$fixture_id" --user "$(id -u):$(id -g)" --network none --read-only --tmpfs /tmp:rw,nosuid,nodev,size=32m --mount "type=bind,src=$root/compat,dst=/fixture" --mount "type=bind,src=$runner,dst=/fixture-runner.mjs,readonly" -e "TEST_OPERATION=$compat_operation" -e "TEST_SERVICE=$compat_service" --entrypoint node)
if [[ -n ${SERVUS_LOCK_DIST:-} ]]; then compat_common+=(--mount "type=bind,src=$SERVUS_LOCK_DIST,dst=/app/dist,readonly"); fi
docker run -d --name "$compat_name" "${compat_common[@]}" -e TEST_MODE=compat_writer "$SERVUS_LOCK_IMAGE" /fixture-runner.mjs >/dev/null
for _ in {1..100}; do [[ -f "$root/compat/ready" ]] && break; sleep 0.1; done
[[ -f "$root/compat/ready" ]] || { docker logs "$compat_name"; exit 1; }
docker run --rm "${compat_common[@]}" -e TEST_MODE=compat_live "$SERVUS_LOCK_IMAGE" /fixture-runner.mjs
docker kill "$compat_name" >/dev/null
docker run --rm "${compat_common[@]}" -e TEST_MODE=compat_dead "$SERVUS_LOCK_IMAGE" /fixture-runner.mjs
echo 'PASS existing locked upload recovers across versions'
mkdir -m 700 "$root/gap"
gap_operation=$(openssl rand -hex 16)
gap_service=$(python3 -c 'import uuid; print(uuid.uuid4())')
gap_lock=$(openssl rand -hex 16)
gap_common=(--label "servus.test=$fixture_id" --user "$(id -u):$(id -g)" --network none --read-only --tmpfs /tmp:rw,nosuid,nodev,size=32m --mount "type=bind,src=$root/gap,dst=/fixture" --mount "type=bind,src=$runner,dst=/fixture-runner.mjs,readonly" -e "TEST_OPERATION=$gap_operation" -e "TEST_SERVICE=$gap_service" --entrypoint node)
if [[ -n ${SERVUS_LOCK_DIST:-} ]]; then gap_common+=(--mount "type=bind,src=$SERVUS_LOCK_DIST,dst=/app/dist,readonly"); fi
docker run -d --name "$gap_name" "${gap_common[@]}" -e "TEST_LOCK_ID=$gap_lock" -e TEST_MODE=unregistered_writer "$SERVUS_LOCK_IMAGE" /fixture-runner.mjs >/dev/null
for _ in {1..100}; do [[ -f "$root/gap/ready" ]] && break; sleep 0.1; done
[[ -f "$root/gap/ready" ]] || { docker logs "$gap_name"; exit 1; }
docker kill "$gap_name" >/dev/null
rm "$root/gap/ready"
docker run -d --name "$gap_legacy_name" "${gap_common[@]}" -e TEST_MODE=legacy_writer "$SERVUS_LOCK_IMAGE" /fixture-runner.mjs >/dev/null
for _ in {1..100}; do [[ -f "$root/gap/ready" ]] && break; sleep 0.1; done
[[ -f "$root/gap/ready" ]] || { docker logs "$gap_legacy_name"; exit 1; }
docker run --rm "${gap_common[@]}" -e TEST_MODE=legacy_live "$SERVUS_LOCK_IMAGE" /fixture-runner.mjs
docker kill "$gap_legacy_name" >/dev/null
docker run --rm "${gap_common[@]}" -e TEST_MODE=legacy_dead "$SERVUS_LOCK_IMAGE" /fixture-runner.mjs
echo 'PASS crash before journal publication cannot unlock a legacy writer'
active_mounts=()
if [[ -n ${SERVUS_LOCK_DIST:-} ]]; then active_mounts+=(--mount "type=bind,src=$SERVUS_LOCK_DIST,dst=/app/dist,readonly"); fi
for kind in postgres mariadb; do
  docker run --rm -i --network none --read-only --user "$(id -u):$(id -g)" \
    --tmpfs /tmp:rw,nosuid,nodev,size=1g "${active_mounts[@]}" -e "TEST_KIND=$kind" --entrypoint node "$SERVUS_LOCK_IMAGE" \
    --input-type=module < "$(dirname "$runner")/active-cancel.mjs"
done
