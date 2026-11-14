# Servus

Brand domain: `servus.run`. The local panel runs at <http://localhost:4180>, and the website development server runs at <http://localhost:4182>.

Deploy applications and private databases on a Docker server you control. Servus stores project settings and deployment actions in SQLite, while its worker sends recorded operations to a separate local agent that builds Dockerfiles and manages Docker Swarm workloads.

This repository contains an expanded local pilot with an independently written API, worker, agent and browser interface. Full EasyPanel compatibility remains unfinished. Fonts and browser assets are bundled locally.

## Monorepo

The repository uses npm workspaces and Turborepo. Run commands from the repository root with Node.js 24 and the npm version pinned in `package.json`.

```text
apps/panel/       API, worker, Docker agent and React management interface
apps/website/     React website and Cloudflare static asset configuration
scripts/          Local supervisor, installer and integration tools
deployment/       Linux installation package
tests/install/    Host-safe installer tests
spec/parity/      Comparison scenarios
```

Each app builds into its own `dist` directory. The root `.data` directory keeps local projects, authentication state and secrets in place. Source paths changed during the workspace migration, but the existing local state directory is retained.

See [AGENTS.md](AGENTS.md) for contribution instructions and [the architecture notes](docs/architecture.md) for process boundaries.

## VPS installation

The installer supports Ubuntu 22.04, 24.04 and 26.04, plus Debian 12 and 13 on amd64 or arm64. It prepares Docker when needed, builds Servus from source and starts the installation Compose package. You do not need Node.js on the VPS. Installation state lives under `/var/lib/servus`, and host configuration lives under `/etc/servus`.

After the website and matching repository revision are published, the public command will be:

```sh
curl -fsSL https://servus.run/install.sh | sudo bash
```

Publication is required. Preparing this repository does not establish that `servus.run/install.sh` already serves the new installer. Inspect the script locally, then preview the installation on a supported Linux host:

```sh
bash scripts/install.sh --help
bash scripts/install.sh --dry-run --source "$(pwd)"
```

On the target Linux host, install from a local checkout with:

```sh
sudo bash scripts/install.sh --source "$(pwd)"
```

The installer binds the management panel to `127.0.0.1:4180` by default. Application HTTP ingress uses port 80. To reach a VPS panel from your computer, use the SSH tunnel in the [installation guide](deployment/README.md). Use a tested immutable source revision for a release. Each installed panel needs its own address and management TLS configuration.

## Website

In one terminal, start the local panel with `npm run local`. In another, run:

```sh
npm run dev
```

This starts the panel frontend on <http://localhost:4181> and the React website on <http://localhost:4182>. Use `npm run dev:website` to work on the website alone. Its basic assets and fonts are local.

The website's `public/install.sh` is generated from `scripts/install.sh` before development and builds. Edit the canonical script, then run its tests. Do not maintain a second installer copy by hand.

Cloudflare configuration is in `apps/website/wrangler.jsonc`. Package it without publication using:

```sh
npm run check:cloudflare
```

Publishing requires an authenticated Cloudflare account with access to the `servus.run` zone. After deployment has been authorized, log in locally and publish:

```sh
npx wrangler login
npm run deploy:website
```

The website deployment is independent of the VPS panel. A successful local build or dry run does not confirm public DNS, HTTPS or installer availability.

## Supported operations

| Area               | Current behavior                                                                                                            |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| Access             | One-time administrator setup, cookie sessions, CSRF and origin checks, project access checks                                |
| Projects           | Create, list, rename, edit descriptions and delete empty projects                                                           |
| Applications       | Public Docker images or public Git repositories with a Dockerfile, branch/ref and build context                             |
| Configuration      | Saved and deployed revisions, environment variables, multiple HTTP domains, CPU/RAM limits and replicas                     |
| Storage            | Named volumes, immutable read-only configuration files and administrator-approved bind paths                                |
| Databases          | PostgreSQL 17, Redis 7 and MariaDB 11.4 presets with private project networking and persistent data                         |
| Operations         | Deploy, start, stop, restart and destroy actions with durable events and failure details                                    |
| Runtime inspection | Current CPU, RAM and network samples, container lists, recent logs, live log streaming and an interactive `/bin/sh` console |
| Recovery           | Durable agent operation journal and restoration of the previous application specification after a failed deployment         |

Automatic application HTTPS, private Git credentials, Compose application imports, backups, historical monitoring, templates, CLI/MCP and multi-node management are outside this implementation. The repository's own Docker Compose package runs Servus components. It does not add Compose workload support.

## Requirements

