#!/usr/bin/python3 -I
"""Exercise released HTTP authorization in the exclusively owned update VM."""
import hashlib
import http.cookiejar
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid

BASE = Path('/root/servus-update-fixture')
PASSWORD = 'update-e2e-password'
CHECKS = []


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def command(*args, input=None):
    result = subprocess.run(args, input=input, capture_output=True, timeout=60)
    require(result.returncode == 0, 'Captured fixture subprocess failed')
    return result.stdout


class Client:
    def __init__(self, origin, token=None):
        self.origin = origin
        self.token = token
        self.csrf = None
        self.cookies = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.cookies))

    def request(self, method, path, expected=200, body=None, key=None, csrf=True,
                bearer=None, binary=False, record=True):
        headers = {'Origin': self.origin}
        if body is not None:
            headers['Content-Type'] = 'application/json'
        if csrf and self.csrf:
            headers['X-CSRF-Token'] = self.csrf
        if self.token or bearer:
            headers['Authorization'] = 'Bearer ' + (bearer or self.token)
        if key:
            headers['Idempotency-Key'] = key
        request = urllib.request.Request(self.origin + '/api/v1' + path, method=method,
                                         data=json.dumps(body).encode() if body is not None else None,
                                         headers=headers)
        try:
            response = self.opener.open(request, timeout=30)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            status = response.status
            data = response.read(16 * 1024 * 1024 + 1)
        require(status == expected, f'{method} {path}: expected HTTP {expected}, received {status}')
        require(len(data) <= 16 * 1024 * 1024, 'Response exceeded fixture size limit')
        if record:
            CHECKS.append({'method': method, 'path': path, 'status': status})
        if binary:
            return data
        if not data:
            return None
        try:
            return json.loads(data)
        except ValueError:
            raise RuntimeError(f'{method} {path}: expected JSON response') from None

    def login(self, email):
        result = self.request('POST', '/auth/login', body={'email': email, 'password': PASSWORD})
        self.csrf = result['csrfToken']
        require(any(cookie.name == 'panel_session' for cookie in self.cookies), 'Login did not establish a session')
        return self


def poll(fetch, identifier, description):
    deadline = time.monotonic() + 180
    while time.monotonic() < deadline:
        value = fetch()
        if isinstance(value, list):
            value = next((row for row in value if row['id'] == identifier), None)
        if value and value.get('status') == 'succeeded':
            return value
        require(not value or value.get('status') not in ('failed', 'cancelled'), description + ' failed')
        time.sleep(1)
    raise RuntimeError(description + ' did not succeed within 180 seconds')


