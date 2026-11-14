#!/bin/bash
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd -P)
suffix=$(openssl rand -hex 8)
profile="servus-backup-e2e-$suffix"
context="colima-$profile"
image="servus-backup-e2e:$suffix"
temporary=$(mktemp -d "${TMPDIR:-/tmp}/servus-backup-e2e.XXXXXXXX")
created=0
cleanup() {
  local result=$?
  trap - EXIT INT TERM
  if [ "$created" = 1 ]; then
    if ! colima delete "$profile" --force --data; then printf '%s\n' "Fixture cleanup failed for $profile" >&2; result=1; fi
  fi
  rm -rf -- "$temporary"
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
if [ -e "$HOME/.colima/$profile" ] || [ -L "$HOME/.colima/$profile" ]; then
  printf '%s\n' 'Disposable profile already exists.' >&2
  exit 1
fi
created=1
printf 'Disposable fixture profile: %s\n' "$profile"
printf 'Temporary build directory: %s\n' "$temporary"
colima start "$profile" --activate=false --ssh-config=false --cpus 2 --memory 3 --disk 18 --mount none
docker --context "$context" swarm init >/dev/null
mkdir -p "$temporary/source" "$temporary/utility"
git -C "$root" archive HEAD | tar -x -C "$temporary/source"
cp "$root/apps/updater/backup.py" "$temporary/utility/backup.py"
cp "$root/tests/backup-mariadb-e2e/capture.py" "$temporary/utility/capture.py"
docker --context "$context" build -t "$image" -f "$temporary/source/Dockerfile" "$temporary/source"
cat > "$temporary/utility/Dockerfile" <<EOF
FROM python:3.12-slim-bookworm AS python
FROM $image
USER root
COPY --from=python /usr/local/bin/python3.12 /usr/local/bin/python3.12
COPY --from=python /usr/local/lib/python3.12 /usr/local/lib/python3.12
COPY --from=python /usr/local/lib/libpython3.12.so.1.0 /usr/local/lib/libpython3.12.so.1.0
COPY backup.py capture.py /fixture/
RUN apt-get update && apt-get install -y --no-install-recommends libsqlite3-0 && rm -rf /var/lib/apt/lists/* && /usr/local/bin/python3.12 -I -c 'import sqlite3'
EOF
docker --context "$context" build -t "$image-utility" "$temporary/utility"
SERVUS_BACKUP_E2E_PROFILE="$profile" SERVUS_BACKUP_E2E_IMAGE="$image" SERVUS_BACKUP_E2E_UTILITY="$image-utility" \
  "$root/node_modules/.bin/tsx" "$root/tests/backup-mariadb-e2e/verify.ts"
