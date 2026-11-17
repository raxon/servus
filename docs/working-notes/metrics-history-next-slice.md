# Metrics history - next implementation slice

This is a grounded discovery note, not implemented functionality.

## Existing behavior

`apps/panel/src/agent/observability.ts` collects current measurements from owned Swarm service containers. CPU uses Docker deltas, memory excludes inactive file cache and network totals are cumulative. `agent/runtime.ts` delegates collection and the authenticated agent route exposes `/services/:id/metrics`.

The public route in `server/app.ts` checks service access and calls the agent. Project tokens already allow the current metrics path. `shared/types.ts` defines six current measurements without a timestamp or runtime generation. `web/ServiceFeatures.tsx` polls every three seconds while the service is running. There is no independent sampling, historical store, host usage/disk collector or Compose metrics surface.

## Proposed bounded implementation

Sample current Swarm services every 60 seconds independently of browser requests, with CPU, RAM and container-count views for 1h/6h/24h. Keep cumulative live network cards unchanged until rate calculations across counter resets are tested. CPU above 100% is valid for multiple cores.

A collector must prevent overlapping ticks, bound concurrency and agent request timeouts, and hold maintenance admission through sampling, writes and pruning. Shutdown stops scheduling and waits for active work. Capture service/project/deployed revision before awaiting the agent, then reload the live service/project afterward and discard a sample whose identity changed. Current authorization applies to every history read and must be checked again after asynchronous work. A cached project ID never grants access.

Use a sample timestamp and runtime generation derived from sorted owned running container IDs, ideally confirming that the set stayed stable during collection. Revision alone is insufficient because restarting or redeploying the same revision can replace processes. Record observed unavailability as a gap. A zero requires a real Docker observation. Add explicit history token/OpenAPI routes for read/deploy scopes.

## Storage boundary

A separate private `metrics.sqlite` can retain history across process restarts while remaining a disposable telemetry cache excluded from installation snapshots. Bound retention to 24h plus explicit row/disk limits, and expose the earliest available timestamp when capacity truncates history. Document that installation restore starts with an empty cache. Add an actual snapshot/restore compatibility check for the metrics DB and WAL.

Do not add tables silently to panel schema 8. `backup.py` checks an exact table inventory and imposes a 64 MiB database bound. Including telemetry in recoverable panel state requires a coordinated schema migration and snapshot validator changes instead.

## Acceptance

Use an exclusive VM and labelled workload, generate real CPU/memory/local HTTP activity, and observe at least two default sampling intervals without opening the metrics UI. Verify nonzero measurements and persistence after reopening API/cache state. A same-revision redeploy must change generation. An agent outage must produce a gap, followed by valid resumed measurements. Test TTL boundaries with an injected collector clock without changing host time.

Deletion or configuration changes during a delayed sample must discard stale results. Membership and token revocation must deny history immediately. Maintenance drain must exclude late writes. Browser checks cover 375/768/1440 px, chart units, visible gaps and keyboard access. These checks establish service history only, while host, disk and Compose metrics remain separate work.
