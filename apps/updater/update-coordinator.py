"""Private primitives for a fail-closed update coordinator."""

import hashlib
from contextlib import closing
import json
import os
import re
import sqlite3
import stat
import time
from types import SimpleNamespace


class UpdateError(Exception):
    pass


def _pairs(items):
    result = {}
    for key, value in items:
        if key in result:
            raise UpdateError('Duplicate manifest entry')
        result[key] = value
    return result


def verify_snapshot(path, digest, backup_module, node_fd, supervisor):
    """Verify a protected snapshot before allowing activation.

    The caller must hold the maintenance and installation locks throughout.
    This function does not itself establish writer quiescence.
    """
    if not isinstance(digest, str) or not re.fullmatch(r'sha256:[a-f0-9]{64}', digest):
        raise UpdateError('Invalid snapshot digest')
    digest = digest[7:]
    directory = supervisor._trusted_directory(path, 0o700)
    try:
        dev = os.fstat(directory).st_dev
        manifest_fd, _ = backup_module._file(directory, 'manifest.json', 0, dev)
        try:
            raw = backup_module._read(manifest_fd)
        finally:
            os.close(manifest_fd)
        if hashlib.sha256(raw).hexdigest() != digest:
            raise UpdateError('Snapshot manifest digest mismatch')
        manifest = json.loads(raw, object_pairs_hook=_pairs)
        if not isinstance(manifest, dict) or set(manifest) != {'format', 'files'} or type(manifest['format']) is not int or manifest['format'] != 1 or not isinstance(manifest['files'], dict):
            raise UpdateError('Invalid snapshot manifest')
        files = manifest['files']
        base = {'panel.sqlite', 'agent.sqlite', 'secret-key', 'agent-token'}
        if not base.issubset(files):
            raise UpdateError('Incomplete snapshot')
        for name, checksum in files.items():
            parts = name.split('/')
            if (not isinstance(checksum, str) or not re.fullmatch(r'[a-f0-9]{64}', checksum) or
                not (name in base or len(parts) == 2 and parts[0] in ('secrets', 'database-roots') and backup_module.UUID.fullmatch(parts[1]))):
                raise UpdateError('Invalid snapshot inventory')

        def check_inventory():
            if set(os.listdir(directory)) != base | {'manifest.json', 'secrets', 'database-roots'}:
                raise UpdateError('Unexpected snapshot contents')
            for folder in ('secrets', 'database-roots'):
                child = backup_module._child_dir(directory, folder, 0, dev)
                try:
                    if set(os.listdir(child)) != {key.split('/')[1] for key in files if key.startswith(folder + '/')}:
                        raise UpdateError('Snapshot inventory mismatch')
                finally:
                    os.close(child)
            for name, checksum in files.items():
                parts = name.split('/')
                child = backup_module._child_dir(directory, parts[0], 0, dev) if len(parts) == 2 else None
                try:
                    fd, _ = backup_module._file(child if child is not None else directory, parts[-1], 0, dev,
                                                backup_module.MAX_DATABASE if name.endswith('.sqlite') else backup_module.MAX_FILE)
                    try:
                        hasher = hashlib.sha256()
                        while chunk := os.read(fd, 65536):
                            hasher.update(chunk)
                    finally:
                        os.close(fd)
                finally:
                    if child is not None:
                        os.close(child)
                if hasher.hexdigest() != checksum:
                    raise UpdateError('Snapshot file digest mismatch')

        check_inventory()
        for name in ('panel.sqlite', 'agent.sqlite'):
            with closing(sqlite3.connect(f'file:/proc/self/fd/{directory}/{name}?mode=ro&immutable=1', uri=True)) as db:
                if db.execute('PRAGMA integrity_check').fetchall() != [('ok',)] or db.execute('PRAGMA foreign_key_check').fetchone() is not None:
                    raise UpdateError('Snapshot database integrity check failed')
        backup_module._validate_staging(directory, node_fd)
        check_inventory()
        manifest_fd, _ = backup_module._file(directory, 'manifest.json', 0, dev)
        try:
            if hashlib.sha256(backup_module._read(manifest_fd)).hexdigest() != digest:
                raise UpdateError('Snapshot manifest changed')
        finally:
            os.close(manifest_fd)
    finally:
        os.close(directory)


def begin_snapshot(journal, operation_id, lease, supervisor):
    """Record capture intent while the authenticated maintenance gate is held.

    A drained lease does not prove every writer is stopped. The caller must
    establish that independently before creating a snapshot.
    """
    if not supervisor._uuid4(operation_id) or not isinstance(lease, supervisor.DrainLease) or getattr(lease,'_legacy_upload_id',None) is not None:
        raise UpdateError('Invalid snapshot operation')
    lease.assert_locked(operation_id, 'stopped_unverified')
    db = journal.db
    db.execute('BEGIN IMMEDIATE')
    try:
        result = db.execute("UPDATE update_transactions SET phase='snapshotting' "
            "WHERE operation_id=? AND phase='intent' AND backup_path IS NULL AND backup_manifest_digest IS NULL "
            "AND EXISTS (SELECT 1 FROM operations o JOIN preparations p ON p.operation_id=o.id "
            "WHERE o.id=update_transactions.operation_id AND o.status='verified' AND p.status='prepared' "
            "AND o.digest=update_transactions.root_digest AND o.attempt_id=update_transactions.attempt_id "
            "AND o.attempt_nonce=update_transactions.attempt_nonce AND p.attempt_id=update_transactions.attempt_id "
            "AND p.attempt_nonce=update_transactions.attempt_nonce AND p.preparation_id=update_transactions.preparation_id)",
            (operation_id,))
        if result.rowcount != 1:
            raise UpdateError('Snapshot does not match the active update')
        lease.assert_locked(operation_id, 'stopped_unverified')
        db.execute('COMMIT')
    except BaseException:
        if db.in_transaction:
            db.execute('ROLLBACK')
        raise
    try:
        lease.record('snapshotting')
    except BaseException:
        db.execute("UPDATE update_transactions SET phase='recovery_required' WHERE operation_id=? AND phase='snapshotting'", (operation_id,))
        raise


