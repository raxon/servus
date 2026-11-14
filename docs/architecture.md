# Architecture

Servus has two applications in one npm workspace. Turborepo coordinates their checks and builds. The panel runs beside the operator's Docker daemon, while the public website is a static React application that can be deployed separately to Cloudflare.

## Layout

```text
apps/
  panel/
    src/
      server/
      worker/
      agent/
      shared/
      web/
    public/
    tests/
    dist/
  website/
    src/
    public/
    dist/
scripts/
deployment/
tests/install/
spec/parity/
```

The root holds the lockfile, workspace scripts and Docker build context. Each app owns its source, configuration and build output. Root `.data` remains the local control-plane state directory, so moving source into `apps/panel` does not create a new administrator or reset existing projects.

## Panel processes

The API validates configuration and access, then commits desired state and queued actions to SQLite. Browser mutations use session cookies, CSRF tokens and origin checks. Project access is checked on the server.

The worker leases queued actions and coordinates their execution. It sends authenticated requests to the local agent, which journals operation IDs before calling Docker. A restarted process can inspect the previous operation instead of issuing an unrelated duplicate.

The agent owns Docker builds, Swarm services, project networks and runtime inspection. The API and worker do not need the Docker socket. PostgreSQL, Redis and MariaDB services stay on private project networks unless a separate workflow explicitly publishes access.

Saved revisions describe the next requested deployment. Deployed snapshots describe the running service. Start and restart retain that distinction. Restoring an older application specification after a failed update does not reverse writes to a volume or database.

## Local development

`npm run local` builds `apps/panel` and starts its API, worker and agent through `scripts/local.mjs`. The supervisor passes root `.data` and the panel's built web directory explicitly. `npm run local:vm` first starts the dedicated Colima profile `panel-dev`.

The management API serves port 4180. Local application ingress uses port 18080. `npm run dev` starts the panel frontend on 4181 and website on 4182, with the panel frontend proxying API and WebSocket traffic to 4180.

Fixture and parity scripts remain under root `scripts`. Their reports stay under root `artifacts`, and fixture state stays under root `.data/parity`. The independent reference installation is outside this repository.

## Docker and VPS installation

The root Dockerfile builds the panel workspace and places its compiled server, worker, agent and frontend under `/app/dist` in the runtime image. It does not bundle or serve the public website.

`scripts/install.sh` prepares a Linux host and starts the Compose package in `deployment`. It builds the panel from the selected source revision rather than assuming a published container image exists. Installer state and configuration use `/var/lib/servus` and `/etc/servus`. The data bind is mounted at the same absolute path inside the agent so Docker-host file paths remain valid.

The development Compose package at root is separate from the installer package. It retains its existing volume and local defaults. Neither package imports arbitrary Compose applications into the product.

## Website and domain

`apps/website` builds static assets for `servus.run`. Its Cloudflare configuration belongs to that app. The website does not receive Docker credentials, the panel database or its local credentials.

Before website development or a build, `scripts/prepare-website.mjs` copies the canonical installer into the website's public directory. This produces `/install.sh` from the same source that installer tests exercise.

The intended public command is:

```sh
curl -fsSL https://servus.run/install.sh | sudo bash
```

That endpoint becomes available after the website and matching source revision are published. A local build or Cloudflare dry run does not establish that the public command works. Release deployments should select a tested immutable revision and document it alongside the installer.

The domain is for the website and installation assets. Each installed panel has its own address and management TLS configuration. Public website deployment does not expose a local panel or alter its allowed origins.

## Boundaries to preserve

The website can change independently of the panel runtime. Branding changes must leave service ownership labels, SQLite identifiers and persisted state intact. Installer upgrades must preserve application volumes and configuration. Secrets, local credentials and private keys stay outside source control and public build outputs.

The current license is PolyForm Noncommercial 1.0.0. Public descriptions must reflect that license and the local pilot's tested capabilities.
