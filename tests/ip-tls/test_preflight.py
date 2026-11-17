import importlib.util
import json
import pathlib
import unittest

PATH = pathlib.Path(__file__).resolve().parents[2] / 'deployment/ip-tls/preflight.py'
spec = importlib.util.spec_from_file_location('ip_tls_preflight', PATH)
preflight = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preflight)


class PreflightTests(unittest.TestCase):
    def test_expected_configuration_still_requires_manual_checks(self):
        service = {'Spec': {'Labels': {'panel.owner': 'self-hosted-panel'}, 'TaskTemplate': {'ContainerSpec': {'Args': ['--entrypoints.web.address=:8080', '--providers.swarm.exposedbydefault=false']}}, 'EndpointSpec': {'Ports': [{'PublishedPort': 80, 'TargetPort': 8080, 'Protocol': 'tcp', 'PublishMode': 'host'}]}}}
        responses = {
            ('certbot', '--version'): 'certbot 5.4.0',
            ('docker', 'info', '--format', '{{json .Swarm}}'): json.dumps({'LocalNodeState': 'active', 'ControlAvailable': True}),
            ('docker', 'service', 'inspect', 'panel-ingress'): json.dumps([service]),
            ('docker', 'network', 'inspect', 'panel-ingress'): json.dumps([{'Driver': 'overlay', 'Labels': {'panel.owner': 'self-hosted-panel'}}]),
            ('ss', '-H', '-ltn', 'sport', '=', ':443'): '',
        }
        checks = {check['check']: check['state'] for check in preflight.inspect_state(lambda *args: responses.get(args))}
        for key in ('swarm', 'ingress', 'network', 'port_443'):
            self.assertEqual(checks[key], 'pass')
        for key in ('certbot', 'published_ports', 'public_reachability', 'challenge_route', 'panel_security', 'renewal'):
            self.assertEqual(checks[key], 'unknown')

    def test_missing_tools_fail_closed(self):
        checks = {check['check']: check['state'] for check in preflight.inspect_state(lambda *args: None)}
        self.assertEqual(checks['certbot'], 'unknown')
        self.assertEqual(checks['ingress'], 'fail')
        self.assertEqual(checks['port_443'], 'unknown')

    def test_old_certbot_and_occupied_port(self):
        def run(*args):
            if args[0] == 'certbot': return 'certbot 5.3.9'
            if args[0] == 'ss': return 'LISTEN 0 128 0.0.0.0:443 0.0.0.0:*'
            return None
        checks = {check['check']: check['state'] for check in preflight.inspect_state(run)}
        self.assertEqual(checks['certbot'], 'unknown')
        self.assertEqual(checks['port_443'], 'fail')


if __name__ == '__main__':
    unittest.main()
