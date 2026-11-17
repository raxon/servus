#!/usr/bin/python3 -I
"""Exercise origin migration and rollback against real Docker Compose."""
import importlib.util
import json
import os
import pathlib
import secrets
import shutil
import subprocess
import tempfile
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('origin_migration', ROOT / 'deployment/ip-tls/configure-origin.py')
origin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(origin)


def docker(*args):
    return subprocess.check_output(['/usr/bin/docker', *args], stderr=subprocess.PIPE, text=True, timeout=90).strip()


def main():
    if os.geteuid() != 0:
        raise SystemExit('Linux root is required')
    image = 'servus-origin-snapshot-fixture:' + secrets.token_hex(8)
    with tempfile.TemporaryDirectory(prefix='servus-origin-fixture-', dir='/run') as directory:
        base = pathlib.Path(directory)
        build = base / 'build'
        build.mkdir()
        (build / 'Dockerfile').write_text('FROM node:24-bookworm-slim\nENV NODE_ENV=production PANEL_DATA_DIR=/var/lib/panel PANEL_HOST=0.0.0.0 PANEL_PORT=4180\n')
        try:
            docker('build', '--network=none', '--pull=false', '-t', image, str(build))
            config = base / 'config'; config.mkdir(mode=0o700)
            install = base / 'install'; release = install / 'releases/release1'
            (release / 'deployment').mkdir(parents=True)
            (release / 'apps/updater').mkdir(parents=True)
            shutil.copyfile(ROOT / 'deployment/compose.yaml', release / 'deployment/compose.template.yaml')
            shutil.copyfile(ROOT / 'apps/updater/validate-compose.py', release / 'apps/updater/validate-compose.py')
            (install / 'current').symlink_to(release)
            (install / '.servus-install').write_text('servus-installer-v1\n')
            (install / 'install.lock').touch(mode=0o600)
            compose = release / 'deployment/compose.yaml'
            compose.write_text('{}\n'); compose.chmod(0o600)
            env = config / 'servus.env'
            contents = (f'SERVUS_IMAGE={image}\nSERVUS_DATA_DIR=/var/lib/servus-origin-fixture\n'
                        'SERVUS_PORT=4180\nSERVUS_INGRESS_PORT=80\nSERVUS_DOCKER_GID=0\n'
                        'SERVUS_BIND_ADDRESS=127.0.0.1\nSERVUS_PUBLIC_URL=http://159.65.115.230:4180\n'
                        'SERVUS_ALLOWED_ORIGINS=http://159.65.115.230:4180,http://localhost:14480\n'
                        'SERVUS_SECURE_COOKIES=false\nSERVUS_SOURCE_REF=fixture\n'
                        f'SERVUS_LIFECYCLE_DIR={config}/lifecycle\n'
                        f'SERVUS_SUPERVISOR_CONTROL_DIR={config}/supervisor-control\n'
                        f'SERVUS_SUPERVISOR_SECRET_DIR={config}/supervisor-secrets\n').encode('ascii')
            env.write_bytes(contents); env.chmod(0o600)
            origin.CONFIG, origin.INSTALL = env, install
            _, values = origin.parse_settings(contents)
            previous = origin.compose_snapshot(compose, contents, values)
            compose.write_bytes(previous); compose.chmod(0o600)
            health = {'status': 'ok', 'version': 'fixture'}
            with mock.patch.object(origin, 'request_health', return_value=health), \
                 mock.patch.object(origin, 'running_image', return_value=('sha256:' + 'a'*64, 'b'*64)), \
                 mock.patch.object(origin, 'verify_proxy_instance'), mock.patch.object(origin, 'restart_api'), \
                 mock.patch.object(origin, 'wait_api'):
                backup = origin.migrate()
                assert backup.read_bytes() == contents
                snapshot = json.loads(compose.read_bytes())
                assert snapshot['services']['api']['environment']['PANEL_ALLOWED_ORIGINS'] == 'https://159.65.115.230,http://localhost:14480'
                assert snapshot['services']['api']['environment']['PANEL_SECURE_COOKIES'] == 'true'
                assert snapshot['services']['worker'] == json.loads(previous)['services']['worker']
                changed = env.read_bytes()
                assert changed != contents
                env.write_bytes(contents); compose.write_bytes(previous)
                origin.restart_api.side_effect = [origin.MigrationError('synthetic failure'), None]
                try:
                    origin.migrate()
                except origin.MigrationError as error:
                    assert 'previous configuration and API were restored' in str(error)
                else:
                    raise AssertionError('Expected rollback')
                assert env.read_bytes() == contents and compose.read_bytes() == previous
            print('Real Compose: origin snapshot updated and both files restored after failure')
        finally:
            subprocess.run(['/usr/bin/docker', 'image', 'rm', image], stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL, timeout=30, check=False)


if __name__ == '__main__':
    main()
