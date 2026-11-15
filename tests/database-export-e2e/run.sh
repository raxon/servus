#!/usr/bin/env bash
# Exercise logical exports and restores using disposable databases only.
set -euo pipefail
for command in docker python3; do command -v "$command" >/dev/null || { printf 'Missing %s\n' "$command" >&2; exit 1; }; done
id=$(python3 -c 'import secrets; print(secrets.token_hex(16))')
root="/tmp/servus-db-export-$id"
mkdir -m 700 "$root"
names=("servus-db-export-$id-pg-source" "servus-db-export-$id-pg-target" "servus-db-export-$id-maria-source" "servus-db-export-$id-maria-target" "servus-db-export-$id-redis-source" "servus-db-export-$id-redis-target")
redis_volume="servus-db-export-$id-redis-data"
cleanup() {
  for name in "${names[@]}"; do
    if [[ $(docker inspect --format '{{ index .Config.Labels "servus.test" }}' "$name" 2>/dev/null || true) == "$id" ]]; then
      docker rm -f -v "$name" >/dev/null || printf 'Could not remove fixture %s\n' "$name" >&2
    fi
  done
  if [[ $(docker volume inspect --format '{{ index .Labels "servus.test" }}' "$redis_volume" 2>/dev/null || true) == "$id" ]]; then
    docker volume rm "$redis_volume" >/dev/null || printf 'Could not remove fixture volume %s\n' "$redis_volume" >&2
  fi
  python3 -c 'import re,shutil,sys; p=sys.argv[1]; assert re.fullmatch(r"/tmp/servus-db-export-[a-f0-9]{32}",p); shutil.rmtree(p)' "$root"
}
trap cleanup EXIT
password=$(python3 -c 'import secrets; print(secrets.token_hex(24))')
printf 'POSTGRES_DB=fixture\nPOSTGRES_USER=fixture\nPOSTGRES_PASSWORD=%s\n' "$password" > "$root/postgres.env"
printf 'MARIADB_DATABASE=fixture\nMARIADB_USER=fixture\nMARIADB_PASSWORD=%s\nMARIADB_ROOT_PASSWORD=%s\n' "$password" "$password" > "$root/mariadb.env"
printf 'REDIS_PASSWORD=%s\n' "$password" > "$root/redis.env"
printf '%s' "$password" > "$root/password"
chmod 600 "$root"/*.env "$root/password"
start() {
  docker run -d --network none --label "servus.test=$id" --name "$1" --env-file "$2" --mount "type=bind,src=$root/password,dst=/run/secrets/panel-db-password,readonly" "$3" >/dev/null
}
export_with_agent() {
  local container=$1 kind=$2 output=$3 container_id module
  local -a mounts=()
  [[ -n ${SERVUS_EXPORT_SOURCE:-} && -n ${SERVUS_EXPORT_IMAGE:-} ]] || return 1
  container_id=$(docker inspect --format '{{.Id}}' "$container")
  if [[ $SERVUS_EXPORT_SOURCE == image ]]; then module=/app/dist/agent/database-export.js; else
    module=/fixture-export.ts; mounts+=(--mount "type=bind,src=$SERVUS_EXPORT_SOURCE,dst=$module,readonly")
  fi
  docker run --rm --network none --user 0 --mount type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock \
    "${mounts[@]}" -e "SERVUS_EXPORT_CONTAINER=$container_id" -e "SERVUS_EXPORT_KIND=$kind" -e "SERVUS_EXPORT_MODULE=$module" --entrypoint node "$SERVUS_EXPORT_IMAGE" \
    --input-type=module -e 'import {pipeline} from "node:stream/promises"; const {exportDatabase}=await import(process.env.SERVUS_EXPORT_MODULE); const result=await exportDatabase({containerId:process.env.SERVUS_EXPORT_CONTAINER,dockerSocket:"/var/run/docker.sock",kind:process.env.SERVUS_EXPORT_KIND,database:"fixture",user:"fixture"}); try {await pipeline(result.stream(),process.stdout,{end:false});} finally {result.close();}' > "$output"
}
wait_ready() {
  local name=$1 kind=$2
  for _ in $(seq 1 90); do
    if [[ $kind == postgres ]]; then
      if docker exec "$name" pg_isready -q -h 127.0.0.1 -U fixture -d fixture; then return; fi
    elif [[ $kind == redis ]]; then
      if docker exec "$name" sh -c 'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli --raw PING' 2>/dev/null | grep -qx PONG; then return; fi
    elif docker exec "$name" sh -c 'MYSQL_PWD="$MARIADB_PASSWORD" mariadb -h 127.0.0.1 -u fixture fixture -N -e "SELECT 1"' >/dev/null 2>&1; then return; fi
    sleep 1
  done
  printf 'Database fixture did not become ready: %s\n' "$name" >&2; return 1
}
start "${names[0]}" "$root/postgres.env" postgres:17-alpine
start "${names[1]}" "$root/postgres.env" postgres:17-alpine
wait_ready "${names[0]}" postgres; wait_ready "${names[1]}" postgres
docker exec -i "${names[0]}" sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -h 127.0.0.1 -U fixture -d fixture -v ON_ERROR_STOP=1' >/dev/null <<'SQL'
CREATE TABLE items (id integer PRIMARY KEY, title text NOT NULL);
INSERT INTO items VALUES (1,'hello'),(2,'Zażółć gęślą jaźń');
CREATE TABLE empty_items (id integer PRIMARY KEY);
SQL
if [[ -n ${SERVUS_EXPORT_SOURCE:-} ]]; then export_with_agent "${names[0]}" postgres "$root/postgres.dump"; else
  docker exec "${names[0]}" sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -h 127.0.0.1 -U fixture --format=custom --no-owner --no-privileges fixture' > "$root/postgres.dump"
fi
test -s "$root/postgres.dump"
docker exec -i "${names[1]}" sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" pg_restore -h 127.0.0.1 -U fixture -d fixture --exit-on-error --no-owner --no-privileges' < "$root/postgres.dump"
result=$(docker exec "${names[1]}" sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -h 127.0.0.1 -U fixture -d fixture -At -v ON_ERROR_STOP=1 -c "SELECT count(*) || '\''|'\'' || (SELECT title FROM items WHERE id=2) || '\''|'\'' || (SELECT count(*) FROM empty_items) FROM items"')
[[ $result == '2|Zażółć gęślą jaźń|0' ]]
docker rm -f -v "${names[0]}" "${names[1]}" >/dev/null
printf 'PASS PostgreSQL logical export and restore\n'
start "${names[2]}" "$root/mariadb.env" mariadb:11.4
start "${names[3]}" "$root/mariadb.env" mariadb:11.4
wait_ready "${names[2]}" mariadb; wait_ready "${names[3]}" mariadb
docker exec -i "${names[2]}" sh -c 'MYSQL_PWD="$MARIADB_PASSWORD" mariadb -h 127.0.0.1 -u fixture --default-character-set=utf8mb4 fixture' <<'SQL'
CREATE TABLE items (id integer PRIMARY KEY, title varchar(100) NOT NULL) CHARACTER SET utf8mb4;
INSERT INTO items VALUES (1,'hello'),(2,'Zażółć gęślą jaźń');
CREATE TABLE empty_items (id integer PRIMARY KEY);
SQL
if [[ -n ${SERVUS_EXPORT_SOURCE:-} ]]; then export_with_agent "${names[2]}" mariadb "$root/mariadb.sql"; else
  docker exec "${names[2]}" sh -c 'MYSQL_PWD="$MARIADB_PASSWORD" mariadb-dump -h 127.0.0.1 -u fixture --single-transaction --quick --skip-lock-tables --no-tablespaces --default-character-set=utf8mb4 fixture' > "$root/mariadb.sql"
fi
test -s "$root/mariadb.sql"
docker exec -i "${names[3]}" sh -c 'MYSQL_PWD="$MARIADB_PASSWORD" mariadb -h 127.0.0.1 -u fixture --default-character-set=utf8mb4 fixture' < "$root/mariadb.sql"
result=$(docker exec "${names[3]}" sh -c 'MYSQL_PWD="$MARIADB_PASSWORD" mariadb -h 127.0.0.1 -u fixture --default-character-set=utf8mb4 fixture -N -e "SELECT CONCAT(COUNT(*), '\''|'\'', (SELECT title FROM items WHERE id=2), '\''|'\'', (SELECT COUNT(*) FROM empty_items)) FROM items"')
[[ $result == '2|Zażółć gęślą jaźń|0' ]]
printf 'PASS MariaDB logical export and restore\n'
docker rm -f -v "${names[2]}" "${names[3]}" >/dev/null
docker run -d --network none --label "servus.test=$id" --name "${names[4]}" --env-file "$root/redis.env" --mount "type=bind,src=$root/password,dst=/run/secrets/panel-db-password,readonly" redis:7-alpine sh -c 'exec redis-server --appendonly yes --requirepass "$REDIS_PASSWORD"' >/dev/null
wait_ready "${names[4]}" redis
docker exec "${names[4]}" sh -c 'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli SET message "Zażółć gęślą jaźń"' >/dev/null
docker exec "${names[4]}" sh -c 'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli HSET metadata version 1' >/dev/null
if [[ -n ${SERVUS_EXPORT_SOURCE:-} ]]; then export_with_agent "${names[4]}" redis "$root/redis.rdb"; else
  docker exec "${names[4]}" sh -c 'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli --rdb -' > "$root/redis.rdb"
fi
test -s "$root/redis.rdb"; chmod 644 "$root/redis.rdb"
docker volume create --label "servus.test=$id" "$redis_volume" >/dev/null
docker create --network none --label "servus.test=$id" --name "${names[5]}" --env-file "$root/redis.env" --mount "type=volume,src=$redis_volume,dst=/data" redis:7-alpine sh -c 'exec redis-server --appendonly no --requirepass "$REDIS_PASSWORD"' >/dev/null
docker cp "$root/redis.rdb" "${names[5]}:/data/dump.rdb"
docker start "${names[5]}" >/dev/null
wait_ready "${names[5]}" redis
for stage in 1 2; do
  if [[ $(docker exec "${names[5]}" sh -c 'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli --raw GET message') != 'Zażółć gęślą jaźń' ]]; then
    printf 'Redis snapshot data was not restored\n' >&2; docker logs "${names[5]}" >&2; exit 1
  fi
  [[ $(docker exec "${names[5]}" sh -c 'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli --raw HGET metadata version') == 1 ]]
  if [[ $stage == 1 ]]; then
    docker exec "${names[5]}" sh -c 'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli CONFIG SET appendonly yes' | grep -qx OK
    complete=0
    for _ in $(seq 1 90); do
      info=$(docker exec "${names[5]}" sh -c 'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli --raw INFO persistence' | tr -d '\r')
      if grep -qx 'aof_enabled:1' <<<"$info" && grep -qx 'aof_rewrite_in_progress:0' <<<"$info" && grep -qx 'aof_rewrite_scheduled:0' <<<"$info" && grep -qx 'aof_last_bgrewrite_status:ok' <<<"$info"; then complete=1; break; fi
      sleep 1
    done
    [[ $complete == 1 ]] || { printf 'Redis AOF conversion did not complete\n' >&2; exit 1; }
    docker stop "${names[5]}" >/dev/null; docker rm "${names[5]}" >/dev/null
    docker run -d --network none --label "servus.test=$id" --name "${names[5]}" --env-file "$root/redis.env" --mount "type=volume,src=$redis_volume,dst=/data" redis:7-alpine sh -c 'exec redis-server --appendonly yes --requirepass "$REDIS_PASSWORD"' >/dev/null
    wait_ready "${names[5]}" redis
  fi
done
printf 'PASS Redis snapshot restore and AOF restart\n'
