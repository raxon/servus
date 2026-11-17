#!/bin/sh
# Run only on the dedicated disposable Swarm profile after building the panel image.
set -eu
context=colima-servus-migration-e2e
image=${SERVUS_MIGRATION_TEST_IMAGE:-servus-migration-test:local}
case "$image" in servus-migration-test:local|servus-migration-test:cached) ;; *) echo 'Unexpected test image' >&2; exit 1;; esac
mode=${SERVUS_HTTPS_TEST_MODE:-direct}
case "$mode" in direct|external) ;; *) echo 'Unexpected HTTPS test mode' >&2; exit 1;; esac
d() { docker --context "$context" "$@"; }
[ "$(d info --format '{{.Name}}')" = colima-servus-migration-e2e ] || { echo 'Unexpected Docker host' >&2; exit 1; }
[ "$(d service inspect panel-ingress --format '{{index .Spec.Labels "panel.owner"}}')" = self-hosted-panel ] || { echo 'Missing disposable ingress' >&2; exit 1; }
for name in servus-migration-agent-test servus-port-holder-test; do
  if d container inspect "$name" >/dev/null 2>&1; then echo "Container $name already exists" >&2; exit 1; fi
done
if d volume inspect servus-migration-agent-data >/dev/null 2>&1; then echo 'Test volume already exists' >&2; exit 1; fi
gid=$(colima ssh -p servus-migration-e2e -- stat -c %g /var/run/docker.sock)
case "$gid" in ''|*[!0-9]*) echo 'Invalid socket group' >&2; exit 1;; esac
cleanup() { d rm -f servus-migration-agent-test servus-port-holder-test >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM
d volume create servus-migration-agent-data >/dev/null
d run -d --name servus-migration-agent-test --label com.docker.compose.service=agent --group-add "$gid" \
  -e PANEL_DATA_DIR=/var/lib/panel -e PANEL_INGRESS_PORT=80 \
  -v /var/run/docker.sock:/var/run/docker.sock -v servus-migration-agent-data:/var/lib/panel \
  --entrypoint node "$image" dist/agent/index.js >/dev/null
for ignored in $(seq 1 40); do
  if d exec servus-migration-agent-test test -S /var/lib/panel/agent.sock; then break; fi
  sleep 0.5
done
d exec servus-migration-agent-test node --input-type=module -e "import {SecretVault} from './dist/shared/secrets.js';new SecretVault('/var/lib/panel').setHttpsIngress('ops@example.test',true)"
d run -d --name servus-port-holder-test --network host --user root --entrypoint node "$image" -e "require('node:net').createServer().listen(443,'0.0.0.0')" >/dev/null
ready=false
for ignored in $(seq 1 40); do
  if d exec servus-port-holder-test node -e "const s=require('node:net').connect(443,'127.0.0.1');s.on('connect',()=>{s.destroy();process.exit(0)});s.on('error',()=>process.exit(1));"; then ready=true; break; fi
  sleep 0.25
done
[ "$ready" = true ] || { echo 'Port holder did not start' >&2; exit 1; }
request='const fs=require("node:fs"),http=require("node:http");const token=fs.readFileSync("/var/lib/panel/agent-token","utf8").trim();const req=http.request({socketPath:"/var/lib/panel/agent.sock",path:"/https/ingress/"+process.argv[2],method:"POST",headers:{authorization:"Bearer "+token,"content-type":"application/json"}},res=>{let body="";res.on("data",s=>body+=s);res.on("end",()=>{console.log(res.statusCode,body);process.exit(res.statusCode===Number(process.argv[1])?0:1)})});req.on("error",e=>{console.error(e.message);process.exit(1)});req.end("{}");'
d exec servus-migration-agent-test node -e "$request" 422 migrate
if [ "$mode" = direct ]; then
  d rm -f servus-port-holder-test >/dev/null
  d exec servus-migration-agent-test node -e "$request" 200 migrate
  d service inspect panel-ingress --format '{{json .Spec.EndpointSpec.Ports}}' | grep -q '"PublishedPort":443'
else
  d exec servus-migration-agent-test node -e "$request" 200 migrate-external
  [ "$(d service inspect panel-ingress --format '{{index .Spec.Labels "panel.https-access"}}')" = loopback-forwarder-v1 ]
  [ "$(d inspect servus-port-holder-test --format '{{.State.Running}}')" = true ]
  [ "$(d inspect servus-https-forwarder --format '{{(index (index .HostConfig.PortBindings "8443/tcp") 0).HostIp}}')" = 127.0.0.1 ]
fi
d exec servus-migration-agent-test node -e 'const fs=require("node:fs"),http=require("node:http");const token=fs.readFileSync("/var/lib/panel/agent-token","utf8").trim();http.get({socketPath:"/var/lib/panel/agent.sock",path:"/runtime",headers:{authorization:"Bearer "+token}},res=>{let body="";res.on("data",part=>body+=part);res.on("end",()=>{const value=JSON.parse(body);console.log(JSON.stringify({httpsConfigured:value.httpsConfigured,ingressRecoveryRequired:value.ingressRecoveryRequired}));process.exit(value.httpsConfigured&&!value.ingressRecoveryRequired?0:1)})}).on("error",()=>process.exit(1));'
echo 'Agent rejected an occupied port and migrated the existing ingress successfully.'