def record_verified_snapshot(journal, operation_id, path, digest, lease, backup_module, node_fd, supervisor):
    """Bind a validated snapshot to the exact prepared release under the drain lease.

    The caller must have independently established writer quiescence and marked
    both journals as snapshotting before capture. An interrupted handoff leaves
    the operation requiring recovery instead of authorizing activation.
    """
    if (not supervisor._uuid4(operation_id) or not isinstance(lease, supervisor.DrainLease) or
        not isinstance(path, str) or not path.startswith('/') or os.path.normpath(path) != path or
        not isinstance(digest, str) or not re.fullmatch(r'sha256:[a-f0-9]{64}', digest)):
        raise UpdateError('Invalid snapshot proof')
    lease.assert_locked(operation_id, 'snapshotting')
    verify_snapshot(path, digest, backup_module, node_fd, supervisor)
    db = journal.db
    db.execute('BEGIN IMMEDIATE')
    try:
        lease.assert_locked(operation_id, 'snapshotting')
        verify_snapshot(path, digest, backup_module, node_fd, supervisor)
        result = db.execute("UPDATE update_transactions SET backup_path=?,backup_manifest_digest=?,phase='snapshot_verified' "
            "WHERE operation_id=? AND phase='snapshotting' AND backup_path IS NULL AND backup_manifest_digest IS NULL "
            "AND EXISTS (SELECT 1 FROM operations o JOIN preparations p ON p.operation_id=o.id "
            "WHERE o.id=update_transactions.operation_id AND o.status='verified' AND p.status='prepared' "
            "AND o.digest=update_transactions.root_digest AND o.attempt_id=update_transactions.attempt_id "
            "AND o.attempt_nonce=update_transactions.attempt_nonce AND p.attempt_id=update_transactions.attempt_id "
            "AND p.attempt_nonce=update_transactions.attempt_nonce AND p.preparation_id=update_transactions.preparation_id)",
            (path, digest, operation_id))
        if result.rowcount != 1:
            raise UpdateError('Snapshot does not match the active update')
        lease.assert_locked(operation_id, 'snapshotting')
        db.execute('COMMIT')
    except BaseException:
        if db.in_transaction:
            db.execute('ROLLBACK')
        raise
    try:
        lease.record('snapshot_verified')
    except BaseException:
        db.execute("UPDATE update_transactions SET phase='recovery_required' WHERE operation_id=? AND phase='snapshot_verified'", (operation_id,))
        raise


def preflight_external_containers(hub, supervisor, quiescence, *, trusted_ingress=None):
    """Reject unsafe external mounts before stopping the running control plane.

    The snapshot still repeats this check after the drain under the startup gate.
    """
    class DockerInspection:
        @staticmethod
        def call(*args):
            return supervisor._docker(*args)

        @staticmethod
        def inspect(*ids):
            try:
                return json.loads(supervisor._docker('inspect', *ids), object_pairs_hook=_pairs)
            except (ValueError, UnicodeError, RecursionError):
                raise UpdateError('Docker inspection is unavailable') from None

    try:
        expected = {hub.identities[role]['id'] for role in supervisor.ROLES}
    except (KeyError, TypeError):
        raise UpdateError('Authenticated drain identity is unavailable') from None
    quiescence.ensure_no_other_data_mounts(DockerInspection(), expected, hub.policy.data_dir,
                                           trusted_ingress=trusted_ingress, allow_running_expected=True)


