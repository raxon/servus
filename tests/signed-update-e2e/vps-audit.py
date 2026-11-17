#!/usr/bin/python3 -I
"""Read-only audit of the published update on the explicitly selected test VPS."""
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import urllib.request

VERSION = '0.1.53'
COMMIT = 'b21b37119145e7cf5e0bc38680f3044814adb27c'
DIGEST = 'sha256:bb90ac666b0940f91cfee997896d7d54c9dad2a27aca39c59ae31f6bc241dac6'


def sha(path):
    assert path.is_file() and not path.is_symlink(), 'Expected an unchanged regular file'
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(65536), b''):
            digest.update(chunk)
    return digest.hexdigest()


def docker(*args):
    return subprocess.check_output(['docker', *args], timeout=30)


def audit():
    assert os.geteuid() == 0 and os.uname().nodename == 'ubuntu-s-2vcpu-2gb-fra1', 'Wrong audit host'
    network = json.loads(subprocess.check_output(['ip', '-j', 'address']))
    assert any(a.get('local') == '159.65.115.230' for link in network for a in link.get('addr_info', [])), 'Wrong VPS address'
    values = dict(line.split('=', 1) for line in Path('/etc/servus/servus.env').read_text().splitlines() if '=' in line)
    expected = 'ghcr.io/raxon/servus@' + DIGEST
    assert values['SERVUS_IMAGE'] == expected, 'Configured image differs from the published target'
    data = Path(values['SERVUS_DATA_DIR'])
    with urllib.request.urlopen('http://127.0.0.1:4180/api/v1/health', timeout=10) as response:
        health = json.load(response)
    assert health['version'] == VERSION and health['revision'] == COMMIT, 'Wrong running release'
    roles = {}
    for role in ('api', 'worker', 'agent'):
        ids = docker('ps', '-q', '--no-trunc', '--filter', 'label=com.docker.compose.project=servus', '--filter', f'label=com.docker.compose.service={role}').decode().splitlines()
        assert len(ids) == 1, 'Missing or ambiguous installed role'
        inventory = json.loads(docker('inspect', ids[0]))[0]
        assert inventory['Config']['Image'] == expected, 'Role uses a different image'
        roles[role] = ids[0]
    with sqlite3.connect('file:/var/lib/servus-updater/journal.sqlite?mode=ro', uri=True) as db:
        rows = db.execute('SELECT o.id,o.status,o.config_digest,t.phase,t.backup_path,t.backup_manifest_digest '
                          'FROM operations o JOIN policy_approvals a ON a.operation_id=o.id '
                          'JOIN update_transactions t ON t.operation_id=o.id '
                          "WHERE o.tag=? AND o.commit_sha=? AND o.digest=? AND a.state='active'",
                          ('v' + VERSION, COMMIT, DIGEST)).fetchall()
        assert len(rows) == 1 and rows[0][1] == 'verified' and rows[0][3] == 'completed', 'No completed verified active update'
        operation, _, config_digest, _, snapshot_path, manifest_digest = rows[0]
        host = db.execute('SELECT h.status,p.status,s.phase FROM host_stops h JOIN host_preparations p ON p.operation_id=h.operation_id JOIN host_switches s ON s.operation_id=h.operation_id WHERE h.operation_id=?', (operation,)).fetchall()
        assert host == [('completed', 'completed', 'completed')], 'Host generation did not complete'
    snapshot = Path(snapshot_path)
    assert snapshot.is_dir() and not snapshot.is_symlink(), 'Missing protected pre-update snapshot'
    assert 'sha256:' + sha(snapshot / 'manifest.json') == manifest_digest, 'Snapshot manifest changed'
    manifest = json.loads((snapshot / 'manifest.json').read_text())
    for name, expected_hash in manifest['files'].items():
        path = snapshot / name
        assert path.resolve().is_relative_to(snapshot.resolve()), 'Unsafe manifest path'
        assert sha(path) == expected_hash, 'Snapshot file changed'
    with sqlite3.connect(f'file:{snapshot / "panel.sqlite"}?mode=ro&immutable=1', uri=True) as source, \
            sqlite3.connect(f'file:{data / "panel.sqlite"}?mode=ro', uri=True) as target:
        before = source.execute('PRAGMA user_version').fetchone()[0]
        after = target.execute('PRAGMA user_version').fetchone()[0]
        assert before == 5 and after == 8, 'Unexpected source or migrated schema'
        retained = {}
        for table in ('users', 'projects', 'services'):
            original = {row[0] for row in source.execute('SELECT id FROM ' + table)}
            current = {row[0] for row in target.execute('SELECT id FROM ' + table)}
            assert original <= current, 'Previously existing identities disappeared'
            retained[table] = len(original)
        sessions = source.execute('SELECT token_hash,user_id FROM sessions').fetchall()
        kept_sessions = set(target.execute('SELECT token_hash,user_id FROM sessions'))
        assert set(sessions) <= kept_sessions, 'Previously existing sessions disappeared'
        references = {row[0] for row in source.execute('SELECT reference FROM service_secret_refs')}
        for reference in references:
            assert sha(snapshot / 'secrets' / reference) == sha(data / 'secrets' / reference), 'Stored service secret changed'
    assert sha(snapshot / 'secret-key') == sha(data / 'secret-key'), 'Installation encryption key changed'
    for unit in ('servus-updater', 'servus-supervisor'):
        subprocess.run(['systemctl', 'is-active', '--quiet', unit + '.service'], check=True, timeout=10)
    return {'status': 'passed', 'host': '159.65.115.230', 'version': VERSION, 'commit': COMMIT,
            'digest': DIGEST, 'configDigest': config_digest, 'operationId': operation,
            'snapshotManifestDigest': manifest_digest, 'snapshotSchema': before, 'liveSchema': after,
            'retainedIdentities': retained, 'retainedSessions': len(sessions), 'retainedServiceSecrets': len(references),
            'checks': ['published-running-image-and-all-three-roles', 'verified-active-operation-and-completed-host-generation',
                       'pre-upgrade-snapshot-manifest-and-file-integrity', 'immutable-schema5-snapshot-and-live-schema8',
                       'existing-account-project-service-session-and-encrypted-secret-identities', 'healthy-root-services'],
            'scope': 'read-only observation of an already completed update; no VPS update or recovery was initiated by this audit'}


if __name__ == '__main__':
    print(json.dumps(audit(), indent=2))
