#!/usr/bin/python3 -I
"""Read real release, migration and workload evidence inside the owned test VM."""
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import sys
import time
import urllib.request

BASE = Path('/root/servus-update-fixture')


def command(*args, input=None):
    result = subprocess.run(args, input=input, capture_output=True, timeout=45, check=True)
    return result.stdout


def health(port):
    deadline = time.monotonic() + 180
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(f'http://127.0.0.1:{port}/api/v1/health', timeout=5) as response:
                value = json.load(response)
            if value.get('status') == 'ok':
                return value
        except (OSError, ValueError):
            pass
        time.sleep(1)
    raise RuntimeError('The installed panel did not become healthy')


def diagnostics():
    result = {'fixture': os.uname().nodename, 'status': 'failed', 'units': {}, 'operations': [], 'transactions': []}
    if os.geteuid() != 0 or not result['fixture'].startswith('colima-servus-update-e2e-'):
        raise RuntimeError('An owned fixture VM is required')
    for name in ('servus-updater-bootstrap', 'servus-updater', 'servus-supervisor', 'servus-host-update'):
        state = command('systemctl', 'show', name + '.service', '--property=ActiveState,SubState,Result').decode()
        result['units'][name] = dict(line.split('=', 1) for line in state.splitlines() if '=' in line)
    path = Path('/var/lib/servus-updater/journal.sqlite')
    if path.is_file():
        with sqlite3.connect(f'file:{path}?mode=ro', uri=True) as journal:
            tables = {row[0] for row in journal.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if 'operations' in tables:
                result['operations'] = journal.execute('SELECT id,tag,status FROM operations').fetchall()
            if 'update_transactions' in tables:
                result['transactions'] = journal.execute('SELECT operation_id,phase FROM update_transactions').fetchall()
    print(json.dumps(result, indent=2), flush=True)


def inspect(stage, version, schema, port):
    if os.geteuid() != 0 or not os.uname().nodename.startswith('colima-servus-update-e2e-'):
        raise RuntimeError('An exclusively owned release fixture VM is required')
    if stage not in ('baseline', 'target', 'reboot') or not re.fullmatch(r'\d+\.\d+\.\d+', version):
        raise RuntimeError('Invalid verification input')
    release = json.loads((BASE / f'release-{version}.json').read_text())
    expected_image = 'ghcr.io/raxon/servus@' + release['digest']
    observed = health(port)
    assert observed['version'] == version and observed['revision'] == release['commit'], 'Wrong installed release'
    values = dict(line.split('=', 1) for line in Path('/etc/servus/servus.env').read_text().splitlines() if '=' in line)
    assert values['SERVUS_IMAGE'] == expected_image, 'Installed digest differs from the frozen manifest'
    data = Path(values['SERVUS_DATA_DIR'])
    with sqlite3.connect(f'file:{data / "panel.sqlite"}?mode=ro', uri=True) as database:
        assert database.execute('PRAGMA user_version').fetchone()[0] == schema, 'Unexpected live schema'
    with sqlite3.connect('file:/var/lib/servus-updater/journal.sqlite?mode=ro', uri=True) as journal:
        rows = journal.execute('SELECT id,status,digest,commit_sha,config_digest FROM operations WHERE tag=?', (release['tag'],)).fetchall()
        assert len(rows) == 1 and rows[0][1:4] == ('verified', release['digest'], release['commit']), 'Release was not verified by the real updater'
        assert re.fullmatch(r'sha256:[a-f0-9]{64}', rows[0][4]), 'Missing authenticated image configuration'
        operation = rows[0][0]
        transaction = journal.execute('SELECT phase,backup_path,backup_manifest_digest FROM update_transactions WHERE operation_id=?', (operation,)).fetchone()
    role_ids = {}
    for role in ('api', 'worker', 'agent'):
        ids = command('docker', 'ps', '-q', '--no-trunc', '--filter', 'label=com.docker.compose.project=servus', '--filter', f'label=com.docker.compose.service={role}').decode().splitlines()
        assert len(ids) == 1, f'Missing or duplicate installed {role}'
        inventory = json.loads(command('docker', 'inspect', ids[0]))[0]
        assert inventory['Config']['Image'] == expected_image, f'{role} is running a different image'
        role_ids[role] = ids[0]
    for unit in ('servus-updater.service', 'servus-supervisor.service', 'servus-host-update.timer'):
        command('systemctl', 'is-active', '--quiet', unit)
    key_digest = hashlib.sha256((data / 'secret-key').read_bytes()).hexdigest()
    result_path = BASE / 'result.json'
    report = json.loads(result_path.read_text()) if result_path.exists() else {
        'status': 'in_progress', 'fixture': os.uname().nodename, 'checks': [],
        'scope': {'initialInstaller': 'frozen baseline with fixture-only source bootstrap and tag selector',
                  'signatureVerification': 'unmodified production verifier and bootstrap',
                  'failureRecovery': 'not_exercised'},
    }
    report[stage] = {'version': version, 'commit': release['commit'], 'digest': release['digest'],
                     'configDigest': rows[0][4], 'operationId': operation, 'schema': schema,
                     'keySha256': key_digest, 'controlPlaneIds': role_ids}
    report['checks'].append(stage + '-real-signed-image-health-schema-and-root-journal')
    if stage != 'baseline':
        assert report['baseline']['keySha256'] == key_digest, 'Installation key changed'
        assert transaction is not None and transaction[0] == 'completed', 'Update transaction did not complete'
        snapshot = Path(transaction[1])
        manifest = (snapshot / 'manifest.json').read_bytes()
        assert 'sha256:' + hashlib.sha256(manifest).hexdigest() == transaction[2], 'Snapshot manifest changed'
        inventory = json.loads(manifest)
        for name, expected in inventory['files'].items():
            assert name in ('panel.sqlite', 'agent.sqlite', 'secret-key', 'agent-token') or re.fullmatch(r'(?:secrets|database-roots)/[a-f0-9-]{36}', name), 'Unsafe snapshot file'
            assert hashlib.sha256((snapshot / name).read_bytes()).hexdigest() == expected, 'Captured snapshot file changed'
        with sqlite3.connect(f'file:{snapshot / "panel.sqlite"}?mode=ro&immutable=1', uri=True) as database:
            assert database.execute('PRAGMA user_version').fetchone()[0] == report['baseline']['schema'], 'Snapshot was migrated'
        proof = json.loads((BASE / 'proof.json').read_text())
        service_id = proof['serviceId']
        assert re.fullmatch(r'[a-f0-9-]{36}', service_id), 'Invalid application identity'
        tasks = command('docker', 'ps', '-q', '--no-trunc', '--filter', f'label=com.docker.swarm.service.name=panel-app-{service_id}').decode().splitlines()
        assert len(tasks) == 1, 'Application did not recover its running task'
        if stage == 'target':
            assert tasks[0] == proof['containerId'], 'Control-plane update restarted the application'
        content = command('docker', 'exec', tasks[0], 'cat', '/usr/share/nginx/html/update-proof')
        assert hashlib.sha256(content).hexdigest() == proof['markerSha256'], 'Application volume content changed'
        secret_check = """import Database from '/app/node_modules/better-sqlite3/lib/index.js';
import {SecretVault} from '/app/dist/shared/secrets.js';
import {createHash} from 'node:crypto';
const [service,expected]=process.argv.slice(1),root=process.env.PANEL_DATA_DIR;
const db=new Database(root+'/panel.sqlite',{readonly:true}),vault=new SecretVault(root);
const rows=db.prepare('SELECT reference FROM service_secret_refs WHERE service_id=? AND purpose=?').all(service,'environment');
if(!rows.some(row=>createHash('sha256').update(vault.getServiceSecret(row.reference,service,'environment')).digest('hex')===expected))process.exit(2);
db.close();console.log('SECRET_DECRYPTION_OK');"""
        assert command('docker', 'exec', role_ids['api'], 'node', '--input-type=module', '-e', secret_check, service_id, proof['secretSha256']).strip() == b'SECRET_DECRYPTION_OK'
        hostname = proof['hostname']
        assert re.fullmatch(r'update-terminal-[a-f0-9]{8}\.localhost', hostname), 'Unexpected fixture hostname'
        request = urllib.request.Request('http://127.0.0.1:18080/update-proof', headers={'Host': hostname})
        with urllib.request.urlopen(request, timeout=10) as response:
            assert hashlib.sha256(response.read(65537)).hexdigest() == proof['markerSha256'], 'Application ingress returned different data'
        report[stage].update(snapshotManifestDigest=transaction[2], snapshotSchema=report['baseline']['schema'])
        report['checks'].extend([stage + '-snapshot-preserved-at-baseline-schema', stage + '-workload-data-ingress-and-secret-decryption'])
        if stage == 'reboot':
            report['signedUpdateStatus'] = 'passed'
            report['status'] = 'passed' if report.get('security', {}).get('status') == 'passed' else 'partial'
    result_path.write_text(json.dumps(report, indent=2) + '\n')
    result_path.chmod(0o600)
    print(f'PASS {stage}: signed {version}, schema {schema}, installed roles and applicable data proofs', flush=True)


if __name__ == '__main__':
    if sys.argv[1:] == ['diagnostics']:
        diagnostics()
    else:
        inspect(sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4]))