def capture_stopped_snapshot(journal, operation_id, lease, destination, node_fd,
                             supervisor, quiescence, backup_module, *, trusted_ingress=None):
    """Capture and verify a snapshot during a held, authenticated drain.

    The root caller must supply the verified release's Node executable and an
    ingress identity from protected installation policy, never from a request.
    Root, Docker and any explicitly trusted ingress are inside the trust boundary.
    This operation does not start containers or apply the new release.
    """
    if not isinstance(lease, supervisor.DrainLease) or getattr(lease,'_legacy_upload_id',None) is not None:
        raise UpdateError('A current maintenance lease is required')
    lease.assert_locked(operation_id, 'stopped_unverified')
    hub = lease._hub
    if (not isinstance(hub, supervisor.DrainHub) or hub.used is not True or
        lease._policy_binding is None or hub.expected_uid != 1000 or
        not isinstance(hub.policy, supervisor.RuntimePolicy) or set(hub.identities) != set(supervisor.ROLES)):
        raise UpdateError('Authenticated drain identity is unavailable')
    try:
        expected = {hub.identities[role]['id'] for role in supervisor.ROLES}
    except (KeyError, TypeError):
        raise UpdateError('Authenticated drain identity is unavailable') from None
    data_dir = hub.policy.data_dir
    supervisor._verify_data_directory(data_dir)

    class DockerInspection:
        @staticmethod
        def call(*args):
            return supervisor._docker(*args)

        @staticmethod
        def inspect(*ids):
            try:
                return json.loads(supervisor._docker('inspect', *ids), object_pairs_hook=_pairs)
            except (ValueError, UnicodeError, RecursionError):
                raise UpdateError('Docker inspection is unavailable') from None

    docker = DockerInspection()
    def check():
        lease.assert_locked(operation_id, 'snapshotting')
        quiescence.ensure_host_namespaces()
        quiescence.ensure_no_other_data_mounts(docker, expected, data_dir, trusted_ingress=trusted_ingress)
        quiescence.ensure_no_mount_aliases(docker, data_dir)
        quiescence.ensure_no_open_data(data_dir)
        quiescence.ensure_no_uid_writers(hub.expected_uid)
        lease.assert_locked(operation_id, 'snapshotting')

    source_fd = destination_fd = None
    try:
        destination_fd = supervisor._trusted_directory(destination, 0o700)
        source_fd = os.open(data_dir, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
        begin_snapshot(journal, operation_id, lease, supervisor)
        check()
        backup_module._capture_quiescent(source_fd, destination_fd, node_fd, source_uid=hub.expected_uid, reader_gid=65534)
        check()
        manifest_fd, _ = backup_module._file(destination_fd, 'manifest.json', 0, os.fstat(destination_fd).st_dev)
        try:
            digest = 'sha256:' + hashlib.sha256(backup_module._read(manifest_fd)).hexdigest()
        finally:
            os.close(manifest_fd)
        record_verified_snapshot(journal, operation_id, destination, digest, lease, backup_module, node_fd, supervisor)
        return digest
    except BaseException:
        journal.db.execute("UPDATE update_transactions SET phase='recovery_required' WHERE operation_id=? AND phase IN ('snapshotting','snapshot_verified')", (operation_id,))
        raise
    finally:
        if source_fd is not None:
            os.close(source_fd)
        if destination_fd is not None:
            os.close(destination_fd)


def cleanup_stopped_legacy_upload(operation_id, restore_id, service_id, lease, supervisor, quiescence, *, trusted_ingress=None):
    """Run the fixed image worker while a scoped host maintenance lease is held.

    This leaves a durable marker and does not open the gate or start services.
    A separate coordinator must verify and finalize the original generation.
    """
    if (not isinstance(lease,supervisor.DrainLease) or not supervisor._uuid4(operation_id) or
        not isinstance(restore_id,str) or not re.fullmatch(r'[a-f0-9]{32}',restore_id) or
        not isinstance(service_id,str) or not re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}',service_id) or
        getattr(lease,'_legacy_upload_id',None)!=restore_id):
        raise UpdateError('Invalid legacy upload recovery scope')
    lease.assert_locked(operation_id,'stopped_unverified')
    hub=lease._hub
    binding=lease._policy_binding
    if (not isinstance(hub,supervisor.DrainHub) or hub.used is not True or not isinstance(binding,tuple) or len(binding)!=3 or
        not isinstance(binding[0],str) or not os.path.isabs(binding[0]) or
        any(not isinstance(value,str) or not re.fullmatch(r'sha256:[a-f0-9]{64}',value) for value in binding[1:]) or
        hub.expected_uid!=1000 or not isinstance(hub.policy,supervisor.RuntimePolicy) or set(hub.identities)!=set(supervisor.ROLES)):
        raise UpdateError('Authenticated drain identity is unavailable')
    try: expected={hub.identities[role]['id'] for role in supervisor.ROLES}
    except (KeyError,TypeError): raise UpdateError('Authenticated drain identity is unavailable') from None
    if len(expected)!=3 or not all(isinstance(cid,str) and re.fullmatch(r'[a-f0-9]{64}',cid) for cid in expected):
        raise UpdateError('Authenticated drain identity is unavailable')
    data_dir=hub.policy.data_dir
    if ',' in data_dir or '\n' in data_dir or not re.fullmatch(r'sha256:[a-f0-9]{64}',hub.policy.image_id):
        raise UpdateError('Worker runtime is unavailable')
    supervisor._verify_data_directory(data_dir)

    class DockerInspection:
        @staticmethod
        def call(*args): return supervisor._docker(*args)
        @staticmethod
        def inspect(*ids):
            try: return json.loads(supervisor._docker('inspect',*ids),object_pairs_hook=_pairs)
            except (ValueError,UnicodeError,RecursionError): raise UpdateError('Docker inspection is unavailable') from None

    def check():
        lease.assert_locked(operation_id,'stopped_unverified')
        quiescence.ensure_host_namespaces()
        quiescence.ensure_no_other_data_mounts(DockerInspection(),expected,data_dir,trusted_ingress=trusted_ingress)
        quiescence.ensure_no_mount_aliases(DockerInspection(),data_dir)
        quiescence.ensure_no_open_data(data_dir)
        quiescence.ensure_no_uid_writers(hub.expected_uid)
        lease.assert_locked(operation_id,'stopped_unverified')

    check()
    marker='legacy-upload-recovery.json'
    try: os.stat(marker,dir_fd=lease._owner.journal,follow_symlinks=False)
    except FileNotFoundError: pass
    else: raise UpdateError('A legacy upload recovery already requires reconciliation')
    record={'version':1,'operationId':operation_id,'restoreId':restore_id,'serviceId':service_id,'state':'intent',
            'policyBinding':list(binding),'containerIds':{role:hub.identities[role]['id'] for role in supervisor.ROLES}}
    supervisor._atomic_file(lease._owner.journal,marker,json.dumps(record,separators=(',',':')).encode('ascii')+b'\n',0o600)
    lease.assert_locked(operation_id,'stopped_unverified')
    raw=supervisor._docker('run','--rm','--name','servus-recovery-'+operation_id,'--label','servus.recovery='+operation_id,'--user','1000:1000',
        '--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges',
        '--pids-limit','64','--memory','256m','--tmpfs','/tmp:rw,noexec,nosuid,nodev,size=32m',
        '--mount','type=bind,src='+data_dir+',dst=/data','--entrypoint','node',hub.policy.image_id,
        '/app/dist/agent/restore-legacy-worker.js',restore_id,service_id,timeout=120)
    try: result=json.loads(raw,object_pairs_hook=_pairs)
    except (ValueError,UnicodeError,RecursionError): raise UpdateError('Worker result is unavailable') from None
    if result!={'operationId':restore_id,'phase':'cancelled'}: raise UpdateError('Worker result is unavailable')
    check()
    record['state']='cleaned'
    supervisor._atomic_file(lease._owner.journal,marker,json.dumps(record,separators=(',',':')).encode('ascii')+b'\n',0o600)
    return result


