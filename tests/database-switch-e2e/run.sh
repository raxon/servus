#!/usr/bin/env bash
set -euo pipefail
: "${SERVUS_IMPORT_IMAGE:?Set SERVUS_IMPORT_IMAGE to a test image containing Node and Docker CLI}"
id=$(python3 -c 'import secrets; print(secrets.token_hex(16))')
kind=${SERVUS_SWITCH_KIND:-postgres}
binding_test=${SERVUS_SWITCH_BINDING:-0}
[[ $kind == postgres || $kind == mariadb ]]
service_id=$(python3 -c 'import uuid; print(uuid.uuid4())')
root="/tmp/servus-db-switch-$id"
service="panel-app-$service_id"
source_volume="panel-data-$service_id-database"
candidate="panel-restore-$id"
created_swarm=0
mkdir -m 700 "$root"
cleanup() {
  if [[ $(docker service inspect --format '{{ index .Spec.Labels "panel.service" }}' "$service" 2>/dev/null || true) == "$service_id" && $(docker service inspect --format '{{ index .Spec.Labels "panel.owner" }}' "$service" 2>/dev/null || true) == self-hosted-panel ]]; then docker service rm "$service" >/dev/null; fi
  for container in $(docker ps -aq --filter "label=com.docker.swarm.service.name=$service"); do
    if [[ $(docker inspect --format '{{ index .Config.Labels "panel.service" }}' "$container" 2>/dev/null || true) == "$service_id" ]]; then docker rm -f "$container" >/dev/null 2>&1 || true; fi
  done
  for container in $(docker ps -aq --filter "label=panel.restore.service=$service_id" --filter label=panel.restore.purpose=candidate); do
    if [[ $(docker inspect --format '{{ index .Config.Labels "panel.restore.service" }}' "$container" 2>/dev/null || true) == "$service_id" ]]; then docker rm -f "$container" >/dev/null 2>&1 || true; fi
  done
  if [[ $(docker inspect --format '{{ index .Config.Labels "panel.restore.operation" }}' "$candidate" 2>/dev/null || true) == "$id" ]]; then docker rm -f "$candidate" >/dev/null; fi
  if [[ $(docker volume inspect --format '{{ index .Labels "panel.restore.operation" }}' "$candidate" 2>/dev/null || true) == "$id" ]]; then docker volume rm "$candidate" >/dev/null; fi
  for volume in $(docker volume ls -q --filter "label=panel.restore.service=$service_id" --filter label=panel.restore.purpose=candidate); do
    if [[ $(docker volume inspect --format '{{ index .Labels "panel.restore.service" }}' "$volume" 2>/dev/null || true) == "$service_id" ]]; then docker volume rm "$volume" >/dev/null; fi
  done
  if [[ $(docker volume inspect --format '{{ index .Labels "servus.test" }}' "$source_volume" 2>/dev/null || true) == "$id" ]]; then docker volume rm "$source_volume" >/dev/null; fi
  for secret in $(docker secret ls -q --filter "label=panel.service=$service_id"); do docker secret rm "$secret" >/dev/null; done
  if [[ -s "$root/project" ]]; then
    project_id=$(cat "$root/project"); [[ $project_id =~ ^[a-f0-9-]{36}$ ]]
    network="panel-project-$project_id"
    if [[ $(docker network inspect --format '{{ index .Labels "panel.project" }}' "$network" 2>/dev/null || true) == "$project_id" ]]; then docker network rm "$network" >/dev/null; fi
  fi
  if [[ $created_swarm == 1 ]]; then docker swarm leave --force >/dev/null; fi
  python3 -c 'import re,shutil,sys; p=sys.argv[1]; assert re.fullmatch(r"/tmp/servus-db-switch-[a-f0-9]{32}",p); shutil.rmtree(p)' "$root"
}
trap cleanup EXIT
if [[ $(docker info --format '{{.Swarm.LocalNodeState}}') != active ]]; then docker swarm init --advertise-addr 127.0.0.1 >/dev/null; created_swarm=1; fi
node_id=$(docker info --format '{{.Swarm.NodeID}}')
password=$(python3 -c 'import secrets; print(secrets.token_hex(24))')
printf '%s' "$password" > "$root/password"; chmod 600 "$root/password"
touch "$root/project"; chmod 600 "$root/project"
docker volume create --label "servus.test=$id" --label panel.owner=self-hosted-panel --label "panel.service=$service_id" "$source_volume" >/dev/null
if [[ $kind == postgres ]]; then
  image=postgres:17-alpine; data_path=/var/lib/postgresql/data
  database_env=(--env POSTGRES_DB=fixture --env POSTGRES_USER=fixture --env "POSTGRES_PASSWORD=$password")
else
  image=mariadb:11.4; data_path=/var/lib/mysql
  database_env=(--env MARIADB_DATABASE=fixture --env MARIADB_USER=fixture --env "MARIADB_PASSWORD=$password" --env "MARIADB_ROOT_PASSWORD=$password")
fi
docker service create --quiet --name "$service" --no-resolve-image --replicas 1 --update-order stop-first --constraint "node.id==$node_id" \
  --label "servus.test=$id" --label panel.owner=self-hosted-panel --label "panel.service=$service_id" --label "panel.kind=$kind" \
  --container-label "servus.test=$id" --container-label panel.owner=self-hosted-panel --container-label "panel.service=$service_id" \
  --mount "type=volume,source=$source_volume,target=$data_path" "${database_env[@]}" "$image" >/dev/null
