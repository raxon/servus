# Legacy PostgreSQL migration design

Status: proposed. No migration or database change is implemented by this document.

## Purpose and scope

Allow a panel-managed PostgreSQL service created before image-reference labels to receive future deployments without silently changing its image or data volume. Preserve the running service while evidence is collected. Changes to the PostgreSQL major version, credentials, authentication policy, or storage location require a separate migration.

The existing guard rejects a saved image tag when the running service has no matching image-reference label. Removing that guard would let a queued configuration with a different image be marked as deployed. Resolving the tag again would also be unsafe because a registry tag can move.

## Available evidence

| Record | Relevant fields | Limit |
| --- | --- | --- |
| Panel `services` | Current image, revision, deployed revision, image digest | Mutable summary, not a historical binding by itself |
| Panel `actions` and `jobs` | Action ID, type, status and frozen service snapshot | The snapshot captures the requested configuration, not the Docker outcome |
| Agent `operations` | Action ID used as operation ID, state, result and encrypted previous and target specs | The agent journal and vault must be available and trusted |
| Swarm service | Version index, owner, service ID, operation, revision, image digest and mounts | The latest operation can be a start or restart rather than the deploy |
| Running task and container | Image ID, resolved mount sources, effective PostgreSQL settings | A stopped or replaced task cannot establish the old container's effective data path |

These records are trusted local state, not signed attestations. An operator with control of the panel database, agent journal, Docker daemon, image, or host can alter the evidence. This design does not defend against such an operator.

## Admission procedure

1. Acquire a per-service migration lock respected by API edits, the worker and the agent. Reject new actions while it is held. Reconcile any queued, running, expired-lease or uncertain operation first. A process-local lock alone is insufficient across restarts.
2. Inspect the owned Swarm service and record its ID, version index, node placement, replicas, current task ID, container ID and image digest. Require one healthy running task. Do not update its spec during admission.
3. Find the successful deploy action for the active revision. Join its immutable job snapshot to the agent operation by action ID, and require a successful agent result with a readable target spec. Match the service ID, revision, target image digest and mount identities to the current runtime. Trace any later successful stop, start or restart operations through their journal entries. An ambiguous chain stops admission.
4. Compare the deployed snapshot's image reference with the current saved reference. If the saved reference differs, report configuration drift and leave it unresolved. Never infer the original reference from a freshly resolved registry tag.
5. Verify the running container's image identity and inspect PostgreSQL's effective `data_directory`. Resolve the path inside the container, inspect the container mount and daemon volume or bind source, and confirm the resolved data directory is covered by the same writable persistent mount on the pinned node. A string-prefix comparison or image environment variable is not sufficient. Reject unknown symlinks, overlapping mounts, anonymous or ephemeral storage, inaccessible sources and unverified custom entrypoints.
6. Create a PostgreSQL-consistent backup using a separately designed backup mechanism. Restore it into an isolated instance and verify that it belongs to the intended service and can be read. Record the backup identifier and verification time without storing credentials in the migration record. A backup and restore rehearsal is required before a later operation that replaces the container.
7. Re-read the panel revision, active-operation state, service version index, task identity, image and mount identities while holding the lock. Any change invalidates the evidence. Record an auditable binding between service ID, deployed revision, original image reference, exact digest, mount fingerprint, node identity, evidence action and backup verification. Commit this record in a panel database transaction with a schema version and a migration ID.

Release the lock only after recording the outcome. Admission changes panel metadata only. Updating Docker service labels is deliberately excluded because a service update can replace a task. On restart, a durable migration state must resume evidence collection or leave the service unchanged. The implementation must define a fencing mechanism for stale workers and a recovery protocol across the panel database, agent journal and Docker, since these systems do not share a transaction.

## Future deployments

A deploy reads the binding under the same per-service lock, verifies the current Swarm version and compares the saved image reference, pinned digest, node and mount fingerprint with the admission record. The target spec uses the admitted digest and unchanged storage. It does not pull or resolve the mutable tag. A changed image or storage layout requires an explicit migration and a new backup.

The admission record is not perpetual proof. Recheck the effective runtime and mount binding before every operation that can replace the task. Docker can also restart tasks outside panel control, so the design must explain how that independent behavior is detected and how a service with unproven storage is protected before production release.

## Fail-closed cases

- The successful deploy snapshot, agent journal, vault key or target spec is missing, unreadable, inconsistent or no longer attributable to the running service.
- Multiple successful records could explain the runtime, or a later operation cannot be reconciled.
- The service, task, image, mount, node or revision changes during admission, or another worker can act without the migration fence.
- The saved reference differs from the deployed snapshot, a digest is missing or mutable, or the target image differs from the admitted digest.
- The real data directory cannot be mapped to a verified persistent mount. Examples include custom `PGDATA`, unresolved symlinks, hidden parent mounts and image-defined behavior that has not been verified.
- The service is stopped, its current task cannot be inspected, its previous storage cannot be identified, or the Docker daemon is unavailable.
- Backup creation or isolated restoration fails, or the backup cannot be attributed to this service.
- A journal or database recovery state is uncertain, a migration record is incomplete, or lock ownership cannot be proved.

In each case, leave the existing service and storage unchanged. Show the evidence that is missing without exposing database credentials. Recovery is an explicit operator procedure, not an automatic rewrite of the deployment history.

## Test plan

Tests must run against disposable services and volumes. Use synthetic credentials and markers.

| Scenario | Required result |
| --- | --- |
| Successful deploy followed by start or restart | Recover the original deploy chain and admit the exact reference and digest |
| Tag moves after deploy | Reuse the admitted digest without pulling the tag |
| Queued snapshot contains a different image | Reject admission or deployment and keep the running task unchanged |
| Missing, failed, conflicting or unreadable journal entry | Reject with a specific reason and write no binding |
| Runtime image, mount, node, revision or Docker version changes during collection | Abort and require a new evidence pass |
| Concurrent edit, new action, expired lease or agent crash | Fence the stale operation and recover without changing the service |
| Custom image, image-defined `PGDATA`, symlink, overlapping mount or ephemeral path | Reject unless the effective directory and persistent source are proved |
| Stopped task or inaccessible Docker daemon | Reject without reconstructing a task from assumptions |
| Backup or isolated restore fails | Reject container replacement and retain existing data |
| Crash before and after the metadata commit | Recover idempotently with either no binding or one complete binding |
| Deploy, retry and rollback after admission | Keep the original digest and mount, retain the marker and never report an unverified revision as deployed |
| Swarm independently restarts a task | Detect the event and verify the data binding without assuming the panel initiated it |

Integration tests must exercise the panel database, encrypted agent journal and a real local Swarm with PostgreSQL. Unit tests for evidence matching and crash points do not replace that run. Verify that errors and audit records contain no secrets. Do not run these tests against user databases or production volumes.
