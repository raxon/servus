#!/usr/bin/env bash
# Publish only the locally verified release image and capture its registry digest.
set -euo pipefail
[[ $# == 4 ]] || { printf 'Expected image, version, image ID and log path.\n' >&2; exit 1; }
image=$1 version=$2 expected_id=$3 log=$4
[[ $image == ghcr.io/raxon/servus && $version =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ && $expected_id =~ ^sha256:[a-f0-9]{64}$ && -n $log && -n ${GITHUB_OUTPUT:-} ]] || { printf 'Invalid release push parameters.\n' >&2; exit 1; }
success=0
for attempt in 1 2 3; do
  [[ $(docker image inspect --format '{{.Id}}' "$image:$version") == "$expected_id" ]] || { printf 'Image tag no longer references the tested image.\n' >&2; exit 1; }
  if docker push "$image:$version" | tee "$log"; then success=1; break; fi
  if ((attempt < 3)); then printf 'Registry push failed; retrying.\n' >&2; sleep "$((attempt * 2))"; fi
done
((success == 1)) || { printf 'Registry push failed after three attempts.\n' >&2; exit 1; }
digest=$(sed -nE 's/.*digest: (sha256:[0-9a-f]{64}).*/\1/p' "$log" | tail -n 1)
[[ $digest =~ ^sha256:[a-f0-9]{64}$ ]] || { printf 'Registry did not return an image digest.\n' >&2; exit 1; }
printf 'digest=%s\n' "$digest" >> "$GITHUB_OUTPUT"
