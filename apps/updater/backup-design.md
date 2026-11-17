# Control-plane backup design

Status: internal implementation notes. The lifecycle gate, strict capture/restore primitives and signed-update integration exist. Standalone installation backup authorization, host scheduling and guarded restart are implemented in the working tree. The public UI, explicit interrupted-operation recovery and full host acceptance remain unfinished.

## Scope and guarantees

The proposed backup covers the Servus control plane on one host: `panel.sqlite`, `agent.sqlite`, the installation encryption key, encrypted secret files, database-root references, the agent token, and the configuration and metadata required to identify the installation and its release. Both databases use SQLite WAL. The snapshot must represent one quiescent interval across both databases and all included files.

This is not a full disaster-recovery backup. It does not include the Docker Swarm state store, Swarm secrets, images, deployed service state, application volumes, or external databases. It does not restore application data or guarantee that the recorded control plane matches a separately changed Swarm. These require independently designed backups and reconciliation. Do not label this artifact as a backup of application data.

The design assumes the host kernel, Docker daemon, root supervisor, and privileged host administrators are trusted. It must fail closed when it cannot prove that all relevant writers are stopped and prevented from restarting. A pair of `docker ps` checks does not prove this condition.

## Writers and consistency boundaries

- The API and worker open `panel.sqlite` through `Store`, including migrations and WAL writes. Both initialize `SecretVault`.
- The agent opens `agent.sqlite` in WAL mode, writes durable operation state and encrypted runtime snapshots, and performs Docker and Swarm mutations.
- `SecretVault` creates the installation key and writes encrypted files under `secrets/`. The agent can also create `agent-token`, `database-roots/`, source revisions, build workspaces, and logs.
- The worker may still be handling a claimed job when shutdown begins. The agent waits for active operations during graceful close, but a timeout, crash, or forced stop can interrupt one. An interrupted operation and a separately modified Swarm cannot be treated as an atomic snapshot.
- The shared data directory belongs to container UID 1000. Its paths and descendants cannot be trusted by a privileged file-copy process solely because a prior path check succeeded.

## Implementation stages

### 1. Define the control-plane inventory and maintenance protocol

1. Specify the exact included files, mandatory and optional entries, supported filesystem and mount topology, schema versions, owner and mode rules, and limits. Capture the installation image digest, source revision, effective Compose configuration identity, and database schema versions without recording secret values.
2. Add an API maintenance state that rejects new state-changing requests and closes or refuses terminals. Define a read-only health/status response for the supervisor. Existing requests must drain or reach a reported deadline.
3. Add a worker quiesce handshake: stop claiming jobs and report whether current work completed, is still active, or requires reconciliation. Do not infer completion from process liveness.
4. Add an agent quiesce handshake: reject new apply requests, wait for active operations and builds, and report the durable state of unfinished work. Require explicit safe handling of Docker-side work that can outlive a client process.
5. Record maintenance state and operation progress in a root-owned durable supervisor journal, outside the application data directory. Serialize backup, installer, updater, origin migration, and other control-plane maintenance through one shared host lock.

Tests: concurrent mutations during maintenance; drained and timed-out requests; active and interrupted jobs; lost worker lease; agent apply and build in progress; duplicate requests; lock contention; restart during each handshake. The supervisor must reject uncertain or inconsistent states.

### 2. Enforce a quiescent window

1. Verify the expected installation, data directory, image identities, mounts, and the complete set of processes or containers that can write the inventory. Detect or reject unsupported bind mounts, volume aliases, hard links, filesystem topologies, and other writable access paths.
2. Prevent new writers mechanically for the whole window, including Docker restart policies, host service restarts, installer and updater actions, and host reboot. The implemented lifecycle gate and root maintenance journal provide this boundary for the supported updater path. The standalone backup path still needs complete interruption and host-restart acceptance.
3. Drain and stop the specific API, worker, and agent only after their quiesce handshakes. Verify that all known writers exited and that the startup gate remains in force. Do not stop unrelated workloads or access their volumes.
4. If a writer, alias, outstanding operation, unsafe path, or inability to enforce the gate is detected, leave maintenance through a controlled recovery path and do not publish a snapshot.

Tests: process and container restart attempts, Docker daemon restart, host reboot, externally initiated writers, alternate mounts, active terminals, timeout and SIGKILL at every transition. Test that an unknown writer causes refusal, not a warning followed by backup.

### 3. Capture databases and files