def start_cleaned_legacy_upload(operation_id, lease, daemon_ownership, approval_journal, active_env,
                                supervisor, daemon, quiescence, *, trusted_ingress=None, timeout=120):
    """Start the original approved containers; finalization needs fresh channels."""
    if (not isinstance(lease,supervisor.DrainLease) or not supervisor._uuid4(operation_id) or
        not isinstance(getattr(lease,'_legacy_upload_id',None),str) or
        not re.fullmatch(r'[a-f0-9]{32}',lease._legacy_upload_id) or type(timeout) is not int or not 1<=timeout<=180):
        raise UpdateError('Invalid legacy upload recovery start')
    lease.assert_locked(operation_id,'stopped_unverified')
    hub=lease._hub
    if (not isinstance(hub,supervisor.DrainHub) or hub.used is not True or hub.expected_uid!=1000 or
        not isinstance(hub.policy,supervisor.RuntimePolicy) or set(hub.identities)!=set(supervisor.ROLES)):
        raise UpdateError('Authenticated drain identity is unavailable')
    try: identities={role:hub.identities[role]['id'] for role in supervisor.ROLES}
    except (KeyError,TypeError):raise UpdateError('Authenticated drain identity is unavailable') from None
    if any(not isinstance(cid,str) or not re.fullmatch(r'[a-f0-9]{64}',cid) for cid in identities.values()) or len(set(identities.values()))!=3:
        raise UpdateError('Authenticated drain identity is unavailable')
    control_dir=os.readlink('/proc/self/fd/'+str(daemon_ownership.directory))
    daemon_ownership.assert_held(control_dir)
    policy_path,accepted_env,policy=daemon.resolve_active_policy(approval_journal,active_env)
    binding=daemon.approved_policy_binding(hub,policy_path,approval_journal,accepted_env)
    if policy!=hub.policy or not isinstance(binding,tuple) or len(binding)!=4 or binding[:3]!=lease._policy_binding or binding[3]!=policy:
        raise UpdateError('Active recovery policy changed')

    class DockerInspection:
        @staticmethod
        def call(*args):return supervisor._docker(*args)
        @staticmethod
        def inspect(*ids):
            try:return json.loads(supervisor._docker('inspect',*ids),object_pairs_hook=_pairs)
            except (ValueError,UnicodeError,RecursionError):raise UpdateError('Docker inspection is unavailable') from None

    supervisor._verify_data_directory(policy.data_dir)
    quiescence.ensure_host_namespaces()
    quiescence.ensure_no_other_data_mounts(DockerInspection(),set(identities.values()),policy.data_dir,trusted_ingress=trusted_ingress)
    quiescence.ensure_no_mount_aliases(DockerInspection(),policy.data_dir)
    quiescence.ensure_no_open_data(policy.data_dir)
    quiescence.ensure_no_uid_writers(hub.expected_uid)
    lease.assert_locked(operation_id,'stopped_unverified')
    daemon_ownership.assert_held(control_dir)
    if daemon.approved_policy_binding(hub,policy_path,approval_journal,accepted_env)!=binding:
        raise UpdateError('Active recovery policy changed')
    lease.record_legacy_start()
    lease.release_for_start()
    deadline=time.monotonic()+timeout
    for role in ('agent','api','worker'):
        remaining=deadline-time.monotonic()
        if remaining<=0:raise UpdateError('Recovery start timed out')
        supervisor._docker('start',identities[role],timeout=min(remaining,30))
    while True:
        remaining=deadline-time.monotonic()
        if remaining<=0:raise UpdateError('Recovery health check timed out')
        ids=[identities[role] for role in supervisor.ROLES]
        try:records=json.loads(supervisor._docker('inspect',*ids,timeout=min(remaining,15)),object_pairs_hook=_pairs)
        except (ValueError,UnicodeError,RecursionError):raise UpdateError('Recovery health is unavailable') from None
        if not isinstance(records,list) or len(records)!=len(ids):raise UpdateError('Recovery health is unavailable')
        by_id={item.get('Id'):item for item in records if isinstance(item,dict)}
        if set(by_id)!=set(ids):raise UpdateError('Recovery identity changed')
        ready=True
        for role in supervisor.ROLES:
            item=by_id[identities[role]];state=item.get('State')
            if not isinstance(state,dict) or state.get('Running') is not True or item.get('Image')!=policy.image_id:
                raise UpdateError('A recovery container failed to start')
            if policy.healthchecks[role] is not None:
                health=state.get('Health')
                if not isinstance(health,dict) or health.get('Status') not in ('starting','healthy'):raise UpdateError('A recovery container is unhealthy')
                if health['Status']!='healthy':ready=False
        if ready:break
        time.sleep(min(1,max(0,deadline-time.monotonic())))
    running=supervisor.inspect_servus(policy)
    if time.monotonic()>=deadline or any(running.get(role,{}).get('id')!=identities[role] for role in supervisor.ROLES):
        raise UpdateError('Recovery container identity changed')
    daemon_ownership.assert_held(control_dir)
    if daemon.resolve_active_policy(approval_journal,active_env)!=(policy_path,accepted_env,policy):
        raise UpdateError('Active recovery policy changed')
    return running