def main():
    require(os.geteuid() == 0 and os.uname().nodename.startswith('colima-servus-update-e2e-'),
            'An exclusively owned update fixture VM is required')
    require(len(sys.argv) <= 2, 'Usage: security.py [port]')
    port = int(sys.argv[1]) if len(sys.argv) == 2 else 43899
    require(1 <= port <= 65535, 'Invalid HTTP port')
    origin = f'http://127.0.0.1:{port}'
    anonymous = Client(origin)
    run_id = uuid.uuid4().hex[:8]
    health = anonymous.request('GET', '/health')
    require(health.get('version') == '0.1.53', 'Security fixture requires released 0.1.53')
    proof = json.loads((BASE / 'proof.json').read_text())
    project_id, app_id = proof['projectId'], proof['serviceId']
    admin = Client(origin).login('update-e2e@example.test')
    ids = command('docker', 'ps', '-q', '--no-trunc', '--filter',
                  'label=com.docker.compose.project=servus', '--filter',
                  'label=com.docker.compose.service=api').decode().splitlines()
    require(len(ids) == 1, 'Expected exactly one installed API container')
    seed = """import {Store} from '/app/dist/server/store.js';
import {hashPassword} from '/app/dist/server/auth.js';
let input='';for await(const part of process.stdin)input+=part;
const {password,emails}=JSON.parse(input),store=new Store(process.env.PANEL_DATA_DIR);
try {const ids=[];for(const email of emails){if(store.findUser(email))throw new Error('Fixture user already exists');ids.push(store.createUser(email,await hashPassword(password),'member').id);}console.log(JSON.stringify(ids));}finally{store.close();}
"""
    emails = [f'update-security-{role}-{run_id}@example.test'
              for role in ('viewer', 'editor', 'outsider')]
    user_ids = json.loads(command('docker', 'exec', '-i', '--user', '1000', ids[0], 'node',
                                  '--input-type=module', '-e', seed,
                                  input=json.dumps({'password': PASSWORD, 'emails': emails}).encode()))
    require(len(user_ids) == 3, 'Synthetic users were not created')
    members = f'/projects/{project_id}/members/'
    for user_id, role in zip(user_ids[:2], ('viewer', 'editor')):
        admin.request('PUT', members + user_id, body={'role': role})
    viewer, editor, outsider = [Client(origin).login(email) for email in emails]
    app_path = '/services/' + app_id
    settings = viewer.request('GET', app_path + '/volume-backup-settings')['settings']
    require(bool(settings), 'Proof app must have a writable named volume')
    volume_settings = {'mountTarget': settings[0]['mountTarget'], 'enabled': False,
                       'cron': '0 3 * * *', 'retention': 3}
    viewer.request('GET', app_path + '/volume-backups')
    viewer.request('PUT', app_path + '/volume-backup-settings', 404, volume_settings)
    for suffix in ('/volume-backup-settings', '/volume-backups'):
        outsider.request('GET', app_path + suffix, 404)
        anonymous.request('GET', app_path + suffix, 401)
    editor.request('PUT', app_path + '/volume-backup-settings', body=volume_settings)
    volume_backup = editor.request('POST', app_path + '/volume-backups', 202,
                                   {'mountTarget': volume_settings['mountTarget'],
                                    'name': 'security-volume-' + run_id}, key=str(uuid.uuid4()))['backup']
    volume_completed = poll(lambda: editor.request('GET', app_path + '/volume-backups', record=False)['backups'],
                            volume_backup['id'], 'Proof application manual volume backup')
    volume_backup_path = app_path + '/volume-backups/' + volume_backup['id']
    for client in (admin, editor):
        data = client.request('GET', volume_backup_path + '/download', binary=True)
        require(len(data) == volume_completed['size'] and
                hashlib.sha256(data).hexdigest() == volume_completed['sha256'],
                'Downloaded volume backup does not match completed artifact')
    for client in (viewer, outsider):
        client.request('GET', volume_backup_path + '/download', 404)
        client.request('DELETE', volume_backup_path, 404)
    CHECKS.append({'check': 'real-volume-backup-download-integrity', 'status': 'succeeded',
                   'backupId': volume_backup['id']})

    created = editor.request('POST', f'/projects/{project_id}/services', 202,
                             {'name': 'security-redis-' + run_id, 'kind': 'redis',
                              'resources': {'cpu': 0.2, 'memoryMb': 128}}, key=str(uuid.uuid4()))
    redis_id, action_id = created['service']['id'], created['action']['id']
    poll(lambda: editor.request('GET', '/actions/' + action_id, record=False)['action'], action_id, 'Redis deployment')
    CHECKS.append({'check': 'real-redis-deployment', 'status': 'succeeded', 'actionId': action_id})
    redis_path = '/services/' + redis_id
    backup_settings = {'enabled': False, 'cron': '0 2 * * *', 'retention': 3}
    for suffix in ('/backup-settings', '/backups'):
        viewer.request('GET', redis_path + suffix)
        anonymous.request('GET', redis_path + suffix, 401)
        outsider.request('GET', redis_path + suffix, 404)
    viewer.request('PUT', redis_path + '/backup-settings', 404, backup_settings)
    editor.request('PUT', redis_path + '/backup-settings', body=backup_settings)
    backup = editor.request('POST', redis_path + '/backups', 202,
                            {'name': 'security-download-proof'}, key=str(uuid.uuid4()))['backup']
    completed = poll(lambda: editor.request('GET', redis_path + '/backups', record=False)['backups'],
                     backup['id'], 'Redis manual backup')
    download_path = redis_path + '/backups/' + backup['id'] + '/download'
    for client in (admin, editor):
        data = client.request('GET', download_path, binary=True)
        require(len(data) == completed['size'] and hashlib.sha256(data).hexdigest() == completed['sha256'],
                'Downloaded backup does not match completed artifact')
    viewer.request('GET', download_path, 404)
    outsider.request('GET', download_path, 404)
    for client in (viewer, outsider):
        client.request('DELETE', redis_path + '/backups/' + backup['id'], 404)
    CHECKS.append({'check': 'real-redis-backup-download-integrity', 'status': 'succeeded', 'backupId': backup['id']})

    created = editor.request('POST', f'/projects/{project_id}/compose', 202,
                             {'name': 'security-compose-' + run_id, 'source': {'type': 'inline',
                              'yaml': 'services:\n  web:\n    image: nginx:alpine\n'}, 'domains': []},
                             key=str(uuid.uuid4()))
    compose_id, action_id = created['workload']['id'], created['action']['id']
    compose_path = '/compose/' + compose_id
    poll(lambda: editor.request('GET', compose_path + '/actions', record=False), action_id, 'Compose deployment')
    for suffix in ('', '/actions', '/logs'):
        viewer.request('GET', compose_path + suffix)
        anonymous.request('GET', compose_path + suffix, 401)
        outsider.request('GET', compose_path + suffix, 404)
    anonymous.request('GET', f'/projects/{project_id}/compose', 401)
    viewer.request('GET', compose_path + '/configuration', 404)
    viewer.request('POST', compose_path + '/deploy', 404, key=str(uuid.uuid4()))
    for path in (f'/projects/{project_id}', f'/projects/{project_id}/services',
                 f'/projects/{project_id}/compose', app_path, redis_path):
        outsider.request('GET', path, 404)

    tokens = {}
    for scope in ('read', 'deploy'):
        tokens[scope] = editor.request('POST', '/auth/api-tokens', 201,
                                       {'projectId': project_id, 'name': 'security-' + scope, 'scope': scope})
    read = Client(origin, tokens['read']['token'])
    deploy = Client(origin, tokens['deploy']['token'])
    for suffix in ('', '/actions', '/logs'):
        read.request('GET', compose_path + suffix)
    read.request('POST', compose_path + '/deploy', 403, key=str(uuid.uuid4()))
    read.request('GET', compose_path + '/configuration', 403)
    deploy.request('GET', compose_path + '/configuration', 403)
    # These administrator routes must reject before calling the privileged updater.
    # Installation backups additionally reject any Authorization header with 401.
    for path in ('/installation-backups', '/updates', '/updates/preferences'):
        anonymous.request('GET', path, 401)
        for client in (viewer, editor, outsider):
            client.request('GET', path, 403)
        for client in (read, deploy):
            client.request('GET', path, 401 if path == '/installation-backups' else 403)
    for client, status in ((anonymous, 401), (viewer, 403), (editor, 403), (read, 401)):
        client.request('POST', '/installation-backups', status, {'name': 'must-not-create'})
    preferences = {'automatic': False, 'channel': 'production', 'installTime': '02:00', 'timeZone': 'UTC'}
    for client, status in ((anonymous, 401), (viewer, 403), (editor, 403), (read, 403), (deploy, 403)):
        client.request('PUT', '/updates/preferences', status, preferences)
    key = str(uuid.uuid4())
    first = deploy.request('POST', compose_path + '/deploy', 202, key=key)
    repeat = deploy.request('POST', compose_path + '/deploy', 202, key=key)
    require(first['id'] == repeat['id'], 'Repeated Compose key created another action')
    poll(lambda: deploy.request('GET', compose_path + '/actions', record=False), first['id'],
         'Bearer Compose deployment')
    CHECKS.append({'check': 'real-compose-bearer-deploy-idempotency', 'status': 'succeeded', 'actionId': first['id']})

    # A separate actual project proves bearer project isolation, even for an administrator-created resource.
    foreign = admin.request('POST', '/projects', 201, {'name': 'security-foreign-' + run_id})
    for client in (read, deploy, viewer, editor, outsider):
        client.request('GET', '/projects/' + foreign['id'], 404)
        client.request('GET', '/projects/' + foreign['id'] + '/compose', 404)
    admin.request('DELETE', members + user_ids[1])
    for client in (read, deploy):
        client.request('GET', compose_path, 404)
    admin.request('PUT', members + user_ids[1], body={'role': 'editor'})
    for client in (read, deploy):
        client.request('GET', compose_path)
    editor.request('GET', compose_path, 401, bearer=tokens['read']['token'])
    editor.request('PUT', redis_path + '/backup-settings', 403, backup_settings, csrf=False)
    for scope, client in (('read', read), ('deploy', deploy)):
        editor.request('DELETE', '/auth/api-tokens/' + tokens[scope]['id'])
        client.request('GET', compose_path, 401)
    # Only remove fixture archives after all download authorization checks completed.
    editor.request('DELETE', redis_path + '/backups/' + backup['id'])
    editor.request('GET', download_path, 404)
    editor.request('DELETE', volume_backup_path)
    editor.request('GET', volume_backup_path + '/download', 404)
    for client in (viewer, editor, outsider):
        # Keep a copy of the revoked cookie so the check proves server-side session revocation.
        saved = list(client.cookies)
        client.request('POST', '/auth/logout')
        for cookie in saved:
            client.cookies.set_cookie(cookie)
        client.request('GET', '/auth/session', 401)

    result_path = BASE / 'result.json'
    report = json.loads(result_path.read_text())
    require('security' not in report, 'Security evidence already exists; refusing duplicate fixture run')
    report['security'] = {'status': 'passed', 'release': health['version'],
                          'scope': ['volume-backup-settings/list/manual-create/download/delete ACL and artifact integrity',
                                    'database-backup-settings/list/manual-create/download/delete ACL and artifact integrity',
                                    'installation-backups GET/POST administrator denials only',
                                    'updates GET and preferences GET/PUT administrator denials only',
                                    'Compose metadata/actions/logs/configuration/deploy ACL',
                                    'project isolation', 'read/deploy bearer scopes', 'live membership removal/restoration',
                                    'token revocation', 'session logout revocation', 'mixed credentials', 'CSRF'],
                          'checks': CHECKS,
                          'resources': {'redisServiceId': redis_id, 'composeId': compose_id,
                                        'volumeBackupId': volume_backup['id'], 'backupArtifactsDeleted': True,
                                        'backupId': backup['id'], 'foreignProjectId': foreign['id']}}
    report.setdefault('checks', []).append('released-http-security-acl-isolation-and-revocation')
    temporary = result_path.with_suffix('.security.tmp')
    temporary.write_text(json.dumps(report, indent=2) + '\n')
    temporary.chmod(0o600)
    temporary.replace(result_path)
    print(f'PASS security: {len(CHECKS)} released HTTP and real workload checks', flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Never emit server bodies, process output, credentials or traceback locals.
        print('FAIL security: ' + (str(error) if isinstance(error, RuntimeError) else type(error).__name__),
              file=sys.stderr, flush=True)
        sys.exit(1)
