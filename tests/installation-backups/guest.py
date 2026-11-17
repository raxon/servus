#!/usr/bin/python3 -I
"""Real backup acceptance inside an exclusively owned disposable Colima VM.

The fixture provisions a trusted local policy from actual container inspection.
It does not establish release attestation or authorize a production deployment.
No Docker, drain, capture, restart or restore implementation is replaced.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid

BASE = Path('/run/servus-installation-backup-fixture')
CONFIG = Path('/etc/servus-backup-fixture')
INSTALL = Path('/opt/servus-backup-fixture')
DATA = Path('/var/lib/servus-backup-fixture')
STATE = Path('/var/lib/servus-updater')
CONTROL = Path('/run/servus-supervisor')
UPDATER = Path('/run/servus-updater/control')
MODULES = Path('/usr/local/libexec/servus')
ORIGIN = 'http://127.0.0.1:4180'
CLEAN = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'HOME': '/root', 'LC_ALL': 'C', 'LANG': 'C'}
CHECKS = []


def error_hints(content):
    """Allowlisted diagnostics, never raw logs or environment-derived values."""
    value = content.decode('utf-8', errors='replace').lower() if isinstance(content, bytes) else content.lower()
    return [hint for hint in ('permission denied', 'eacces', 'err_module_not_found', 'cannot find package',
                              'cannot find module', 'eaddrinuse', 'syntaxerror', 'unhealthy', 'no such file',
                              'startup gate', 'migration', 'sqlite_error', 'supervisor could not start safely') if hint in value]


def guard():
    if (os.geteuid() != 0 or not sys.flags.isolated or
        not os.uname().nodename.startswith('colima-servus-installation-backup-e2e-')):
        raise RuntimeError('An owned disposable installation-backup VM is required')


def docker(*args, timeout=120, input=None):
    result = subprocess.run(['/usr/bin/docker', '--config', str(STATE / 'docker-config'), *args],
                            env=CLEAN, cwd='/', input=input, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
    if result.returncode:
        failure = {'command': args[0], 'exitCode': result.returncode, 'stderrHints': error_hints(result.stderr),
                   'stderrSha256': hashlib.sha256(result.stderr).hexdigest()}
        # The diagnostics phase runs as a separate process after a failed
        # fixture; preserve only this sanitized boundary result for it.
        temporary = BASE / 'docker-failure.tmp'
        with open(temporary, 'w', opener=lambda path, flags: os.open(path, flags, 0o600)) as stream:
            json.dump(failure, stream); stream.write('\n')
        os.replace(temporary, BASE / 'docker-failure.json')
        raise RuntimeError('Fixture Docker command failed: ' + args[0])
    return result.stdout.decode().strip()


def load(name):
    path = MODULES / (name + '.py')
    spec = importlib.util.spec_from_file_location('fixture_' + name.replace('-', '_'), path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def private(path, value, mode=0o600):
    content = value if isinstance(value, bytes) else value.encode()
    with open(path, 'xb') as stream:
        os.fchmod(stream.fileno(), mode)
        stream.write(content)
        stream.flush()
        os.fsync(stream.fileno())


def diagnostics():
    """Inspect this VM's fixture without exporting secrets or unrestricted logs."""
    report = {'status': 'failed', 'checkedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
              'host': os.uname().nodename, 'roles': [], 'daemonHints': {}, 'operations': []}
    failure = BASE / 'docker-failure.json'
    if failure.exists():
        report['dockerFailure'] = json.loads(failure.read_text())
    command = ['/usr/bin/docker', '--config', str(STATE / 'docker-config')]
    ids = subprocess.run([*command, 'ps', '-aq', '--filter', 'label=com.docker.compose.project=servus'],
                         stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=15, env=CLEAN).stdout.decode().splitlines()
    if ids and all(re.fullmatch(r'[a-f0-9]{12,64}', value) for value in ids) and len(ids) <= 3:
        result = subprocess.run([*command, 'inspect', *ids], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=15, env=CLEAN)
        if result.returncode == 0:
            for item in json.loads(result.stdout):
                role = item.get('Config', {}).get('Labels', {}).get('com.docker.compose.service')
                if role not in ('api', 'agent', 'worker'): continue
                state = item.get('State', {})
                logs = subprocess.run([*command, 'logs', '--tail', '80', item['Id']], stdout=subprocess.PIPE,
                                      stderr=subprocess.STDOUT, timeout=15, env=CLEAN).stdout
                report['roles'].append({'role': role, 'state': state.get('Status'), 'exitCode': state.get('ExitCode'),
                                        'running': state.get('Running'), 'health': state.get('Health', {}).get('Status'),
                                        'logHints': error_hints(logs), 'logSha256': hashlib.sha256(logs).hexdigest()})
                for line in logs.decode('utf-8', errors='replace').splitlines():
                    try: entry = json.loads(line)
                    except ValueError: continue
                    if isinstance(entry, dict) and entry.get('msg') == 'API drain is uncertain' and isinstance(entry.get('sources'), list):
                        report['roles'][-1]['uncertaintySources'] = [value for value in entry['sources'] if value in
                            ('handler', 'request_aborted', 'response_closed', 'closer', 'unknown')]
    for name in ('supervisor', 'supervisor-recovery', 'updater'):
        path = BASE / (name + '.log')
        if path.exists():
            content = path.read_bytes()[-32768:]
            report['daemonHints'][name] = error_hints(content)
            events = []
            for line in content.decode('utf-8', errors='replace').splitlines():
                drain = re.fullmatch(r'servus drain failure role=(api|worker|agent) outcome=(channel_error|uncertain|timeout|stopped|invalid_response)', line)
                phase = re.fullmatch(r'servus maintenance failure phase=(maintenance_gate|drain|identity|stop|exclusive_gate|update)', line)
                if drain: events.append({'role': drain[1], 'outcome': drain[2]})
                if phase: events.append({'phase': phase[1]})
            report.setdefault('daemonEvents', {})[name] = events[-20:]
    gate = CONFIG / 'lifecycle/state'
    if gate.exists():
        state = gate.read_bytes()
        report['gate'] = state.decode().strip() if state in (b'servus-lifecycle-v1 normal\n', b'servus-lifecycle-v1 maintenance\n', b'servus-lifecycle-v1 recovering\n') else 'unknown'
    journal = STATE / 'maintenance/installation-backups'
    if journal.exists():
        for path in sorted(journal.glob('*.json')):
            if path.name == 'active.json': continue
            item = json.loads(path.read_text())
            report['operations'].append({key: item[key] for key in ('operationId', 'state', 'errorCode')})
    print(json.dumps(report), flush=True)