def create_generation(journal, operation_id, lease, daemon_ownership, approval_journal,
                      active_env, docker_config, supervisor, daemon, extractor,
                      runtime_policy, backup_module, node_fd):
    """Create and inspect a candidate generation while the startup gate is closed.

    This trusted host operation does not start the containers. Any uncertain
    Docker result leaves both the gate and the transaction in recovery state.
    """
    if not isinstance(lease, supervisor.DrainLease) or not supervisor._uuid4(operation_id):
        raise UpdateError('A current maintenance lease is required')
    lease.assert_snapshot_verified(operation_id)
    control_dir = os.readlink('/proc/self/fd/' + str(daemon_ownership.directory))
    daemon_ownership.assert_held(control_dir)
    database = journal.db.execute('PRAGMA database_list').fetchone()
    if not database or os.path.realpath(database[2]) != os.path.realpath(approval_journal):
        raise UpdateError('Approval journal does not match update journal')
    config_fd = supervisor._trusted_directory(docker_config, 0o700)
    try:
        if os.listdir(config_fd):
            raise UpdateError('Docker configuration must be empty')
    finally:
        os.close(config_fd)
    policy_path, accepted_env, policy = daemon.resolve_active_policy(approval_journal, active_env)
    if not isinstance(policy, supervisor.RuntimePolicy) or policy.control_dir != control_dir:
        raise UpdateError('Active policy identity changed')
    row = journal.db.execute("SELECT p.staging_path,t.backup_path,t.backup_manifest_digest,t.root_digest "
        "FROM update_transactions t JOIN operations o ON o.id=t.operation_id "
        "JOIN preparations p ON p.operation_id=t.operation_id JOIN policy_approvals a ON a.operation_id=t.operation_id "
        "WHERE t.operation_id=? AND t.phase='snapshot_verified' AND o.status='verified' AND p.status='prepared' "
        "AND a.state='active' AND a.policy_path=? AND a.accepted_env_path=? AND a.source_env_path=? "
        "AND t.preparation_id=p.preparation_id AND t.attempt_id=p.attempt_id AND t.attempt_nonce=p.attempt_nonce "
        "AND t.attempt_id=o.attempt_id AND t.attempt_nonce=o.attempt_nonce AND t.root_digest=o.digest "
        "AND a.attempt_id=t.attempt_id AND a.attempt_nonce=t.attempt_nonce AND a.preparation_id=t.preparation_id "
        "AND a.root_digest=t.root_digest AND a.image_config_digest=o.config_digest",
        (operation_id, policy_path, accepted_env, active_env)).fetchone()
    if (not row or not isinstance(row[0], str) or not os.path.isabs(row[0]) or os.path.normpath(row[0]) != row[0] or
        not re.fullmatch(r'servus-install-[a-f0-9]{32}', os.path.basename(row[0])) or
        policy.image_reference != 'ghcr.io/raxon/servus@' + row[3]):
        raise UpdateError('Active generation does not match the verified update')
    stage = row[0]
    stage_fd = supervisor._trusted_directory(stage, 0o700)
    deployment_fd = None
    try:
        manifest_fd = supervisor._open_root_file(stage_fd, 'manifest.json', 0o644)
        try:
            manifest = extractor._manifest_files(backup_module._read(manifest_fd, extractor.MANIFEST_LIMIT))
        finally:
            os.close(manifest_fd)
        deployment_fd = supervisor._trusted_directory(os.path.join(stage, 'deployment'))
        compose_fd = supervisor._open_root_file(deployment_fd, 'compose-supervised.yaml', 0o644)
        try:
            content = backup_module._read(compose_fd, extractor.MAX_FILE)
        finally:
            os.close(compose_fd)
        expected = manifest.get('deployment/compose-supervised.yaml')
        if expected != (0o644, len(content), hashlib.sha256(content).hexdigest()):
            raise UpdateError('Prepared Compose file changed')
        compose = os.path.join(stage, 'deployment', 'compose-supervised.yaml')
        verify_snapshot(row[1], row[2], backup_module, node_fd, supervisor)
        lease.assert_snapshot_verified(operation_id)
        daemon_ownership.assert_held(control_dir)
        result = journal.db.execute("UPDATE update_transactions SET phase='switching' WHERE operation_id=? AND phase='snapshot_verified' AND backup_path=? AND backup_manifest_digest=? AND root_digest=?",
                                    (operation_id, row[1], row[2], row[3]))
        if result.rowcount != 1:
            raise UpdateError('Update transaction changed')
        try:
            lease.record('switching')
            runtime_policy._docker(docker_config, 'compose', '--env-file', active_env, '-f', compose,
                                   '-p', 'servus', 'create', '--no-build', '--pull', 'never', '--force-recreate', timeout=180)
            lease.assert_locked(operation_id, 'switching')
            daemon_ownership.assert_held(control_dir)
            path, accepted, current = daemon.resolve_active_policy(approval_journal, active_env)
            if (path, accepted, current) != (policy_path, accepted_env, policy):
                raise UpdateError('Active policy changed during creation')
            return supervisor.inspect_servus(policy, created=True)
        except BaseException:
            journal.db.execute("UPDATE update_transactions SET phase='recovery_required' WHERE operation_id=? AND phase='switching'", (operation_id,))
            raise
    finally:
        if deployment_fd is not None:
            os.close(deployment_fd)
        os.close(stage_fd)


