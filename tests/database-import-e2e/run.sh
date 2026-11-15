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
  local kind=$1 dump=$2 target module journal_module preparation_module digest
  local -a mounts=()
  target=$(docker inspect --format '{{.Id}}' "$candidate_name")
  digest=${3:-$(sha256sum "$dump" | cut -d' ' -f1)}
  if [[ $SERVUS_IMPORT_SOURCE == image ]]; then
    module=/app/dist/agent/database-import.js; journal_module=/app/dist/agent/restore-journal.js; preparation_module=/app/dist/agent/restore-preparation.js
  else
    module=/fixture-import.ts; journal_module=/fixture-journal.ts; preparation_module=/fixture-preparation.ts
    mounts+=(--mount "type=bind,src=$SERVUS_IMPORT_SOURCE,dst=$module,readonly" --mount "type=bind,src=$(dirname "$SERVUS_IMPORT_SOURCE")/restore-journal.ts,dst=$journal_module,readonly" --mount "type=bind,src=$(dirname "$SERVUS_IMPORT_SOURCE")/restore-preparation.ts,dst=$preparation_module,readonly")
  fi
  docker run --rm --network none --user 0 --mount type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock \
    "${mounts[@]}" \
    --mount "type=bind,src=$dump,dst=/fixture-data,readonly" \
    -e PATH=/usr/bin:/bin -e "SERVUS_IMPORT_CONTAINER=$target" -e "SERVUS_IMPORT_OPERATION=$id" -e "SERVUS_IMPORT_KIND=$kind" -e "SERVUS_IMPORT_MODULE=$module" -e "SERVUS_IMPORT_JOURNAL=$journal_module" -e "SERVUS_IMPORT_PREPARATION=$preparation_module" -e "SERVUS_IMPORT_SHA256=$digest" \
    --entrypoint /usr/local/bin/node "$SERVUS_IMPORT_IMAGE" --input-type=module -e 'import {createReadStream} from "node:fs";import Database from "/app/node_modules/better-sqlite3/lib/index.js";const {importDatabaseCandidate}=await import(process.env.SERVUS_IMPORT_MODULE);const {RestoreJournal}=await import(process.env.SERVUS_IMPORT_JOURNAL);const {prepareRestoreCandidate}=await import(process.env.SERVUS_IMPORT_PREPARATION);const db=new Database(":memory:");db.exec("CREATE TABLE operations(id TEXT PRIMARY KEY,service_id TEXT,state TEXT)");const journal=new RestoreJournal(db,()=>false),operationId=process.env.SERVUS_IMPORT_OPERATION,serviceId="11111111-1111-4111-8111-111111111111";journal.reserve({id:operationId,serviceId,kind:process.env.SERVUS_IMPORT_KIND,archiveSha256:process.env.SERVUS_IMPORT_SHA256});try{const result=await prepareRestoreCandidate({journal,operationId,serviceId,importCandidate:importDatabaseCandidate,target:{containerId:process.env.SERVUS_IMPORT_CONTAINER,dockerSocket:"/var/run/docker.sock",database:"fixture",user:"fixture",input:()=>createReadStream("/fixture-data")}});if(result.phase!=="prepared")throw Error("Candidate is not prepared");}catch{process.exitCode=journal.get(operationId)?.phase==="needs_review"?12:2;}finally{db.close();}'
}
reject_import() {
  local status=0
  run_import "$@" >/dev/null 2>&1 || status=$?
  if [[ $status != 12 ]]; then printf 'Expected a fenced import failure, got status %s\n' "$status" >&2; return 1; fi
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
  reject_import "$kind" "$root/bad-dump"
  if [[ $kind == mariadb ]]; then
    partial=$(docker exec "$candidate_name" sh -c 'MYSQL_PWD="$MARIADB_PASSWORD" mariadb -h 127.0.0.1 -u fixture fixture -N -e "SELECT count(*) FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name='\''partial'\''"')
    [[ $partial == 1 ]]
  fi
  docker rm -f -v "$candidate_name" >/dev/null; docker volume rm "$volume" >/dev/null
  start_candidate
  reject_import "$kind" "$root/dump" "$(printf 'f%.0s' {1..64})"
  docker rm -f -v "$candidate_name" >/dev/null; docker volume rm "$volume" >/dev/null
  start_candidate
  run_import "$kind" "$root/dump"
  if [[ $kind == postgres ]]; then
    result=$(docker exec "$candidate_name" sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -X -h 127.0.0.1 -U fixture -d fixture -tA -c "SELECT value FROM items"')
  else
    result=$(docker exec "$candidate_name" sh -c 'MYSQL_PWD="$MARIADB_PASSWORD" mariadb -h 127.0.0.1 -u fixture fixture -N -e "SELECT value FROM items"')
  fi
  [[ $result == expected-marker ]]
  reject_import "$kind" "$root/dump"
  printf 'PASS %s isolated import and nonempty-target rejection\n' "$kind"
  docker rm -f -v "$source_name" "$candidate_name" >/dev/null
  docker volume rm "$volume" >/dev/null
done
