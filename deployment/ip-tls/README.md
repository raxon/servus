# IP address TLS for Servus

This is a proposed deployment for `159.65.115.230`. It has not been tested end to end as a production deployment. Review the stack, host configuration, certificate paths and systemd units before use. It does not change the panel's origin or cookie settings.

The existing Swarm Traefik service keeps port 80. The challenge stack attaches to its overlay network and serves only the ACME path for this IP. A separate host nginx instance listens on port 443 and forwards to `127.0.0.1:4180`. The proxy has its own config, PID and systemd unit. It does not reload the host's ordinary nginx service.

## Preconditions

Run `python3 deployment/ip-tls/preflight.py --ip 159.65.115.230`. Its results are a partial snapshot, not an approval to deploy. Check externally that port 80 reaches the expected ingress and that port 443 is free, including Docker publications. Verify IPv6 and cloud firewall rules too. Docker NAT can bypass UFW and does not always appear in `ss`.

Check that an administrator already exists, the panel is bound to `127.0.0.1:4180`, the expected Swarm service and overlay are owned by Servus, and the new Traefik router and service names do not collide. Verify the selected Swarm manager is the same host where the bind-mounted webroot will exist. Check the IP route and challenge path against existing applications. This configuration assumes the documented Servus Traefik `web` entrypoint and a Linux host with rootful Docker, `/usr/sbin/nginx`, OpenSSL, `flock`, GNU coreutils and systemd.

Do not overwrite an existing `/var/lib/servus-ip-tls`, `/etc/servus-ip-tls`, stack named `servus-ip-tls`, or units with these names. Investigate any collision first. Protect the host against untrusted users with Docker access: Docker and Swarm administrators can access the bind mounts and alter routing.

## Layout and preparation

The following commands are intended for a fresh, reviewed installation as root. Replace the checkout path before running them. They install files but do not deploy a stack, start a service, issue a certificate, or modify the panel configuration.

```sh
cd /path/to/servus
for path in /var/lib/servus-ip-tls /etc/servus-ip-tls /usr/local/libexec/servus-ip-tls; do
  test ! -e "$path" && test ! -L "$path" || { echo "Path already exists: $path" >&2; exit 1; }
done
install -d -o root -g root -m 0755 /var/lib/servus-ip-tls /var/lib/servus-ip-tls/webroot
install -d -o root -g root -m 0700 /var/lib/servus-ip-tls/staging /var/lib/servus-ip-tls/production
for env in staging production; do
  install -d -o root -g root -m 0700 "/var/lib/servus-ip-tls/$env/config" "/var/lib/servus-ip-tls/$env/work" "/var/lib/servus-ip-tls/$env/logs"
done
install -d -o root -g root -m 0700 /etc/servus-ip-tls /usr/local/libexec/servus-ip-tls
install -o root -g root -m 0600 deployment/ip-tls/nginx.conf /etc/servus-ip-tls/nginx.conf
install -o root -g root -m 0700 deployment/ip-tls/certificates.sh /usr/local/libexec/servus-ip-tls/certificates.sh
```

Inspect existing systemd units before copying the three files from `systemd/` into `/etc/systemd/system/` with owner root and mode 0644, then run `systemctl daemon-reload`. Review all parent paths for symlinks and ownership first. The certificate script checks its data paths at every run, but it does not install or secure the systemd units.

The challenge image receives the webroot read-only and no Docker socket. Certbot writes to the same webroot and to separate root-only staging or production state. The production nginx master reads both `live` and `archive` through the host filesystem, because Certbot uses symlinks between them. Test the actual image UID, directory search permissions and file readability on the chosen node.

## Staging first

Set `CHALLENGE_NODE_ID` to the verified full ID of the host's Swarm manager, review `docker stack config -c deployment/ip-tls/challenge-stack.yml`, and deploy this dedicated stack only after checking for existing names. The service publishes no ports. Do not restart or replace `panel-ingress`.

From outside the VPS, verify a temporary random file under the webroot is served with its exact contents at the IP's `/.well-known/acme-challenge/` path. Verify an existing application still responds. Remove only that temporary file. Then issue and test a staging certificate:

```sh
/usr/local/libexec/servus-ip-tls/certificates.sh issue staging ADMIN_EMAIL
/usr/local/libexec/servus-ip-tls/certificates.sh renew staging
```

For a real staging renewal test, invoke the same pinned Certbot image with the staging mounts and `renew --dry-run --no-random-sleep-on-renew`. Inspect the SAN and expiry. Staging certificates are not publicly trusted. Keep staging and production directories separate.

## Production and renewal

After staging and a separate deployment review, run `certificates.sh issue production ADMIN_EMAIL`. Check the certificate's IP SAN, chain and validity before starting `servus-ip-tls-proxy.service`. Install and enable `servus-ip-tls-renew.timer` only after the proxy is active and the challenge route is durable. The timer checks twice daily with a randomized systemd delay. The Certbot invocation disables its own extra randomized sleep. Failed reloads leave the previous fingerprint in place so a later run retries.

Monitor the timer, renewal failures and the certificate actually served on port 443. Alert before fewer than 48 hours remain. A successful `certbot renew` exit alone does not prove that a certificate was renewed or that nginx serves it. Verify a changed certificate serial after a real renewal. The six-day lifetime leaves little time to repair a broken route, timer or reload.

The panel must separately allow the exact origin `https://159.65.115.230` and use Secure cookies. The current installer preserves the stored public URL on rerun, so setting a new environment variable alone does not migrate an existing installation. Plan a transactional configuration update and rollback before exposing the proxy. Keep an SSH recovery path and test login, CSRF, WebSocket console and existing applications. A localhost SSH tunnel may behave differently across browsers once Secure cookies are enabled.

## Local checks

```sh
python3 -m unittest discover -s tests/ip-tls -p 'test_*.py' -v
sh -n deployment/ip-tls/certificates.sh
CHALLENGE_NODE_ID=abcdefghijklmnopqrstuvwxy docker stack config -c deployment/ip-tls/challenge-stack.yml
```

The tests mock Docker and systemd. They do not prove host permissions, production certificate issuance, proxy reload, firewall policy or external reachability. Test those on the target in staging before production.

References: [Let's Encrypt IP certificates and Certbot](https://letsencrypt.org/2026/03/11/shorter-certs-certbot/), [Certbot renewal](https://eff-certbot.readthedocs.io/en/stable/using.html), [Traefik entrypoints](https://doc.traefik.io/traefik/routing/entrypoints/), [Docker and UFW](https://docs.docker.com/engine/network/packet-filtering-firewalls/).
