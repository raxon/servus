#!/usr/bin/env bash
set -Eeuo pipefail

if [[ $# -ne 1 || -z $1 ]]; then
  printf 'Usage: %s IMAGE\n' "$0" >&2
  exit 2
fi
image=$1
architecture=$(docker image inspect --format '{{.Architecture}}' "$image")
if [[ $architecture != amd64 ]]; then
  printf 'Expected an amd64 image, got %s.\n' "$architecture" >&2
  exit 1
fi

scratch=$(mktemp -d)
container_id=
cleanup() {
  if [[ $container_id =~ ^[0-9a-f]{64}$ ]]; then
    docker rm -f "$container_id" >/dev/null 2>&1 || true
  fi
  rm -rf -- "$scratch"
}
trap cleanup EXIT

container_id=$(docker run -d --pull=never -p 127.0.0.1::4180 "$image")
[[ $container_id =~ ^[0-9a-f]{64}$ ]] || { printf 'Docker returned an invalid container ID.\n' >&2; exit 1; }
binding=$(docker port "$container_id" 4180/tcp)
if [[ ! $binding =~ ^127\.0\.0\.1:([0-9]+)$ ]]; then
  printf 'Could not determine the isolated test port.\n' >&2
  exit 1
fi
base="http://127.0.0.1:${BASH_REMATCH[1]}"
ready=0
for _ in $(seq 1 40); do
  if curl --silent --show-error --fail --max-time 2 "$base/api/v1/health" > "$scratch/health.json" 2>/dev/null; then ready=1; break; fi
  sleep 1
done
if (( ! ready )); then
  printf 'Image did not become ready.\n' >&2
  docker logs --tail 40 "$container_id" >&2 || true
  exit 1
fi
python3 - "$scratch/health.json" <<'PY'
import json, pathlib, sys
value = json.loads(pathlib.Path(sys.argv[1]).read_text())
if value.get('status') != 'ok' or not isinstance(value.get('version'), str):
    raise SystemExit('Image health response was invalid')
PY
curl --silent --show-error --fail --max-time 5 "$base/" > "$scratch/index.html"
python3 - "$scratch/index.html" <<'PY'
import pathlib, sys
if '<div id="root">' not in pathlib.Path(sys.argv[1]).read_text():
    raise SystemExit('Panel frontend was not served')
PY
curl --silent --show-error --fail --max-time 10 -c "$scratch/cookies" \
  -H 'Content-Type: application/json' \
  --data '{"email":"image-smoke@example.test","password":"image-smoke-password"}' \
  "$base/api/v1/setup" > "$scratch/setup.json"
curl --silent --show-error --fail --max-time 5 -b "$scratch/cookies" "$base/api/v1/auth/session" > "$scratch/session.json"
python3 - "$scratch/session.json" <<'PY'
import json, pathlib, sys
value = json.loads(pathlib.Path(sys.argv[1]).read_text())
if value.get('user', {}).get('email') != 'image-smoke@example.test':
    raise SystemExit('Image did not persist the setup session')
PY
printf 'Verified amd64 image startup, frontend, first setup and session.\n'
