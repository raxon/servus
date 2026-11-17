#!/usr/bin/env bash
# Verify packaged tools through the actual production lifecycle entrypoint.
set -euo pipefail
image=${1:?Specify the tested image}
context=${DOCKER_CONTEXT:-default}
case "$context" in
  colima-panel-dev|colima-servus-update-e2e-*) ;;
  default)
    if [[ ${GITHUB_ACTIONS:-} == true && ${RUNNER_ENVIRONMENT:-} == github-hosted ]]; then :
    elif [[ $(uname -s) == Linux && $EUID == 0 && $(hostname) == colima-servus-update-e2e-* ]]; then
      [[ $(docker context inspect default --format '{{.Endpoints.docker.Host}}') == unix:///var/run/docker.sock ]] || exit 1
    else printf 'An isolated test context is required.\n' >&2; exit 1; fi;;
  *) printf 'An isolated test context is required.\n' >&2; exit 1;;
esac
run_id=$(openssl rand -hex 16)
volume="servus-lifecycle-tools-$run_id"
created=0
cleanup() {
  local result=$?
  trap - EXIT
  if [ "$created" = 1 ]; then
    owner=$(docker --context "$context" volume inspect --format '{{index .Labels "servus.fixture"}}' "$volume")
    if [ "$owner" = "$run_id" ]; then docker --context "$context" volume rm "$volume" >/dev/null || result=1
    else printf 'Refusing to remove an unowned tool fixture volume.\n' >&2; result=1; fi
  fi
  exit "$result"
}
trap cleanup EXIT
docker --context "$context" image inspect "$image" >/dev/null
docker --context "$context" volume create --label "servus.fixture=$run_id" "$volume" >/dev/null
created=1
docker --context "$context" run --rm --pull=never --network none --read-only --user root \
  --mount "type=volume,source=$volume,target=/run/servus-lifecycle" --entrypoint /bin/sh "$image" -ec \
  "chmod 755 /run/servus-lifecycle; : > /run/servus-lifecycle/lock; printf 'servus-lifecycle-v1 normal\\n' > /run/servus-lifecycle/state; chmod 644 /run/servus-lifecycle/lock /run/servus-lifecycle/state"
docker --context "$context" run --rm --pull=never --network none --read-only --user 1000:1000 \
  --mount "type=volume,source=$volume,target=/run/servus-lifecycle,readonly" \
  --env PATH=/untrusted-path --entrypoint /bin/sh "$image" /app/lifecycle-gate.sh \
  --input-type=module -e '
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
assert.equal(process.env.PATH,"/usr/bin:/bin");
for(const [tool,args,pattern] of [
  ["docker",["--version"],/^Docker version /],
  ["docker",["compose","version","--short"],/^v?\d+\./],
  ["docker",["buildx","version"],/buildx.*v?\d+\./],
  ["git",["--version"],/^git version /],
  ["ssh",["-V"],/^OpenSSH/],
]) {
  const result=spawnSync(tool,args,{encoding:"utf8",env:{PATH:process.env.PATH}});
  assert.equal(result.error,undefined,`${tool} was unavailable through the lifecycle PATH`);
  assert.equal(result.status,0,`${tool} ${args.join(" ")} failed: ${result.stderr}`);
  assert.match((result.stdout+result.stderr).trim(),pattern);
}
console.log("PASS actual lifecycle gate resolves Docker, Compose, Buildx, Git and SSH with a fixed trusted PATH");'
