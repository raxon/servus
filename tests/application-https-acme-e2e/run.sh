#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C
: "${SERVUS_ACME_DOMAIN:?Set SERVUS_ACME_DOMAIN to a test domain pointing to this server}"
python3 - "$SERVUS_ACME_DOMAIN" <<'PYDOMAIN'
import re, sys
name=sys.argv[1]
if len(name)>253 or not re.fullmatch(r"(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?",name):
    raise SystemExit("Expected a lowercase non-wildcard DNS name")
PYDOMAIN
id=$(openssl rand -hex 8)
root=$(mktemp -d /tmp/servus-acme-test.XXXXXX)
service="servus-acme-test-$id"
router="servus-acme-$id"
cleanup() {
  if ! docker info >/dev/null 2>&1; then
    echo "Cannot verify fixture cleanup; retained $root and $service" >&2; return 1
  fi
  if ! services=$(docker service ls --format '{{.Name}}'); then
    echo "Cannot list fixtures; retained $root and $service" >&2; return 1
  fi
  if printf '%s\n' "$services" | grep -Fxq "$service"; then
    if ! label=$(docker service inspect --format '{{ index .Spec.Labels "servus.fixture" }}' "$service"); then
      echo "Cannot verify fixture ownership; retained $root and $service" >&2; return 1
    fi
    if [ "$label" != "$id" ]; then
      echo "Fixture ownership changed; retained $root and $service" >&2; return 1
    fi
    if ! docker service rm "$service" >/dev/null; then
      echo "Cannot remove fixture; retained $root and $service" >&2; return 1
    fi
  fi
  rm -rf "$root"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir -p "$root/web/.well-known/acme-challenge" "$root/config" "$root/work" "$root/logs"
chmod 755 "$root/web" "$root/web/.well-known" "$root/web/.well-known/acme-challenge"
printf '%s' "$id" > "$root/web/.well-known/acme-challenge/$id"
chmod 644 "$root/web/.well-known/acme-challenge/$id"
node_id=$(docker info --format '{{.Swarm.NodeID}}')
docker service create --quiet --name "$service" --constraint "node.id==$node_id" --network panel-ingress --mount "type=bind,source=$root/web,target=/usr/share/nginx/html,readonly" \
  --label "servus.fixture=$id" --label traefik.enable=true --label traefik.swarm.network=panel-ingress \
  --label "traefik.http.routers.$router.rule=Host(\`$SERVUS_ACME_DOMAIN\`) && PathPrefix(\`/.well-known/acme-challenge/\`)" \
  --label "traefik.http.routers.$router.entrypoints=web" --label "traefik.http.routers.$router.priority=1200" \
  --label "traefik.http.routers.$router.service=$router" --label "traefik.http.services.$router.loadbalancer.server.port=80" \
  nginx@sha256:65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10 >/dev/null
ready=0
for attempt in $(seq 1 45); do
  response=$(curl --noproxy '*' -fsS --max-time 3 "http://$SERVUS_ACME_DOMAIN/.well-known/acme-challenge/$id" 2>/dev/null || true)
  if [ "$response" = "$id" ]; then ready=1; break; fi
  sleep 1
done
[ "$ready" = 1 ] || { echo 'ACME route did not become reachable'; exit 1; }
echo 'PASS temporary ACME challenge through public DNS'
docker run --rm --network bridge \
  --mount "type=bind,src=$root/web,dst=/challenge" \
  --mount "type=bind,src=$root/config,dst=/etc/letsencrypt" \
  --mount "type=bind,src=$root/work,dst=/var/lib/letsencrypt" \
  --mount "type=bind,src=$root/logs,dst=/var/log/letsencrypt" \
  certbot/certbot@sha256:c23159d30afdd9c97960578aa4654f5901de6cae394958f894074dedd55e599d \
  certonly --non-interactive --agree-tos --register-unsafely-without-email --staging --webroot --webroot-path /challenge \
  -d "$SERVUS_ACME_DOMAIN" --cert-name fixture --no-eff-email
check=$(openssl x509 -in "$root/config/live/fixture/fullchain.pem" -noout -checkhost "$SERVUS_ACME_DOMAIN")
[ "$check" = "Hostname $SERVUS_ACME_DOMAIN does match certificate" ] || { echo 'Certificate hostname mismatch' >&2; exit 1; }
openssl x509 -in "$root/config/live/fixture/fullchain.pem" -noout -issuer -dates
openssl x509 -in "$root/config/live/fixture/fullchain.pem" -noout -issuer | grep -F '(STAGING)' >/dev/null
echo "PASS staging certificate issued for $SERVUS_ACME_DOMAIN"
