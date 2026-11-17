# Test application HTTPS on 159.65.115.230

This host-specific configuration exposes the existing `welcome.localhost` test
application as `test.servus.run`. It is an operational configuration for this
one installation, not automatic application certificate management in Servus.
The application domain is not recorded in the panel's service configuration.

The existing `servus-ip-tls-proxy` nginx owns port 443 and includes
`/etc/servus-app-tls/test-servus-nginx.conf` inside its `http` block, **after**
the IP panel's server block. The order preserves the IP certificate as the
default for clients without SNI. The domain server forwards to local Traefik
using `Host: welcome.localhost`, so changes to that application hostname need a
corresponding proxy update. The original nginx configuration was backed up as
`/etc/servus-ip-tls/nginx.conf.before-app-tls`.

The `servus-app-tls` Swarm stack serves HTTP-01 challenges from
`/var/lib/servus-app-tls/webroot` and redirects other HTTP requests for this
domain to HTTPS. Its challenge task is pinned to the host containing the
webroot. The stack configuration is kept under `/etc/servus-app-tls`. When
updating it, set `CHALLENGE_NODE_ID` to the full local Swarm node ID before
running `docker stack deploy`.

Certbot state is separate from the panel IP certificate under
`/var/lib/servus-app-tls`. The `servus-app-tls-renew.timer` systemd timer
checks it twice daily. The renewal service validates the certificate, reloads
the shared TLS proxy and verifies the certificate served over a local TLS
handshake. Inspect failures with `systemctl status servus-app-tls-renew.service`
and `journalctl -u servus-app-tls-renew.service`. The ACME account was created
without a contact email, so it cannot send email notices.

`servus-app-tls-monitor.timer` runs an hourly check of the publicly resolved
HTTPS endpoint, its certificate expiry (alerting below 21 days), the renewal
timer and the most recent renewal service result. A failed check leaves the
monitor service in a failed state and writes an `ALERT` entry to the systemd
journal. Inspect it with `systemctl status servus-app-tls-monitor.service` and
`journalctl -u servus-app-tls-monitor.service`. These checks run from the server
and there is no notification delivery or independent outage monitoring.

Check public access with `curl -f https://test.servus.run/`, HTTP redirect with
`curl -I http://test.servus.run/`, and the panel with
`curl -f https://159.65.115.230/`. A staging dry run of the deployed renewal
configuration is needed to test ACME reachability; a successful scheduled
renewal check alone can mean the certificate was not yet due for renewal.
