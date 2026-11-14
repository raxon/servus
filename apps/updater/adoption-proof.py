#!/usr/bin/python3 -I
"""Bind staged migration data to one verified, approved initial release.

The caller must establish and maintain a durable writer and startup fence for
both the old and restored data. This module records evidence only; it does not
stop services, authorize container startup or perform recovery.
"""
import hashlib
import os
import re
import sys


class AdoptionError(Exception):
    pass


def prepared_binding(journal, operation, active_env, policy_root, supervisor, runtime):
    """Resolve a verified candidate before stopping an unsupervised installation.

    This is evidence for preparing the stop only. It does not activate policy,
    permit startup, or replace the separate durable migration fence.
    """
    if not supervisor._uuid4(operation) or not isinstance(policy_root,str) or not policy_root.startswith('/') or os.path.normpath(policy_root)!=policy_root:
        raise AdoptionError('Invalid prepared migration')
    root=supervisor._trusted_directory(policy_root,0o700);os.close(root)
    row=journal.db.execute("""SELECT p.preparation_id,p.attempt_id,p.attempt_nonce,o.digest,o.config_digest,
        a.candidate_path,a.candidate_digest,a.accepted_env_path,a.env_digest
        FROM preparations p JOIN operations o ON o.id=p.operation_id JOIN policy_approvals a ON a.operation_id=o.id
        WHERE o.id=? AND o.status='verified' AND p.status='prepared' AND a.state='candidate' AND a.policy_path IS NULL
          AND a.source_env_path=? AND p.attempt_id=o.attempt_id AND p.attempt_nonce=o.attempt_nonce
          AND a.attempt_id=o.attempt_id AND a.attempt_nonce=o.attempt_nonce AND a.preparation_id=p.preparation_id
          AND a.root_digest=o.digest AND a.image_config_digest=o.config_digest
          AND NOT EXISTS(SELECT 1 FROM update_transactions) AND NOT EXISTS(SELECT 1 FROM extraction_probes WHERE status='intent')
          AND NOT EXISTS(SELECT 1 FROM policy_approvals WHERE state IN ('active','activating','recovery_required'))
          AND EXISTS(SELECT 1 FROM policy_probes WHERE operation_id=o.id AND preparation_id=p.preparation_id AND attempt_id=o.attempt_id AND attempt_nonce=o.attempt_nonce
                     AND config_digest=a.env_digest AND state='removed')""",(operation,active_env)).fetchone()
    if (not row or not supervisor._uuid4(row[0]) or not supervisor._uuid4(row[1]) or
        not isinstance(row[2],str) or not re.fullmatch(r'[0-9a-f]{64}',row[2]) or
        any(not isinstance(value,str) or not re.fullmatch(r'sha256:[0-9a-f]{64}',value) for value in (row[3],row[4],row[6],row[8])) or
        row[5]!=os.path.join(policy_root,'candidate-'+row[0]+'.json') or
        row[7]!=os.path.join(policy_root,'env-'+row[0]+'.env')):
        raise AdoptionError('Verified policy candidate is unavailable')
    candidate=runtime._read_private_file(row[5],1024*1024)
    original=runtime._read_private_file(active_env,65536)
    snapshot=runtime._read_private_file(row[7],65536)
    if ('sha256:'+hashlib.sha256(candidate).hexdigest()!=row[6] or
        'sha256:'+hashlib.sha256(original).hexdigest()!=row[8] or original!=snapshot):
        raise AdoptionError('Prepared policy or environment changed')
    document=runtime._json(candidate)
    if not isinstance(document,dict) or set(document)!={'version','policy'} or type(document['version']) is not int or document['version']!=1 or not isinstance(document['policy'],dict):
        raise AdoptionError('Prepared policy is invalid')
    approved=supervisor.RuntimePolicy(**document['policy'])
    if approved.image_reference!='ghcr.io/raxon/servus@'+row[3] or runtime._env(original).get('SERVUS_IMAGE')!=approved.image_reference:
        raise AdoptionError('Prepared release does not match')
    return os.path.join(policy_root,'policy-'+operation+'.json'),row[7],approved,row[:5]


