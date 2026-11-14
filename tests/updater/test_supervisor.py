import copy
import importlib.util
import json
import os
from pathlib import Path
import socket
import stat
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import uuid
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('servus_supervisor', ROOT / 'apps/updater/supervisor.py')
supervisor = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(supervisor)
CID = 'a' * 64
IDENTITIES = {role: {'id': CID, 'pid': 123, 'cgroup': '/docker/' + CID} for role in supervisor.ROLES}
TOKENS = {'api': '1' * 64, 'worker': '2' * 64, 'agent': '3' * 64}
HOST_CONFIG = {'Privileged': False, 'PidMode': '', 'IpcMode': 'private', 'NetworkMode': 'servus_default', 'UTSMode': '', 'UsernsMode': '', 'CapAdd': None, 'CapDrop': None, 'SecurityOpt': None, 'Devices': [], 'DeviceRequests': None, 'PortBindings': {}, 'PublishAllPorts': False, 'RestartPolicy': {'Name': 'unless-stopped', 'MaximumRetryCount': 0}, 'ReadonlyRootfs': False, 'Init': True, 'Runtime': 'runc', 'Sysctls': None}
HEALTHCHECK = {'Test': ['CMD', 'node', '-e', 'process.exit(0)'], 'Interval': 10000000000}
if os.environ.get('SERVUS_COMPOSE_INSPECT_FILE'):
    compose_record = json.loads(Path(os.environ['SERVUS_COMPOSE_INSPECT_FILE']).read_text())[0]
    HOST_CONFIG = compose_record['HostConfig']
    HEALTHCHECK = compose_record['Config']['Healthcheck']
HOST_CONFIGS = {role: copy.deepcopy(HOST_CONFIG) for role in supervisor.ROLES}
HOST_CONFIGS['api']['PortBindings'] = {'4180/tcp': [{'HostIp': '0.0.0.0', 'HostPort': '4180'}]}
POLICY = supervisor.RuntimePolicy(
    image_reference='ghcr.io/raxon/servus@sha256:' + 'a' * 64,
    image_id='sha256:' + 'b' * 64,
    install_dir='/opt/servus', data_dir='/var/lib/servus', gate_dir='/etc/servus/lifecycle', control_dir='/run/servus-supervisor',
    secret_sources={role: '/etc/servus/secrets/' + role for role in supervisor.ROLES},
    config_hashes={role: 'c' * 64 for role in supervisor.ROLES},
    environments={role: {'PANEL_DATA_DIR': '/var/lib/servus'} for role in supervisor.ROLES},
    host_configs=HOST_CONFIGS,
    healthchecks={role: HEALTHCHECK for role in supervisor.ROLES},
) if sys.platform == 'linux' else None


