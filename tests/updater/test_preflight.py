import copy
import importlib.util
import pathlib
import sys
import unittest

MODULE = pathlib.Path(__file__).resolve().parents[2] / 'apps/updater/preflight.py'
spec = importlib.util.spec_from_file_location('servus_preflight', MODULE)
pf = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = pf
spec.loader.exec_module(pf)


class PreflightFixtures(unittest.TestCase):
    def setUp(self):
        self.ref = 'ghcr.io/raxon/servus@sha256:' + 'a' * 64
        self.image_id = 'sha256:' + 'b' * 64
        data = pf.ExpectedMount('bind', '/var/lib/servus', '/var/lib/servus', True)
        docker = pf.ExpectedMount('bind', '/var/run/docker.sock', '/var/run/docker.sock', True)
        common_env = {'PATH': '/usr/local/bin:/usr/bin', 'PANEL_DATA_DIR': '/var/lib/servus'}
        self.expected = pf.ExpectedState(self.ref, self.image_id, '/var/lib/servus', {
            'api': pf.ExpectedService('1' * 64, (data,), True, common_env),
            'worker': pf.ExpectedService('2' * 64, (data,), False, common_env),
            'agent': pf.ExpectedService('3' * 64, (data, docker), True, common_env),
        })
        self.image = {'Id': self.image_id, 'RepoDigests': [self.ref]}
        self.containers = []
        for index, service in enumerate(('api', 'worker', 'agent'), 1):
            policy = self.expected.services[service]
            state = {'Status': 'running', 'Running': True, 'Paused': False, 'Restarting': False, 'Dead': False}
            if policy.health_required:
                state['Health'] = {'Status': 'healthy'}
            self.containers.append({
                'Id': str(index) * 64,
                'Image': self.image_id,
                'Config': {'Image': self.ref, 'Cmd': ['node', 'dist/' + ('server' if service == 'api' else service) + '/index.js'], 'Entrypoint': ['docker-entrypoint.sh'], 'WorkingDir': '/app', 'User': 'node', 'Env': [key + '=' + value for key, value in policy.environment.items()], 'Labels': {
                    'com.docker.compose.project': 'servus', 'com.docker.compose.service': service,
                    'com.docker.compose.container-number': '1', 'com.docker.compose.oneoff': 'False',
                    'com.docker.compose.config-hash': policy.config_hash,
                }},
                'State': state,
                'Mounts': [{'Type': m.kind, 'Source': m.source, 'Destination': m.destination, 'RW': m.writable} for m in policy.mounts],
            })
        self.jobs = ['succeeded']
        self.operations = ['succeeded']

    def check(self):
        return pf.compare_fixture(self.expected, self.image, self.containers, self.jobs, self.operations)

    def test_matching_fixture_has_no_authorization_result(self):
        self.assertIsNone(self.check())

    def test_image_reference_and_content_identity_are_both_required(self):
        for mutate in (
            lambda: self.image.update(Id='sha256:' + 'c' * 64),
            lambda: self.image.update(RepoDigests=[]),
            lambda: self.containers[0].update(Image='sha256:' + 'c' * 64),
            lambda: self.containers[0]['Config'].update(Image='ghcr.io/raxon/servus:latest'),
        ):
            self.setUp(); mutate()
            with self.assertRaises(pf.InconsistentState): self.check()

    def test_complete_distinct_compose_containers_and_configuration_required(self):
        for mutate in (
            lambda: self.containers.pop(),
            lambda: self.containers.append(copy.deepcopy(self.containers[0])),
            lambda: self.containers[1].update(Id=self.containers[0]['Id']),
            lambda: self.containers[0]['Config']['Labels'].update({'com.docker.compose.project': 'other'}),
            lambda: self.containers[0]['Config']['Labels'].update({'com.docker.compose.service': 'agent'}),
            lambda: self.containers[0]['Config']['Labels'].update({'com.docker.compose.config-hash': '4' * 64}),
            lambda: self.containers[0]['Config']['Labels'].update({'com.docker.compose.oneoff': 'True'}),
            lambda: self.containers[0]['Config']['Labels'].update({'com.docker.compose.container-number': '2'}),
        ):
            self.setUp(); mutate()
            with self.assertRaises(pf.InconsistentState): self.check()

    def test_mounts_must_match_including_write_access_and_all_extras(self):
        for mutate in (
            lambda: self.containers[0]['Mounts'][0].update(Source='/tmp/different'),
            lambda: self.containers[0]['Mounts'][0].update(Destination='/tmp/different'),
            lambda: self.containers[0]['Mounts'][0].update(RW=False),
            lambda: self.containers[2]['Mounts'].pop(),
            lambda: self.containers[0]['Mounts'].append({'Type':'bind','Source':'/tmp','Destination':'/tmp','RW':True}),
            lambda: self.containers[0]['Mounts'].append(copy.deepcopy(self.containers[0]['Mounts'][0])),
        ):
            self.setUp(); mutate()
            with self.assertRaises(pf.InconsistentState): self.check()

    def test_health_and_running_status_are_fail_closed(self):
        for mutate in (
            lambda: self.containers[0]['State'].update(Status='exited', Running=False),
            lambda: self.containers[0]['State'].update(Paused=True),
            lambda: self.containers[0]['State'].update(Restarting=True),
            lambda: self.containers[0]['State']['Health'].update(Status='starting'),
            lambda: self.containers[2]['State'].pop('Health'),
            lambda: self.containers[1]['State'].update(Health={'Status':'unhealthy'}),
        ):
            self.setUp(); mutate()
            with self.assertRaises(pf.InconsistentState): self.check()

    def test_unresolved_and_unknown_journal_states_are_rejected(self):
        for target in ('jobs', 'operations'):
            for status in ('queued', 'running', 'failed', 'uncertain', 'new-version-state', None, {}):
                self.setUp(); getattr(self, target).append(status)
                with self.assertRaises(pf.InconsistentState): self.check()
        self.setUp(); self.jobs = None
        with self.assertRaises(pf.InconsistentState): self.check()

    def test_malformed_objects_and_non_string_labels_fail_closed(self):
        self.containers[0]['Config']['Labels']['com.docker.compose.service'] = []
        with self.assertRaises(pf.InconsistentState): self.check()
        self.setUp(); self.expected = pf.ExpectedState(None, self.image_id, '/var/lib/servus', self.expected.services)
        with self.assertRaises(pf.InconsistentState): self.check()
        self.setUp(); self.containers[0]['Mounts'][0]['RW'] = 1
        with self.assertRaises(pf.InconsistentState): self.check()

    def test_required_mount_policy_cannot_be_weakened_along_with_observation(self):
        for role, observed_index in (('api', 0), ('worker', 1), ('agent', 2)):
            self.setUp()
            policies = dict(self.expected.services)
            original = policies[role]
            policies[role] = pf.ExpectedService(original.config_hash, (), original.health_required, original.environment)
            self.expected = pf.ExpectedState(self.ref, self.image_id, '/var/lib/servus', policies)
            self.containers[observed_index]['Mounts'] = []
            with self.assertRaises(pf.InconsistentState): self.check()
        self.setUp()
        self.containers[0]['Mounts'].append({'Type': 'bind', 'Source': '/var/run/docker.sock', 'Destination': '/var/run/docker.sock', 'RW': True})
        with self.assertRaises(pf.InconsistentState): self.check()

    def test_command_entrypoint_workdir_and_user_must_match(self):
        for key, value in (('Cmd', ['node', '-e', 'process.exit(0)']), ('Entrypoint', ['/bin/sh']), ('WorkingDir', '/tmp'), ('User', 'root')):
            self.setUp(); self.containers[0]['Config'][key] = value
            with self.assertRaises(pf.InconsistentState): self.check()

    def test_complete_environment_and_single_data_directory_are_required(self):
        for mutate in (
            lambda: self.containers[0]['Config']['Env'].append('PANEL_DATA_DIR=/tmp/elsewhere'),
            lambda: self.containers[0]['Config']['Env'].append('NODE_OPTIONS=--require=/tmp/unknown'),
            lambda: self.containers[0]['Config']['Env'].remove('PANEL_DATA_DIR=/var/lib/servus'),
            lambda: self.containers[0]['Config']['Env'].append('NO_EQUALS'),
        ):
            self.setUp(); mutate()
            with self.assertRaises(pf.InconsistentState): self.check()
        self.setUp()
        services = dict(self.expected.services)
        old = services['api']
        wrong_env = dict(old.environment, PANEL_DATA_DIR='/tmp/other')
        services['api'] = pf.ExpectedService(old.config_hash, old.mounts, old.health_required, wrong_env)
        self.expected = pf.ExpectedState(self.ref, self.image_id, '/var/lib/servus', services)
        self.containers[0]['Config']['Env'] = [key + '=' + value for key, value in wrong_env.items()]
        with self.assertRaises(pf.InconsistentState): self.check()

    def test_invalid_configured_data_directory_fails_closed(self):
        for path in ('/', '/var/../tmp', '/var//lib/servus', '/var/lib/servus/', '/var/run/docker.sock', '', None):
            self.setUp(); self.expected = pf.ExpectedState(self.ref, self.image_id, path, self.expected.services)
            with self.assertRaises(pf.InconsistentState): self.check()

    def test_failure_does_not_expose_sensitive_input(self):
        marker = 'secret-should-not-be-printed'
        self.containers[0]['Config']['Env'] = ['PASSWORD=' + marker]
        self.containers[0]['Mounts'][0]['Source'] = marker
        with self.assertRaises(pf.InconsistentState) as raised: self.check()
        self.assertNotIn(marker, str(raised.exception))


if __name__ == '__main__':
    unittest.main()
