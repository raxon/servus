# Project API, CLI and MCP

Create a token under Settings > API tokens. Choose one project and either read access or read and deploy access. Copy the token when it appears. Servus stores its hash and shows the original once.

Tokens created in the interface expire after 30 days. Revocation takes effect on the next request, and changing a local password revokes that user's API tokens. Every request also checks the owner's current project membership, so an editor who becomes a viewer loses deployment access even if the token originally allowed it.

Set `SERVUS_URL` to the panel origin and `SERVUS_TOKEN` to the copied token in your local process environment. Keep credentials out of command arguments, shell history and project files. Remote connections require HTTPS. A loopback HTTP URL works through an SSH tunnel.

## CLI

Use Node.js 24 with this repository's dependencies installed:

```sh
node scripts/servus.mjs projects
node scripts/servus.mjs services PROJECT_UUID
node scripts/servus.mjs service SERVICE_UUID
node scripts/servus.mjs logs SERVICE_UUID
node scripts/servus.mjs deploy SERVICE_UUID --idempotency-key release-123
node scripts/servus.mjs deploy SERVICE_UUID --force-rebuild --idempotency-key rebuild-123
node scripts/servus.mjs action ACTION_UUID
node scripts/servus.mjs compose PROJECT_UUID
node scripts/servus.mjs compose-workload WORKLOAD_UUID
node scripts/servus.mjs compose-logs WORKLOAD_UUID
node scripts/servus.mjs compose-deploy WORKLOAD_UUID --idempotency-key compose-release-123
node scripts/servus.mjs compose-actions WORKLOAD_UUID
```

Output is JSON. A queued operation returns an action ID. Read that action until its status is `succeeded` or `failed` to determine the outcome.

`start`, `stop` and `restart` take a service UUID and an optional idempotency key. Reuse the key when retrying the same request after a timeout. A different request with the same key returns a conflict. When omitted, the CLI generates a key and includes it in connection failure messages.

Use `compose-start`, `compose-stop` and `compose-restart` for an existing workload. Poll `compose-actions WORKLOAD_UUID` after a mutation until the returned action succeeds or fails. Compose inspection returns metadata. Source contents are omitted.

## MCP

Run `scripts/servus-mcp.mjs` directly with Node. Configure your MCP client to launch that file and provide `SERVUS_URL` and `SERVUS_TOKEN` through its environment or secret settings. The stdio transport uses stdout for protocol messages.

MCP tools cover project and service lists, inspection, recent logs, action polling and deployment. Compose has `list_compose`, `inspect_compose`, `read_compose_actions` and `read_compose_logs`, plus `deploy_compose` and `control_compose` for existing workloads. Use explicit idempotency keys for mutations. The panel checks authorization on every call, including renewed membership and token checks after an awaited Compose log request before returning its output.

## HTTP contract

The authenticated OpenAPI document is at `/api/v1/openapi.json`. Send `Authorization: Bearer TOKEN` without browser cookies. Read tokens can inspect their project, services, actions, current metrics, containers and recent logs. Compose access covers workload metadata, action history and logs. Deploy tokens can also deploy, start, stop and restart existing services and Compose workloads within the token's project.

Interactive account settings, secret reveal, terminals, backup downloads and installation administration require a browser session. Compose creation, configuration and deletion also require that session. Token creation and revocation retain the browser's CSRF and origin checks.

## Database compatibility

The panel database migrates to schema 8, which includes API tokens, backup metadata, volume recovery records, encrypted Compose and authentication settings, and service-owned registry and SSH references. Schema 8 also protects Redis restore volume bindings from older agents. Older binaries refuse this database. An image rollback alone cannot undo the migration. Use an installation snapshot captured before migration when recovering to an older release, and verify the associated runtime state before allowing writes.
