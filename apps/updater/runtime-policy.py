#!/usr/bin/python3 -I
"""Derive a supervisor policy from a verified image and accepted configuration.

The caller is a trusted root coordinator. Docker, root and the image verifier
are trusted. This module does not authorize an operation or start containers.
"""
import json
import fcntl
import hashlib
import os
import pathlib
import re
import secrets
import selectors
import shutil
import stat
import subprocess
import sys
import tempfile
import time

ROLES = ('api', 'worker', 'agent')
IMAGE = 'ghcr.io/raxon/servus'
DIGEST = re.compile(r'^sha256:[a-f0-9]{64}$')
CONTAINER = re.compile(r'^[a-f0-9]{64}$')
HASH = re.compile(r'^[a-f0-9]{64}$')


class PolicyError(Exception):
    """Do not include secret environment values or Docker output."""


def _docker(config, *args, limit=1024 * 1024, timeout=30):
    env = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'HOME': '/root', 'LANG': 'C',
           'DOCKER_CONFIG': config, 'DOCKER_HOST': 'unix:///var/run/docker.sock', 'DOCKER_CONTEXT': 'default'}
    process = subprocess.Popen(['/usr/bin/docker', *args], stdin=subprocess.DEVNULL,
                               stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                               env=env, cwd='/', close_fds=True)
    selector = selectors.DefaultSelector()
    output = bytearray()
    deadline = time.monotonic() + timeout
    try:
        selector.register(process.stdout, selectors.EVENT_READ)
        while selector.get_map():
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not selector.select(remaining):
                raise PolicyError('Docker operation timed out')
            chunk = os.read(process.stdout.fileno(), 65536)
            if not chunk:
                selector.unregister(process.stdout)
                break
            output.extend(chunk)
            if len(output) > limit:
                raise PolicyError('Docker output exceeded limit')
        remaining = deadline - time.monotonic()
        if remaining <= 0 or process.wait(timeout=remaining) != 0:
            raise PolicyError('Docker operation failed')
        return bytes(output)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise PolicyError('Docker operation failed') from error
    finally:
        selector.close()
        if process.poll() is None:
            process.kill()
            try: process.wait(timeout=3)
            except subprocess.TimeoutExpired: pass
        process.stdout.close()


def _read_private_file(path, maximum=1024 * 1024):
    if not isinstance(path, str) or not path.startswith('/') or os.path.normpath(path) != path:
        raise PolicyError('Unsafe configuration path')
    parent, name = os.path.split(path)
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in parent.split('/')[1:]:
            if not part:
                continue
            info = os.fstat(fd)
            if info.st_uid != 0 or info.st_mode & 0o022:
                raise PolicyError('Unsafe configuration parent')
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
        info = os.fstat(fd)
        if info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o700:
            raise PolicyError('Unsafe configuration parent')
        file_fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
        try:
            before = os.fstat(file_fd)
            if not stat.S_ISREG(before.st_mode) or before.st_uid != 0 or before.st_nlink != 1 or stat.S_IMODE(before.st_mode) != 0o600 or before.st_size > maximum:
                raise PolicyError('Unsafe configuration file')
            with os.fdopen(file_fd, 'rb', closefd=False) as stream:
                content = stream.read(maximum + 1)
            after = os.fstat(file_fd)
            named = os.stat(name, dir_fd=fd, follow_symlinks=False)
            if (len(content) != before.st_size or len(content) > maximum or
                (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) !=
                (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns) or
                (named.st_dev, named.st_ino) != (before.st_dev, before.st_ino)):
                raise PolicyError('Configuration changed while reading')
            return content
        finally:
            os.close(file_fd)
    finally:
        os.close(fd)


def _env(content):
    try:
        result = {}
        for line in content.decode('ascii').splitlines():
            if not line or '=' not in line:
                raise ValueError()
            key, value = line.split('=', 1)
            if key in result or not re.fullmatch(r'SERVUS_[A-Z_]+', key) or '\x00' in value:
                raise ValueError()
            result[key] = value
        return result
    except (ValueError, UnicodeError) as error:
        raise PolicyError('Invalid accepted configuration') from error


def _write(path, content):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as stream:
        os.fchmod(stream.fileno(), 0o600)
        stream.write(content)
        stream.flush()
        os.fsync(stream.fileno())


def _publish_private(directory_fd, name, content):
    temporary = '.private-' + secrets.token_hex(16)
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory_fd)
    try:
        with os.fdopen(fd, 'wb', closefd=False) as stream:
            os.fchmod(fd, 0o600)
            stream.write(content)
            stream.flush()
            os.fsync(fd)
        os.link(temporary, name, src_dir_fd=directory_fd, dst_dir_fd=directory_fd, follow_symlinks=False)
        os.unlink(temporary, dir_fd=directory_fd)
        os.fsync(directory_fd)
    finally:
        os.close(fd)
        try: os.unlink(temporary, dir_fd=directory_fd)
        except FileNotFoundError: pass


def _replace_private(directory_fd, name, content):
    temporary = '.private-' + secrets.token_hex(16)
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory_fd)
    try:
        with os.fdopen(fd, 'wb', closefd=False) as stream:
            os.fchmod(fd, 0o600)
            stream.write(content)
            stream.flush()
            os.fsync(fd)
        os.replace(temporary, name, src_dir_fd=directory_fd, dst_dir_fd=directory_fd)
        os.fsync(directory_fd)
    finally:
        os.close(fd)
        try: os.unlink(temporary, dir_fd=directory_fd)
        except FileNotFoundError: pass