def _binding(journal, operation, active_env, supervisor, daemon):
    if not supervisor._uuid4(operation): raise AdoptionError('Invalid operation')
    database=journal.db.execute('PRAGMA database_list').fetchone()
    if not database or not database[2] or not os.path.isabs(database[2]): raise AdoptionError('Persistent journal is required')
    policy_path,snapshot,approved=daemon.resolve_active_policy(database[2],active_env)
    if not isinstance(approved,supervisor.RuntimePolicy): raise AdoptionError('Invalid active policy')
    row=journal.db.execute("""SELECT p.preparation_id,p.attempt_id,p.attempt_nonce,o.digest,o.config_digest
        FROM preparations p JOIN operations o ON o.id=p.operation_id JOIN policy_approvals a ON a.operation_id=o.id
        WHERE o.id=? AND o.status='verified' AND p.status='prepared' AND a.state='active'
          AND a.policy_path=? AND a.accepted_env_path=? AND a.source_env_path=?
          AND p.attempt_id=o.attempt_id AND p.attempt_nonce=o.attempt_nonce
          AND a.attempt_id=o.attempt_id AND a.attempt_nonce=o.attempt_nonce
          AND a.preparation_id=p.preparation_id AND a.root_digest=o.digest
          AND a.image_config_digest=o.config_digest AND NOT EXISTS(SELECT 1 FROM update_transactions)
          AND NOT EXISTS(SELECT 1 FROM extraction_probes WHERE status='intent')""",
        (operation,policy_path,snapshot,active_env)).fetchone()
    if (not row or not supervisor._uuid4(row[0]) or not supervisor._uuid4(row[1]) or
        not isinstance(row[2],str) or not re.fullmatch(r'[0-9a-f]{64}',row[2]) or
        any(not isinstance(value,str) or not re.fullmatch(r'sha256:[0-9a-f]{64}',value) for value in row[3:]) or
        approved.image_reference!='ghcr.io/raxon/servus@'+row[3]):
        raise AdoptionError('Verified release is not prepared')
    return policy_path,snapshot,approved,row


def _check_paths(snapshot, digest, parent, operation, approved):
    if (not isinstance(snapshot,str) or not os.path.isabs(snapshot) or os.path.normpath(snapshot)!=snapshot or
        not isinstance(parent,str) or not os.path.isabs(parent) or os.path.normpath(parent)!=parent or
        not isinstance(digest,str) or not re.fullmatch(r'sha256:[0-9a-f]{64}',digest) or
        approved.data_dir!=os.path.join(parent,'restore-'+operation) or
        snapshot==parent or snapshot.startswith(parent+'/') or parent.startswith(snapshot+'/')):
        raise AdoptionError('Migration paths do not match the approved policy')


def _quiet(quiescence, target):
    # These observations are necessary, but cannot prevent a new writer. The
    # caller must maintain the independent startup and writer fence.
    quiescence.ensure_host_namespaces()
    quiescence.ensure_no_uid_writers(1000)
    quiescence.ensure_no_open_data(target)


def record(journal, operation, active_env, snapshot_path, digest, parent, backup, node_fd, supervisor, daemon, policy, coordinator, restore, quiescence, *, inherited_lock=None):
    if sys.platform!='linux' or os.geteuid()!=0 or not sys.flags.isolated: raise AdoptionError('Isolated Linux root is required')
    policy_path,accepted,approved,binding=_binding(journal,operation,active_env,supervisor,daemon)
    _check_paths(snapshot_path,digest,parent,operation,approved)
    directory=supervisor._trusted_directory(approved.install_dir,0o700);lock=None
    try:
        lock=policy._installation_lock(directory,supervisor,inherited_lock)
        if _binding(journal,operation,active_env,supervisor,daemon)!=(policy_path,accepted,approved,binding): raise AdoptionError('Approved policy changed')
        _quiet(quiescence,approved.data_dir)
        identity=restore.verify_staged(snapshot_path,digest,parent,operation,backup,node_fd,supervisor,coordinator)
        _quiet(quiescence,approved.data_dir)
        db=journal.db;db.execute('BEGIN IMMEDIATE')
        try:
            if _binding(journal,operation,active_env,supervisor,daemon)!=(policy_path,accepted,approved,binding): raise AdoptionError('Approved policy changed')
            if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='initial_generations'").fetchone() and db.execute('SELECT 1 FROM initial_generations LIMIT 1').fetchone():
                raise AdoptionError('Initial generation already started')
            db.execute("CREATE TABLE IF NOT EXISTS initial_adoptions (operation_id TEXT PRIMARY KEY, preparation_id TEXT NOT NULL, attempt_id TEXT NOT NULL, attempt_nonce TEXT NOT NULL, root_digest TEXT NOT NULL, config_digest TEXT NOT NULL, policy_path TEXT NOT NULL, accepted_env TEXT NOT NULL, active_env TEXT NOT NULL, snapshot_path TEXT NOT NULL, snapshot_digest TEXT NOT NULL, data_parent TEXT NOT NULL, data_dev INTEGER NOT NULL, data_ino INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('ready','consumed','recovery_required')))")
            if db.execute('SELECT 1 FROM initial_adoptions LIMIT 1').fetchone(): raise AdoptionError('Existing adoption requires recovery')
            db.execute("INSERT INTO initial_adoptions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'ready')",(operation,*binding,policy_path,accepted,active_env,snapshot_path,digest,parent,*identity))
            db.execute('COMMIT')
        except BaseException:
            if db.in_transaction:db.execute('ROLLBACK')
            raise
        return identity
    finally:
        if lock is not None:os.close(lock)
        os.close(directory)