def start_generation(journal, operation_id, lease, daemon_ownership, approval_journal,
                     active_env, candidates, supervisor, daemon, backup_module, node_fd, *, timeout=120):
    """Start only the inspected candidate containers and leave finalization pending.

    Once the gate opens, the new version can write data. An uncertain or failed
    start requires recovery; this operation never automatically rolls back.
    """
    if (not isinstance(lease, supervisor.DrainLease) or not supervisor._uuid4(operation_id) or
        type(timeout) is not int or not 1 <= timeout <= 180 or not isinstance(candidates, dict) or
        set(candidates) != set(supervisor.ROLES) or
        any(not isinstance(item, dict) or set(item) != {'id'} or not isinstance(item['id'], str) or
            not re.fullmatch(r'[a-f0-9]{64}', item['id']) for item in candidates.values()) or
        len({item['id'] for item in candidates.values()}) != len(supervisor.ROLES)):
        raise UpdateError('Invalid candidate generation')
    lease.assert_locked(operation_id, 'switching')
    control_dir = os.readlink('/proc/self/fd/' + str(daemon_ownership.directory))
    daemon_ownership.assert_held(control_dir)
    database = journal.db.execute('PRAGMA database_list').fetchone()
    if not database or os.path.realpath(database[2]) != os.path.realpath(approval_journal):
        raise UpdateError('Approval journal does not match update journal')
    policy_path, accepted_env, policy = daemon.resolve_active_policy(approval_journal, active_env)
    if not isinstance(policy, supervisor.RuntimePolicy) or policy.control_dir != control_dir:
        raise UpdateError('Active policy identity changed')
    row = journal.db.execute("SELECT t.backup_path,t.backup_manifest_digest,t.root_digest "
        "FROM update_transactions t JOIN operations o ON o.id=t.operation_id "
        "JOIN preparations p ON p.operation_id=t.operation_id JOIN policy_approvals a ON a.operation_id=t.operation_id "
        "WHERE t.operation_id=? AND t.phase='switching' AND o.status='verified' AND p.status='prepared' "
        "AND a.state='active' AND a.policy_path=? AND a.accepted_env_path=? AND a.source_env_path=? "
        "AND t.preparation_id=p.preparation_id AND t.attempt_id=p.attempt_id AND t.attempt_nonce=p.attempt_nonce "
        "AND t.attempt_id=o.attempt_id AND t.attempt_nonce=o.attempt_nonce AND t.root_digest=o.digest "
        "AND a.attempt_id=t.attempt_id AND a.attempt_nonce=t.attempt_nonce AND a.preparation_id=t.preparation_id "
        "AND a.root_digest=t.root_digest AND a.image_config_digest=o.config_digest",
        (operation_id, policy_path, accepted_env, active_env)).fetchone()
    if not row or policy.image_reference != 'ghcr.io/raxon/servus@' + row[2]:
        raise UpdateError('Candidate generation is not approved')
    verify_snapshot(row[0], row[1], backup_module, node_fd, supervisor)
    if supervisor.inspect_servus(policy, created=True) != candidates:
        raise UpdateError('Candidate container identity changed')
    lease.assert_locked(operation_id, 'switching')
    daemon_ownership.assert_held(control_dir)
    result = journal.db.execute("UPDATE update_transactions SET phase='starting' WHERE operation_id=? AND phase='switching' AND backup_path=? AND backup_manifest_digest=? AND root_digest=?",
                                (operation_id, row[0], row[1], row[2]))
    if result.rowcount != 1:
        raise UpdateError('Update transaction changed')
    try:
        lease.record('starting')
        lease.release_for_start()
        deadline = time.monotonic() + timeout
        for role in ('agent', 'api', 'worker'):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise UpdateError('Candidate startup timed out')
            supervisor._docker('start', candidates[role]['id'], timeout=min(remaining, 30))
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise UpdateError('Candidate health check timed out')
            ids = [candidates[role]['id'] for role in supervisor.ROLES]
            records = json.loads(supervisor._docker('inspect', *ids, timeout=min(remaining, 15)), object_pairs_hook=_pairs)
            if not isinstance(records, list) or len(records) != len(ids):
                raise UpdateError('Started container inventory is unavailable')
            by_id = {item.get('Id'): item for item in records if isinstance(item, dict)}
            if set(by_id) != set(ids):
                raise UpdateError('Started container identity changed')
            ready = True
            for role in supervisor.ROLES:
                item = by_id[candidates[role]['id']]; state = item.get('State')
                if not isinstance(state, dict) or state.get('Running') is not True or item.get('Image') != policy.image_id:
                    raise UpdateError('A candidate container failed to start')
                if policy.healthchecks[role] is not None:
                    health = state.get('Health')
                    if not isinstance(health, dict) or health.get('Status') not in ('starting', 'healthy'):
                        raise UpdateError('A candidate container is unhealthy')
                    if health['Status'] != 'healthy':
                        ready = False
            if ready:
                break
            time.sleep(min(1, max(0, deadline - time.monotonic())))
        running = supervisor.inspect_servus(policy)
        if time.monotonic() >= deadline:
            raise UpdateError('Candidate startup timed out')
        if any(running.get(role, {}).get('id') != candidates[role]['id'] for role in supervisor.ROLES):
            raise UpdateError('Started container identity changed')
        daemon_ownership.assert_held(control_dir)
        if daemon.resolve_active_policy(approval_journal, active_env) != (policy_path, accepted_env, policy):
            raise UpdateError('Active policy changed during startup')
        return running
    except BaseException:
        journal.db.execute("UPDATE update_transactions SET phase='recovery_required' WHERE operation_id=? AND phase='starting'", (operation_id,))
        raise