def _json(content):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise PolicyError('Duplicate Docker JSON key')
            result[key] = value
        return result
    try:
        return json.loads(content, object_pairs_hook=unique,
                          parse_constant=lambda _: (_ for _ in ()).throw(PolicyError('Invalid JSON value')))
    except (UnicodeError, ValueError, RecursionError) as error:
        raise PolicyError('Invalid Docker JSON') from error


def _record_identity(db, operation_id):
    db.execute('BEGIN IMMEDIATE')
    try:
        row = db.execute("SELECT o.digest,o.config_digest,p.attempt_id,p.attempt_nonce,p.preparation_id,p.staging_path "
                         "FROM operations o JOIN preparations p ON p.operation_id=o.id "
                         "WHERE o.id=? AND o.status='verified' AND p.status='prepared' "
                         "AND o.attempt_id=p.attempt_id AND o.attempt_nonce=p.attempt_nonce", (operation_id,)).fetchone()
        if not row or not all(isinstance(x, str) and x for x in row) or not DIGEST.fullmatch(row[0]) or not DIGEST.fullmatch(row[1]):
            raise PolicyError('Verified preparation is unavailable')
        cursor = db.execute("UPDATE preparations SET status='preparing' WHERE operation_id=? AND status='prepared' AND preparation_id=?", (operation_id, row[4]))
        if cursor.rowcount != 1:
            raise PolicyError('Preparation changed')
        db.execute('COMMIT')
        return row
    except BaseException:
        if db.in_transaction:
            db.execute('ROLLBACK')
        raise


def _record_probe(db, operation_id, attempt_id, nonce, preparation_id, project, config_digest):
    """Persist cleanup identity before creating any Compose resource."""
    db.execute('BEGIN IMMEDIATE')
    try:
        db.execute("CREATE TABLE IF NOT EXISTS policy_probes (operation_id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL, attempt_nonce TEXT NOT NULL, preparation_id TEXT NOT NULL, project TEXT NOT NULL, config_digest TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('intent','removed')))")
        row = db.execute("SELECT 1 FROM preparations WHERE operation_id=? AND attempt_id=? AND attempt_nonce=? AND preparation_id=? AND status='preparing'", (operation_id, attempt_id, nonce, preparation_id)).fetchone()
        if row is None or not re.fullmatch(r'servusprobe[a-f0-9]{32}', project) or not DIGEST.fullmatch(config_digest):
            raise PolicyError('Probe identity is invalid')
        db.execute("INSERT INTO policy_probes VALUES (?,?,?,?,?,?,'intent')", (operation_id, attempt_id, nonce, preparation_id, project, config_digest))
        db.execute('COMMIT')
    except BaseException:
        if db.in_transaction: db.execute('ROLLBACK')
        raise


def _record_candidate(db, operation_id, attempt_id, nonce, preparation_id, project,
                      root_digest, image_config_digest, accepted_env_path, source_env_path, env_digest,
                      candidate_path, candidate_digest):
    db.execute('BEGIN IMMEDIATE')
    try:
        definition = db.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='policy_approvals'").fetchone()
        if definition and "'superseded'" not in definition[0]:
            columns = [row[1] for row in db.execute('PRAGMA table_info(policy_approvals)')]
            expected = ['operation_id', 'attempt_id', 'attempt_nonce', 'preparation_id', 'root_digest', 'image_config_digest', 'accepted_env_path', 'env_digest', 'candidate_path', 'candidate_digest', 'policy_path', 'state']
            if columns != expected:
                raise PolicyError('Unsupported policy approval schema')
            db.execute('ALTER TABLE policy_approvals RENAME TO policy_approvals_legacy')
        db.execute("CREATE TABLE IF NOT EXISTS policy_approvals (operation_id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL, attempt_nonce TEXT NOT NULL, preparation_id TEXT NOT NULL, root_digest TEXT NOT NULL, image_config_digest TEXT NOT NULL, accepted_env_path TEXT NOT NULL, env_digest TEXT NOT NULL, candidate_path TEXT NOT NULL, candidate_digest TEXT NOT NULL, policy_path TEXT, state TEXT NOT NULL CHECK(state IN ('candidate','activating','active','superseded','recovery_required')))")
        if definition and "'superseded'" not in definition[0]:
            db.execute('INSERT INTO policy_approvals SELECT * FROM policy_approvals_legacy')
            db.execute('DROP TABLE policy_approvals_legacy')
        if 'source_env_path' not in [row[1] for row in db.execute('PRAGMA table_info(policy_approvals)')]:
            db.execute('ALTER TABLE policy_approvals ADD COLUMN source_env_path TEXT')
            db.execute('UPDATE policy_approvals SET source_env_path=accepted_env_path')
        db.execute("CREATE UNIQUE INDEX IF NOT EXISTS one_active_policy ON policy_approvals ((1)) WHERE state='active'")
        cursor = db.execute("UPDATE preparations SET status='prepared' WHERE operation_id=? AND status='preparing' AND attempt_id=? AND attempt_nonce=? AND preparation_id=? AND NOT EXISTS (SELECT 1 FROM extraction_probes WHERE status='intent') AND EXISTS (SELECT 1 FROM policy_probes WHERE operation_id=? AND preparation_id=? AND project=? AND config_digest=? AND state='removed') AND EXISTS (SELECT 1 FROM operations WHERE id=? AND status='verified' AND attempt_id=? AND attempt_nonce=? AND digest=? AND config_digest=?)", (operation_id, attempt_id, nonce, preparation_id, operation_id, preparation_id, project, env_digest, operation_id, attempt_id, nonce, root_digest, image_config_digest))
        if cursor.rowcount != 1:
            raise PolicyError('Preparation changed')
        db.execute("INSERT INTO policy_approvals(operation_id,attempt_id,attempt_nonce,preparation_id,root_digest,image_config_digest,accepted_env_path,env_digest,candidate_path,candidate_digest,policy_path,state,source_env_path) VALUES (?,?,?,?,?,?,?,?,?,?,NULL,'candidate',?)", (operation_id, attempt_id, nonce, preparation_id, root_digest, image_config_digest, accepted_env_path, env_digest, candidate_path, candidate_digest, source_env_path))
        db.execute('COMMIT')
    except BaseException:
        if db.in_transaction: db.execute('ROLLBACK')
        raise