def verify(journal, operation, active_env, backup, node_fd, supervisor, daemon, coordinator, restore, quiescence, *, install_lock):
    """Recheck an existing proof while the caller holds its installation fence."""
    if sys.platform!='linux' or os.geteuid()!=0 or not sys.flags.isolated:raise AdoptionError('Isolated Linux root is required')
    policy_path,accepted,approved,binding=_binding(journal,operation,active_env,supervisor,daemon)
    directory=supervisor._trusted_directory(approved.install_dir,0o700)
    try:
        expected=supervisor._open_root_file(directory,'install.lock',0o600)
        try:
            held=os.fstat(install_lock);named=os.fstat(expected)
            if (held.st_dev,held.st_ino)!=(named.st_dev,named.st_ino):raise AdoptionError('Installation lock does not match')
            supervisor._assert_exclusive_flock(install_lock)
        finally:os.close(expected)
    finally:os.close(directory)
    try:
        row=journal.db.execute("SELECT preparation_id,attempt_id,attempt_nonce,root_digest,config_digest,policy_path,accepted_env,active_env,snapshot_path,snapshot_digest,data_parent,data_dev,data_ino,state FROM initial_adoptions WHERE operation_id=?",(operation,)).fetchone()
    except Exception as error:raise AdoptionError('Adoption evidence is unavailable') from error
    if not row or row[:8] != (*binding,policy_path,accepted,active_env) or row[-1]!='ready':raise AdoptionError('Adoption evidence does not match')
    snapshot_path,digest,parent,dev,ino=row[8:13]
    _check_paths(snapshot_path,digest,parent,operation,approved)
    _quiet(quiescence,approved.data_dir)
    identity=restore.verify_staged(snapshot_path,digest,parent,operation,backup,node_fd,supervisor,coordinator)
    if identity!=(dev,ino) or _binding(journal,operation,active_env,supervisor,daemon)!=(policy_path,accepted,approved,binding):raise AdoptionError('Migration evidence changed')
    _quiet(quiescence,approved.data_dir)
    current=journal.db.execute("SELECT preparation_id,attempt_id,attempt_nonce,root_digest,config_digest,policy_path,accepted_env,active_env,snapshot_path,snapshot_digest,data_parent,data_dev,data_ino,state FROM initial_adoptions WHERE operation_id=?",(operation,)).fetchone()
    if current!=row:raise AdoptionError('Migration evidence changed')
    return identity


def claim(journal, operation, active_env, backup, node_fd, supervisor, daemon, coordinator, restore, quiescence, *, install_lock):
    """Atomically consume a verified adoption and record startup intent.

    This only records intent. The caller must maintain the independent durable
    writer and startup fence through verification, claiming, and startup.
    Interrupted starts require recovery and cannot be retried as new installs.
    """
    db=journal.db
    try:
        before=db.execute("SELECT preparation_id,attempt_id,attempt_nonce,root_digest,config_digest,policy_path,accepted_env,active_env,snapshot_path,snapshot_digest,data_parent,data_dev,data_ino,state FROM initial_adoptions WHERE operation_id=?",(operation,)).fetchone()
    except Exception as error:raise AdoptionError('Adoption evidence is unavailable') from error
    identity=verify(journal,operation,active_env,backup,node_fd,supervisor,daemon,coordinator,restore,quiescence,install_lock=install_lock)
    db.execute('BEGIN IMMEDIATE')
    try:
        policy_path,accepted,approved,binding=_binding(journal,operation,active_env,supervisor,daemon)
        row=db.execute("SELECT preparation_id,attempt_id,attempt_nonce,root_digest,config_digest,policy_path,accepted_env,active_env,snapshot_path,snapshot_digest,data_parent,data_dev,data_ino,state FROM initial_adoptions WHERE operation_id=?",(operation,)).fetchone()
        if not row or row!=before or row[:8]!=(*binding,policy_path,accepted,active_env) or row[-1]!='ready' or tuple(row[11:13])!=identity:
            raise AdoptionError('Migration evidence changed')
        _check_paths(row[8],row[9],row[10],operation,approved)
        db.execute("CREATE TABLE IF NOT EXISTS initial_generations (operation_id TEXT PRIMARY KEY, phase TEXT NOT NULL CHECK(phase IN ('starting','started','recovery_required')))")
        if db.execute('SELECT 1 FROM initial_generations LIMIT 1').fetchone():
            raise AdoptionError('Initial generation requires recovery')
        if db.execute("UPDATE initial_adoptions SET state='consumed' WHERE operation_id=? AND state='ready'",(operation,)).rowcount!=1:
            raise AdoptionError('Migration evidence changed')
        db.execute("INSERT INTO initial_generations VALUES (?,'starting')",(operation,))
        db.execute('COMMIT')
    except BaseException:
        if db.in_transaction:db.execute('ROLLBACK')
        raise
    return identity
