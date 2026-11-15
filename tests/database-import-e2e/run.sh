#!/usr/bin/env bash
set -euo pipefail
: "${SERVUS_IMPORT_IMAGE:?Set SERVUS_IMPORT_IMAGE to a test image containing Node and Docker CLI}"
: "${SERVUS_IMPORT_SOURCE:?Set SERVUS_IMPORT_SOURCE to the candidate import module}"
id=$(python3 -c 'import secrets; print(secrets.token_hex(16))')
root="/tmp/servus-db-import-$id"
source_name="servus-import-$id-source"
candidate_name="servus-import-$id-candidate"
volume="panel-restore-$id"
mkdir -m 700 "$root"
cleanup() {
  for name in "$source_name" "$candidate_name"; do
    if [[ $(docker inspect --format '{{ index .Config.Labels "servus.test" }}' "$name" 2>/dev/null || true) == "$id" ]]; then docker rm -f -v "$name" >/dev/null; fi
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
  local kind=$1 dump=$2 target module
  local -a mounts=()
  target=$(docker inspect --format '{{.Id}}' "$candidate_name")
  if [[ $SERVUS_IMPORT_SOURCE == image ]]; then module=/app/dist/agent/database-import.js; else
    module=/fixture-import.ts; mounts+=(--mount "type=bind,src=$SERVUS_IMPORT_SOURCE,dst=$module,readonly")
  fi
  docker run --rm --network none --user 0 --mount type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock \
    "${mounts[@]}" \
    --mount "type=bind,src=$dump,dst=/fixture-data,readonly" \
    -e PATH=/usr/bin:/bin -e "SERVUS_IMPORT_CONTAINER=$target" -e "SERVUS_IMPORT_OPERATION=$id" -e "SERVUS_IMPORT_KIND=$kind" -e "SERVUS_IMPORT_MODULE=$module" \
    --entrypoint /usr/local/bin/node "$SERVUS_IMPORT_IMAGE" --input-type=module -e 'import {createReadStream} from "node:fs";const {importDatabaseCandidate}=await import(process.env.SERVUS_IMPORT_MODULE);await importDatabaseCandidate({containerId:process.env.SERVUS_IMPORT_CONTAINER,dockerSocket:"/var/run/docker.sock",operationId:process.env.SERVUS_IMPORT_OPERATION,kind:process.env.SERVUS_IMPORT_KIND,database:"fixture",user:"fixture",input:()=>createReadStream("/fixture-data")});'
}
for kind in postgres mariadb; do
  if [[ $kind == postgres ]]; then image=postgres:17-alpine; data=/var/lib/postgresql/data; else image=mariadb:11.4; data=/var/lib/mysql; fi
  docker run -d --network none --label "servus.test=$id" --name "$source_name" --env-file "$root/$kind.env" "$image" >/dev/null
  start_candidate() {
    docker volume create --label "panel.restore.operation=$id" --label panel.restore.purpose=candidate "$volume" >/dev/null
    docker run -d --network none --label "servus.test=$id" --label "panel.restore.operation=$id" --name "$candidate_name" \
      --env-file "$root/$kind.env" --mount "type=volume,src=$volume,dst=$data" --mount "type=bind,src=$root/password,dst=/run/secrets/panel-db-password,readonly" "$image" >/dev/null
    wait_ready "$candidate_name" "$kind"
  }
  wait_ready "$source_name" "$kind"; start_candidate
  if [[ $kind == postgres ]]; then
    docker exec "$source_name" sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -X -h 127.0.0.1 -U fixture -d fixture -v ON_ERROR_STOP=1 -c "CREATE TABLE items (value text); INSERT INTO items VALUES ('\''expected-marker'\'');"' >/dev/null
    docker exec "$source_name" sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -h 127.0.0.1 -U fixture --format=custom --no-owner --no-privileges fixture' > "$root/dump"
  else
    docker exec "$source_name" sh -c 'MYSQL_PWD="$MARIADB_PASSWORD" mariadb -h 127.0.0.1 -u fixture fixture -e "CREATE TABLE items (value text); INSERT INTO items VALUES ('\''expected-marker'\'');"'
    docker exec "$source_name" sh -c 'MYSQL_PWD="$MARIADB_PASSWORD" mariadb-dump -h 127.0.0.1 -u fixture --single-transaction --quick --skip-lock-tables --no-tablespaces fixture' > "$root/dump"
  fi
  if [[ $kind == postgres ]]; then printf 'invalid archive' > "$root/bad-dump"; else printf 'CREATE TABLE partial (id INT);\nINVALID SQL;\n' > "$root/bad-dump"; fi
  if run_import "$kind" "$root/bad-dump" >/dev/null 2>&1; then printf 'Invalid import was accepted\n' >&2; exit 1; fi
  if [[ $kind == mariadb ]]; then
    partial=$(docker exec "$candidate_name" sh -c 'MYSQL_PWD="$MARIADB_PASSWORD" mariadb -h 127.0.0.1 -u fixture fixture -N -e "SELECT count(*) FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name='\''partial'\''"')
    [[ $partial == 1 ]]
  fi
  docker rm -f -v "$candidate_name" >/dev/null; docker volume rm "$volume" >/dev/null
  start_candidate
  run_import "$kind" "$root/dump"
  if [[ $kind == postgres ]]; then
    result=$(docker exec "$candidate_name" sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -X -h 127.0.0.1 -U fixture -d fixture -tA -c "SELECT value FROM items"')
  else
    result=$(docker exec "$candidate_name" sh -c 'MYSQL_PWD="$MARIADB_PASSWORD" mariadb -h 127.0.0.1 -u fixture fixture -N -e "SELECT value FROM items"')
  fi
  [[ $result == expected-marker ]]
  if run_import "$kind" "$root/dump" >/dev/null 2>&1; then printf 'Nonempty candidate was accepted\n' >&2; exit 1; fi
  printf 'PASS %s isolated import and nonempty-target rejection\n' "$kind"
  docker rm -f -v "$source_name" "$candidate_name" >/dev/null
  docker volume rm "$volume" >/dev/null
done