Use Node.js 24, the npm version declared in the root `packageManager` field and a Linux Docker Engine available to the agent with Swarm manager privileges. The macOS workflow also requires Docker CLI, its Buildx plugin and Colima. Servus listens on port 4180 and application HTTP ingress on port 18080.

Choose a dedicated test daemon. The agent can initialize Swarm and create ingress services, so this pilot assumes trusted operators with Docker administration rights.

## Run locally

On macOS:

```sh
nvm use
npm ci
npm run local:vm
```

This starts the separate Colima profile `panel-dev`, builds Servus and supervises the API, worker and agent. Your selected Docker context stays unchanged. Existing VM data and deployed services are retained.

Source builds use `docker buildx`. If `DOCKER_CONFIG` is unset, the local supervisor detects the Homebrew plugin at `/opt/homebrew/lib/docker/cli-plugins/docker-buildx` and writes a local plugin configuration under `.data/docker-config/`.

Open <http://localhost:4180> and create the first local administrator with an email address and a password of at least 8 characters. Until setup is complete, restrict access to the panel to the administrator: anyone who can reach an unconfigured instance can create the first account. Control-plane data and encrypted secret files live under `.data/`, which is excluded from Git and the Docker build context.

For an existing local Linux Docker daemon:

```sh
nvm use
npm ci
PANEL_DOCKER_SOCKET=/var/run/docker.sock npm run local
```

Stop the supervised processes with Ctrl+C. You can stop the dedicated VM separately with `colima stop panel-dev`. Neither operation deletes application volumes.

## Deploy an application

1. Create a project and add an Application service.
2. Choose Docker image, enter `nginx:alpine`, container port `80` and hostname `welcome.localhost`.
3. Select **Create & deploy** and follow the action until it succeeds.
4. Open <http://welcome.localhost:18080>.

Deployment success requires the intended runtime tasks and an HTTP response through ingress. A direct routing check is also available:

```sh
curl -H 'Host: welcome.localhost' http://127.0.0.1:18080
```

For Git, select a public HTTPS repository, branch or ref, build context such as `.` and Dockerfile path such as `Dockerfile`. Build paths must remain inside the repository. Successful Git deployments record the source commit and image identifier.

**Save** records desired settings. **Deploy** applies them. Start and restart use the deployed configuration, while stop sets runtime replicas to zero and retains the saved settings. A failed application update can restore the preceding runtime specification. It cannot undo database migrations or external side effects.

## Configuration and data

Environment entries have unique names. The text editor accepts `KEY=value`, blank lines and `#` comments. Single quotes preserve literal values, and double-quoted values use JSON escapes such as `\n`. Raw multiline blocks, shell expansion and `export` statements are unsupported.

Secret entries are stored encrypted and returned as `secretRef` identifiers. Existing values stay masked until explicitly replaced. Keep those references when submitting a complete environment array through the API. Removing an entry from that array removes it from desired configuration. Secret values reach the running workload, so operators with Docker access can inspect its environment.

Each domain maps a hostname to a container port, with at most one primary domain. HTTP only. An empty domain list keeps the application on its private project network, and configuration file mounts contain ordinary settings that can be inspected by operators with runtime access.

Writable volumes and database services require one replica. Application CPU limits accept 0.1 to 64 cores, memory limits 32 to 131072 MiB, and stateless application replicas 1 to 5. Bind mount sources must be existing paths nested under `PANEL_MANAGED_BIND_ROOT`, which defaults to `/var/lib/panel/mounts`, on the Docker host. Configure the same approved root in the API and agent.

Database services publish no host ports. Use their service names from applications in the same project. PostgreSQL and MariaDB initialize the selected database and user. Redis uses logical database 0 and its default user. An omitted password is generated. The connection panel reads the last successful deployment and reveals its password only after an explicit request.

Database names, users and passwords are immutable after creation. Image changes are blocked after a database has been deployed. Credential rotation and database upgrade migrations need separate workflows and are not implemented.

Destroy removes a service and its HTTP routes while retaining managed volumes and action history. Delete an empty project after removing its services. Retained data needs explicit operator cleanup when it is no longer required.

## API contracts

All endpoints use `/api/v1`. Authentication uses a session cookie. Read the `csrfToken` from setup, login or session responses and send it as `X-CSRF-Token` on authenticated mutations. Service creation, lifecycle actions and service deletion also require an `Idempotency-Key`. Reuse that key only when retrying the same request.

