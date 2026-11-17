#!/bin/sh
set -eu
umask 077
base=/var/lib/servus-app-tls
domain=test.servus.run
image=certbot/certbot@sha256:c23159d30afdd9c97960578aa4654f5901de6cae394958f894074dedd55e599d
exec 9>"$base/renew.lock"
flock -w 120 9
docker run --rm \
  --mount "type=bind,src=$base/config,dst=/etc/letsencrypt" \
  --mount "type=bind,src=$base/work,dst=/var/lib/letsencrypt" \
  --mount "type=bind,src=$base/logs,dst=/var/log/letsencrypt" \
  --mount "type=bind,src=$base/webroot,dst=/challenge" \
  "$image" renew --non-interactive --no-random-sleep-on-renew
cert="$base/config/live/$domain/fullchain.pem"
openssl verify -purpose sslserver -verify_hostname "$domain" -untrusted "$cert" "$cert" >/dev/null
openssl x509 -in "$cert" -noout -checkend 0 >/dev/null
systemctl is-active --quiet servus-ip-tls-proxy.service
systemctl reload servus-ip-tls-proxy.service
expected=$(openssl x509 -in "$cert" -noout -fingerprint -sha256)
handshake=$(mktemp "$base/.handshake.XXXXXXXX")
trap 'rm -f "$handshake"' EXIT HUP INT TERM
verified=false
for attempt in 1 2 3 4 5; do
  if timeout 5 openssl s_client -connect 127.0.0.1:443 -servername "$domain" -verify_hostname "$domain" -verify_return_error </dev/null >"$handshake" 2>/dev/null; then
    served=$(openssl x509 -in "$handshake" -noout -fingerprint -sha256)
    if [ "$expected" = "$served" ]; then verified=true; break; fi
  fi
  sleep 1
done
[ "$verified" = true ] || { echo 'The proxy does not serve the renewed certificate.' >&2; exit 1; }
