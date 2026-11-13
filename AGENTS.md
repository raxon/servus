# Repository instructions

## Scope and workflow

These instructions apply to this repository. Read a more specific `AGENTS.md` before changing a nested area if one exists.

- Communicate with the user in Polish unless they request another language. Write code comments, developer documentation and technical instructions in English.
- Use ordinary hyphens. Do not use en dashes or em dashes.
- Inspect the relevant code and current Git changes before editing. Preserve unrelated work. Reuse this checkout unless isolation is needed, and do not add `codex` to branch or worktree names.
- Plan code changes before implementation. Give each contributor a bounded responsibility and separate implementation from verification. Keep edits within the agreed scope.
- Prefer small changes that solve the requested problem. Avoid speculative abstractions, unrelated refactors and dependencies that duplicate existing tools.
- Use `rg` for code searches. Run independent read-only checks together, but keep dependent edits and deployment steps sequential.
- Report completion only after examining fresh verification output. Distinguish a passing check from an untested assumption or a blocked check.

## Repository map

| Path | Responsibility |
| --- | --- |
| `apps/panel/src/server` | HTTP API, authentication, persistence and configuration validation |
| `apps/panel/src/worker` | Durable deployment orchestration and action leases |
| `apps/panel/src/agent` | Docker access, builds, runtime operations and observability |
| `apps/panel/src/shared` | Shared types, schemas and secret handling |
| `apps/panel/src/web` | React management interface |
| `apps/panel/tests` | Panel unit and contract tests, plus application fixtures |
| `apps/website` | Public React website and Cloudflare static asset configuration |
| `scripts` | Local supervision, the canonical installer and integration tooling |
| `deployment` | Linux installation package and operator instructions |
| `tests/install` | Installer tests that must run without changing the host |
| `spec/parity` | Scenario definitions and comparison criteria |
| `docs` | Architecture and developer documentation |

The root npm workspace and Turborepo configuration coordinate both apps. Keep one root `package-lock.json`. Do not create per-app dependency lockfiles. The control fixture's existing lockfile belongs to that independent test application.

## Commands

Use Node.js 24 and the npm version declared in the root `packageManager` field. Run commands from the repository root.

```sh
nvm use
npm ci
npm run typecheck
npm test
npm run build
```

| Command | Purpose |
| --- | --- |
| `npm run local:vm` | Start the dedicated `panel-dev` VM and supervise the panel |
| `npm run local` | Build and supervise the panel using an existing Docker daemon |
| `npm run dev` | Run both frontend development servers |
| `npm run dev:panel` | Panel frontend on port 4181 |
| `npm run dev:website` | Public website on port 4182 |
| `npm run dev:api` | Watch the panel API source on port 4180 |
| `npm run agent` / `npm run worker` | Run the corresponding development process |
| `npm run test:panel` | Panel unit and contract tests |
| `npm run test:installer` | Host-safe installer tests |
| `npm run check:cloudflare` | Build and package the website without publishing |

The frontend development servers need the panel API separately. `npm run local` supplies the API, worker and agent. Do not start a second process on an occupied port.

## State and runtime boundaries

- Preserve the root `.data` directory, deployed services, named volumes and existing local Docker contexts. Branding or workspace changes must not alter SQLite identities, Docker ownership labels, runtime service names or secret references.
- The local supervisor keeps control-plane state in root `.data`. All development processes must use the same `PANEL_DATA_DIR`. Environment files are not loaded automatically.
- Use the dedicated `panel-dev` context for panel integration work. Reference environments and their data are separate. Do not run cleanup against the default Docker context.
- Docker access belongs to the agent. The API and worker communicate through the authenticated local agent channel. Keep Docker socket access out of the public website and API containers.
- Deployment actions use persistent operation IDs, leases and journals. Retain idempotency, recovery and ownership checks when changing orchestration.
- Saved configuration and deployed configuration are different revisions. Start and restart use the deployed snapshot. An application rollback does not roll back database contents or schema migrations.
- Preserve stateful service constraints, authenticated readiness checks and private database networking. Do not replace runtime measurements with fabricated data.

## Security and installation

- Keep session, CSRF, origin and project authorization checks on every applicable API path. A hidden frontend control is not an authorization boundary.
- Keep secret values out of logs, reports, Git and generated website assets. Read secret files only when required for the authorized task. Never print their contents during inventory or debugging.
- Keep the local secret encryption key outside source control. Preserve secret references and redaction in ordinary API responses.
- Validate Git build contexts, Dockerfile paths, bind paths and archive paths before use. Reject traversal and symlink escapes rather than normalizing them into an allowed path.
- `scripts/install.sh` is the canonical installer. The website's `/install.sh` is generated from it by `scripts/prepare-website.mjs`; edit the source script only.
- Installer changes must preserve data on rerun, reject conflicts and touch only owned installation paths. Never fix an install failure by deleting unrelated containers, Swarm services, volumes or host files.
- Exercise installer parsing and failure paths with mocks before a real install. Use an isolated Linux VM for destructive integration scenarios, and clean only resources created by that run.
- Do not weaken another product's licensing or activation checks. Servus implements its own functionality and retains its declared license.

## TypeScript, React and website practices

- Keep TypeScript strict and use the existing schemas and shared types. Validate untrusted inputs at API and runtime boundaries.
- Preserve transactional writes for configuration and queued actions. Treat stale revisions and repeated idempotency keys as contract behavior.
- Use the existing React components, query keys and request helpers before adding another state layer. Derive render values directly when possible instead of synchronizing them with effects.
- Keep effects for external synchronization and include their dependencies. Avoid defining components inside render functions or adding memoization without a measured reason.
- Use semantic elements, visible labels, keyboard access and useful error states. Check logo, navigation and forms at 375, 768 and 1440 px when their layout changes.
- Bundle fonts and assets locally. Basic functionality must work without a CDN or a remote demo.
- Website claims must match tested product behavior. Do not add invented customers, metrics, testimonials, support guarantees or production readiness claims.
- Servus currently uses `PolyForm-Noncommercial-1.0.0`. Do not describe it as open source or promise unrestricted commercial use without an explicit license change.
- Public prose, including README content, must pass the `humanize` skill and then `ai-check`. Preserve technical meaning. Internal AI instructions and working notes are exempt.

## Verification and delivery

- Run checks suited to the changed behavior. A normal panel or workspace change needs type checking, relevant tests and a build. Do not add tests that merely repeat low-impact visual implementation details.
- For installer changes, run `npm run test:installer` and the appropriate Linux integration check. A dry run proves planning and validation only.
- For website changes, build locally and inspect responsive output. Check copy actions, navigation, focus states, console errors and the generated installer asset when affected.
- Integration and parity suites create real workloads. Read `spec/parity/scenarios.md`, choose the intended isolated contexts and use a run ID. A skipped scenario is not a passing scenario.
- Do not publish, push to a remote repository, modify public DNS or deploy a website without authorization for that action. Prepare the concrete result before requesting any remaining approval.
- `servus.run` is the website and installer domain. It does not automatically become the address of a user's self-hosted panel. Keep Cloudflare website deployment separate from VPS installation.
- Keep release identifiers and installation documentation consistent with published artifacts. Do not claim that an installation URL or release is live based on local files alone.
- In the final handoff, describe the result, the checks actually run and any material verification limit. Do not expose credentials in command output, screenshots or links.