| Endpoint                                                   | Contract                                                         |
| ---------------------------------------------------------- | ---------------------------------------------------------------- |
| `GET /setup`, `POST /setup`                                | Setup status, then `{email,password}`                      |
| `POST /auth/login`, `GET /auth/session`                    | Login accepts `{email,password}`, both return `{user,csrfToken}` |
| `GET/POST /projects`                                       | List or create projects                                          |
| `GET/PATCH/DELETE /projects/:id`                           | Read, edit or delete an empty project                            |
| `GET/POST /projects/:id/services`                          | List services or create one and return `{service,action}`        |
| `GET/PATCH/DELETE /services/:id`                           | Read, save configuration or queue a destroy action               |
| `POST /services/:id/deploy`, `/start`, `/stop`, `/restart` | Queue an action                                                  |
| `GET /services/:id/actions`, `GET /actions/:id`            | Action list or `{action,events}`                                 |
| `GET /services/:id/metrics`, `/containers`, `/logs`        | Current runtime data, with log tails capped at 500 lines         |
| `GET /services/:id/logs/stream`                            | Session-authenticated SSE messages containing `{lines:string[]}` |
| `GET /services/:id/connection`                             | Deployed database connection without a password                  |
| `POST /services/:id/connection/reveal`                     | Explicit authorized password reveal                              |
| `POST /services/:id/console-ticket`                        | `{containerId,shell:"/bin/sh"}` returns a single-use ticket      |

Configuration updates require `expectedRevision`. A stale revision returns HTTP 409. Arrays supplied in a patch replace the corresponding desired collection. The typed request shapes are defined in `apps/panel/src/shared/types.ts`, and validation rules in `apps/panel/src/server/configuration.ts`.

The console connects to `/api/v1/services/:id/console?ticket=...` by WebSocket. Input packets use `{type:"input",data}`, resize packets use `{type:"resize",cols,rows}`, and output is raw terminal data. Reloading or leaving the console closes its connection. Errors use `{error:{code,message}}`.

## Docker Compose packaging

Servus includes a multi-stage Dockerfile and `compose.yaml`. The API and worker do not mount the Docker socket. The agent needs the socket and its host group ID.

From an isolated Linux Docker environment:

```sh
export DOCKER_GID=$(stat -c '%g' /var/run/docker.sock)
docker compose build
docker compose up -d
```

Open <http://localhost:4180> and create the first local administrator, or sign in if setup is complete.

The `panel-data` volume stores SQLite, agent state and secret material. Keep live SQLite files on local storage. This root Compose package binds the management interface to localhost. The VPS installer has separate port and host settings described in its installation guide. Configure management HTTPS and secure cookies before exposing the panel publicly, and decide separately whether application ingress should be reachable remotely.

The recorded package verification covers a Linux ARM64 image with Node.js 24 and Docker 29. It includes a real deployment, Git clone and BuildKit build inside the Linux package. Other architectures need their own verification.

## Development and verification

```sh
npm run typecheck
npm test
npm run build
npm run smoke
```

The smoke check creates a real project and Nginx service in the dedicated instance. It exercises lifecycle operations and recovery after a bad port change. If setup is needed, it saves a randomly generated administrator password to `.data/local-credentials.json` with mode 0600 and does not print it.

The expanded fixture suites share a run ID:

```sh
export PARITY_RUN_ID=local-20261113
npm run test:integration
npm run test:parity
npm run test:advanced
npm run test:access
npm run test:reference-failures
npm run test:restart
```

These commands require the local fixture Git server, test images and two isolated Docker contexts. Follow [the reproduction scenarios](spec/parity/scenarios.md) for prerequisites, operator recovery and the full replay after VM restart. Keep the same run ID throughout. Access checks run both before and after restart.

Run the six storage and replica checks after the VM restart, without the replay flag, then generate the local report:

```sh
env -u PARITY_REPLAY npm run test:storage
npm run report:parity
```

Storage checks create disposable bind services after the reboot and verify persistence through API service restart, read-only behavior, symlink escape rejection and two real replicas. This does not claim that those bind fixtures existed during the VM reboot. The report writes `artifacts/parity/<run-id>/index.html` and `summary.json`, preserving recorded reference failures and marking missing required evidence as pending. A unit test count alone does not establish parity or certify the complete product.

For separate panel processes, run `npm run dev:api`, `npm run agent` and `npm run worker`, using the same `PANEL_DATA_DIR`. Start the frontend with `npm run dev:panel`. Set `PANEL_DOCKER_SOCKET` for the agent. The panel Vite server proxies API and WebSocket requests to port 4180. Environment files are not loaded automatically.

The API commits configuration and jobs together. The worker owns orchestration leases, and the agent journals operation IDs before talking to Docker. Recovery inspects or resumes the same operation after an interruption. Browser builds retain earlier hashed assets so an already open tab can still load its console module.

## License

Servus is available under the PolyForm Noncommercial License 1.0.0. See [LICENSE](LICENSE) for the terms. Dependencies retain their own licenses. Servus runs without an activation server.
