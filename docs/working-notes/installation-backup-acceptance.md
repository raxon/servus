# Installation backup acceptance - working notes

## Implemented boundaries

The administrator-only Settings section submits a named operation through the session API, follows its UUID across a panel restart and retries uncertain submissions with the same identity. Browser storage contains only the current operation UUID, scoped to user and origin. Capability checks do not read the approval key. Creation and cancellation have distinct HMAC purposes. Cancellation only applies before maintenance begins and retains the original operation actor.

The root supervisor persists the approved policy and exact original container identities before recording drain intent. It excludes host updates, drains authenticated API/worker/agent channels and stops those writers before capture. Completion requires the original roles to restart, authenticate afresh and pass health checks. A partial or uncertain capture stays fenced for explicit recovery.

`--recover-installation-backup UUID` is an option to the configured root supervisor command, with its normal policy, journal, socket, secrets and installation arguments. It is not a standalone executable. Ordinary startup refuses uncertain maintenance. Recovery validates all original containers and the approved policy, acquires installation and lifecycle locks, and restarts the original installation. An unverified capture ends as `failed/capture_failed` after healthy restart. It never fabricates a manifest or replaces live SQLite with a partial copy.

The ingress recognizer accepts the exact constrained Compose Docker provider added by Servus. It still rejects partial, duplicate, conflicting or unconstrained provider arguments. Operational capture/quiescence failures are converted into journaled supervisor failures instead of escaping the daemon and abandoning its control loop.

## Actual host evidence

`artifacts/installation-backups/host-5dcbb7e4.json` records the successful current-code run on a fresh VM, using the standard supervisor command without an exception observer or replaced primitives. All seven checks passed: authenticated panel/application setup, capability detection, cancellation before maintenance, signed API dispatch, authenticated drain and stopped-writer capture, healthy restart with original identities and application data, and isolated restore with login/configuration/secret verification. Its cleanup record confirms deletion of that owned VM.

The first repetitions exposed a real stale generation after restarting only the worker: its container ID and cgroup stayed the same while its host PID changed. The supervisor now compares the entire live inventory before registration and again before reporting an authenticated channel ready. Its ordinary readiness command also checks that inventory under the installation lock. Regression checks cover both identity changes during authentication and changed-PID status. Failed attempts remain separate diagnostics and are not counted as passing capture evidence.

The `20261117a` reports below describe an earlier frozen local runtime image with the recovery modules copied into the fixture. They do not include the latest capability/cancellation API or Settings bundle.

`artifacts/installation-backups/host-recovery-20261117a.json` records explicit recovery after a real failed capture. The original three control-plane containers restarted with their identities preserved, the gate returned to normal and only the operation's own active marker was cleared. The application kept its single replica and exact volume marker. The partial directory remained available for inspection, with no snapshot path or manifest recorded as successful.

`artifacts/installation-backups/host-capture-20261117a.json` records a subsequent successful capture on that isolated host. It exercised the real HTTP API, approval proxy, root daemon, authenticated drain, Docker stop/start, capture and isolated restore. A fresh API opened the restored copy with no Docker access, accepted login, returned the expected project and decrypted the service secret with the correct purpose. The original application volume remained unchanged.

The fixture uses synthetic credentials and an exclusively owned disposable ARM64 VM. Its root-owned local policy binds actual Docker inspection and a content-addressed local image alias. This setup tests host orchestration, not a published release signature. There is no registry push, production deployment or DNS change.

## Reproduction

Use Node.js 24, Colima and Docker CLI. `bash tests/installation-backups/run.sh` requires cached `servus-parity-v7-check:20261117`, `nginx:alpine` and `traefik:3.7.13` in `colima-panel-dev`. `SERVUS_BACKUP_E2E_BASE_IMAGE` can select another compatible cached runtime base. The script compiles current code, copies it into the runtime image and creates a uniquely named VM with no host mounts. It transfers only the required images, runs preparation and acceptance, exports a safe JSON result and deletes its own VM on exit. It does not prune the source daemon or touch unrelated workloads.

The real fixture checks current capability detection, cancellation of an untouched queued operation, capture/restart and isolated restore. A failed or interrupted run is evidence of failure until examined and rerun successfully. Earlier failed reproduction logs remain separate from passing JSON evidence.

`node tests/installation-backups/browser.mjs` checks operation states, keyboard/focus handling, UUID-only storage, retries and responsive layout. `node tests/installation-backups/settings-app.mjs` checks integration with the actual Settings route and administrator-only mounting. Both use mocked HTTP responses and do not establish host capture success.

## Remaining work

History, retention, archive download and user-directed restore orchestration remain open. The interruption matrix still needs wider real-process coverage, including cancellation races, restart-boundary failures and verified-snapshot recovery. Public VPS acceptance, a signed final release and its upgrade/recovery path require separate evidence. Application data, database contents and workload volumes remain outside the installation snapshot.