source_id=''
ready() {
  if [[ $kind == postgres ]]; then docker exec "$source_id" pg_isready -q -h 127.0.0.1 -U fixture -d fixture
  else docker exec "$source_id" sh -c 'MYSQL_PWD="$MARIADB_PASSWORD" mariadb -h 127.0.0.1 -u fixture fixture -N -e "SELECT 1"' >/dev/null 2>&1; fi
}
for _ in $(seq 1 90); do
  source_id=$(docker ps -q --no-trunc --filter "label=com.docker.swarm.service.name=$service" | head -1)
  if [[ -n $source_id ]] && ready; then break; fi
  sleep 1
done
[[ -n $source_id ]] && ready
if [[ $kind == postgres ]]; then
  docker exec "$source_id" sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -X -h 127.0.0.1 -U fixture -d fixture -v ON_ERROR_STOP=1 -c "CREATE TABLE items (value text); INSERT INTO items VALUES ('\''expected-marker'\'');"' >/dev/null
  docker exec "$source_id" sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -h 127.0.0.1 -U fixture --format=custom --no-owner --no-privileges fixture' > "$root/dump"
  docker exec "$source_id" sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -X -h 127.0.0.1 -U fixture -d fixture -v ON_ERROR_STOP=1 -c "INSERT INTO items VALUES ('\''source-after-backup'\'');"' >/dev/null
else
  docker exec "$source_id" sh -c 'MYSQL_PWD="$MARIADB_PASSWORD" mariadb -h 127.0.0.1 -u fixture fixture -e "CREATE TABLE items (value text); INSERT INTO items VALUES ('\''expected-marker'\'');"'
  docker exec "$source_id" sh -c 'MYSQL_PWD="$MARIADB_PASSWORD" mariadb-dump -h 127.0.0.1 -u fixture --single-transaction --quick --skip-lock-tables --no-tablespaces fixture' > "$root/dump"
  docker exec "$source_id" sh -c 'MYSQL_PWD="$MARIADB_PASSWORD" mariadb -h 127.0.0.1 -u fixture fixture -e "INSERT INTO items VALUES ('\''source-after-backup'\'');"'
fi
runner=$(cd "$(dirname "$0")/../database-import-e2e" && pwd)/agent-runner.mjs
mounts=()
if [[ -n ${SERVUS_IMPORT_DIST:-} ]]; then mounts+=(--mount "type=bind,src=$SERVUS_IMPORT_DIST,dst=/app/dist,readonly"); fi
docker run --rm --network none --user 0 --mount type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock "${mounts[@]}" \
  --mount "type=bind,src=$root/dump,dst=/fixture-data,readonly" --mount "type=bind,src=$root/password,dst=/fixture-password,readonly" --mount "type=bind,src=$root/project,dst=/fixture-project" --mount "type=bind,src=$runner,dst=/fixture-agent-runner.mjs,readonly" \
  -e PATH=/usr/bin:/bin -e "SERVUS_IMPORT_SOURCE_ID=$source_id" -e "SERVUS_IMPORT_SERVICE_ID=$service_id" -e "SERVUS_IMPORT_OPERATION=$id" -e "SERVUS_IMPORT_KIND=$kind" -e "SERVUS_SWITCH_BINDING=$binding_test" -e SERVUS_SWITCH_INSPECT=1 -e SERVUS_SWITCH_APPLY=1 \
  --entrypoint /usr/local/bin/node "$SERVUS_IMPORT_IMAGE" /fixture-agent-runner.mjs
source_id=$(docker ps -q --no-trunc --filter "label=com.docker.swarm.service.name=$service" --filter "volume=$source_volume" | head -1)
[[ -n $source_id ]]
for _ in $(seq 1 90); do if ready; then break; fi; sleep 1; done
ready
if [[ $kind == postgres ]]; then
  source_result=$(docker exec "$source_id" sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -X -h 127.0.0.1 -U fixture -d fixture -tA -c "SELECT string_agg(value, '\'','\'' ORDER BY value) FROM items"')
else
  source_result=$(docker exec "$source_id" sh -c 'MYSQL_PWD="$MARIADB_PASSWORD" mariadb -h 127.0.0.1 -u fixture fixture -N -e "SELECT GROUP_CONCAT(value ORDER BY value SEPARATOR '\'','\'') FROM items"')
fi
[[ $source_result == expected-marker,source-after-backup ]]
! docker inspect "$candidate" >/dev/null 2>&1
for container in $(docker ps -aq --filter "volume=$candidate"); do
  [[ $(docker inspect --format '{{ index .Config.Labels "panel.service" }}' "$container") == "$service_id" ]]
  [[ $(docker inspect --format '{{.State.Running}}' "$container") == false ]]
  docker rm "$container" >/dev/null
done
[[ $(docker volume inspect --format '{{ index .Labels "panel.restore.operation" }}' "$candidate") == "$id" ]]
docker volume rm "$candidate" >/dev/null
printf 'PASS %s Swarm switch, target verification and fixture rollback (binding=%s)\n' "$kind" "$binding_test"
