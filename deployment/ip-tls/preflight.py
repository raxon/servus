#!/usr/bin/env python3
"""Read-only checks for a proposed IP certificate deployment."""
import argparse
import ipaddress
import json
import subprocess
import sys


def command(*args):
    try:
        result = subprocess.run(args, capture_output=True, text=True, timeout=10, check=False)
        return result.stdout if result.returncode == 0 else None
    except (OSError, subprocess.TimeoutExpired):
        return None


def parse_json(value):
    try:
        return json.loads(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def inspect_state(run=command):
    findings = []

    def add(name, state, detail):
        findings.append({'check': name, 'state': state, 'detail': detail})

    add('certbot', 'unknown', 'Verify the pinned Certbot image is available and supports IP webroot issuance.')

    info = parse_json(run('docker', 'info', '--format', '{{json .Swarm}}'))
    manager = isinstance(info, dict) and info.get('LocalNodeState') == 'active' and info.get('ControlAvailable') is True
    add('swarm', 'pass' if manager else 'fail', 'A reachable Docker Swarm manager is required.')

    service = parse_json(run('docker', 'service', 'inspect', 'panel-ingress'))
    service = service[0] if isinstance(service, list) and len(service) == 1 and isinstance(service[0], dict) else {}
    spec = service.get('Spec') or {}
    task = spec.get('TaskTemplate') or {}
    container = task.get('ContainerSpec') or {}
    ports = (spec.get('EndpointSpec') or {}).get('Ports') or []
    valid_port = any(p.get('Protocol', 'tcp') == 'tcp' and p.get('PublishedPort') == 80 and p.get('TargetPort') == 8080 and p.get('PublishMode') == 'host' for p in ports if isinstance(p, dict))
    args = container.get('Args') or []
    valid_ingress = (spec.get('Labels') or {}).get('panel.owner') == 'self-hosted-panel' and valid_port and '--entrypoints.web.address=:8080' in args and '--providers.swarm.exposedbydefault=false' in args
    add('ingress', 'pass' if valid_ingress else 'fail', 'Expected Servus ingress ownership and port mapping must be present.')

    network = parse_json(run('docker', 'network', 'inspect', 'panel-ingress'))
    network = network[0] if isinstance(network, list) and len(network) == 1 and isinstance(network[0], dict) else {}
    valid_network = network.get('Driver') == 'overlay' and (network.get('Labels') or {}).get('panel.owner') == 'self-hosted-panel'
    add('network', 'pass' if valid_network else 'fail', 'Expected Servus overlay network must be present.')

    listeners = run('ss', '-H', '-ltn', 'sport', '=', ':443')
    add('port_443', 'unknown' if listeners is None else ('fail' if listeners.strip() else 'pass'), 'Check port 443 listeners and Docker published ports before selecting a proxy.')
    # Docker publishes can be implemented through NAT without an ss listener.
    add('published_ports', 'unknown', 'Inspect Docker container and Swarm published ports; a listener check alone is insufficient.')
    add('public_reachability', 'unknown', 'Verify IPv4 port 80 and 443 externally and inspect cloud firewall, UFW, Docker and IPv6 rules.')
    add('challenge_route', 'unknown', 'Verify the exact IP host and ACME path route against existing Traefik routers without disrupting them.')
    add('panel_security', 'unknown', 'Verify localhost-only panel bind, initialized administrator, exact HTTPS origin and Secure cookies.')
    add('renewal', 'unknown', 'Verify a scheduler, deploy hook, reload, expiry alert and a staging renewal end to end.')
    return findings


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--ip', required=True, help='Public IPv4 address to assess')
    args = parser.parse_args()
    try:
        address = ipaddress.ip_address(args.ip)
        if address.version != 4 or not address.is_global:
            raise ValueError()
    except ValueError:
        parser.error('A public IPv4 address is required')
    result = {'ip': str(address), 'ready_to_deploy': False, 'checks': inspect_state()}
    print(json.dumps(result, indent=2))
    return 1


if __name__ == '__main__':
    sys.exit(main())
