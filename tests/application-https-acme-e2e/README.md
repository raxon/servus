# Application ACME staging check

Run on a single-node Swarm server whose existing Traefik service watches the
`panel-ingress` network and serves port 80. `SERVUS_ACME_DOMAIN` must be a
non-wildcard test domain whose public DNS points to that server. Docker, curl,
OpenSSL and Python 3 are required. The pinned nginx and Certbot images may need
to be available to Docker.

```sh
SERVUS_ACME_DOMAIN=test.example.com bash tests/application-https-acme-e2e/run.sh
```

The test adds a temporary route only for that host's ACME challenge path,
verifies a random file through public DNS, and requests a **staging**
certificate using the webroot challenge. It checks the certificate hostname and
staging issuer, then removes the labelled service and its temporary certificate
and key. The ACME staging server must be able to reach port 80. Run this only
where that temporary route is acceptable.

This does not install a production certificate, configure port 443, exercise
renewal, or prove wildcard DNS-01 or Cloudflare-proxied access. It is a manual
network integration check, not a default CI test.
