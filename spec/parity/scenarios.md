# Local parity and recovery scenarios

This document defines reproducible checks for the implemented application and database scope. It is an internal test procedure. A scenario definition is not a passing test result. Read each run's reports before making a compatibility claim.

## Targets and prerequisites

Use two separate Docker daemons. Current scripts use these explicit context names:

| Target          | Docker context       | Control plane                                  | Application ingress |
| --------------- | -------------------- | ---------------------------------------------- | ------------------- |
| Panel           | `colima-panel-dev`   | `http://localhost:4180`                        | Host port 18080     |
| Local reference | `colima-panel-local` | URL in `../local-image/local-credentials.json` | Host port 80        |

The reference fixture identifies version 2.38.0 and records `modifiedReference: true` in its report. Results describe that local fixture and its recorded image, not every official release. Do not deploy either target outside the local test environment as part of this procedure.

Start Panel with its supervised API, worker and agent processes. Run `npm run smoke` once if `.data/local-credentials.json` does not exist. It initializes credentials without printing the password. The reference adapter reads its credentials from the sibling `../local-image/local-credentials.json` by default. `REFERENCE_CREDENTIALS_FILE` can point to a separately prepared local credential file. Never copy credentials or proprietary reference implementation files into this project's source or public evidence.

The fixtures need Git, Node.js 24, the Docker CLI with Buildx and enough RAM for three databases plus application and WordPress workloads. They use `postgres:17-alpine`, `redis:7-alpine`, `mariadb:11.4`, `wordpress:php8.3-apache`, `nginx:alpine`, `node:24-alpine`, `alpine:3.21` and the configured Traefik image. Registry access is required unless the exact images are already available and local image reuse is explicitly enabled. The verified package is Linux ARM64 with Node.js 24 and Docker 29. For host-side macOS builds, `scripts/local.mjs` detects the Homebrew plugin directory `/opt/homebrew/lib/docker/cli-plugins` when `DOCKER_CONFIG` is unset.

## Git fixture and runtime flags

Start the fixture server in a separate terminal:

```sh
nvm use
node scripts/fixture-git.mjs
```

It creates `.data/parity/git/control.git` and serves smart HTTP at `http://127.0.0.1:32180/control.git`. Branches `v1` and `v2` identify healthy versions. `broken` fails its build, `unhealthy` fails readiness, and `slow` permits controlled process interruption. Fixture commit IDs are saved in `.data/parity/git/commits.json`.

The fixture's `/version` response includes its commit. It accepts the independent builder's `SOURCE_COMMIT` or the reference builder's `GIT_SHA`, with a non-placeholder `SOURCE_COMMIT` taking precedence. Compare the exact SHA, not only the `v1` or `v2` label. The recorded `source-identity.json` contains separate reference and Panel assertions. Both initial `v2` assertions passed in run `20261113b`; the common replay also verifies the exact `v1` and `v2` SHAs.

To inspect the expected `v2` SHA and the running responses:

```sh
git --git-dir=.data/parity/git/control.git rev-parse v2
curl -H "Host: panel-${PARITY_RUN_ID}.localhost" http://127.0.0.1:18080/version
curl -H "Host: reference-${PARITY_RUN_ID}.localhost" http://127.0.0.1/version
```

For these local HTTP fixtures, export this value before starting both the API and agent:

```sh
export PANEL_GIT_HTTP_HOSTS=127.0.0.1
```

The allowlist contains hostnames without ports. It permits this explicit local test source. Normal Git sources use public HTTPS repositories without embedded credentials, query strings or fragments. The reference VM uses the fixture URL `http://192.168.5.2:32180/control.git` through the host connection configured for that local VM. Verify reachability from the VM before running the reference suite. That address is specific to the current test setup.

To reuse images loaded into a dedicated test daemon, explicitly set this flag for the agent before startup:

```sh
export PANEL_ALLOW_LOCAL_IMAGES=1
```

The default path pulls the requested image. The flag first checks for a local image and falls back to a pull if absent. It does not load images or prepare the reference daemon. Use explicit `docker --context colima-panel-dev ...` and `docker --context colima-panel-local ...` commands when inspecting or loading fixture images, rather than changing the user's selected Docker context.

## Run order

Local entry points:

