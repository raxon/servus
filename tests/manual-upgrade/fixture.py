#!/usr/bin/env python3
"""Exercise stopped-writer WAL snapshots in a disposable local Docker fixture.

This fixture uses synthetic databases and secrets. It is not a production
backup, restore tool, Swarm reconciliation, or rollout coordinator.
"""
import os
import pathlib
import secrets
import shutil
import signal
import sqlite3
import subprocess
import sys
import tempfile
import time

DOCKER = '/usr/bin/docker'
IMAGE = 'python:3.12-slim'
LABEL = 'servus.manual-fixture'
ENV = {'PATH': '/usr/bin:/bin', 'HOME': '/root', 'LANG': 'C', 'DOCKER_HOST': 'unix:///var/run/docker.sock', 'DOCKER_CONFIG': '/dev/null'}
WRITER = '''import pathlib,sqlite3,sys,time
p=pathlib.Path('/fixture')
role=sys.argv[1]
if role in ('api','agent'):
 db=sqlite3.connect(p / ('panel.sqlite' if role=='api' else 'agent.sqlite'))
 db.execute('PRAGMA journal_mode=WAL'); db.execute('PRAGMA wal_autocheckpoint=0')
 db.execute('CREATE TABLE IF NOT EXISTS history (id INTEGER PRIMARY KEY, status TEXT NOT NULL)')
 db.execute("INSERT INTO history(status) VALUES ('failed'),('succeeded')"); db.commit()
(p / (role+'.ready')).write_text('ready')
while True: time.sleep(1)
'''


def docker(*args):
    return subprocess.check_output([DOCKER, *args], env=ENV, stderr=subprocess.PIPE, timeout=45, text=True).strip()


def snapshot_database(source, destination):
    source_db = sqlite3.connect(f'file:{source}?mode=ro', uri=True, timeout=3)
    target_db = sqlite3.connect(destination)
    try:
        source_db.backup(target_db)
        if target_db.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
            raise RuntimeError('Fixture SQLite integrity check failed')
        if target_db.execute('PRAGMA foreign_key_check').fetchone() is not None:
            raise RuntimeError('Fixture foreign keys failed')
    finally:
        target_db.close()
        source_db.close()
    os.chmod(destination, 0o600)


def main():
    if sys.platform != 'linux' or os.geteuid() != 0 or os.uname().nodename != 'colima-panel-dev':
        raise SystemExit('Run only as root on the isolated colima-panel-dev fixture host')
    docker('image', 'inspect', IMAGE)
    suffix = secrets.token_hex(12)
    ids = {}
    with tempfile.TemporaryDirectory(prefix='servus-manual-fixture-', dir='/run') as tmp:
        base = pathlib.Path(tmp)
        data = base / 'data'; data.mkdir(mode=0o700)
        application = base / 'application'; application.mkdir(mode=0o700)
        backup = base / 'backup'; backup.mkdir(mode=0o700)
        (data / 'secret-key').write_text('a' * 64)
        (data / 'agent-token').write_text('b' * 64)
        for directory in ('secrets', 'database-roots'):
            (data / directory).mkdir(mode=0o700)
        (data / 'secrets' / 'synthetic').write_text('synthetic-encrypted-value')
        (data / 'database-roots' / 'synthetic').write_text('synthetic-reference')
        for path in (data / 'secret-key', data / 'agent-token', data / 'secrets' / 'synthetic', data / 'database-roots' / 'synthetic'):
            path.chmod(0o600)
        script = base / 'writer.py'; script.write_text(WRITER); script.chmod(0o644)
        try:
            for role in ('api', 'worker', 'agent', 'unrelated'):
                mount = application if role == 'unrelated' else data
                cid = docker('run', '-d', '--name', f'servus-manual-fixture-{suffix}-{role}', '--label', f'{LABEL}={suffix}',
                             '--restart=no', '--network=none', '--mount', f'type=bind,source={mount},target=/fixture',
                             '--mount', f'type=bind,source={script},target=/writer.py,readonly', IMAGE, 'python3', '/writer.py', role)
                if len(cid) != 64: raise RuntimeError('Invalid fixture container')
                ids[role] = cid
            deadline = time.monotonic() + 15
            while not all(((application if role == 'unrelated' else data) / (role + '.ready')).is_file() for role in ids):
                if time.monotonic() > deadline: raise RuntimeError('Fixture writers did not start')
                time.sleep(.05)
            for name in ('panel.sqlite-wal', 'agent.sqlite-wal'):
                if not (data / name).is_file() or (data / name).stat().st_size <= 0:
                    raise RuntimeError('Fixture did not retain WAL content')
            def assert_stopped():
                for role in ('api', 'worker', 'agent'):
                    state = docker('inspect', '--format', '{{.State.Running}} {{.HostConfig.RestartPolicy.Name}} {{index .Config.Labels "servus.manual-fixture"}}', ids[role])
                    if state != f'false no {suffix}': raise RuntimeError('A fixture writer is still running or can restart')
            for role in ('worker', 'api'):
                docker('stop', '--time', '3', ids[role])
            try:
                assert_stopped()
            except RuntimeError:
                pass
            else:
                raise RuntimeError('Live agent was not detected')
            docker('stop', '--time', '3', ids['agent'])
            assert_stopped()
            for name in ('panel.sqlite-wal', 'agent.sqlite-wal'):
                if not (data / name).is_file() or (data / name).stat().st_size <= 0:
                    raise RuntimeError('Fixture WAL content was lost before capture')
            for name in ('panel.sqlite', 'agent.sqlite'):
                snapshot_database(data / name, backup / name)
            for name in ('secret-key', 'agent-token'):
                shutil.copyfile(data / name, backup / name); os.chmod(backup / name, 0o600)
            for name in ('secrets', 'database-roots'):
                shutil.copytree(data / name, backup / name, copy_function=shutil.copyfile)
                os.chmod(backup / name, 0o700)
                for child in (backup / name).iterdir(): os.chmod(child, 0o600)
            assert_stopped()
            restored = base / 'restored'
            shutil.copytree(backup, restored)
            os.chmod(restored, 0o700)
            for name in ('panel.sqlite', 'agent.sqlite'):
                with sqlite3.connect(f'file:{restored / name}?mode=ro', uri=True) as db:
                    if db.execute('SELECT status FROM history ORDER BY id').fetchall() != [('failed',), ('succeeded',)]:
                        raise RuntimeError('Historical operation state was not preserved')
            for name in ('secret-key', 'agent-token', 'secrets/synthetic', 'database-roots/synthetic'):
                if (data / name).read_bytes() != (restored / name).read_bytes(): raise RuntimeError('Fixture secret differs')
            if docker('inspect', '--format', '{{.State.Running}}', ids['unrelated']) != 'true':
                raise RuntimeError('Unrelated fixture application was interrupted')
            print('PASS: stopped writers, WAL snapshots, historical failures, synthetic secret restore, unrelated container')
            print('LIMITATION: synthetic schema and secrets; no production writer exclusion, Swarm reconciliation or application-volume backup')
        finally:
            for role, cid in ids.items():
                try:
                    label = docker('inspect', '--format', '{{index .Config.Labels "servus.manual-fixture"}}', cid)
                    if label == suffix: docker('rm', '-f', cid)
                except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
                    print(f'Fixture cleanup failed for {role}; inspect only fixture {suffix}', file=sys.stderr)


if __name__ == '__main__':
    main()