@unittest.skipUnless(sys.platform == 'linux', 'Requires Linux path semantics')
class RuntimePolicyImmutabilityTest(unittest.TestCase):
    def test_data_directory_rejects_critical_paths_and_allows_custom_paths(self):
        def create(path):
            return supervisor.RuntimePolicy(
                image_reference=POLICY.image_reference, image_id=POLICY.image_id, install_dir=POLICY.install_dir,
                data_dir=path, gate_dir=POLICY.gate_dir, control_dir=POLICY.control_dir,
                secret_sources={role: '/etc/servus/secrets/' + role for role in supervisor.ROLES},
                config_hashes={role: 'c' * 64 for role in supervisor.ROLES},
                environments={role: {'PANEL_DATA_DIR': path} for role in supervisor.ROLES},
                host_configs=copy.deepcopy(HOST_CONFIGS),
                healthchecks={role: copy.deepcopy(HEALTHCHECK) for role in supervisor.ROLES},
            )
        for path in ('/app', '/usr', '/run', '/home/node', '/home/node/.local', '/lib64', '/sbin', '/var/run', '/tmp', '/var/lib', '/opt/servus'):
            with self.subTest(path=path), self.assertRaises(supervisor.SupervisorError):
                create(path)
        with mock.patch.object(supervisor.os.path, 'realpath', side_effect=lambda path: path):
            create('/var/lib/servus')
            create('/var/lib/servus/instance-a')
            create('/srv/custom-data')
            create('/mnt/volume/custom-data')
            create('/data')
            create('/opt/servus-data')
        with mock.patch.object(supervisor.os.path, 'realpath', return_value='/run'):
            with self.assertRaises(supervisor.SupervisorError):
                create('/var/lib/servus/link')

    def test_unsafe_expected_host_configuration_is_rejected(self):
        def create(hosts):
            return supervisor.RuntimePolicy(
                image_reference=POLICY.image_reference, image_id=POLICY.image_id, install_dir=POLICY.install_dir,
                data_dir=POLICY.data_dir, gate_dir=POLICY.gate_dir, control_dir=POLICY.control_dir,
                secret_sources={role: '/etc/servus/secrets/' + role for role in supervisor.ROLES},
                config_hashes={role: 'c' * 64 for role in supervisor.ROLES},
                environments={role: {'PANEL_DATA_DIR': '/var/lib/servus'} for role in supervisor.ROLES},
                host_configs=hosts, healthchecks={role: copy.deepcopy(HEALTHCHECK) for role in supervisor.ROLES},
            )
        create(copy.deepcopy(HOST_CONFIGS))
        for role, key, value in (
            ('api', 'Privileged', True), ('api', 'PidMode', 'host'),
            ('api', 'UsernsMode', 'host'), ('api', 'NetworkMode', 'host'),
            ('api', 'IpcMode', 'host'), ('api', 'UTSMode', 'host'),
            ('api', 'CapAdd', ['SYS_ADMIN']), ('api', 'SecurityOpt', ['seccomp=unconfined']),
            ('api', 'Devices', [{'PathOnHost': '/dev/sda'}]), ('api', 'PublishAllPorts', True),
            ('api', 'ReadonlyRootfs', True), ('api', 'Init', False), ('api', 'Runtime', 'other'),
            ('api', 'CapDrop', ['ALL']), ('worker', 'PortBindings', {'22/tcp': [{'HostIp': '0.0.0.0', 'HostPort': '22'}]}),
            ('agent', 'PortBindings', {'4180/tcp': [{'HostIp': '', 'HostPort': '4180'}]}),
            ('api', 'PortBindings', {'22/tcp': [{'HostIp': '', 'HostPort': '22'}]}),
        ):
            hosts = copy.deepcopy(HOST_CONFIGS)
            hosts[role][key] = value
            with self.subTest(role=role, field=key), self.assertRaises(supervisor.SupervisorError):
                create(hosts)

    def test_input_and_nested_policy_values_cannot_mutate_validated_policy(self):
        secrets = {role: '/etc/servus/secrets/' + role for role in supervisor.ROLES}
        hashes = {role: 'c' * 64 for role in supervisor.ROLES}
        environments = {role: {'PANEL_DATA_DIR': '/var/lib/servus'} for role in supervisor.ROLES}
        hosts = copy.deepcopy(HOST_CONFIGS)
        health = {role: copy.deepcopy(HEALTHCHECK) for role in supervisor.ROLES}
        policy = supervisor.RuntimePolicy(
            image_reference=POLICY.image_reference, image_id=POLICY.image_id, install_dir=POLICY.install_dir,
            data_dir=POLICY.data_dir, gate_dir=POLICY.gate_dir, control_dir=POLICY.control_dir,
            secret_sources=secrets, config_hashes=hashes, environments=environments,
            host_configs=hosts, healthchecks=health,
        )
        old_snapshot = policy._runtime_snapshots['api']
        secrets['api'] = '/tmp/attacker'; hashes['api'] = 'd' * 64
        environments['api']['NODE_OPTIONS'] = '--require=/tmp/attacker'
        hosts['api']['Privileged'] = True
        health['api']['Test'][0] = 'evil'
        self.assertEqual(policy.secret_sources['api'], '/etc/servus/secrets/api')
        self.assertEqual(policy.config_hashes['api'], 'c' * 64)
        self.assertNotIn('NODE_OPTIONS', policy.environments['api'])
        self.assertFalse(policy.host_configs['api']['Privileged'])
        self.assertEqual(policy.healthchecks['api']['Test'][0], 'CMD')
        self.assertEqual(policy._runtime_snapshots['api'], old_snapshot)
        for mutate in (
            lambda: policy.environments['api'].__setitem__('NODE_OPTIONS', 'evil'),
            lambda: policy.secret_sources.__setitem__('api', '/tmp/attacker'),
            lambda: policy.config_hashes.__setitem__('api', 'd' * 64),
            lambda: policy.host_configs['api']['RestartPolicy'].__setitem__('Name', 'always'),
            lambda: policy.healthchecks['api']['Test'].__setitem__(0, 'evil'),
            lambda: policy._runtime_snapshots.__setitem__('api', ('evil', 'evil')),
            lambda: setattr(policy, 'data_dir', '/tmp/attacker'),
        ):
            with self.assertRaises((AttributeError, TypeError)):
                mutate()


