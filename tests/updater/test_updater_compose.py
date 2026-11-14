import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

VALIDATOR = Path(__file__).resolve().parents[2] / 'apps/updater/validate-compose.py'
IMAGE = 'ghcr.io/raxon/servus@sha256:' + 'a' * 64
DATA, GATE, CONTROL, SECRETS = '/var/lib/servus', '/etc/servus/lifecycle', '/run/servus-supervisor', '/etc/servus/supervisor-secrets'
UPDATER = '/run/servus-updater/control'


def fixture(enabled):
    environment = {'SERVUS_IMAGE': IMAGE, 'SERVUS_DATA_DIR': DATA, 'SERVUS_LIFECYCLE_DIR': GATE,
                   'SERVUS_SUPERVISOR_CONTROL_DIR': CONTROL, 'SERVUS_SUPERVISOR_SECRET_DIR': SECRETS,
                   'SERVUS_DOCKER_GID': '998', 'SERVUS_ALLOWED_ORIGINS': 'https://example.test'}
    if enabled: environment['SERVUS_UPDATER_SOCKET_DIR'] = UPDATER
    def bind(source, target, readonly=True):
        return {'type': 'bind', 'source': source, 'target': target, 'read_only': readonly, 'bind': {'create_host_path': False}}
    document = {'name': 'servus', 'networks': {'default': {'name': 'servus_default'}}, 'services': {}}
    for role in ('api', 'worker', 'agent'):
        env = {'PANEL_DATA_DIR': DATA, 'PANEL_INGRESS_PORT': '80', 'PANEL_SUPERVISOR_SOCKET': '/run/servus-supervisor/socket', 'PANEL_SUPERVISOR_SECRET_FILE': '/run/servus-control/token'}
        mounts = [bind(DATA, DATA, False), bind(GATE, '/run/servus-lifecycle'), bind(CONTROL, '/run/servus-supervisor'), bind(SECRETS + '/' + role, '/run/servus-control/token')]
        command = 'dist/' + ('server' if role == 'api' else role) + '/index.js'
        service = {'restart': 'unless-stopped', 'command': [command], 'entrypoint': ['/bin/sh', '/app/lifecycle-gate.sh'], 'environment': env, 'image': IMAGE, 'init': True, 'networks': {'default': None}, 'volumes': mounts}
        if role == 'api':
            env.update({'PANEL_HOST': '0.0.0.0', 'PANEL_PORT': '4180', 'PANEL_ALLOWED_ORIGINS': 'https://example.test', 'PANEL_SECURE_COOKIES': 'false', 'PANEL_TRUSTED_PROXY_SECRET': ''})
            if enabled:
                env.update({'PANEL_UPDATER_SOCKET': '/run/servus-updater/updater.sock', 'PANEL_UPDATER_APPLY_ENABLED': 'true'})
                mounts.append(bind(UPDATER, '/run/servus-updater'))
            service['depends_on'] = {'agent': {'condition': 'service_healthy'}}
            service['healthcheck'] = {'test': ['CMD', 'node', '-e', "fetch('http://127.0.0.1:4180/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"], 'timeout': '5s', 'interval': '10s', 'retries': 12, 'start_period': '20s'}
            service['ports'] = [{'mode': 'ingress', 'host_ip': '0.0.0.0', 'target': 4180, 'published': '4180', 'protocol': 'tcp'}]
        elif role == 'worker': service['depends_on'] = {'agent': {'condition': 'service_healthy'}, 'api': {'condition': 'service_healthy'}}
        else:
            mounts.append(bind('/var/run/docker.sock', '/var/run/docker.sock', False))
            service['group_add'] = ['998']
            service['healthcheck'] = {'test': ['CMD', 'node', '--input-type=module', '-e', "import {runtimeStatus} from './dist/agent/client.js'; runtimeStatus().then(s=>process.exit(s.online?0:1)).catch(()=>process.exit(1))"], 'timeout': '10s', 'interval': '5s', 'retries': 24, 'start_period': '10s'}
        document['services'][role] = service
    return environment, document


class UpdateSocketComposeTest(unittest.TestCase):
    def check(self, env, document):
        with tempfile.TemporaryDirectory() as path:
            root = Path(path)
            (root / 'env').write_text(''.join(f'{key}={value}\n' for key, value in env.items()))
            image = ['PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'NODE_VERSION=24.1.0', 'YARN_VERSION=1.22.0', 'NODE_ENV=production', 'PANEL_DATA_DIR=/var/lib/panel', 'PANEL_HOST=0.0.0.0', 'PANEL_PORT=4180']
            (root / 'image.json').write_text(json.dumps(image))
            return subprocess.run([sys.executable, '-I', str(VALIDATOR), GATE, IMAGE, DATA, str(root / 'env'), str(root / 'image.json'), CONTROL, SECRETS, str(root / 'canonical')], input=json.dumps(document), text=True, capture_output=True)

    def test_disabled_and_enabled_configuration_are_valid(self):
        for enabled in (False, True):
            with self.subTest(enabled=enabled):
                self.assertEqual(self.check(*fixture(enabled)).returncode, 0)

    def test_older_compose_omits_false_bind_option(self):
        env, document = fixture(True)
        for service in document['services'].values():
            for mount in service['volumes']:
                if mount.get('bind', {}).get('create_host_path') is False:
                    mount['bind'] = {}
        self.assertEqual(self.check(env, document).returncode, 0)

    def test_socket_mount_and_access_must_be_exact(self):
        env, document = fixture(True)
        variants = []
        for role, change in [('api', lambda service: service['volumes'][-1].update(read_only=False)),
                             ('api', lambda service: service['volumes'][-1].update(source='/etc')),
                             ('api', lambda service: service['volumes'][-1].update(bind={'create_host_path': True})),
                             ('api', lambda service: service['environment'].update(PANEL_UPDATER_SOCKET='/tmp/fake')),
                             ('api', lambda service: service['environment'].update(PANEL_UPDATER_APPLY_ENABLED='false')),
                             ('worker', lambda service: service['volumes'].append(copy.deepcopy(document['services']['api']['volumes'][-1]))),
                             ('agent', lambda service: service['environment'].update(PANEL_UPDATER_SOCKET='/run/servus-updater/updater.sock'))]:
            item = copy.deepcopy(document); change(item['services'][role]); variants.append(item)
        for item in variants:
            self.assertNotEqual(self.check(env, item).returncode, 0)
        bad_env = dict(env, SERVUS_UPDATER_SOCKET_DIR='/etc')
        self.assertNotEqual(self.check(bad_env, document).returncode, 0)
        without_config = dict(env); del without_config['SERVUS_UPDATER_SOCKET_DIR']
        self.assertNotEqual(self.check(without_config, document).returncode, 0)


if __name__ == '__main__': unittest.main()