| Command                           | Script                                                                     |
| --------------------------------- | -------------------------------------------------------------------------- |
| `npm run fixtures:git`            | [Fixture Git server](../../scripts/fixture-git.mjs)                        |
| `npm run test:integration`        | [Panel common scenarios](../../scripts/integration.ts)                     |
| `npm run test:parity`             | [Reference common scenarios](../../scripts/parity.ts)                      |
| `npm run test:advanced`           | [Panel failure and recovery checks](../../scripts/integration-advanced.ts) |
| `npm run test:access`             | [Real HTTP access checks](../../scripts/access-check.ts)                   |
| `npm run test:reference-failures` | [Reference failure observations](../../scripts/reference-failures.ts)      |
| `npm run test:restart`            | [Dedicated VM restart check](../../scripts/restart-check.ts)               |
| `npm run test:storage`            | [Bind storage and replica checks](../../scripts/storage-check.ts)          |
| `npm run report:parity`           | [Local report generator](../../scripts/report-parity.ts)                   |

Use one new run ID for a complete comparison, in every terminal involved:

```sh
export PARITY_RUN_ID=local-20261113
unset PARITY_REPLAY PARITY_PHASE PARITY_ONLY
npm run test:integration
npm run test:parity
npm run test:advanced
npm run test:access
npm run test:reference-failures
npm run test:restart
```

The integration and reference suites create separate `parity-<run-id>` projects. Advanced and restart checks reuse fixture identities and require the common suites first. `PARITY_RESUME=1` reuses available fixture services and report entries. It does not reset their state or make every scenario safe to repeat independently. Prefer a fresh run ID for a clean run.

For the WordPress phase alone on the reference target:

```sh
PARITY_PHASE=wordpress npm run test:parity
```

Keep the same run ID. Run this phase only after its project and MariaDB fixture exist.

The restart script is `scripts/restart-check.ts`. `PARITY_RESTART_TARGET=panel`, `reference` or `both` selects its target, with `both` as the default. It restarts only the dedicated Colima profiles `panel-dev` and `panel-local`. Keep `PARITY_RUN_ID` equal to the completed fixture run being checked. It verifies application version and data, WordPress content and uploaded media, HTTP authentication and control-plane project/session access after restart.

## Restart observations and operator recovery

The recorded Panel clean-VM restart check passed 5 of 5 assertions after long-running workloads and ingress were configured with Docker restart condition `any`. The modified reference failed its WordPress restart check: a clean exit with code 0 left WordPress stopped under its `on-failure` policy. An existing local Nginx demonstration had the same observed clean-exit behavior.

Keep `reference-restart.json` and its failed assertion. `scripts/recover-reference.ts` performs explicit operator recovery by restarting the known fixture WordPress service and the existing `local-check-1/web` demonstration. Review those service names against the local environment before invoking it:

```sh
npx tsx scripts/recover-reference.ts
```

This records `reference-recovery.json` separately and checks retained content, uploaded media and account access after the manual restart. A successful recovery does not change the earlier automatic-restart failure into a pass. Do not rerun the restart check solely to overwrite that failure with a healthy result after manual intervention.

## Full replay after VM restart

After the existing fixtures recover, rerun the full Panel common, advanced and access suites with both flags. Use the same run ID. The replay writes separate `*-after-restart.json` reports:

```sh
PARITY_RESUME=1 PARITY_REPLAY=1 npm run test:integration
PARITY_RESUME=1 PARITY_REPLAY=1 npm run test:advanced
PARITY_RESUME=1 PARITY_REPLAY=1 npm run test:access
PARITY_RESUME=1 PARITY_REPLAY=1 npm run test:parity
PARITY_RESUME=1 PARITY_REPLAY=1 npm run test:reference-failures
```

The Panel common and advanced suites each require 14 complete assertions. Access requires 4 assertions in each phase. The reference common suite requires 14 assertions, while its 7 failure experiments measure behavior and restoration. A passed experiment can record an action labeled `done` together with HTTP 502 and loss of the preceding runtime. It must not be summarized as a healthy release.

## Bind storage and replica checks

Run the storage suite after the VM restart, with `PARITY_REPLAY` absent:

```sh
env -u PARITY_REPLAY npm run test:storage
```

It writes `storage.json` with `executedAfterVmRestart: true`. Disposable bind services are created during this suite, after the reboot. Their marker persistence is verified across API service restart and container replacement, not across a VM restart with those same bind services already present.

The six checks cover reference bind marker persistence, reference fixture deletion, Panel read-only bind marker persistence, rejection of a symlink escaping the approved root before runtime creation, two real Nginx replicas with CPU/RAM limits across stop/start, and removal of all three disposable Panel fixtures through the API. Synthetic host directories are retained.

In run `20261113b`, the reference bind mount recorded `readOnlyObserved: false` despite the requested read-only setting. Panel recorded `true`. The removed reference route returned its default HTTP 301 HTTPS redirect, while Panel's removed fixture routes returned 404. These are measured differences, not equivalent read-only or route responses.