@unittest.skipUnless(sys.platform == 'linux' and os.geteuid() == 0, 'Requires isolated Linux root')
class SupervisorTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='servus-supervisor-', dir='/root')
        self.root = Path(self.temp.name)
        self.install, self.gate, self.journal = (self.root / part for part in ('install', 'gate', 'journal'))
        self.install.mkdir(mode=0o700)
        self.gate.mkdir(mode=0o755)
        self.journal.mkdir(mode=0o700)
        (self.install / 'install.lock').touch(mode=0o600)
        (self.gate / 'lock').touch(mode=0o644)
        (self.gate / 'state').write_bytes(b'servus-lifecycle-v1 normal\n')
        os.chmod(self.gate / 'state', 0o644)

    def tearDown(self):
        self.temp.cleanup()

    def test_real_data_directory_ownership_chain(self):
        with tempfile.TemporaryDirectory(prefix='servus-test-', dir='/opt') as root:
            parent = Path(root) / 'owned'
            data = parent / 'data'
            parent.mkdir(mode=0o755)
            data.mkdir(mode=0o700)
            os.chown(data, 1000, 1000)
            supervisor._verify_data_directory(str(data))
            os.chmod(parent, 0o777)
            with self.assertRaises(supervisor.SupervisorError):
                supervisor._verify_data_directory(str(data))
            os.chmod(parent, 0o755)
            os.chown(parent, 1000, 1000)
            with self.assertRaises(supervisor.SupervisorError):
                supervisor._verify_data_directory(str(data))
            os.chown(parent, 0, 0)
            os.chown(data, 0, 0)
            with self.assertRaises(supervisor.SupervisorError):
                supervisor._verify_data_directory(str(data))
            os.chown(data, 1000, 1000)
            link = parent / 'alias'
            link.symlink_to(data, target_is_directory=True)
            with self.assertRaises(supervisor.SupervisorError):
                supervisor._verify_data_directory(str(link))

    def test_failed_drain_persists_intent_and_does_not_stop(self):
        hub = mock.create_autospec(supervisor.DrainHub, instance=True)
        hub.drain.side_effect = supervisor.SupervisorError('Unavailable')
        operation = str(uuid.uuid4())
        with supervisor.MaintenanceSupervisor(self.install, self.gate, self.journal) as coordinator:
            with mock.patch.object(supervisor, '_docker') as docker:
                with self.assertRaises(supervisor.SupervisorError):
                    coordinator.stop_after_drain(hub, operation)
                docker.assert_not_called()
            self.assertEqual((self.gate / 'state').read_bytes(), b'servus-lifecycle-v1 maintenance\n')
            self.assertEqual(json.loads((self.journal / 'maintenance.json').read_bytes())['state'], 'recovery_required')
            with self.assertRaises(supervisor.SupervisorError):
                coordinator.stop_after_drain(hub, str(uuid.uuid4()))

    def test_stops_only_authenticated_ids_and_never_reports_snapshot(self):
        ids = {role: {'id': char * 64, 'pid': 123, 'cgroup': '/docker/' + char * 64} for role, char in zip(supervisor.ROLES, 'abc')}
        hub = mock.create_autospec(supervisor.DrainHub, instance=True)
        hub.identities = ids
        hub.policy = POLICY
        stopped = []
        def docker(*args, **_kwargs):
            if args[0] == 'stop':
                stopped.append(args[-1])
                return b''
            if args[0] == 'inspect':
                return json.dumps([{'Id': args[1], 'State': {'Running': False}}]).encode()
            raise AssertionError('Unexpected Docker command')
        with supervisor.MaintenanceSupervisor(self.install, self.gate, self.journal) as coordinator:
            with mock.patch.object(supervisor, '_docker', side_effect=docker), mock.patch.object(supervisor, 'inspect_servus', return_value=ids):
                self.assertEqual(coordinator.stop_after_drain(hub, str(uuid.uuid4())), 'stopped_unverified')
        self.assertEqual(stopped, [ids[role]['id'] for role in supervisor.ROLES])
        self.assertEqual(json.loads((self.journal / 'maintenance.json').read_bytes())['state'], 'stopped_unverified')

    def test_install_lock_and_symlink_are_rejected(self):
        with supervisor.MaintenanceSupervisor(self.install, self.gate, self.journal):
            with self.assertRaises((OSError, supervisor.SupervisorError)):
                supervisor.MaintenanceSupervisor(self.install, self.gate, self.journal)
        (self.gate / 'lock').unlink()
        (self.gate / 'lock').symlink_to(self.install / 'install.lock')
        with self.assertRaises((OSError, supervisor.SupervisorError)):
            supervisor.MaintenanceSupervisor(self.install, self.gate, self.journal)

    def test_host_socket_and_credentials_are_root_owned_and_never_adopt_existing_socket(self):
        directory = self.root / 'control'
        directory.mkdir(mode=0o750); os.chown(directory, 0, 1000)
        secrets = self.root / 'secrets'
        secrets.mkdir(mode=0o700)
        for role, value in TOKENS.items():
            token = secrets / role
            token.write_text(value + '\n', encoding='ascii'); os.chown(token, 0, 1000); os.chmod(token, 0o640)
        with supervisor.MaintenanceSupervisor(self.install, self.gate, self.journal) as coordinator:
            self.assertEqual(coordinator.read_component_tokens(secrets, 1000), TOKENS)
            listener = coordinator.listen(directory, 1000)
            self.assertEqual(stat.S_IMODE((directory / 'socket').stat().st_mode), 0o660)
            self.assertEqual((directory / 'socket').stat().st_gid, 1000)
            client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            try:
                client.connect(str(directory / 'socket'))
                accepted, _ = listener.accept(); accepted.close()
            finally:
                client.close()
            with self.assertRaises(supervisor.SupervisorError): coordinator.listen(directory, 1000)
        self.assertFalse((directory / 'socket').exists())
        (directory / 'socket').write_text('owned by someone else')
        with supervisor.MaintenanceSupervisor(self.install, self.gate, self.journal) as coordinator:
            with self.assertRaises(supervisor.SupervisorError): coordinator.listen(directory, 1000)
        self.assertEqual((directory / 'socket').read_text(), 'owned by someone else')

    def test_runtime_policy_rejects_image_entrypoint_mount_and_environment_drift(self):
        records = []
        for role, char in zip(supervisor.ROLES, 'abc'):
            cid = char * 64
            records.append({
                'Id': cid, 'Image': POLICY.image_id, 'State': {'Pid': 123, 'Running': True}, 'HostConfig': copy.deepcopy(HOST_CONFIGS[role]),
                'Config': {'Image': POLICY.image_reference, 'User': 'node', 'WorkingDir': '/app', 'Healthcheck': dict(HEALTHCHECK),
                           'Entrypoint': ['/bin/sh', '/app/lifecycle-gate.sh'],
                           'Cmd': ['dist/' + ('server' if role == 'api' else role) + '/index.js'],
                           'Env': ['PANEL_DATA_DIR=/var/lib/servus'],
                           'Labels': {'com.docker.compose.project': 'servus', 'com.docker.compose.service': role,
                                      'com.docker.compose.container-number': '1', 'com.docker.compose.oneoff': 'False',
                                      'com.docker.compose.config-hash': POLICY.config_hashes[role]}},
                'Mounts': [{'Type': kind, 'Source': source, 'Destination': dest, 'RW': rw}
                           for kind, source, dest, rw in POLICY.mounts_for(role)],
            })
        def inspect(items):
            ids = ('\n'.join(item['Id'] for item in items) + '\n').encode()
            with mock.patch.object(supervisor, '_docker', side_effect=[ids, json.dumps(items).encode()]), mock.patch.object(supervisor, '_verify_data_directory'), mock.patch.object(supervisor, '_cgroup', side_effect=['/docker/' + item['Id'] for item in items]):
                return supervisor.inspect_servus(POLICY)
        self.assertEqual(set(inspect(records)), set(supervisor.ROLES))
        for mutation in (
            lambda x: x[0]['Config'].__setitem__('Entrypoint', ['node']),
            lambda x: x[0]['Config']['Healthcheck'].__setitem__('Test', ['CMD', 'evil']),
            lambda x: x[0]['HostConfig'].__setitem__('Privileged', True),
            lambda x: x[0]['HostConfig'].__setitem__('PidMode', 'host'),
            lambda x: x[0]['HostConfig'].__setitem__('PortBindings', {'22/tcp': [{'HostIp': '0.0.0.0', 'HostPort': '22'}]}),
            lambda x: x[0]['HostConfig'].__setitem__('RestartPolicy', {'Name': 'always'}),
            lambda x: x[0]['HostConfig'].__setitem__('NetworkMode', 'host'),
            lambda x: x[0]['HostConfig'].__setitem__('SecurityOpt', ['seccomp=unconfined']),
            lambda x: x[0]['HostConfig'].__setitem__('CapAdd', ['SYS_ADMIN']),
            lambda x: x[0]['HostConfig'].pop('Privileged'),
            lambda x: x[0].__setitem__('Image', 'sha256:' + 'd' * 64),
            lambda x: x[0]['Mounts'].append({'Type':'bind','Source':'/tmp/other','Destination':'/app','RW':False}),
            lambda x: x[0]['Config']['Env'].append('NODE_OPTIONS=--require=/tmp/x'),
            lambda x: x[0]['Config']['Env'].append('PANEL_DATA_DIR=/var/lib/servus'),
            lambda x: x[1]['Mounts'][0].__setitem__('RW', not x[1]['Mounts'][0]['RW']),
        ):
            changed = copy.deepcopy(records); mutation(changed)
            with self.assertRaises(supervisor.SupervisorError): inspect(changed)

    def test_oom_default_normalization_preserves_enabled_and_other_settings(self):
        base = {'OomKillDisable': False, 'Privileged': False}
        self.assertEqual(supervisor._normalize_host_config(base), supervisor._normalize_host_config({'OomKillDisable': None, 'Privileged': False}))
        self.assertNotEqual(supervisor._normalize_host_config(base), supervisor._normalize_host_config({'OomKillDisable': True, 'Privileged': False}))
        self.assertNotEqual(supervisor._normalize_host_config(base), supervisor._normalize_host_config({'OomKillDisable': None, 'Privileged': True}))
        self.assertNotEqual(supervisor._normalize_host_config(base), supervisor._normalize_host_config({'Privileged': False}))

    def test_bind_order_is_unordered_but_sources_options_and_targets_are_checked(self):
        first = '/one:/target-one:rw'
        second = '/two:/target-two:ro'
        expected = supervisor._normalize_host_config({'Binds': [first, second]})
        self.assertEqual(expected, supervisor._normalize_host_config({'Binds': [second, first]}))
        for changed in ('/other:/target-one:rw', '/one:/target-one:ro', '/one:/elsewhere:rw'):
            with self.subTest(changed=changed):
                self.assertNotEqual(expected, supervisor._normalize_host_config({'Binds': [changed, second]}))
        for invalid in (['/one:/target-one:rw', '/two:/target-one:ro'], ['/one:/target'], ['/one:relative:rw'], [7], 'not-a-list'):
            with self.subTest(invalid=invalid), self.assertRaises(supervisor.SupervisorError):
                supervisor._normalize_host_config({'Binds': invalid})

    def test_crash_after_intent_refuses_automatic_reentry(self):
        program = '''import importlib.util,os,signal,sys,uuid
s=importlib.util.spec_from_file_location('s',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
c=m.MaintenanceSupervisor(*sys.argv[2:]);c._record(str(uuid.uuid4()),'intent',{r:str(uuid.uuid4()) for r in m.ROLES},5000);os.kill(os.getpid(),signal.SIGKILL)
'''
        result = subprocess.run([sys.executable, '-c', program, str(ROOT / 'apps/updater/supervisor.py'), str(self.install), str(self.gate), str(self.journal)])
        self.assertLess(result.returncode, 0)
        with supervisor.MaintenanceSupervisor(self.install, self.gate, self.journal) as coordinator:
            with self.assertRaises(supervisor.SupervisorError):
                coordinator._verify_no_previous_operation()
        self.assertEqual(json.loads((self.journal / 'maintenance.json').read_bytes())['state'], 'intent')

    def test_mutual_authentication_and_single_drain_over_unix_socket(self):
        # The worker in this isolated fixture deliberately runs as UID 1000.
        socket_dir = tempfile.TemporaryDirectory(prefix='servus-control-', dir='/tmp')
        os.chmod(socket_dir.name, 0o755)
        path = Path(socket_dir.name) / 'control.sock'
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        listener.bind(str(path)); os.chmod(path, 0o666); listener.listen(5)
        hub = supervisor.DrainHub(listener, TOKENS, 1000, POLICY, IDENTITIES)
        script = '''import hashlib,hmac,json,os,socket,sys
role,token,path=sys.argv[1:]; s=socket.socket(socket.AF_UNIX);s.connect(path);f=s.makefile('rb');c='a'*64
def send(v):s.sendall(json.dumps(v,separators=(',',':')).encode()+b'\\n')
def mac(kind,a,b):return hmac.new(bytes.fromhex(token),('servus-supervisor-'+kind+'-v1\\0'+role+'\\0'+a+'\\0'+b).encode(),hashlib.sha256).hexdigest()
send({'version':1,'type':'hello','role':role,'challenge':c});a=json.loads(f.readline());assert hmac.compare_digest(a['proof'],mac('server',c,a['challenge']))
send({'version':1,'type':'hello_confirm','proof':mac('client',c,a['challenge'])});assert json.loads(f.readline())['type']=='ready'
r=json.loads(f.readline());send({'version':1,'type':'drain_result','requestId':r['requestId'],'status':'drained'})
'''
        children = []
        try:
            for role in supervisor.ROLES:
                def demote():
                    os.setgroups([]); os.setgid(1000); os.setuid(1000)
                child = subprocess.Popen([sys.executable, '-c', script, role, TOKENS[role], str(path)], preexec_fn=demote, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
                children.append(child)
                with mock.patch.object(supervisor, '_cgroup', return_value='/docker/' + CID):
                    self.assertEqual(hub.accept(), role)
            with mock.patch.object(supervisor, 'inspect_servus', return_value=IDENTITIES):
                ids={role:str(uuid.uuid4()) for role in supervisor.ROLES}
                hub.drain(5000, ids)
                with self.assertRaises(supervisor.SupervisorError): hub.drain(5000, ids)
            for child in children:
                self.assertEqual(child.wait(timeout=5), 0)
        finally:
            hub.close(); listener.close()
            for child in children:
                if child.poll() is None: child.kill(); child.wait()
                if child.stderr: child.stderr.close()
            socket_dir.cleanup()

    @unittest.skipUnless(os.environ.get('SERVUS_CONTROL_BUNDLE'), 'Requires bundled Node supervisor client')
    def test_real_node_client_interoperates_over_unix_socket(self):
        # The cgroup is controlled here; a separate VM test must prove Docker identity.
        runtime = tempfile.TemporaryDirectory(prefix='servus-control-', dir='/run')
        path = Path(runtime.name)
        os.chown(path, 0, 1000); os.chmod(path, 0o750)
        bundle = path / 'control.mjs'
        shutil.copyfile(os.environ['SERVUS_CONTROL_BUNDLE'], bundle)
        os.chown(bundle, 0, 0); os.chmod(bundle, 0o644)
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        listener.bind(str(path / 'control.sock')); os.chown(path / 'control.sock', 0, 1000); os.chmod(path / 'control.sock', 0o660); listener.listen(5)
        hub = supervisor.DrainHub(listener, TOKENS, 1000, POLICY, IDENTITIES)
        children = []
        try:
            for role in supervisor.ROLES:
                secret = path / (role + '.secret')
                secret.write_text(TOKENS[role] + '\n', encoding='ascii')
                os.chown(secret, 0, 1000); os.chmod(secret, 0o640)
                source = '''import {runSupervisorControl} from %s;
const controller=new AbortController();
await runSupervisorControl({role:%s,socketPath:%s,secretPath:%s,signal:controller.signal,
  drain:async()=>{setTimeout(()=>controller.abort(),100);return {status:'drained'};}});
''' % (json.dumps(bundle.as_uri()), json.dumps(role), json.dumps(str(path / 'control.sock')), json.dumps(str(secret)))
                def demote():
                    os.setgroups([]); os.setgid(1000); os.setuid(1000)
                child = subprocess.Popen(['/usr/local/bin/node', '--input-type=module', '-e', source], preexec_fn=demote, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
                children.append(child)
                with mock.patch.object(supervisor, '_cgroup', return_value='/docker/' + CID):
                    self.assertEqual(hub.accept(), role)
            with mock.patch.object(supervisor, 'inspect_servus', return_value=IDENTITIES):
                hub.drain(5000, {role:str(uuid.uuid4()) for role in supervisor.ROLES})
            for child in children:
                self.assertEqual(child.wait(timeout=5), 0)
        finally:
            hub.close(); listener.close()
            for child in children:
                if child.poll() is None: child.kill(); child.wait()
                if child.stderr: child.stderr.close()
            runtime.cleanup()


if __name__ == '__main__':
    unittest.main()