1. Create a unique root-controlled staging directory with mode 0700. Never reuse or overwrite a prior backup. Record durable intent before capture and do not expose a partial snapshot as complete.
2. Use a dedicated unprivileged process with the data owner's UID for traversal and copying; root must not follow paths controlled by that UID. Traverse from already opened trusted directory descriptors with `openat`-style operations, `O_NOFOLLOW`, `fstat`, and type, ownership, link-count and identity checks. Define a fail-closed policy for unsupported mount crossings and aliases. Stream data over a bounded protocol to a root-owned staging writer that accepts only inventory-approved names and file types; the data owner must not be able to alter staged files after they are written. The unprivileged reader does not receive a root-owned writable path.
3. With all writers excluded, create consistent SQLite copies using the SQLite backup API on independent connections, with deadlines and explicit errors. Do not ignore a WAL or copy a live database as an ordinary file. Do not hold `BEGIN IMMEDIATE` and run backup on that same connection. Closing and checkpointing databases can be evaluated as an alternative, but requires proof of exclusive access and correct recovery after an unclean shutdown.
4. Copy the installation key, encrypted secrets, database-root references, agent token, and other inventory entries in the same quiescent interval. Never log file contents, credentials, decrypted secrets, or tokens. Define handling for incomplete temporary files and unreferenced encrypted secrets.
5. Sync staged files and directories, create a manifest containing non-secret identity, schema versions, file inventory and hashes, then atomically publish the completed snapshot and sync its parent directory. The artifact and any temporary copies remain private and are subject to explicit retention and deletion policy.

Tests: committed WAL records, incomplete transactions, unclean database shutdown, open WAL readers, backup deadline, corrupt database, full disk, failure during fsync or rename, partial copy, symlink and parent-swap races, hard links, directory replacement, mount aliases, and secret-file mismatch. Test no overwrite and inspect output and logs for synthetic secrets.

### 4. Verify restore and define recovery

1. Restore only into a new isolated data directory and disposable environment. Verify manifest and content hashes, SQLite `integrity_check` and `foreign_key_check`, database schema and release compatibility, and that all required secret references decrypt with the captured key. Do not print decrypted values.
2. Start compatible API, worker, and agent instances in a sandbox without access to production Docker, production sockets, networks, or application volumes. Validate login and representative control-plane reads using synthetic fixtures. Exercise interrupted job and agent-journal reconciliation against a fake runtime.
3. Define explicit policy for restoring an older control-plane snapshot against a newer or independently modified Swarm. An image rollback does not roll back a database migration. If backward compatibility or external runtime state is uncertain, stop and require manual recovery rather than starting an older image automatically.
4. Keep the startup gate active until recovery verifies a consistent state or a documented manual procedure takes ownership. Persist completion before reopening writes. Backups must not be reported as restorable solely because files were copied successfully.

Tests: missing or changed key, invalid ciphertext and reference, incompatible schema, mismatched release, missing manifest entry, corrupted file, unfinished operation, independent Swarm drift, repeated restore, rollback after migration, interrupted recovery, and isolated end-to-end restore. Verify that no test can modify a real Docker daemon or application volume.

### 5. Integrate only after the preceding gates pass

Expose a narrowly scoped administrative backup operation with session, role, CSRF and origin checks, authorization auditing, idempotent operation IDs, and bounded execution. IPC to the host supervisor uses a dedicated peer identity and fixed operations; peer identity alone does not prove an administrator approved a request. Report progress and failures without secrets. Release acceptance requires Linux integration tests and an isolated staging restore of the full procedure.

### Current standalone path

The administrator API signs a fixed UTF-8 receipt using the separately mounted API-role key. The root supervisor checks the proof and its 60-second submission window, then persists the actor, operation ID and name in its protected journal. It derives all filesystem paths from host configuration. The API response and status transport contain no backup path, key or proof.

The updater is the sole supported producer of backup and update admissions. Its singleton lock, serial scheduler and durable worker reservations are part of the interlock. While a root backup is pending, new update admissions and background worker ticks stop. The root supervisor rejects backup submission if another verifier, preparation, legacy recovery or update may still be active, including uncertain recovery states. An idle status response is never treated as a lease. Out-of-band root backup submissions while that scheduler is running are outside this protocol.

Capture uses the existing authenticated drain and startup fence for the three control-plane containers. Restart retains a recovering gate until fresh authenticated roles reconnect and health checks pass. Completion rechecks the snapshot, records the receipt durably and then releases work. An uncertain capture or partial restart retains its recovery fence. The fixture coordinator remains a test tool and does not authorize this host path.

## Current blockers

The capture primitive passes the isolated Linux schema 4-8 and encrypted-reference checks. The standalone root journal/start/finalization checks and host orchestration tests also pass, with the actual Docker drain/capture boundary replaced in orchestration tests. These checks do not establish a completed product backup operation.

Remaining work is the full real-host API-to-supervisor capture/restart test, an isolated restore of its resulting artifact, explicit recovery after interruption at each boundary, UI/history/retention and the final signed-release compatibility exercise. A control-plane snapshot does not roll back application data or independently changed Swarm state. This document does not authorize deployment.
