#!/usr/bin/env bash
set -euo pipefail
: "${SERVUS_IMPORT_IMAGE:?Set SERVUS_IMPORT_IMAGE to a test image containing Node and Docker CLI}"
: "${SERVUS_IMPORT_SOURCE:?Set SERVUS_IMPORT_SOURCE to the candidate import module}"
id=$(python3 -c 'import secrets; print(secrets.token_hex(16))')
root="/tmp/servus-db-import-$id"
source_name="servus-import-$id-source"
candidate_name="panel-restore-$id"
volume="panel-restore-$id"
mkdir -m 700 "$root"
cleanup() {
  for name in "$source_name" "$candidate_name"; do
    if [[ $(docker inspect --format '{{ index .Config.Labels "servus.test" }}' "$name" 2>/dev/null || true) == "$id" || $(docker inspect --format '{{ index .Config.Labels "panel.restore.operation" }}' "$name" 2>/dev/null || true) == "$id" ]]; then docker rm -f -v "$name" >/dev/null; fi
  done
  if [[ $(docker volume inspect --format '{{ index .Labels "panel.restore.operation" }}' "$volume" 2>/dev/null || true) == "$id" ]]; then docker volume rm "$volume" >/dev/null; fi
  python3 -c 'import re,shutil,sys; p=sys.argv[1]; assert re.fullmatch(r"/tmp/servus-db-import-[a-f0-9]{32}",p); shutil.rmtree(p)' "$root"
}
trap cleanup EXIT
password=$(python3 -c 'import secrets; print(secrets.token_hex(24))')
printf '%s' "$password" > "$root/password"
printf 'POSTGRES_DB=fixture\nPOSTGRES_USER=fixture\nPOSTGRES_PASSWORD=%s\n' "$password" > "$root/postgres.env"
printf 'MARIADB_DATABASE=fixture\nMARIADB_USER=fixture\nMARIADB_PASSWORD=%s\nMARIADB_ROOT_PASSWORD=%s\n' "$password" "$password" > "$root/mariadb.env"
chmod 600 "$root"/password "$root"/*.env
wait_ready() {
  local name=$1 kind=$2
  for _ in $(seq 1 90); do
    if [[ $kind == postgres ]]; then
      if docker exec "$name" pg_isready -q -h 127.0.0.1 -U fixture -d fixture; then return; fi
    elif docker exec "$name" sh -c 'MYSQL_PWD="$MARIADB_PASSWORD" mariadb -h 127.0.0.1 -u fixture fixture -N -e "SELECT 1"' >/dev/null 2>&1; then return; fi
    sleep 1
  done
  printf 'Candidate database did not become ready\n' >&2; return 1
}
run_import() {
  local kind=$1 dump=$2 target='' source_id module journal_module preparation_module candidate_module archive_module secrets_module digest tamper reuse runner
  local -a mounts=()
  reuse=${5:-0}
  if [[ $reuse == 1 ]]; then target=$(docker inspect --format '{{.Id}}' "$candidate_name"); fi
  source_id=$(docker inspect --format '{{.Id}}' "$source_name")
  runner=$(cd "$(dirname "$0")" && pwd)/runner.mjs
  digest=${3:-$(sha256sum "$dump" | cut -d' ' -f1)}
  tamper=${4:-0}
  if [[ $SERVUS_IMPORT_SOURCE == image ]]; then
    module=/app/dist/agent/database-import.js; journal_module=/app/dist/agent/restore-journal.js; preparation_module=/app/dist/agent/restore-preparation.js; candidate_module=/app/dist/agent/restore-candidate.js; archive_module=/app/dist/agent/restore-archive.js; secrets_module=/app/dist/shared/secrets.js
  else
    module=/fixture-import.ts; journal_module=/fixture-journal.ts; preparation_module=/fixture-preparation.ts; candidate_module=/fixture-candidate.ts; archive_module=/fixture-archive.ts; secrets_module=/app/dist/shared/fixture-secrets.ts
    mounts+=(--mount "type=bind,src=$SERVUS_IMPORT_SOURCE,dst=$module,readonly" --mount "type=bind,src=$(dirname "$SERVUS_IMPORT_SOURCE")/restore-journal.ts,dst=$journal_module,readonly" --mount "type=bind,src=$(dirname "$SERVUS_IMPORT_SOURCE")/restore-preparation.ts,dst=$preparation_module,readonly" --mount "type=bind,src=$(dirname "$SERVUS_IMPORT_SOURCE")/restore-candidate.ts,dst=$candidate_module,readonly" --mount "type=bind,src=$(dirname "$SERVUS_IMPORT_SOURCE")/restore-archive.ts,dst=$archive_module,readonly" --mount "type=bind,src=${SERVUS_IMPORT_SECRETS_SOURCE:-$(dirname "$SERVUS_IMPORT_SOURCE")/../shared/secrets.ts},dst=$secrets_module,readonly")
  fi
  if [[ -n ${SERVUS_IMPORT_DIST:-} ]]; then mounts+=(--mount "type=bind,src=$SERVUS_IMPORT_DIST,dst=/app/dist,readonly"); fi
  docker run --rm --network none --user 0 --mount type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock \
    "${mounts[@]}" \
    --mount "type=bind,src=$dump,dst=/fixture-data,readonly" --mount "type=bind,src=$root/password,dst=/fixture-password,readonly" --mount "type=bind,src=$runner,dst=/fixture-runner.mjs,readonly" \
    -e PATH=/usr/bin:/bin -e "SERVUS_IMPORT_EXISTING=$target" -e "SERVUS_IMPORT_SOURCE_ID=$source_id" -e "SERVUS_IMPORT_OPERATION=$id" -e "SERVUS_IMPORT_KIND=$kind" -e "SERVUS_IMPORT_MODULE=$module" -e "SERVUS_IMPORT_JOURNAL=$journal_module" -e "SERVUS_IMPORT_PREPARATION=$preparation_module" -e "SERVUS_IMPORT_CANDIDATE=$candidate_module" -e "SERVUS_IMPORT_ARCHIVE=$archive_module" -e "SERVUS_IMPORT_SECRETS=$secrets_module" -e "SERVUS_IMPORT_SHA256=$digest" -e "SERVUS_IMPORT_TAMPER=$tamper" \
    --entrypoint /usr/local/bin/node "$SERVUS_IMPORT_IMAGE" /fixture-runner.mjs
}
run_agent_import() {
  local kind=$1 dump=$2 source_id runner
  source_id=$(docker inspect --format '{{.Id}}' "$source_name")
  runner=$(cd "$(dirname "$0")" && pwd)/agent-runner.mjs
  local -a mounts=()
  if [[ -n ${SERVUS_IMPORT_DIST:-} ]]; then mounts+=(--mount "type=bind,src=$SERVUS_IMPORT_DIST,dst=/app/dist,readonly"); fi
  docker run --rm --network none --user 0 --mount type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock "${mounts[@]}" \
    --mount "type=bind,src=$dump,dst=/fixture-data,readonly" --mount "type=bind,src=$root/password,dst=/fixture-password,readonly" --mount "type=bind,src=$runner,dst=/fixture-agent-runner.mjs,readonly" \
    -e PATH=/usr/bin:/bin -e "SERVUS_IMPORT_SOURCE_ID=$source_id" -e "SERVUS_IMPORT_OPERATION=$id" -e "SERVUS_IMPORT_KIND=$kind" \
    --entrypoint /usr/local/bin/node "$SERVUS_IMPORT_IMAGE" /fixture-agent-runner.mjs
}
reject_import() {
  local status=0
  run_import "$@" >/dev/null 2>&1 || status=$?
  if [[ $status != 12 ]]; then printf 'Expected a fenced import failure, got status %s\n' "$status" >&2; return 1; fi
}
for kind in postgres mariadb; do
  if [[ $kind == postgres ]]; then image=postgres:17-alpine; else image=mariadb:11.4; fi
  service_id=11111111-1111-4111-8111-111111111111
  docker run -d --network none --label "servus.test=$id" --label panel.owner=self-hosted-panel --label "panel.service=$service_id" --label "com.docker.swarm.service.name=panel-app-$service_id" --name "$source_name" --env-file "$root/$kind.env" "$image" >/dev/null
  wait_ready "$source_name" "$kind"
  if [[ $kind == postgres ]]; then
    docker exec "$source_name" sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -X -h 127.0.0.1 -U fixture -d fixture -v ON_ERROR_STOP=1 -c "CREATE TABLE items (value text); INSERT INTO items VALUES ('\''expected-marker'\'');"' >/dev/null
    docker exec "$source_name" sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -h 127.0.0.1 -U fixture --format=custom --no-owner --no-privileges fixture' > "$root/dump"
  else
    docker exec "$source_name" sh -c 'MYSQL_PWD="$MARIADB_PASSWORD" mariadb -h 127.0.0.1 -u fixture fixture -e "CREATE TABLE items (value text); INSERT INTO items VALUES ('\''expected-marker'\'');"'
    docker exec "$source_name" sh -c 'MYSQL_PWD="$MARIADB_PASSWORD" mariadb-dump -h 127.0.0.1 -u fixture --single-transaction --quick --skip-lock-tables --no-tablespaces fixture' > "$root/dump"
  fi
  if [[ $kind == postgres ]]; then printf 'invalid archive' > "$root/bad-dump"; else printf 'CREATE TABLE partial (id INT);\nINVALID SQL;\n' > "$root/bad-dump"; fi
  reject_import "$kind" "$root/bad-dump"
  if [[ $kind == mariadb ]]; then
    partial=$(docker exec "$candidate_name" sh -c 'MYSQL_PWD="$(cat /run/secrets/panel-db-password)" mariadb -h 127.0.0.1 -u fixture fixture -N -e "SELECT count(*) FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name='\''partial'\''"')
    [[ $partial == 1 ]]
  fi
  docker rm -f -v "$candidate_name" >/dev/null; docker volume rm "$volume" >/dev/null
  reject_import "$kind" "$root/dump" "$(sha256sum "$root/dump" | cut -d' ' -f1)" 1
  docker rm -f -v "$candidate_name" >/dev/null; docker volume rm "$volume" >/dev/null
  reject_import "$kind" "$root/dump" "$(printf 'f%.0s' {1..64})"
  docker rm -f -v "$candidate_name" >/dev/null; docker volume rm "$volume" >/dev/null
  run_import "$kind" "$root/dump"
  docker inspect "$candidate_name" | python3 -c 'import pathlib,sys; secret=pathlib.Path(sys.argv[1]).read_bytes(); data=sys.stdin.buffer.read(); assert secret not in data, "Candidate metadata contains the fixture secret"' "$root/password"
  docker logs "$candidate_name" 2>&1 | python3 -c 'import pathlib,sys; secret=pathlib.Path(sys.argv[1]).read_bytes(); data=sys.stdin.buffer.read(); assert secret not in data, "Candidate logs contain the fixture secret"' "$root/password"
  if [[ $kind == postgres ]]; then
    result=$(docker exec "$candidate_name" sh -c 'PGPASSWORD="$(cat /run/secrets/panel-db-password)" psql -X -h 127.0.0.1 -U fixture -d fixture -tA -c "SELECT value FROM items"')
    source_result=$(docker exec "$source_name" sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -X -h 127.0.0.1 -U fixture -d fixture -tA -c "SELECT value FROM items"')
  else
    result=$(docker exec "$candidate_name" sh -c 'MYSQL_PWD="$(cat /run/secrets/panel-db-password)" mariadb -h 127.0.0.1 -u fixture fixture -N -e "SELECT value FROM items"')
    source_result=$(docker exec "$source_name" sh -c 'MYSQL_PWD="$MARIADB_PASSWORD" mariadb -h 127.0.0.1 -u fixture fixture -N -e "SELECT value FROM items"')
  fi
  [[ $result == expected-marker && $source_result == expected-marker ]]
  reject_import "$kind" "$root/dump" "$(sha256sum "$root/dump" | cut -d' ' -f1)" 0 1
  printf 'PASS %s isolated import and nonempty-target rejection\n' "$kind"
  docker rm -f -v "$candidate_name" >/dev/null; docker volume rm "$volume" >/dev/null
  run_agent_import "$kind" "$root/dump"
  if [[ $kind == postgres ]]; then
    result=$(docker exec "$candidate_name" sh -c 'PGPASSWORD="$(cat /run/secrets/panel-db-password)" psql -X -h 127.0.0.1 -U fixture -d fixture -tA -c "SELECT value FROM items"')
    source_result=$(docker exec "$source_name" sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -X -h 127.0.0.1 -U fixture -d fixture -tA -c "SELECT value FROM items"')
  else
    result=$(docker exec "$candidate_name" sh -c 'MYSQL_PWD="$(cat /run/secrets/panel-db-password)" mariadb -h 127.0.0.1 -u fixture fixture -N -e "SELECT value FROM items"')
    source_result=$(docker exec "$source_name" sh -c 'MYSQL_PWD="$MARIADB_PASSWORD" mariadb -h 127.0.0.1 -u fixture fixture -N -e "SELECT value FROM items"')
  fi
  [[ $result == expected-marker && $source_result == expected-marker ]]
  printf 'PASS %s agent upload and isolated preparation\n' "$kind"
  docker rm -f -v "$source_name" "$candidate_name" >/dev/null
  docker volume rm "$volume" >/dev/null
done