def produce(journal, operation_id, staging_parent, accepted_env_path, install_dir, output_path, extractor, supervisor, *, resolve_child=None, lock_owner=None):
    """Produce a policy only after durable intent, validation and probe cleanup.

    The caller must load these modules from trusted root-owned code. This
    routine takes the installation lock. An interrupted probe requires recovery.
    """
    if sys.platform != 'linux' or os.geteuid() != 0 or not sys.flags.isolated:
        raise PolicyError('An isolated Linux root coordinator is required')
    # Ensure any files written by this routine are private, and validate input
    # before acquiring an exclusive durable preparation intent.
    parent_fd = extractor._trusted_parent(staging_parent)
    os.close(parent_fd)
    output_parent, output_name = os.path.split(output_path)
    if not output_name or os.path.normpath(output_path) != output_path:
        raise PolicyError('Invalid output path')
    output_fd = extractor._trusted_parent(output_parent)
    install_fd = lock_fd = None
    try:
        if lock_owner is None:
            install_fd = supervisor._trusted_directory(install_dir)
            lock_fd = supervisor._open_root_file(install_fd, 'install.lock', 0o600)
            fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        else:
            if not isinstance(lock_owner, supervisor.MaintenanceSupervisor):
                raise PolicyError('A current installation lock is required')
            supervisor._assert_exclusive_flock(lock_owner.install_lock)
            install_fd = supervisor._trusted_directory(install_dir)
            held, requested = os.fstat(lock_owner.install), os.fstat(install_fd)
            if (held.st_dev, held.st_ino) != (requested.st_dev, requested.st_ino):
                raise PolicyError('Installation lock belongs to another installation')
            lock_fd = os.dup(lock_owner.install_lock)
        db = journal.db
        row = _record_identity(db, operation_id)
    except BaseException:
        if lock_fd is not None: os.close(lock_fd)
        if install_fd is not None: os.close(install_fd)
        os.close(output_fd)
        raise
    root_digest, config_digest, attempt_id, nonce, preparation_id, _old_stage = row
    project = 'servusprobe' + secrets.token_hex(16)
    stage = work = None
    ids = []
    network = project + '_default'
    reference = IMAGE + '@' + root_digest
    success = False
    try:
        if output_name != 'candidate-' + preparation_id + '.json':
            raise PolicyError('A preparation-specific candidate path is required')
        config_bytes = _read_private_file(accepted_env_path, 65536)
        env = _env(config_bytes)
        if env.get('SERVUS_IMAGE') != reference:
            raise PolicyError('Accepted image reference changed')
        for key in ('SERVUS_DATA_DIR', 'SERVUS_LIFECYCLE_DIR', 'SERVUS_SUPERVISOR_CONTROL_DIR', 'SERVUS_SUPERVISOR_SECRET_DIR'):
            if not env.get(key):
                raise PolicyError('Accepted configuration is incomplete')
        # The prepared directory is not an integrity proof after restart.
        # Extract a fresh copy from the exact locally verified image instead.
        work = tempfile.mkdtemp(prefix='servus-policy-', dir=staging_parent)
        os.chmod(work, 0o700)
        docker_config = os.path.join(work, 'docker-client')
        os.mkdir(docker_config, 0o700)
        docker = lambda *args, **kwargs: _docker(docker_config, *args, **kwargs)
        image = _json(docker('image', 'inspect', '--format', '{{json .}}', reference))
        selected = _json(docker('image', 'inspect', '--platform=linux/amd64', '--format', '{{json .}}', reference))
        if (not isinstance(image, dict) or image.get('Id') not in (root_digest, config_digest) or
            not isinstance(selected, dict) or not isinstance(selected.get('Id'), str) or not DIGEST.fullmatch(selected['Id']) or
            selected.get('Os') != 'linux' or selected.get('Architecture') != 'amd64' or
            not isinstance(image.get('RepoDigests'), list) or reference not in image['RepoDigests']):
            raise PolicyError('Verified image is unavailable')
        image_id = image['Id']
        verified_ids = {root_digest, config_digest}
        if selected['Id'] not in verified_ids:
            if resolve_child is None:
                raise PolicyError('Verified platform manifest is required')
            child = resolve_child(root_digest, config_digest)
            if not isinstance(child, str) or not DIGEST.fullmatch(child) or child != selected['Id']:
                raise PolicyError('Platform image identity rejected')
            verified_ids.add(child)
        extraction_operation = {'operationId': operation_id, 'attemptId': attempt_id, 'attemptNonce': nonce,
                                'preparationId': preparation_id, 'configDigest': config_digest}
        extraction_probe = journal.record_extraction_probe(extraction_operation, 'policy')
        stage = extractor.extract(image_id, staging_parent, verified_platform_ids=tuple(sorted(verified_ids - {image_id})),
                                  probe_name=extraction_probe, artifact_format=extractor.format_for_verified_digest(root_digest))
        journal.complete_extraction_probe(extraction_operation, extraction_probe)
        env_file = os.path.join(work, 'servus.env')
        image_env_file = os.path.join(work, 'image-env.json')
        canonical = os.path.join(work, 'canonical.json')
        _write(env_file, config_bytes)
        image_config = selected.get('Config')
        if not isinstance(image_config, dict) or not isinstance(image_config.get('Env'), list):
            raise PolicyError('Image configuration is unavailable')
        _write(image_env_file, json.dumps(image_config['Env'], separators=(',', ':')).encode())
        compose_file = os.path.join(stage, 'deployment/compose.yaml')
        common = ('compose', '--env-file', env_file, '-f', compose_file, '-p', 'servus')
        effective = docker(*common, 'config', '--format', 'json', limit=2 * 1024 * 1024)
        # The validator itself is part of trusted, installed updater code.
        validator = pathlib.Path(__file__).resolve().with_name('validate-compose.py')
        validator_dir = supervisor._trusted_directory(str(validator.parent))
        try:
            validator_fd = supervisor._open_root_file(validator_dir, validator.name, 0o644)
            try:
                command = [sys.executable, '-I', '/proc/self/fd/' + str(validator_fd), env['SERVUS_LIFECYCLE_DIR'], reference,
                           env['SERVUS_DATA_DIR'], env_file, image_env_file, env['SERVUS_SUPERVISOR_CONTROL_DIR'],
                           env['SERVUS_SUPERVISOR_SECRET_DIR'], canonical]
                try:
                    subprocess.run(command, input=effective, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                   env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C'}, cwd='/',
                                   timeout=30, check=True, close_fds=True, pass_fds=(validator_fd,))
                except (OSError, subprocess.SubprocessError) as error:
                    raise PolicyError('Compose validation failed') from error
            finally:
                os.close(validator_fd)
        finally:
            os.close(validator_dir)
        document = _json(_read_private_file(canonical, 2 * 1024 * 1024))
        if document.get('name') != 'servus' or document.get('networks', {}).get('default', {}).get('name') != 'servus_default':
            raise PolicyError('Compose validation failed')
        # The only adaptation is the isolated project and its private network.
        hashes_raw = docker('compose', '--env-file', env_file, '-f', canonical, '-p', 'servus', 'config', '--hash', '*', limit=4096)
        hashes = {}
        for line in hashes_raw.decode('ascii').splitlines():
            role, digest = line.split(' ', 1)
            if role not in ROLES or role in hashes or not HASH.fullmatch(digest):
                raise PolicyError('Invalid Compose hashes')
            hashes[role] = digest
        if set(hashes) != set(ROLES):
            raise PolicyError('Invalid Compose hashes')
        document['name'] = project
        document['networks']['default']['name'] = network
        probe_file = os.path.join(work, 'probe.json')
        _write(probe_file, json.dumps(document, sort_keys=True, separators=(',', ':')).encode())
        # Compose interpolates even canonical JSON. Refuse any transformation
        # beyond the intentional project and network change before create.
        probe_rendered = _json(docker('compose', '--env-file', env_file, '-f', probe_file, '-p', project, 'config', '--format', 'json', limit=2 * 1024 * 1024))
        if probe_rendered != document:
            raise PolicyError('Probe configuration changed during rendering')
        existing = docker('ps', '-a', '--filter', 'label=com.docker.compose.project=' + project, '--format', '{{.ID}}')
        if existing.strip():
            raise PolicyError('Probe project already exists')
        _record_probe(db, operation_id, attempt_id, nonce, preparation_id, project,
                      'sha256:' + hashlib.sha256(config_bytes).hexdigest())
        # Validated snapshot has no named volumes or external resources.
        probe = ('compose', '--env-file', env_file, '-f', probe_file, '-p', project)
        docker(*probe, 'create', '--no-build', timeout=120)
        raw_ids = docker('ps', '-a', '--no-trunc', '--filter', 'label=com.docker.compose.project=' + project, '--format', '{{.ID}}')
        ids = raw_ids.decode('ascii').splitlines()
        if len(ids) != 3 or len(set(ids)) != 3 or not all(CONTAINER.fullmatch(item) for item in ids):
            raise PolicyError('Unexpected probe containers')
        records = _json(docker('inspect', *ids, limit=4 * 1024 * 1024))
        if not isinstance(records, list) or len(records) != 3:
            raise PolicyError('Unexpected probe containers')
        hosts, environments, healthchecks, seen, actual_image_ids = {}, {}, {}, set(), set()
        for record in records:
            config, state, mounts = record.get('Config'), record.get('State'), record.get('Mounts')
            if not isinstance(config, dict) or not isinstance(state, dict) or not isinstance(mounts, list):
                raise PolicyError('Unexpected probe configuration')
            labels = config.get('Labels') or {}
            role = labels.get('com.docker.compose.service')
            if (role not in ROLES or role in seen or labels.get('com.docker.compose.project') != project or
                labels.get('com.docker.compose.container-number') != '1' or labels.get('com.docker.compose.oneoff') != 'False' or
                record.get('Id') not in ids or record.get('Image') not in (image_id, selected['Id']) or config.get('Image') != reference or
                state.get('Status') != 'created' or state.get('Running') is not False or state.get('Pid') != 0 or
                config.get('User') != 'node' or config.get('WorkingDir') != '/app' or
                config.get('Entrypoint') != ['/bin/sh', '/app/lifecycle-gate.sh'] or
                config.get('Cmd') != ['dist/' + ('server' if role == 'api' else role) + '/index.js']):
                raise PolicyError('Unexpected probe configuration')
            seen.add(role)
            actual_image_ids.add(record['Image'])
            entries = []
            for mount in mounts:
                if not isinstance(mount, dict) or type(mount.get('RW')) is not bool:
                    raise PolicyError('Unexpected probe mounts')
                entries.append((mount.get('Type'), mount.get('Source'), mount.get('Destination'), mount['RW']))
            expected = {('bind', env['SERVUS_DATA_DIR'], env['SERVUS_DATA_DIR'], True),
                        ('bind', env['SERVUS_LIFECYCLE_DIR'], '/run/servus-lifecycle', False),
                        ('bind', env['SERVUS_SUPERVISOR_CONTROL_DIR'], '/run/servus-supervisor', False),
                        ('bind', env['SERVUS_SUPERVISOR_SECRET_DIR'] + '/' + role, '/run/servus-control/token', False)}
            if role == 'agent':
                expected.add(('bind', '/var/run/docker.sock', '/var/run/docker.sock', True))
            if role == 'api' and 'SERVUS_UPDATER_SOCKET_DIR' in env:
                expected.add(('bind', env['SERVUS_UPDATER_SOCKET_DIR'], '/run/servus-updater', False))
            if len(entries) != len(expected) or set(entries) != expected:
                raise PolicyError('Unexpected probe mounts')
            host = record.get('HostConfig')
            if not isinstance(host, dict) or host.get('NetworkMode') != network:
                raise PolicyError('Unexpected probe network')
            host['NetworkMode'] = 'servus_default'
            raw_env = config.get('Env')
            if not isinstance(raw_env, list) or not all(isinstance(item, str) and '=' in item for item in raw_env):
                raise PolicyError('Unexpected probe environment')
            pairs = [item.split('=', 1) for item in raw_env]
            if len({pair[0] for pair in pairs}) != len(pairs):
                raise PolicyError('Unexpected probe environment')
            base_env = image_config['Env']
            if not all(isinstance(item, str) and '=' in item for item in base_env):
                raise PolicyError('Unexpected image environment')
            base_pairs = [item.split('=', 1) for item in base_env]
            if len({pair[0] for pair in base_pairs}) != len(base_pairs):
                raise PolicyError('Unexpected image environment')
            expected_env = dict(base_pairs)
            expected_env.update(document['services'][role]['environment'])
            if dict(pairs) != expected_env:
                raise PolicyError('Unexpected probe environment')
            hosts[role], environments[role], healthchecks[role] = host, dict(pairs), config.get('Healthcheck')
        if len(actual_image_ids) != 1:
            raise PolicyError('Inconsistent probe images')
        policy = {'image_reference': reference, 'image_id': next(iter(actual_image_ids)), 'install_dir': install_dir,
                  'data_dir': env['SERVUS_DATA_DIR'], 'gate_dir': env['SERVUS_LIFECYCLE_DIR'],
                  'control_dir': env['SERVUS_SUPERVISOR_CONTROL_DIR'],
                  'secret_sources': {role: env['SERVUS_SUPERVISOR_SECRET_DIR'] + '/' + role for role in ROLES},
                  'config_hashes': hashes, 'environments': environments, 'host_configs': hosts, 'healthchecks': healthchecks}
        if 'SERVUS_UPDATER_SOCKET_DIR' in env: policy['updater_dir'] = env['SERVUS_UPDATER_SOCKET_DIR']
        supervisor.RuntimePolicy(**policy)
        # Remove exact probe objects before publishing policy. Network removal is
        # constrained to the random Compose project created above.
        docker('rm', *ids)
        ids = []
        docker('network', 'rm', network)
        remaining = docker('ps', '-a', '--filter', 'label=com.docker.compose.project=' + project, '--format', '{{.ID}}')
        if remaining.strip():
            raise PolicyError('Probe cleanup is incomplete')
        cursor = db.execute("UPDATE policy_probes SET state='removed' WHERE operation_id=? AND preparation_id=? AND project=? AND state='intent'", (operation_id, preparation_id, project))
        if cursor.rowcount != 1:
            raise PolicyError('Probe identity changed')
        # The work directory contains the accepted proxy secret. Never report
        # a prepared candidate when its temporary copy could not be removed.
        shutil.rmtree(work)
        work = None
        shutil.rmtree(stage)
        stage = None
        data = json.dumps({'version': 1, 'policy': policy}, sort_keys=True, separators=(',', ':'), allow_nan=False).encode() + b'\n'
        snapshot_name = 'env-' + preparation_id + '.env'
        _publish_private(output_fd, snapshot_name, config_bytes)
        _publish_private(output_fd, output_name, data)
        snapshot_path = os.path.join(output_parent, snapshot_name)
        _record_candidate(db, operation_id, attempt_id, nonce, preparation_id, project, root_digest,
                          config_digest, snapshot_path, accepted_env_path, 'sha256:' + hashlib.sha256(config_bytes).hexdigest(),
                          output_path, 'sha256:' + hashlib.sha256(data).hexdigest())
        success = True
        return output_path
    except (OSError, ValueError, UnicodeError, KeyError, TypeError, subprocess.SubprocessError) as error:
        raise PolicyError('Policy generation failed') from error
    finally:
        if not success:
            try:
                db.execute("UPDATE preparations SET status='recovery_required' WHERE operation_id=? AND status='preparing' AND preparation_id=?", (operation_id, preparation_id))
            except BaseException:
                pass
        # Cleanup failures leave the journal in recovery_required. Never delete
        # unidentified Docker objects after an uncertain create operation.
        if ids:
            try:
                docker('rm', *ids)
            except BaseException:
                pass
        for directory in (work, stage):
            if directory:
                shutil.rmtree(directory, ignore_errors=True)
        os.close(output_fd)
        os.close(lock_fd)
        os.close(install_fd)


