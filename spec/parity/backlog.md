# Parity backlog - working notes

## Current implementation - 2026-11-25

The reference is EasyPanel 2.38.1. This register covers the local working tree. It does not certify a released image, a public server, or complete compatibility. Earlier reference observations remain below as historical evidence.

| Priority | Area | Current result | Remaining acceptance |
| --- | --- | --- | --- |
| P0 | Access and sessions | Terminal input/output and delayed logs recheck authorization. Project isolation, hostname validation and session revocation have regression coverage. Central OIDC sign-in routes were removed from the panel while retaining existing local identities and sessions. | Continue these checks on every new endpoint. |
| P0 | Application HTTPS | Verified live on public VPS (`v0.1.61`, `postuj.ai`): real Let's Encrypt HTTP-01 issuance, HTTP->HTTPS redirect, persistence across redeploy, live renewal without restarting the app, Compose custom domain HTTPS, and safe redirect refusal behind Cloudflare proxy. | Keep verifying on future ingress updates. |
| P0 | Database restore | Verified live on VPS (`v0.1.61`) for PostgreSQL 17, MariaDB 11.4 and Redis 7 (both local and Cloudflare R2 encrypted backups), plus candidate-verified restore support for MySQL 8.4 and MongoDB 7. | Re-verify MySQL 8.4, MongoDB 7 and PostgreSQL 18 on live VPS (`v0.2.0`). |
| P0 | Updates and recovery | Verified live on VPS (`v0.1.57 -> v0.1.58 -> v0.1.61`): signed GHCR Sigstore release discovery, host supervisor upgrade, `servus-host-update.service` activation, post-reboot quiescence with exited `panel-ingress` history, and schema 4-9 compatibility. | Maintain backward-compatible sidecar DBs and updater checks on every release. |
| P0 | Documentation | README, website (`servus.run`), OpenAPI 3.1 and automation docs updated to match verified `v0.2.0` capabilities. | Keep release claims matched to live evidence. |
| P1 | Database backups | Verified live on VPS (`v0.1.61`) with real Cloudflare R2 (`test-panel`) and local storage: AES-256-GCM encryption, decrypted download with `X-Backup-SHA256`, full restore, count/age/GFS retention pruning, explicit R2 delete, and negative TLS/credential tests across PostgreSQL, MariaDB and Redis. Extended to MySQL 8.4 (`mysqldump`) and MongoDB 7 (`mongodump`). | Monitor scheduled cron runs across longer soak windows. |
| P1 | Volume backups | Verified live on VPS (`v0.1.61`) with real Cloudflare R2: `/data` backup, download, pre-commit cancel preserving live data, full commit restore, and explicit deletion. | One node, one replica, writable named volumes up to 2 GiB. |
| P1 | Installation backups | Verified live on VPS (`v0.1.61`): named host snapshots across reboots, paginated history, integrity verification, authenticated archive download (`application/gzip`, `X-Backup-SHA256`, `no-store`, zero leftover temp files), protected snapshot deletion, and Settings restore checklist UI. | Automated full host disaster-recovery drill on a fresh clone VPS. |
| P1 | Compose | Inline YAML and HTTPS Git (public or private with credentials or shared GitHub) sources, durable actions, logs, live runtime metrics, named-volume preservation, public Let's Encrypt HTTPS verified live on VPS, and deploy-token CRUD via API, CLI and MCP. | Additional build contexts, build secrets/SSH forwarding and published ports remain unsupported. |
| P1 | Git and build workflow | Repository/branch selection, Force Rebuild, build resource limits, configurable build concurrency (`1-8`), queued action and active build cancellation, generated env files, private registry auth and SSH deploy keys. | Production provider/TLS acceptance remains deployment-specific. |
| P1 | Deployment automation | Server-generated rotated webhook credentials, GitHub HMAC checks, branch selection and idempotent CI triggers are implemented. | Service-owned GitHub webhook registration is manual. |
| P1 | MFA | Local TOTP with replay prevention, encrypted secrets and one-use recovery codes is implemented and live-verified. | Central sign-in remains out of scope. |
| P2 | Templates | WordPress, n8n, Uptime Kuma, Grafana and MinIO templates verified in real runtime fixtures. | Expand catalog as needed. |
| P2 | Public automation | Project-scoped read/deploy tokens, authenticated OpenAPI 3.1, CLI (`servus.mjs`) and stdio MCP (`servus-mcp.mjs`) cover services, Compose CRUD/lifecycle, shared project env vars and saved operational scripts. | Optional remote HTTP MCP transport remains open. |
| P2 | Networking | Shared Traefik ingress with path-prefix, strip-prefix, IPv4/IPv6 CIDR allow-lists, Trusted Proxies (`ipStrategy` depth or `excludedIPs`), htpasswd Basic Auth, redirect rules, published TCP/UDP ports, Swarm `dnsrr` and database external TCP ports. | Cloudflare Tunnel remains optional P3. |
| P2 | Databases | Managed PostgreSQL 17 & 18, MariaDB 11.4, MySQL 8.4, MongoDB 7 and Redis 7 with backups, candidate restore, external TCP access and live password rotation (`POST /services/:id/database/rotate-password`). | Temporary admin UI tools (pgAdmin/Adminer) remain optional P3. |
| P2 | Observability | 60s service metrics history (`metrics.sqlite`, 24h), 7-day redacted log archive & search (`logs.sqlite`), admin alerts across 5 channels (`alerts.sqlite`), host CPU/RAM/disk/uptime metrics, live Compose metrics, live logs and interactive browser console. | Optional snapshot export of alert configuration. |
| P2 | Builders and operations | Dockerfile builds, build resource limits, configurable build concurrency (`1-8`), build cancellation, custom container healthchecks, deployment strategy, service notes, shared project environment variables (`workspace-extras.sqlite`) and saved operational scripts (bounded container exec). | Alternative builders (Railpack/Nixpacks/Buildpacks) remain P3. |
| P3 | Extended modules | No completion claim. | WordPress/Box management modules, server migration, more storage providers, host administration, translations/branding and multi-node. |