def prepare_update_policy(journal, operation_id, active_env, policy_root, maintenance, supervisor,
                          extractor, runtime_policy, *, resolve_child=None):
    """Derive a private candidate from the active config and verified image."""
    row = journal.db.execute("SELECT p.preparation_id,p.staging_path,o.digest FROM preparations p "
        "JOIN operations o ON o.id=p.operation_id WHERE p.operation_id=? AND p.status='prepared' AND o.status='verified' "
        "AND p.attempt_id=o.attempt_id AND p.attempt_nonce=o.attempt_nonce", (operation_id,)).fetchone()
    if (not row or not supervisor._uuid4(row[0]) or not isinstance(row[1], str) or not os.path.isabs(row[1]) or
        os.path.normpath(row[1]) != row[1] or not re.fullmatch(r'servus-install-[a-f0-9]{32}', os.path.basename(row[1])) or
        not isinstance(row[2], str) or not re.fullmatch(r'sha256:[a-f0-9]{64}', row[2])):
        raise UpdateError('Verified preparation is unavailable')
    previous = runtime_policy._read_private_file(active_env, 65536)
    env = runtime_policy._env(previous)
    if 'SERVUS_IMAGE' not in env:
        raise UpdateError('Active image is unavailable')
    lines = previous.splitlines(keepends=True)
    replacement = ('SERVUS_IMAGE=ghcr.io/raxon/servus@' + row[2]).encode('ascii')
    candidate = b''.join(replacement + (b'\n' if line.endswith(b'\n') else b'') if line.startswith(b'SERVUS_IMAGE=') else line for line in lines)
    candidate_env = runtime_policy._env(candidate)
    if (candidate_env.get('SERVUS_IMAGE') != 'ghcr.io/raxon/servus@' + row[2] or
        any(candidate_env.get(key) != value for key, value in env.items() if key != 'SERVUS_IMAGE') or set(candidate_env) != set(env)):
        raise UpdateError('Candidate environment is invalid')
    directory = supervisor._trusted_directory(policy_root, 0o700)
    input_name = 'candidate-env-' + row[0] + '.env'
    output_name = 'candidate-' + row[0] + '.json'
    try:
        try:
            os.stat(output_name, dir_fd=directory, follow_symlinks=False)
        except FileNotFoundError:
            pass
        else:
            raise UpdateError('Candidate policy already exists')
        input_path = os.path.join(policy_root, input_name)
        try:
            runtime_policy._publish_private(directory, input_name, candidate)
        except FileExistsError:
            if runtime_policy._read_private_file(input_path, 65536) != candidate:
                raise UpdateError('Candidate environment changed') from None
        install_dir = os.readlink('/proc/self/fd/' + str(maintenance.install))
        return runtime_policy.produce(journal, operation_id, os.path.dirname(row[1]), input_path, install_dir,
            os.path.join(policy_root, output_name), extractor, supervisor, resolve_child=resolve_child, lock_owner=maintenance)
    finally:
        os.close(directory)