## Common scenarios

| Check                         | Required observation                                                                                        |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Project creation              | A new project belongs to the correct target and run ID                                                      |
| PostgreSQL, Redis and MariaDB | Each engine becomes usable, receives persistent storage and publishes no host ports                         |
| Git build                     | The control application serves version `v1` through both primary and alias HTTP domains                     |
| Database use                  | The application writes and reads a PostgreSQL record and Redis counter                                      |
| Storage                       | A named volume retains a marker, and the immutable file mount contains its configured bytes                 |
| Resource limits               | Docker reports the requested 0.5 CPU and 384 MiB limits                                                     |
| Logs and metrics              | A generated marker appears in real logs, and Panel reports nonzero memory with the expected container count |
| Lifecycle                     | Stop reaches zero replicas, start restores HTTP, and restart replaces the container while preserving data   |
| Saved environment             | Record the response immediately after save, then verify the changed value after deployment                  |
| Git update                    | Version `v2` is served after deployment, data remains, and Panel records commit and image metadata          |
| WordPress                     | Installation, post creation, media upload and authenticated API access work through HTTP                    |
| WordPress persistence         | Container replacement and MariaDB restart preserve the post, media and account                              |

Panel deliberately separates saving desired environment from deployment. The common suite asserts that a save leaves the deployed value unchanged. On the reference target, the same scenario records `valueImmediatelyAfterSave` rather than assuming that the vendor update endpoint has identical runtime side effects. Publish only the observed values from that run. Other reference behavior differences require evidence from its report or a separate observation.

## Advanced and interruption scenarios

The advanced suite checks duplicate idempotency keys, key reuse with a different operation and stale configuration revisions. The same request must resolve to the same action, while conflicting reuse and stale revisions return 409.

The console scenario requests a single-use ticket, opens an authenticated WebSocket and sends canonical input and resize packets. It executes a unique `printf` marker followed by `stty size`, checks the real output and verifies ticket replay is rejected. The SSE check triggers a log marker and reads it from the live authenticated stream. HTTP success without the expected output does not pass either scenario.

Secret checks compare known fixture values against returned service configuration, stored job snapshots, the agent operation journal and runtime logs. Ordinary connection reads must omit the database password. An explicit authorized reveal must return the correct deployed password. Credentials, database names and users stay immutable after creation. Database images cannot change after their first deployment. Rotation and upgrade migration are outside the test scope.

Failure scenarios submit a missing image, absent repository, broken Dockerfile, unhealthy release, incorrect HTTP port and wrong application database password. Each must produce a failed action while the preceding healthy application and its data remain available. Restore desired settings between cases.

Interruption scenarios kill a supervised worker or agent only after Docker accepts the target operation. The supervisor must replace the process. Recovery must finish the original action with the same operation identifier, one intended replica and the retained data marker. Do not run process-killing checks against a shared or production instance.

Project editing must preserve running workloads, and deleting a nonempty project must return 409. Service destroy must remove its runtime and routes, make ordinary service reads return 404, retain the managed data volume and leave action history readable. Retained volumes are expected output, not evidence of a failed destroy.

## Evidence and private files

Reports are written to `artifacts/parity/<PARITY_RUN_ID>/`. They include per-check status, timestamps and target metadata. A stopped run contains only the checks reached so far. Preserve failures instead of presenting a partial report as a complete pass.

Generate the local HTML and structured JSON summary after the suites finish:

```sh
npm run report:parity
```

The generator reads the selected run's JSON reports, `artifacts/unit-tests.json`, `artifacts/package-verification.json` and local screenshot metadata. It writes `index.html` and `summary.json` in the run directory without contacting a hosting service or CDN. The independent Panel completion gate requires the initial common, advanced and access suites, its actual VM restart check, all three full replays, storage, unit and package evidence. Reference failures remain visible separately. The Linux package report includes the actual image identifier and real Git/BuildKit checks.

Run identities, route metadata, generated database passwords and WordPress application passwords are under `.data/parity/`. Credential files use mode 0600. The `.data/` and `artifacts/` directories are excluded from Git. Share only selected reports or screenshots after reviewing their contents. Never include credential files, the secret encryption key, SQLite files, cookie headers or console tickets in published evidence.

Browser checks supplement the scripts: create an application, save and deploy a configuration change, inspect real logs, execute a console command and inspect the interface at 375, 768 and 1440 pixels. Record keyboard and screen reader testing only when performed. Screenshots demonstrate layout, while action and runtime observations establish behavior.