def activate(journal, operation_id, accepted_env_path, candidate_path, policy_path, install_dir, control_dir, extractor, supervisor):
    """Activate exactly one approved candidate while both host locks are held.

    Policies have distinct immutable paths. A previous active policy can only be
    superseded after its preparation completed and the old containers stopped.
    A crash or failed publication requires reconciliation before further work.
    """
    if sys.platform != 'linux' or os.geteuid() != 0 or not sys.flags.isolated:
        raise PolicyError('An isolated Linux root coordinator is required')
    if not isinstance(policy_path, str) or not policy_path.startswith('/') or os.path.normpath(policy_path) != policy_path:
        raise PolicyError('Invalid active policy path')
    parent, name = os.path.split(policy_path)
    if not name:
        raise PolicyError('Invalid active policy path')
    install_fd = control_fd = lock_fd = daemon_lock = output_fd = None
    intent = False
    try:
        install_fd = supervisor._trusted_directory(install_dir)
        lock_fd = supervisor._open_root_file(install_fd, 'install.lock', 0o600)
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        control_fd = supervisor._trusted_directory(control_dir, 0o750)
        try:
            daemon_lock = os.open('daemon.lock', os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=control_fd)
            os.fchmod(daemon_lock, 0o600)
        except FileExistsError:
            daemon_lock = supervisor._open_root_file(control_fd, 'daemon.lock', 0o600)
        info = os.fstat(daemon_lock)
        named = os.stat('daemon.lock', dir_fd=control_fd, follow_symlinks=False)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_gid != 0 or info.st_nlink != 1 or
            stat.S_IMODE(info.st_mode) != 0o600 or (info.st_dev, info.st_ino) != (named.st_dev, named.st_ino)):
            raise PolicyError('Unsafe daemon lock')
        fcntl.flock(daemon_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        output_fd = extractor._trusted_parent(parent)
        config = _read_private_file(accepted_env_path, 65536)
        candidate = _read_private_file(candidate_path, 1024 * 1024)
        db = journal.db
        db.execute('BEGIN IMMEDIATE')
        try:
            if db.execute("SELECT 1 FROM policy_approvals WHERE state IN ('activating','recovery_required') LIMIT 1").fetchone():
                raise PolicyError('A policy activation requires recovery')
            row = db.execute("SELECT a.attempt_id,a.attempt_nonce,a.preparation_id,a.root_digest,a.image_config_digest,a.env_digest,a.candidate_digest,a.accepted_env_path FROM policy_approvals a JOIN operations o ON o.id=a.operation_id JOIN preparations p ON p.operation_id=a.operation_id WHERE a.operation_id=? AND a.state='candidate' AND a.source_env_path=? AND a.candidate_path=? AND o.status='verified' AND o.attempt_id=a.attempt_id AND o.attempt_nonce=a.attempt_nonce AND o.digest=a.root_digest AND o.config_digest=a.image_config_digest AND p.status='prepared' AND p.attempt_id=a.attempt_id AND p.attempt_nonce=a.attempt_nonce AND p.preparation_id=a.preparation_id AND NOT EXISTS (SELECT 1 FROM extraction_probes WHERE status='intent') AND EXISTS (SELECT 1 FROM policy_probes WHERE operation_id=a.operation_id AND preparation_id=a.preparation_id AND config_digest=a.env_digest AND state='removed')", (operation_id, accepted_env_path, candidate_path)).fetchone()
            if not row or row[5] != 'sha256:' + hashlib.sha256(config).hexdigest() or row[6] != 'sha256:' + hashlib.sha256(candidate).hexdigest():
                raise PolicyError('Policy approval or configuration changed')
            snapshot = _read_private_file(row[7], 65536)
            if row[5] != 'sha256:' + hashlib.sha256(snapshot).hexdigest():
                raise PolicyError('Approved environment snapshot changed')
            document = _json(candidate)
            if not isinstance(document, dict) or set(document) != {'version', 'policy'} or type(document['version']) is not int or document['version'] != 1 or not isinstance(document['policy'], dict):
                raise PolicyError('Invalid policy candidate')
            policy = supervisor.RuntimePolicy(**document['policy'])
            if (policy.image_reference != IMAGE + '@' + row[3] or policy.install_dir != install_dir or
                policy.control_dir != control_dir or _env(config).get('SERVUS_IMAGE') != policy.image_reference):
                raise PolicyError('Policy identity changed')
            # Immutable per-operation files avoid replacing a file that a
            # starting daemon may already have opened.
            try:
                os.stat(name, dir_fd=output_fd, follow_symlinks=False)
            except FileNotFoundError:
                pass
            else:
                raise PolicyError('Active policy already exists')
            previous = db.execute("SELECT a.operation_id,a.policy_path,a.accepted_env_path,a.env_digest,a.candidate_digest,p.status FROM policy_approvals a JOIN preparations p ON p.operation_id=a.operation_id WHERE a.state='active'").fetchall()
            if len(previous) > 1:
                raise PolicyError('Multiple active policies require recovery')
            if previous:
                # Replacing a running installation needs a proven drain, held
                # lifecycle gate and verified backup bound to this operation.
                # No integrated proof exists yet, so do not supersede it.
                raise PolicyError('Policy replacement requires verified drain, gate and backup')
            running = supervisor._docker('ps', '--filter', 'label=com.docker.compose.project=servus', '--format', '{{.ID}}')
            if running.strip():
                raise PolicyError('Servus containers must be stopped before policy activation')
            cursor = db.execute("UPDATE policy_approvals SET state='activating',policy_path=? WHERE operation_id=? AND state='candidate'", (policy_path, operation_id))
            if cursor.rowcount != 1: raise PolicyError('Policy approval changed')
            db.execute('COMMIT')
            intent = True
        except BaseException:
            if db.in_transaction: db.execute('ROLLBACK')
            raise
        temporary = '.active-' + secrets.token_hex(16)
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=output_fd)
        try:
            with os.fdopen(fd, 'wb', closefd=False) as stream:
                os.fchmod(fd, 0o600)
                stream.write(candidate)
                stream.flush()
                os.fsync(fd)
            os.link(temporary, name, src_dir_fd=output_fd, dst_dir_fd=output_fd, follow_symlinks=False)
            os.unlink(temporary, dir_fd=output_fd)
            os.fsync(output_fd)
        finally:
            os.close(fd)
            try: os.unlink(temporary, dir_fd=output_fd)
            except FileNotFoundError: pass
        db.execute('BEGIN IMMEDIATE')
        try:
            cursor = db.execute("UPDATE policy_approvals SET state='active' WHERE operation_id=? AND state='activating' AND policy_path=? AND env_digest=? AND candidate_digest=?", (operation_id, policy_path, row[5], row[6]))
            if cursor.rowcount != 1: raise PolicyError('Policy activation changed')
            db.execute('COMMIT')
        except BaseException:
            if db.in_transaction: db.execute('ROLLBACK')
            raise
        intent = False
        return policy_path
    except BaseException:
        if intent:
            try: journal.db.execute("UPDATE policy_approvals SET state='recovery_required' WHERE operation_id=? AND state='activating'", (operation_id,))
            except BaseException: pass
        raise
    finally:
        for fd in (output_fd, daemon_lock, control_fd, lock_fd, install_fd):
            if fd is not None: os.close(fd)