def digest(content):
    return 'sha256:' + hashlib.sha256(content).hexdigest()


def wait(description, predicate, timeout=180):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(.25)
    raise RuntimeError('Fixture deadline: ' + description)


def compose(*args):
    return docker('compose', '--env-file', str(CONFIG / 'servus.env'), '-f', str(BASE / 'compose.yaml'),
                  '-f', str(BASE / 'override.yaml'), '-p', 'servus', *args)


def start_daemon(name, args):
    log = open(BASE / (name + '.log'), 'ab', buffering=0)
    os.chmod(log.name, 0o600)
    try:
        child = subprocess.Popen(args, env=CLEAN, cwd='/', stdin=subprocess.DEVNULL,
                                 stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    finally:
        log.close()
    private(BASE / (name + '.pid'), str(child.pid) + '\n')
    return child


def prepare(image):
    if not re.fullmatch(r'ghcr\.io/raxon/servus@sha256:[a-f0-9]{64}', image):
        raise RuntimeError('An immutable local fixture image is required')
    if any(path.exists() for path in (CONFIG, INSTALL, DATA, STATE, CONTROL, UPDATER)):
        raise RuntimeError('Fixture requires fresh owned host paths')
    if docker('ps', '-aq') or docker('service', 'ls', '-q'):
        raise RuntimeError('Fixture requires an empty daemon')
    for path, mode in ((CONFIG, 0o700), (INSTALL, 0o700), (DATA, 0o700), (STATE, 0o700),
                       (CONTROL, 0o750), (UPDATER.parent, 0o700), (UPDATER, 0o710)):
        path.mkdir(mode=mode)
    os.chown(DATA, 1000, 1000)
    os.chown(CONTROL, 0, 1000)
    os.chown(UPDATER, 0, 1000)
    for name in ('staging', 'maintenance', 'backups', 'policies', 'docker-config', 'host-generations'):
        (STATE / name).mkdir(mode=0o700)
    (CONFIG / 'lifecycle').mkdir(mode=0o755)
    (CONFIG / 'secrets').mkdir(mode=0o700)
    (CONFIG / 'bin').mkdir(mode=0o700)
    private(INSTALL / '.fixture-owner', os.uname().nodename + '\n')
    private(INSTALL / 'install.lock', b'')
    private(CONFIG / 'lifecycle/lock', b'', 0o644)
    private(CONFIG / 'lifecycle/state', 'servus-lifecycle-v1 normal\n', 0o644)
    for role in ('api', 'worker', 'agent'):
        path = CONFIG / 'secrets' / role
        private(path, secrets.token_hex(32) + '\n', 0o640)
        os.chown(path, 0, 1000)
    gid = os.stat('/var/run/docker.sock').st_gid
    env = {'SERVUS_IMAGE': image, 'SERVUS_DATA_DIR': str(DATA), 'SERVUS_DOCKER_GID': str(gid),
           'SERVUS_LIFECYCLE_DIR': str(CONFIG / 'lifecycle'), 'SERVUS_SUPERVISOR_CONTROL_DIR': str(CONTROL),
           'SERVUS_SUPERVISOR_SECRET_DIR': str(CONFIG / 'secrets'), 'SERVUS_UPDATER_SOCKET_DIR': str(UPDATER),
           'SERVUS_BIND_ADDRESS': '127.0.0.1', 'SERVUS_PORT': '4180', 'SERVUS_INGRESS_PORT': '18080',
           'SERVUS_ALLOWED_ORIGINS': ORIGIN, 'SERVUS_SECURE_COOKIES': 'false'}
    content = ''.join(key + '=' + value + '\n' for key, value in env.items()).encode()
    private(CONFIG / 'servus.env', content)
    private(CONFIG / 'accepted.env', content)
    private(BASE / 'override.yaml', 'services:\n  agent:\n    environment:\n      PANEL_ALLOW_LOCAL_IMAGES: "1"\n')
    copier = docker('create', '--pull=never', '--label', 'servus.fixture=installation-backup-node', '--entrypoint', '/bin/false', image)
    try:
        docker('cp', copier + ':/usr/local/bin/node', str(CONFIG / 'bin/node'))
        os.chown(CONFIG / 'bin/node', 0, 0)
        os.chmod(CONFIG / 'bin/node', 0o755)
    finally:
        docker('rm', copier)
    compose('create', '--no-build', '--pull', 'never')
    ids = docker('ps', '-aq', '--filter', 'label=com.docker.compose.project=servus').splitlines()
    records = json.loads(docker('inspect', *ids))
    if len(records) != 3:
        raise RuntimeError('Fixture did not create exactly three roles')
    by_role = {record['Config']['Labels']['com.docker.compose.service']: record for record in records}
    config = {
        'image_reference': image, 'image_id': records[0]['Image'], 'install_dir': str(INSTALL), 'data_dir': str(DATA),
        'gate_dir': str(CONFIG / 'lifecycle'), 'control_dir': str(CONTROL), 'updater_dir': str(UPDATER),
        'secret_sources': {role: str(CONFIG / 'secrets' / role) for role in by_role},
        'config_hashes': {role: item['Config']['Labels']['com.docker.compose.config-hash'] for role, item in by_role.items()},
        'environments': {role: dict(value.split('=', 1) for value in item['Config']['Env']) for role, item in by_role.items()},
        'host_configs': {role: item['HostConfig'] for role, item in by_role.items()},
        'healthchecks': {role: item['Config'].get('Healthcheck') for role, item in by_role.items()},
    }
    supervisor = load('supervisor')
    supervisor.RuntimePolicy(**config)
    policy = json.dumps({'version': 1, 'policy': config}, sort_keys=True, separators=(',', ':')).encode() + b'\n'
    policy_path = STATE / 'policies/fixture.json'
    private(policy_path, policy)
    updater = load('servus-updater')
    runtime = load('runtime-policy')
    journal = updater.Journal(STATE)
    try:
        operation, attempt, preparation = (str(uuid.uuid4()) for _ in range(3))
        nonce, project = secrets.token_hex(32), 'servusprobe' + secrets.token_hex(16)
        root_digest = image.split('@', 1)[1]
        index = json.loads(subprocess.check_output(['/usr/bin/ctr', '--address', '/run/containerd/containerd.sock',
                            '--namespace', 'moby', 'content', 'get', root_digest], env=CLEAN))
        manifests = [item for item in index['manifests'] if item.get('platform', {}).get('architecture') == 'arm64' and item.get('platform', {}).get('os') == 'linux']
        if len(manifests) != 1: raise RuntimeError('Fixture image platform is ambiguous')
        manifest = json.loads(subprocess.check_output(['/usr/bin/ctr', '--address', '/run/containerd/containerd.sock',
                               '--namespace', 'moby', 'content', 'get', manifests[0]['digest']], env=CLEAN))
        # The release verifier is outside this fixture. This root-owned test
        # approval binds the actual image, accepted environment and inspection.
        image_config_digest = manifest['config']['digest']
        journal.db.execute("INSERT INTO operations(id,commit_sha,digest,tag,status,attempt_id,attempt_nonce,config_digest) VALUES(?,?,?,'v0.1.52','verified',?,?,?)",
                           (operation, 'a' * 40, root_digest, attempt, nonce, image_config_digest))
        journal.db.execute("INSERT INTO preparations VALUES(?,?,?,?,'preparing',NULL)", (operation, attempt, nonce, preparation))
        runtime._record_probe(journal.db, operation, attempt, nonce, preparation, project, digest(content))
        journal.db.execute("UPDATE policy_probes SET state='removed' WHERE operation_id=?", (operation,))
        runtime._record_candidate(journal.db, operation, attempt, nonce, preparation, project, root_digest, image_config_digest,
                                  str(CONFIG / 'accepted.env'), str(CONFIG / 'servus.env'), digest(content), str(policy_path), digest(policy))
        journal.db.execute("UPDATE preparations SET status='completed' WHERE operation_id=?", (operation,))
        journal.db.execute("UPDATE policy_approvals SET state='active',policy_path=? WHERE operation_id=?", (str(policy_path), operation))
    finally:
        journal.close()
    host_config = {'backupRoot': str(STATE / 'backups'), 'policyRoot': str(STATE / 'policies'),
                   'dockerConfig': str(STATE / 'docker-config'), 'nodePath': str(CONFIG / 'bin/node'),
                   'nodeSha256': hashlib.sha256((CONFIG / 'bin/node').read_bytes()).hexdigest(), 'trustedIngress': None}
    private(CONFIG / 'apply.json', json.dumps(host_config))
    daemon_args = ['/usr/bin/python3', '-I', '-B', str(MODULES / 'supervisor-daemon.py'), '--policy', str(policy_path),
                   '--install-dir', str(INSTALL), '--gate-dir', str(CONFIG / 'lifecycle'), '--journal-dir', str(STATE / 'maintenance'),
                   '--secret-dir', str(CONFIG / 'secrets'), '--socket-dir', str(CONTROL), '--approval-journal', str(STATE / 'journal.sqlite'),
                   '--accepted-env', str(CONFIG / 'accepted.env'), '--active-env', str(CONFIG / 'servus.env'),
                   '--apply-config', str(CONFIG / 'apply.json'), '--uid', '1000', '--gid', '1000']
    private(BASE / 'supervisor-args.json', json.dumps(daemon_args))
    start_daemon('supervisor', daemon_args)
    wait('supervisor socket', lambda: (CONTROL / 'socket').is_socket())
    start_daemon('updater', ['/usr/bin/python3', '-I', '-B', str(MODULES / 'servus-updater.py'), '--state-dir', str(STATE),
                            '--socket-dir', str(UPDATER), '--peer-uid', '1000', '--socket-gid', '1000',
                            '--supervisor-socket', str(CONTROL / 'command')])
    wait('updater socket', lambda: (UPDATER / 'updater.sock').is_socket())
    compose('up', '-d', '--no-build', '--pull', 'never')
    private(BASE / 'prepared.json', json.dumps({'image': image, 'ids': {role: item['Id'] for role, item in by_role.items()}}))
    print('PREPARED actual inspected control plane and root daemons', flush=True)


class Client:
    def __init__(self):
        self.cookie = self.csrf = ''

    def request(self, path, method='GET', body=None, idempotency=None):
        headers = {'origin': ORIGIN, 'accept': 'application/json'}
        if self.cookie: headers['cookie'] = self.cookie
        if self.csrf: headers['x-csrf-token'] = self.csrf
        if idempotency: headers['idempotency-key'] = idempotency
        payload = None
        if body is not None:
            headers['content-type'] = 'application/json'
            payload = json.dumps(body).encode()
        request = urllib.request.Request(ORIGIN + '/api/v1' + path, data=payload, headers=headers, method=method)
        with urllib.request.urlopen(request, timeout=8) as response:
            cookie = response.headers.get('set-cookie')
            if cookie: self.cookie = cookie.split(';', 1)[0]
            result = json.load(response)
            if isinstance(result, dict) and result.get('csrfToken'): self.csrf = result['csrfToken']
            return result


def cancel_queued_backup(client):
    """Keep the untouched queue observable by stopping only the idle worker."""
    prepared = json.loads((BASE / 'prepared.json').read_text())
    worker = prepared['ids']['worker']
    updater = load('servus-updater')
    def supervisor_ready():
        return updater.supervisor_request(str(CONTROL / 'command'), {'version': 1, 'type': 'status'}, 2)['status'] == 'ready'
    docker('stop', '--time', '30', worker)
    try:
        wait('worker channel disconnected', lambda: not supervisor_ready(), 30)
        operation = str(uuid.uuid4())
        name = 'Cancel before maintenance'
        queued = client.request('/installation-backups', 'POST', {'operationId': operation, 'name': name})['operation']
        if queued['state'] != 'requested': raise RuntimeError('An untouched backup was not queued')
        cancelled = client.request('/installation-backups/' + operation + '/cancel', 'POST', {'name': name})['operation']
        if cancelled['state'] != 'cancelled' or cancelled['actorId'] != queued['actorId']:
            raise RuntimeError('Actual cancellation did not preserve the operation creator')
        if (STATE / 'maintenance/maintenance.json').exists() or (CONFIG / 'lifecycle/state').read_bytes() != b'servus-lifecycle-v1 normal\n':
            raise RuntimeError('Cancellation changed the untouched lifecycle gate')
        CHECKS.append('actual-purpose-separated-api-cancellation-before-maintenance')
    finally:
        docker('start', worker)
    wait('worker fresh authenticated channel', supervisor_ready, 60)


def exercise():
    client = Client()
    def ready():
        try: return client.request('/health').get('status') == 'ok'
        except (OSError, ValueError): return False
    wait('panel health', ready)
    credentials = {'email': 'backup-fixture@example.test', 'password': secrets.token_urlsafe(24)}
    private(BASE / 'credentials.json', json.dumps(credentials))
    client.request('/setup', 'POST', credentials)
    project = client.request('/projects', 'POST', {'name': 'installation-backup-proof'})
    create = client.request('/projects/' + project['id'] + '/services', 'POST', {
        'name': 'persistent-app', 'image': 'nginx:alpine', 'port': 80, 'domains': [],
        'mounts': [{'type': 'volume', 'name': 'content', 'target': '/usr/share/nginx/html'}],
        'environment': [{'name': 'SYNTHETIC_BACKUP_SECRET', 'value': 'owned-restore-proof', 'secret': True}],
    }, str(uuid.uuid4()))
    def deployed():
        action = client.request('/actions/' + create['action']['id'])['action']
        if action['status'] == 'failed': raise RuntimeError('Fixture application deployment failed')
        return action['status'] == 'succeeded'
    wait('application deployment', deployed, 240)
    wait('owned ingress task', lambda: len(docker('ps', '-q', '--filter', 'label=com.docker.swarm.service.name=panel-ingress').splitlines()) == 1)
    service = create['service']['id']
    task = docker('ps', '-q', '--filter', 'label=com.docker.swarm.service.name=panel-app-' + service)
    if not task or '\n' in task: raise RuntimeError('Fixture application task is ambiguous')
    marker = 'application-proof-' + str(uuid.uuid4())
    docker('exec', task, 'sh', '-c', 'printf %s "$1" >/usr/share/nginx/html/backup-proof', 'fixture', marker)
    private(BASE / 'content-proof.json', json.dumps({'project': project['id'], 'service': service, 'task': task, 'marker': marker}))
    CHECKS.append('real-panel-session-and-application-volume-deployment')
    if client.request('/installation-backups').get('available') is not True:
        raise RuntimeError('The real host capability route did not confirm availability')
    CHECKS.append('real-installation-backup-capability-probe')
    cancel_queued_backup(client)
    operation = str(uuid.uuid4())
    private(BASE / 'operation.json', json.dumps({'operationId': operation}))
    result = client.request('/installation-backups', 'POST', {'operationId': operation, 'name': 'Before isolated restore'})
    if result['operation']['operationId'] != operation: raise RuntimeError('Backup approval response identity differs')
    CHECKS.append('real-administrator-api-approval-and-updater-dispatch')
    return verify_backup(client, operation)


def verify_backup(client, operation):
    credentials = json.loads((BASE / 'credentials.json').read_text())
    proof = json.loads((BASE / 'content-proof.json').read_text())
    project = {'id': proof['project']}
    service, task, marker = proof['service'], proof['task'], proof['marker']
    def completed():
        try:
            record = client.request('/installation-backups/' + operation)['operation']
        except (OSError, ValueError):
            return False
        if record['state'] in ('failed', 'recovery_required', 'cancelled'):
            raise RuntimeError('Real installation backup requires investigation: ' + record['state'])
        return record['state'] == 'completed'
    wait('capture and authenticated restart', completed, 240)
    journal = json.loads((STATE / 'maintenance/installation-backups' / (operation + '.json')).read_text())
    if journal['state'] != 'completed' or (STATE / 'maintenance/maintenance.json').exists():
        raise RuntimeError('Protected completion receipt is inconsistent')
    original = json.loads((BASE / 'prepared.json').read_text())
    actual = {item['Config']['Labels']['com.docker.compose.service']: item['Id'] for item in
              json.loads(docker('inspect', *original['ids'].values()))}
    if actual != original['ids']: raise RuntimeError('Backup replaced the original control-plane generation')
    if docker('exec', task, 'cat', '/usr/share/nginx/html/backup-proof') != marker:
        raise RuntimeError('Application volume changed during control-plane backup')
    if docker('ps', '-q', '--filter', 'id=' + task) != task[:12]:
        # Docker may print the full ID depending on its configured format.
        if docker('inspect', '--format', '{{.State.Running}}', task) != 'true':
            raise RuntimeError('Application stopped during control-plane backup')
    CHECKS.extend(['actual-authenticated-drain-stopped-writer-capture-and-fresh-role-restart',
                   'original-container-identities-and-application-volume-preserved'])
    supervisor, backup, coordinator, restore = (load(name) for name in ('supervisor', 'backup', 'update-coordinator', 'restore-snapshot'))
    parent = Path('/var/lib/servus-backup-fixture-restores')
    parent.mkdir(mode=0o711)
    node = os.open(CONFIG / 'bin/node', os.O_RDONLY)
    try:
        restored = restore.stage(journal['snapshotPath'], journal['manifestDigest'], str(parent), str(uuid.uuid4()),
                                 backup, node, supervisor, coordinator)
    finally:
        os.close(node)
    sandbox = docker('run', '-d', '--pull=never', '--network', 'none', '--label', 'servus.fixture=backup-restore-sandbox',
                     '--mount', 'type=bind,source=' + restored + ',target=' + str(DATA),
                     '--env', 'PANEL_DATA_DIR=' + str(DATA), '--env', 'PANEL_HOST=127.0.0.1',
                     '--entrypoint', '/usr/local/bin/node', original['image'], 'dist/server/index.js')
    try:
        program = """let text='';for await(const c of process.stdin)text+=c;const x=JSON.parse(text),base='http://127.0.0.1:4180/api/v1';let r=await fetch(base+'/auth/login',{method:'POST',headers:{'content-type':'application/json',origin:'http://localhost:4180'},body:JSON.stringify(x.credentials)});if(!r.ok)process.exit(2);const cookie=r.headers.get('set-cookie').split(';')[0];r=await fetch(base+'/projects',{headers:{cookie}});const projects=await r.json();if(!Array.isArray(projects)||!projects.some(p=>p.id===x.project))process.exit(3);const {Store}=await import('/app/dist/server/store.js');const s=new Store(process.env.PANEL_DATA_DIR);const ref=s.db.prepare('SELECT reference FROM service_secret_refs WHERE service_id=? AND purpose=?').get(x.service,'environment');if(!ref||s.vault.getServiceSecret(ref.reference,x.service,'environment')!=='owned-restore-proof')process.exit(4);s.close();console.log('SANDBOX_API_AND_SECRET_OK');"""
        def sandbox_ok():
            try:
                return docker('exec', '-i', sandbox, 'node', '--input-type=module', '-e', program,
                              input=json.dumps({'credentials': credentials, 'project': project['id'], 'service': service}).encode()) == 'SANDBOX_API_AND_SECRET_OK'
            except RuntimeError:
                return False
        wait('isolated restored API login and content', sandbox_ok, 60)
        CHECKS.append('actual-restored-api-login-project-and-service-secret-without-docker-access')
    finally:
        docker('rm', '-f', sandbox)
    report = {'status': 'passed', 'checkedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'checks': CHECKS,
              'operationId': operation, 'image': original['image'], 'snapshotManifestDigest': journal['manifestDigest'],
              'limits': 'Dedicated disposable ARM64 VM, trusted local policy fixture and local immutable image alias. Release attestation, public VPS acceptance and external storage are separate.'}
    private(BASE / 'result.json', json.dumps(report, indent=2) + '\n')
    print(json.dumps(report), flush=True)


def retry_after_recovery():
    credentials = json.loads((BASE / 'credentials.json').read_text())
    previous = json.loads((BASE / 'operation.json').read_text())['operationId']
    client = Client()
    client.request('/auth/login', 'POST', credentials)
    failed = client.request('/installation-backups/' + previous)['operation']
    if failed['state'] != 'failed' or failed['errorCode'] != 'capture_failed':
        raise RuntimeError('An unverified partial backup was not recovered as failed')
    raw = json.loads((STATE / 'maintenance/installation-backups' / (previous + '.json')).read_text())
    if raw['snapshotPath'] is not None or raw['manifestDigest'] is not None:
        raise RuntimeError('An unverified snapshot was fabricated during recovery')
    if (CONFIG / 'lifecycle/state').read_bytes() != b'servus-lifecycle-v1 normal\n':
        raise RuntimeError('Recovery did not release the healthy original generation')
    if (STATE / 'maintenance/maintenance.json').exists():
        raise RuntimeError('Recovery left its active maintenance marker')
    CHECKS.append('real-failed-capture-root-recovery-preserves-original-data-without-fabricated-snapshot')
    operation_path = BASE / 'retry-operation.json'
    if operation_path.exists():
        operation = json.loads(operation_path.read_text())['operationId']
    else:
        operation = str(uuid.uuid4())
        private(operation_path, json.dumps({'operationId': operation}))
    result = client.request('/installation-backups', 'POST', {'operationId': operation, 'name': 'After recovered refusal'})
    if result['operation']['operationId'] != operation:
        raise RuntimeError('Retried backup response identity differs')
    return verify_backup(client, operation)


if __name__ == '__main__':
    guard()
    parser = argparse.ArgumentParser()
    parser.add_argument('phase', choices=('prepare', 'exercise', 'retry-after-recovery', 'diagnostics'))
    parser.add_argument('--image')
    args = parser.parse_args()
    if args.phase == 'diagnostics': diagnostics()
    elif args.phase == 'prepare': prepare(args.image)
    elif args.phase == 'exercise': exercise()
    else: retry_after_recovery()