def apply_prepared_update(journal, operation_id, hub, maintenance, daemon_ownership,
                          approval_journal, active_env, backup_root, policy_root, docker_config,
                          node_fd, supervisor, daemon, extractor, runtime_policy, quiescence,
                          backup_module, *, trusted_ingress=None, resolve_child=None):
    """Run the prepared generation up to authenticated post-start finalization.

    All paths, modules, the Node descriptor and ingress identity must be supplied
    by trusted root configuration, never by the requesting panel process. The
    caller holds the installation and daemon locks and owns the live drain hub.
    """
    if (not supervisor._uuid4(operation_id) or not isinstance(hub, supervisor.DrainHub) or
        not isinstance(maintenance, supervisor.MaintenanceSupervisor)):
        raise UpdateError('Invalid update context')
    supervisor._assert_exclusive_flock(maintenance.install_lock)
    control_dir = os.readlink('/proc/self/fd/' + str(daemon_ownership.directory))
    daemon_ownership.assert_held(control_dir)
    node = os.fstat(node_fd)
    if (not stat.S_ISREG(node.st_mode) or node.st_uid != 0 or node.st_nlink != 1 or
        node.st_mode & 0o022 or not node.st_mode & 0o111):
        raise UpdateError('Trusted Node executable is unavailable')
    database = journal.db.execute('PRAGMA database_list').fetchone()
    if not database or os.path.realpath(database[2]) != os.path.realpath(approval_journal):
        raise UpdateError('Approval journal does not match update journal')
    old_policy, old_env, active = daemon.resolve_active_policy(approval_journal, active_env)
    if active != hub.policy:
        raise UpdateError('The authenticated generation changed')
    binding = daemon.approved_policy_binding(hub, old_policy, approval_journal, old_env)
    def candidate_row():
        return journal.db.execute("SELECT a.source_env_path,a.candidate_path FROM policy_approvals a "
        "JOIN operations o ON o.id=a.operation_id JOIN preparations p ON p.operation_id=a.operation_id "
        "WHERE a.operation_id=? AND a.state='candidate' AND o.status='verified' AND p.status='prepared' "
        "AND a.attempt_id=o.attempt_id AND a.attempt_nonce=o.attempt_nonce AND a.root_digest=o.digest "
        "AND a.image_config_digest=o.config_digest AND a.attempt_id=p.attempt_id "
        "AND a.attempt_nonce=p.attempt_nonce AND a.preparation_id=p.preparation_id", (operation_id,)).fetchone()
    row = candidate_row()
    if row is None:
        prepare_update_policy(journal, operation_id, active_env, policy_root, maintenance, supervisor,
                              extractor, runtime_policy, resolve_child=resolve_child)
        row = candidate_row()
    if not row or any(not isinstance(path, str) or not os.path.isabs(path) or os.path.normpath(path) != path for path in row):
        raise UpdateError('Prepared policy candidate is unavailable')
    preflight_external_containers(hub, supervisor, quiescence, trusted_ingress=trusted_ingress)
    backup_fd = supervisor._trusted_directory(backup_root, 0o700)
    policy_fd = None
    try:
        policy_fd = supervisor._trusted_directory(policy_root, 0o700)
        backup_name = 'update-' + operation_id
        policy_name = 'policy-' + operation_id + '.json'
        for directory, name in ((backup_fd, backup_name), (policy_fd, policy_name)):
            try:
                os.stat(name, dir_fd=directory, follow_symlinks=False)
            except FileNotFoundError:
                continue
            raise UpdateError('Update output already exists')
        journal.claim_update(operation_id)
        try:
            os.mkdir(backup_name, 0o700, dir_fd=backup_fd)
            os.fsync(backup_fd)
            destination = os.path.join(backup_root, backup_name)
            target_policy = os.path.join(policy_root, policy_name)
            with maintenance.drained_window(hub, operation_id, policy_binding=binding) as lease:
                capture_stopped_snapshot(journal, operation_id, lease, destination, node_fd,
                                         supervisor, quiescence, backup_module, trusted_ingress=trusted_ingress)
                runtime_policy.activate_locked(journal, operation_id, row[0], row[1], target_policy,
                    active_env, lease, daemon_ownership, extractor, supervisor, SimpleNamespace(verify_snapshot=verify_snapshot), backup_module, node_fd)
                candidates = create_generation(journal, operation_id, lease, daemon_ownership, approval_journal,
                    active_env, docker_config, supervisor, daemon, extractor, runtime_policy, backup_module, node_fd)
                return start_generation(journal, operation_id, lease, daemon_ownership, approval_journal,
                    active_env, candidates, supervisor, daemon, backup_module, node_fd)
        except BaseException:
            journal.db.execute("UPDATE update_transactions SET phase='recovery_required' WHERE operation_id=? AND phase NOT IN ('completed','recovery_required')", (operation_id,))
            raise
    finally:
        if policy_fd is not None:
            os.close(policy_fd)
        os.close(backup_fd)
