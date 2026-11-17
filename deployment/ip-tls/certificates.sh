#!/bin/sh
set -eu
umask 077

IMAGE='certbot/certbot@sha256:c23159d30afdd9c97960578aa4654f5901de6cae394958f894074dedd55e599d'
BASE=/var/lib/servus-ip-tls
IP=159.65.115.230

fail() { printf '%s\n' "$*" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || fail 'Run as root.'
[ "$#" -ge 2 ] || fail 'Usage: certificates.sh issue staging|production EMAIL | renew staging|production'
action=$1
environment=$2
case "$environment" in staging|production) ;; *) fail 'Expected staging or production.';; esac
case "$action:$#" in issue:3|renew:2) ;; *) fail 'Invalid action or argument count.';; esac

# Check the complete path, not just the final directory, before bind mounting it.
for path in /var /var/lib "$BASE" "$BASE/$environment" "$BASE/$environment/config" "$BASE/$environment/work" "$BASE/$environment/logs" "$BASE/webroot"; do
  [ -d "$path" ] && [ ! -L "$path" ] && [ "$(readlink -f "$path")" = "$path" ] || fail "Invalid directory: $path"
  [ "$(stat -c %u "$path")" -eq 0 ] || fail "Directory is not owned by root: $path"
  mode=$(stat -c %a "$path")
  [ $((0$mode & 0022)) -eq 0 ] || fail "Directory is writable by other users: $path"
done
for path in "$BASE/$environment" "$BASE/$environment/config" "$BASE/$environment/work" "$BASE/$environment/logs"; do
  [ "$(stat -c %a "$path")" = 700 ] || fail "Private directory must have mode 0700: $path"
done
command -v docker >/dev/null || fail 'Docker is required.'
command -v flock >/dev/null || fail 'flock is required.'
lock="$BASE/.certificates.lock"
[ ! -L "$lock" ] || fail 'Invalid certificate lock path.'
if [ -e "$lock" ]; then
  [ -f "$lock" ] && [ "$(stat -c %u "$lock")" -eq 0 ] && [ "$(stat -c %a "$lock")" = 600 ] || fail 'Invalid certificate lock file.'
fi
exec 9>>"$lock"
flock -n 9 || fail 'Another certificate operation is running.'

run_certbot() {
  docker run --rm \
    --mount "type=bind,src=$BASE/$environment/config,dst=/etc/letsencrypt" \
    --mount "type=bind,src=$BASE/$environment/work,dst=/var/lib/letsencrypt" \
    --mount "type=bind,src=$BASE/$environment/logs,dst=/var/log/letsencrypt" \
    --mount "type=bind,src=$BASE/webroot,dst=/challenge" \
    "$IMAGE" "$@"
}
if [ "$action" = issue ]; then
  email=$3
  case "$email" in *@*.*) ;; *) fail 'A contact email is required.';; esac
  if [ "$environment" = staging ]; then
    run_certbot certonly --non-interactive --agree-tos --email "$email" --staging --preferred-profile shortlived --webroot --webroot-path /challenge --ip-address "$IP" --cert-name servus-ip --keep-until-expiring
  else
    run_certbot certonly --non-interactive --agree-tos --email "$email" --preferred-profile shortlived --webroot --webroot-path /challenge --ip-address "$IP" --cert-name servus-ip --keep-until-expiring
  fi
  printf '%s\n' 'Issuance finished. Review the certificate before starting or reloading the proxy.'
  exit 0
fi

run_certbot renew --non-interactive --no-random-sleep-on-renew
[ "$environment" = production ] || exit 0
cert="$BASE/production/config/live/servus-ip/fullchain.pem"
key="$BASE/production/config/live/servus-ip/privkey.pem"
[ -r "$cert" ] && [ -r "$key" ] || fail 'Production certificate or key is missing.'
openssl verify -purpose sslserver -verify_ip "$IP" -untrusted "$cert" "$cert" >/dev/null || fail 'Production certificate is not trusted or has the wrong IP.'
openssl x509 -in "$cert" -noout -checkend 0 >/dev/null || fail 'Production certificate has expired.'
cert_pub=$(openssl x509 -in "$cert" -pubkey -noout | openssl pkey -pubin -outform DER | sha256sum | cut -d ' ' -f 1)
key_pub=$(openssl pkey -in "$key" -pubout -outform DER | sha256sum | cut -d ' ' -f 1)
[ -n "$cert_pub" ] && [ "$cert_pub" = "$key_pub" ] || fail 'Certificate and private key do not match.'
digest=$(cat "$cert" "$key" | sha256sum | cut -d ' ' -f 1)
state="$BASE/production/reloaded.sha256"
previous=''
[ ! -L "$state" ] || fail 'Invalid reload state path.'
[ ! -f "$state" ] || previous=$(cat "$state")
if [ "$digest" != "$previous" ]; then
  systemctl is-active --quiet servus-ip-tls-proxy.service || fail 'The dedicated TLS proxy is not active; certificate was not reloaded.'
  systemctl reload servus-ip-tls-proxy.service || fail 'TLS proxy reload failed; retry is required.'
  handshake=$(mktemp "$BASE/production/.handshake.XXXXXXXX")
  trap 'rm -f "$handshake" "$handshake.expected" "$handshake.served"' EXIT
  openssl x509 -in "$cert" -outform DER -out "$handshake.expected" || fail 'Cannot read the production certificate.'
  expected=$(sha256sum "$handshake.expected" | cut -d ' ' -f 1)
  verified=false
  for attempt in 1 2 3 4 5; do
    if timeout 3s openssl s_client -connect 127.0.0.1:443 -verify_ip "$IP" -verify_return_error </dev/null > "$handshake" 2>/dev/null &&
       openssl x509 -in "$handshake" -outform DER -out "$handshake.served" 2>/dev/null; then
      served=$(sha256sum "$handshake.served" | cut -d ' ' -f 1)
      if [ -n "$expected" ] && [ "$expected" = "$served" ]; then verified=true; break; fi
    fi
    [ "$attempt" = 5 ] || sleep 1
  done
  [ "$verified" = true ] || fail 'TLS proxy did not serve the verified certificate after reload.'
  printf '%s\n' "$digest" > "$state.tmp"
  mv -f "$state.tmp" "$state"
fi