def activate_locked(journal, operation_id, accepted_env_path, candidate_path, policy_path,
                    active_env_path, lease, daemon_ownership, extractor, supervisor,
                    coordinator, backup_module, node_fd):
    """Supersede an active policy only inside a verified maintenance window.

    The caller owns the installation, gate and daemon locks and supplies only
    modules loaded from trusted root-owned files. Proof is read from the same
    journal as the candidate; no caller-provided assertion authorizes the swap.
    A crash after durable intent blocks policy loading until reconciliation.
    """
    if sys.platform != 'linux' or os.geteuid() != 0 or not sys.flags.isolated:
        raise PolicyError('An isolated Linux root coordinator is required')
    if not isinstance(lease, supervisor.DrainLease) or not supervisor._uuid4(operation_id):
        raise PolicyError('A current maintenance lease is required')
    if not isinstance(policy_path, str) or not policy_path.startswith('/') or os.path.normpath(policy_path) != policy_path:
        raise PolicyError('Invalid active policy path')
    parent, name = os.path.split(policy_path)
    if not name:
        raise PolicyError('Invalid active policy path')
    install_dir = os.readlink('/proc/self/fd/' + str(lease._owner.install))
    control_dir = os.readlink('/proc/self/fd/' + str(daemon_ownership.directory))
    lease.assert_snapshot_verified(operation_id)
    daemon_ownership.assert_held(control_dir)
    output_fd = extractor._trusted_parent(parent)
    intent = False
    db = journal.db
    try:
        candidate = _read_private_file(candidate_path, 1024 * 1024)
        config = _read_private_file(accepted_env_path, 65536)
        live_config = _read_private_file(active_env_path, 65536)
        db.execute('BEGIN IMMEDIATE')
        try:
            if db.execute("SELECT 1 FROM policy_approvals WHERE state IN ('activating','recovery_required') LIMIT 1").fetchone():
                raise PolicyError('A policy activation requires recovery')
            row = db.execute("SELECT a.attempt_id,a.attempt_nonce,a.preparation_id,a.root_digest,a.image_config_digest,a.env_digest,a.candidate_digest,a.accepted_env_path "
                "FROM policy_approvals a JOIN operations o ON o.id=a.operation_id JOIN preparations p ON p.operation_id=a.operation_id "
                "WHERE a.operation_id=? AND a.state='candidate' AND a.source_env_path=? AND a.candidate_path=? "
                "AND o.status='verified' AND o.attempt_id=a.attempt_id AND o.attempt_nonce=a.attempt_nonce "
                "AND o.digest=a.root_digest AND o.config_digest=a.image_config_digest AND p.status='prepared' "
                "AND p.attempt_id=a.attempt_id AND p.attempt_nonce=a.attempt_nonce AND p.preparation_id=a.preparation_id "
                "AND NOT EXISTS (SELECT 1 FROM extraction_probes WHERE status='intent') "
                "AND EXISTS (SELECT 1 FROM policy_probes WHERE operation_id=a.operation_id AND preparation_id=a.preparation_id AND config_digest=a.env_digest AND state='removed')",
                (operation_id, accepted_env_path, candidate_path)).fetchone()
            if not row or row[5] != 'sha256:' + hashlib.sha256(config).hexdigest() or row[6] != 'sha256:' + hashlib.sha256(candidate).hexdigest():
                raise PolicyError('Policy approval or configuration changed')
            if row[5] != 'sha256:' + hashlib.sha256(_read_private_file(row[7], 65536)).hexdigest():
                raise PolicyError('Approved environment snapshot changed')
            previous = db.execute("SELECT a.operation_id,a.policy_path,a.accepted_env_path,a.env_digest,a.candidate_digest,a.source_env_path "
                "FROM policy_approvals a JOIN preparations p ON p.operation_id=a.operation_id "
                "WHERE a.state='active' AND p.status='completed'").fetchall()
            if len(previous) != 1 or previous[0][0] == operation_id or previous[0][5] != active_env_path:
                raise PolicyError('Previous active policy is unavailable')
            old = previous[0]
            if (old[3] != 'sha256:' + hashlib.sha256(_read_private_file(old[2], 65536)).hexdigest() or
                    old[4] != 'sha256:' + hashlib.sha256(_read_private_file(old[1], 1024 * 1024)).hexdigest()):
                raise PolicyError('Previous approved policy changed')
            if old[3] != 'sha256:' + hashlib.sha256(live_config).hexdigest():
                raise PolicyError('Active environment does not match the previous policy')
            previous_env, next_env = _env(live_config), _env(config)
            if (set(previous_env) != set(next_env) or any(previous_env[key] != next_env[key] for key in previous_env if key != 'SERVUS_IMAGE')):
                raise PolicyError('Update changes unrelated installation configuration')
            # A valid old approval is not sufficient unless it is the policy
            # under which the currently held hub was authenticated and drained.
            lease.assert_active_policy(old[1], old[3], old[4])
            proof = db.execute("SELECT preparation_id,attempt_id,attempt_nonce,root_digest,backup_path,backup_manifest_digest "
                "FROM update_transactions WHERE operation_id=? AND phase='snapshot_verified'", (operation_id,)).fetchone()
            if (not proof or proof[:4] != (row[2], row[0], row[1], row[3]) or
                not isinstance(proof[4], str) or not proof[4].startswith('/') or os.path.normpath(proof[4]) != proof[4] or
                not isinstance(proof[5], str) or not DIGEST.fullmatch(proof[5])):
                raise PolicyError('Verified snapshot proof is unavailable')
            document = _json(candidate)
            if not isinstance(document, dict) or set(document) != {'version', 'policy'} or type(document['version']) is not int or document['version'] != 1 or not isinstance(document['policy'], dict):
                raise PolicyError('Invalid policy candidate')
            policy = supervisor.RuntimePolicy(**document['policy'])
            if (policy.image_reference != IMAGE + '@' + row[3] or policy.install_dir != install_dir or
                policy.control_dir != control_dir or _env(config).get('SERVUS_IMAGE') != policy.image_reference):
                raise PolicyError('Policy identity changed')
            try:
                os.stat(name, dir_fd=output_fd, follow_symlinks=False)
            except FileNotFoundError:
                pass
            else:
                raise PolicyError('Active policy already exists')
            # Recheck the entire inventory, encryption and database integrity.
            coordinator.verify_snapshot(proof[4], proof[5], backup_module, node_fd, supervisor)
            lease.assert_snapshot_verified(operation_id)
            daemon_ownership.assert_held(control_dir)
            lease.assert_active_policy(old[1], old[3], old[4])
            if _read_private_file(active_env_path, 65536) != live_config:
                raise PolicyError('Active environment changed')
            cursor = db.execute("UPDATE policy_approvals SET state='activating',policy_path=?,source_env_path=? WHERE operation_id=? AND state='candidate'", (policy_path, active_env_path, operation_id))
            if cursor.rowcount != 1:
                raise PolicyError('Policy approval changed')
            db.execute('COMMIT')
            intent = True
        except BaseException:
            if db.in_transaction: db.execute('ROLLBACK')
            raise
        env_parent, env_name = os.path.split(active_env_path)
        env_fd = extractor._trusted_parent(env_parent)
        try:
            if not env_name or _read_private_file(active_env_path, 65536) != live_config:
                raise PolicyError('Active environment changed')
            _replace_private(env_fd, env_name, config)
        finally:
            os.close(env_fd)
        _publish_private(output_fd, name, candidate)
        lease.assert_snapshot_verified(operation_id)
        daemon_ownership.assert_held(control_dir)
        lease.assert_active_policy(old[1], old[3], old[4])
        if _read_private_file(active_env_path, 65536) != config:
            raise PolicyError('Active environment changed')
        db.execute('BEGIN IMMEDIATE')
        try:
            prior = db.execute("UPDATE policy_approvals SET state='superseded' WHERE operation_id=? AND state='active'", (old[0],))
            current = db.execute("UPDATE policy_approvals SET state='active' WHERE operation_id=? AND state='activating' AND policy_path=? AND env_digest=? AND candidate_digest=? AND source_env_path=? "
                "AND EXISTS (SELECT 1 FROM update_transactions t WHERE t.operation_id=policy_approvals.operation_id AND t.phase='snapshot_verified' AND t.preparation_id=? AND t.attempt_id=? AND t.attempt_nonce=? AND t.root_digest=? AND t.backup_path=? AND t.backup_manifest_digest=?) "
                "AND EXISTS (SELECT 1 FROM operations o JOIN preparations p ON p.operation_id=o.id WHERE o.id=policy_approvals.operation_id AND o.status='verified' AND o.attempt_id=? AND o.attempt_nonce=? AND o.digest=? AND o.config_digest=? AND p.status='prepared' AND p.preparation_id=? AND p.attempt_id=? AND p.attempt_nonce=?) "
                "AND NOT EXISTS (SELECT 1 FROM extraction_probes WHERE status='intent')",
                (operation_id, policy_path, row[5], row[6], active_env_path,
                 row[2], row[0], row[1], row[3], proof[4], proof[5],
                 row[0], row[1], row[3], row[4], row[2], row[0], row[1]))
            if prior.rowcount != 1 or current.rowcount != 1:
                raise PolicyError('Policy activation changed')
            db.execute('COMMIT')
        except BaseException:
            if db.in_transaction: db.execute('ROLLBACK')
            raise
        intent = False
        return policy_path
    except BaseException:
        if intent:
            try: db.execute("UPDATE policy_approvals SET state='recovery_required' WHERE operation_id=? AND state='activating'", (operation_id,))
            except BaseException: pass
        raise
    finally:
        os.close(output_fd)