### Reproduction

Use Node.js 24. Default unit and contract checks are `npm test`, with type checking and production builds through `npm run typecheck` and `npm run build`. The source, automation, backup, MFA, update and Compose browser fixtures run against isolated API state or mocked responses as documented by their scripts.

Real runtime fixtures require their explicitly selected Docker contexts. `tests/integration/source-build-options.ts`, `tests/integration/compose-workloads.ts` and `tests/backups/verify.ts` create their own labelled resources. The S3 fixture uses `SERVUS_BACKUP_S3=1` and a private MinIO endpoint. Never treat a skipped integration test as a pass. Public ACME and signed-release acceptance have separate requirements.

Additional acceptance fixtures are `tests/integration/source-credentials.ts`, `tests/application-https-acme-e2e/compose.ts`, `tests/backups/volume-verify.ts` and `tests/integration/package-parity-smoke.mjs`. `SERVUS_VOLUME_S3=1` runs the volume fixture against real MinIO. Its binary is checked against the official release checksum, including when supplied through `SERVUS_MINIO_FIXTURE_BINARY`. The fixture download uses bounded curl attempts and resumes only after measurable progress.

`tests/integration/compose-builds.ts` requires `SERVUS_DISPOSABLE_COMPOSE_BUILD_TEST=1` and uses the dedicated panel-dev context. `tests/backups/redis-restore-verify.ts` exercises RDB recovery, and `tests/integration/schema-compatibility.mjs` runs the frozen schema 7 executable against an owned schema 8 volume. Central MFA evidence lives in the sibling `servus-api/artifacts` directory. Its 117-assertion run includes browser and two-issuer gate-failure scenarios, with fake SMTP and disposable PostgreSQL.

Machine-readable evidence is stored under `artifacts/source-credentials`, `artifacts/compose`, `artifacts/backups/volume-e2e.json`, `artifacts/backups/redis-restore-e2e.json` and `artifacts/parity-implementation`. The earlier continuation report records schema 7 and remains historical evidence. `schema8-compatibility.json` records the frozen old binary refusal check. These local artifacts do not establish a published release or public-server acceptance.

`tests/templates/wordpress.ts`, `tests/templates/minio.ts` and `tests/templates/n8n.ts` require their explicitly enabled, exclusively owned Docker VM. Evidence is recorded under `artifacts/templates`, including negative preflight checks against preexisting ingress resources. Deleting a Compose workload now preserves authorized access to its action history while still checking the project's current existence and access.

## Historical findings

This is a prioritization of gaps in Servus, not a certification of EasyPanel compatibility. The comparison run in `artifacts/parity/20261113b` used a modified local EasyPanel 2.38.0 fixture. Its observations do not establish the behavior of other releases. Server verification is pending unless stated otherwise.

| Priority | Area | Work remaining | Evidence and acceptance |
| --- | --- | --- | --- |
| P0 | Restore recovery | Fence and recover interrupted candidate preparation and uploads created before process locks existed. Never infer that a writer has stopped solely from a missing lock file. | Exercise process termination at each journal and Docker boundary; verify that the original database stays available and that uncertain operations remain fenced. |
| P0 | Application HTTPS | Add per-domain routing, certificate issuance, renewal, and failure reporting without interfering with panel HTTPS or HTTP ingress. | On 2026-11-15 `test.servus.run` reached HTTP ingress with 404 and HTTPS returned 520 through Cloudflare. Verify trusted TLS and real application responses from outside the server, including renewal and failure recovery. |
| P1 | Backups | Complete automated, scheduled backup and recovery with explicit retention and consistency guarantees. Existing database export and restore do not establish a complete backup system. | Test real PostgreSQL and MariaDB data, repeated restore, interrupted work, and recovery on an isolated server fixture. |
| P1 | Compose workloads | Define and implement application Compose import and lifecycle management. The Servus installation Compose package does not provide this feature. | Test multi-service deployments, updates, persistent volumes, and cleanup using isolated fixtures. |
| P2 | Monitoring history | Add persisted metrics, retention, and historical views. | Compare real runtime measurements and queries across restarts and retention boundaries. |
| P2 | Templates | Define supported application templates and their upgrade behavior. | Test creation, configuration, updates, and removal with persistent data. |
| P3 | CLI, MCP, multi-node | Define scope and authentication before implementing. | Test against real authorized instances and multiple nodes where applicable. |

Private Git credentials are implemented in the source and tested in the release workflow; the README's older statement that they are absent is stale. Do not treat either that statement or this backlog as a current product-wide feature inventory.
