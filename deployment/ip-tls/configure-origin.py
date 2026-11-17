#!/usr/bin/python3 -I
"""Migrate one existing local Servus installation to its verified HTTPS origin."""

from contextlib import contextmanager
import fcntl
import http.client
import json
import os
import pathlib
import re
import secrets
import signal
import ssl
import stat
import subprocess
import sys
import tempfile
import time
import urllib.parse
import uuid

CONFIG = pathlib.Path('/etc/servus/servus.env')
INSTALL = pathlib.Path('/opt/servus')
TARGET_HOST = '159.65.115.230'
TARGET_ORIGIN = 'https://' + TARGET_HOST
TUNNEL_ORIGIN = 'http://localhost:14480'
TRUSTED_UID = 0
DOCKER = '/usr/bin/docker'
CA_BUNDLE = pathlib.Path('/etc/ssl/certs/ca-certificates.crt')
KEY_PATTERN = re.compile(r'^[A-Z][A-Z0-9_]*$')
VALUE_PATTERN = re.compile(r'^[A-Za-z0-9_./,:@%+\-]*$')
ID_PATTERN = re.compile(r'^(?:sha256:)?[a-f0-9]{64}$')
HTTP_DEADLINE_SECONDS = 5


class MigrationError(Exception):
    pass


def trusted_directory(path):
    path = pathlib.Path(os.path.abspath(path))
    current = pathlib.Path(path.anchor)
    for part in path.parts[1:]:
        current /= part
        info = current.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid not in (0, TRUSTED_UID):
            raise MigrationError('A required directory is not trusted')
        if info.st_mode & 0o022 and not (info.st_uid == 0 and info.st_mode & stat.S_ISVTX):
            raise MigrationError('A required directory is writable by other users')
    return path


def trusted_file(path, mode=None):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != TRUSTED_UID or info.st_nlink != 1:
        raise MigrationError('A required file is not trusted')
    if mode is not None and stat.S_IMODE(info.st_mode) != mode:
        raise MigrationError('A required file has unsafe permissions')
    if info.st_mode & 0o022:
        raise MigrationError('A required file is writable by other users')
    return info


def current_compose():
    install = trusted_directory(INSTALL)
    releases = trusted_directory(install / 'releases')
    current = install / 'current'
    info = current.lstat()
    if not stat.S_ISLNK(info.st_mode) or info.st_uid != TRUSTED_UID:
        raise MigrationError('The current release link is not trusted')
    target = pathlib.Path(os.path.abspath(os.path.join(install, os.readlink(current))))
    if releases not in target.parents:
        raise MigrationError('The current release is outside the owned releases directory')
    trusted_directory(target)
    trusted_directory(target / 'deployment')
    compose = target / 'deployment/compose.yaml'
    trusted_file(compose)
    return compose


def parse_settings(data):
    try:
        text = data.decode('ascii')
    except UnicodeError as error:
        raise MigrationError('The configuration contains unsupported bytes') from error
    if '\r' in text or '\x00' in text:
        raise MigrationError('The configuration contains invalid line endings')
    values = {}
    for line in text.splitlines():
        if not line or line.startswith('#'):
            continue
        if '=' not in line:
            raise MigrationError('The configuration is malformed')
        key, value = line.split('=', 1)
        if not KEY_PATTERN.fullmatch(key) or not VALUE_PATTERN.fullmatch(value) or key in values:
            raise MigrationError('The configuration is malformed or has duplicate keys')
        values[key] = value
    required = {'SERVUS_IMAGE', 'SERVUS_DATA_DIR', 'SERVUS_PORT', 'SERVUS_BIND_ADDRESS', 'SERVUS_PUBLIC_URL', 'SERVUS_ALLOWED_ORIGINS', 'SERVUS_SECURE_COOKIES'}
    if not required.issubset(values) or not values['SERVUS_IMAGE']:
        raise MigrationError('The configuration is missing required settings')
    if values['SERVUS_BIND_ADDRESS'] != '127.0.0.1' or values['SERVUS_PORT'] != '4180':
        raise MigrationError('The existing API must already listen on 127.0.0.1:4180')
    if values['SERVUS_SECURE_COOKIES'] not in ('true', 'false'):
        raise MigrationError('The existing cookie setting is invalid')
    if values.get('SERVUS_TRUSTED_PROXY_SECRET') or values.get('SERVUS_TRUSTED_PROXY_SECRET_FILE'):
        raise MigrationError('Proxy-secret configurations require a separate coordinated migration')
    if not pathlib.PurePosixPath(values['SERVUS_DATA_DIR']).is_absolute():
        raise MigrationError('The configured data directory is invalid')
    for origin in [values['SERVUS_PUBLIC_URL'], *values['SERVUS_ALLOWED_ORIGINS'].split(',')]:
        parsed = urllib.parse.urlsplit(origin)
        try:
            port = parsed.port
        except ValueError as error:
            raise MigrationError('An existing origin is invalid') from error
        if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment or (port is not None and not 1 <= port <= 65535):
            raise MigrationError('An existing origin is invalid')
    return text, values


def make_updated_settings(text, values):
    origins = []
    for origin in [TARGET_ORIGIN, *values['SERVUS_ALLOWED_ORIGINS'].split(','), TUNNEL_ORIGIN]:
        parsed = urllib.parse.urlsplit(origin)
        if parsed.scheme == 'http' and parsed.hostname not in ('localhost', '127.0.0.1'):
            continue
        if origin not in origins:
            origins.append(origin)
    replacement = {'SERVUS_PUBLIC_URL': TARGET_ORIGIN, 'SERVUS_ALLOWED_ORIGINS': ','.join(origins), 'SERVUS_SECURE_COOKIES': 'true'}
    return ''.join((key + '=' + replacement[key] + '\n') if (key := line.partition('=')[0]) in replacement else line
                   for line in text.splitlines(keepends=True)).encode('ascii')


def read_configuration(path):
    trusted_file(path, 0o600)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != TRUSTED_UID or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o600 or info.st_size > 65536:
            raise MigrationError('The configuration file is not trusted')
        with os.fdopen(fd, 'rb', closefd=False) as stream:
            return stream.read(65537)
    finally:
        os.close(fd)


def write_exclusive(path, data):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())


def sync_directory(directory):
    fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def atomic_replace(path, data):
    fd, name = tempfile.mkstemp(prefix='.servus-origin-', dir=path.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'wb') as stream:
            fd = -1
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        trusted_file(path, 0o600)
        os.replace(name, path)
        sync_directory(path.parent)
    finally:
        if fd >= 0:
            os.close(fd)
        if os.path.lexists(name):
            os.unlink(name)


def tls_context():
    trusted_directory(CA_BUNDLE.parent)
    trusted_file(CA_BUNDLE)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    context.load_verify_locations(cafile=str(CA_BUNDLE))
    return context


@contextmanager
def http_deadline():
    try:
        old_handler = signal.getsignal(signal.SIGALRM)
        if any(signal.getitimer(signal.ITIMER_REAL)):
            raise MigrationError('An existing timer prevents a safe HTTP deadline')
        def expired(_signum, _frame):
            raise TimeoutError('HTTP request exceeded its deadline')
        signal.signal(signal.SIGALRM, expired)
        try:
            signal.setitimer(signal.ITIMER_REAL, HTTP_DEADLINE_SECONDS)
        except (OSError, ValueError):
            signal.signal(signal.SIGALRM, old_handler)
            raise MigrationError('Cannot enforce an HTTP deadline') from None
    except (OSError, ValueError):
        raise MigrationError('Cannot enforce an HTTP deadline') from None
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, old_handler)


def request_health(host, secure):
    context = tls_context() if secure else None
    connection = http.client.HTTPSConnection(host, 443, timeout=5, context=context) if secure else http.client.HTTPConnection(host, 4180, timeout=5)
    try:
        with http_deadline():
            connection.request('GET', '/api/v1/health', headers={'Accept': 'application/json'})
            response = connection.getresponse()
            data = response.read(16385)
            if response.status != 200 or len(data) > 16384:
                raise MigrationError('An API health check failed')
            health = json.loads(data)
            if not isinstance(health, dict) or health.get('status') != 'ok' or not isinstance(health.get('version'), str):
                raise MigrationError('An API health check failed')
            return health
    except (OSError, ssl.SSLError, http.client.HTTPException, ValueError) as error:
        raise MigrationError('An API health or verified TLS check failed') from error
    finally:
        connection.close()


def docker(*args):
    with tempfile.TemporaryDirectory(prefix='servus-docker-config-', dir=CONFIG.parent) as directory:
        os.chmod(directory, 0o700)
        result = subprocess.run([DOCKER, *args], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'DOCKER_HOST': 'unix:///var/run/docker.sock',
                                     'DOCKER_CONFIG': directory, 'HOME': directory},
                                timeout=120, check=False, text=True)
    if result.returncode:
        raise MigrationError('A Docker operation failed')
    return result.stdout.strip()


def compose_snapshot(compose, settings, values):
    """Regenerate and validate a private snapshot from its owned template."""
    template = compose.with_name('compose.template.yaml')
    if not os.path.lexists(template):
        return None
    trusted_file(compose, 0o600)
    trusted_file(template)
    validator = compose.parent.parent / 'apps/updater/validate-compose.py'
    trusted_directory(validator.parent)
    trusted_file(validator)
    required = ('SERVUS_LIFECYCLE_DIR', 'SERVUS_SUPERVISOR_CONTROL_DIR', 'SERVUS_SUPERVISOR_SECRET_DIR')
    if any(not values.get(key) for key in required):
        raise MigrationError('The snapshot configuration is incomplete')
    with tempfile.TemporaryDirectory(prefix='.servus-compose-', dir=CONFIG.parent) as directory:
        os.chmod(directory, 0o700)
        root = pathlib.Path(directory)
        env_file, image_file = root / 'servus.env', root / 'image.json'
        write_exclusive(env_file, settings)
        image_env = docker('image', 'inspect', '--format', '{{json .Config.Env}}', values['SERVUS_IMAGE'])
        if len(image_env.encode()) > 65536:
            raise MigrationError('The image environment exceeds its limit')
        write_exclusive(image_file, image_env.encode('utf-8'))
        previous = template
        outputs = []
        for index in range(2):
            content = docker('compose', '--env-file', str(env_file), '-f', str(previous), '-p', 'servus', 'config', '--format', 'json')
            if len(content.encode()) > 1024 * 1024:
                raise MigrationError('The effective Compose configuration exceeds its limit')
            output = root / ('snapshot-' + str(index) + '.json')
            args = ['/usr/bin/python3', '-I', str(validator), values['SERVUS_LIFECYCLE_DIR'], values['SERVUS_IMAGE'],
                    values['SERVUS_DATA_DIR'], str(env_file), str(image_file), values['SERVUS_SUPERVISOR_CONTROL_DIR'],
                    values['SERVUS_SUPERVISOR_SECRET_DIR'], str(output)]
            result = subprocess.run(args, input=content, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                                    text=True, timeout=30, check=False,
                                    env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C'})
            if result.returncode:
                raise MigrationError('The effective Compose configuration is invalid')
            outputs.append(read_configuration(output))
            previous = output
        if outputs[0] != outputs[1]:
            raise MigrationError('The Compose snapshot is not stable')
        return outputs[0]


def inspect_json(container, template):
    try:
        return json.loads(docker('inspect', '--format', template, container))
    except (TypeError, ValueError) as error:
        raise MigrationError('Docker returned invalid container metadata') from error


def data_path(value):
    path = pathlib.Path(value)
    if not path.is_absolute() or str(path) != value or '..' in path.parts:
        raise MigrationError('The configured data directory is invalid')
    current = pathlib.Path('/')
    for part in path.parts[1:]:
        current /= part
        info = current.lstat()
        if not stat.S_ISDIR(info.st_mode):
            raise MigrationError('The configured data directory is unsafe')
    return path


def running_image(compose, config, values):
    ids = docker('compose', '--env-file', str(config), '-f', str(compose), '-p', 'servus', 'ps', '--status', 'running', '-q', 'api').splitlines()
    if len(ids) != 1 or not re.fullmatch(r'[a-f0-9]{12,64}', ids[0]):
        raise MigrationError('Exactly one running API container is required')
    desired = docker('compose', '--env-file', str(config), '-f', str(compose), '-p', 'servus', 'config', '--hash', 'api').splitlines()
    if len(desired) != 1 or not re.fullmatch(r'api [a-f0-9]{64}', desired[0]):
        raise MigrationError('The API Compose configuration hash is unavailable')
    actual = docker('inspect', '--format', '{{index .Config.Labels "com.docker.compose.config-hash"}}', ids[0])
    if actual != desired[0].split(' ', 1)[1]:
        raise MigrationError('The running API differs from the Compose configuration; reconcile it first')
    running = docker('inspect', '--format', '{{.Image}}', ids[0])
    configured = docker('image', 'inspect', '--format', '{{.Id}}', values['SERVUS_IMAGE'])
    if not ID_PATTERN.fullmatch(running) or running != configured:
        raise MigrationError('The configured API image does not match the running container')
    data = data_path(values['SERVUS_DATA_DIR'])
    mounts = inspect_json(ids[0], '{{json .Mounts}}')
    if not isinstance(mounts, list):
        raise MigrationError('Docker returned invalid mount metadata')
    expected = []
    for mount in mounts:
        if not isinstance(mount, dict):
            raise MigrationError('Docker returned invalid mount metadata')
        destination = mount.get('Destination')
        if not isinstance(destination, str) or not destination.startswith('/'):
            raise MigrationError('Docker returned invalid mount metadata')
        dest = pathlib.PurePosixPath(destination)
        web = pathlib.PurePosixPath('/app/dist/web')
        if dest == web or dest in web.parents or web in dest.parents:
            raise MigrationError('The API static directory must not be mounted')
        if destination == str(data):
            expected.append(mount)
        elif dest in data.parents or data in dest.parents:
            raise MigrationError('Unexpected API mount overlaps the data directory')
    if len(expected) != 1 or expected[0].get('Type') != 'bind' or expected[0].get('Source') != str(data) or expected[0].get('RW') is not True:
        raise MigrationError('The running API data mount does not match the configuration')
    raw_env = inspect_json(ids[0], '{{json .Config.Env}}')
    if not isinstance(raw_env, list) or not all(isinstance(item, str) and '=' in item for item in raw_env):
        raise MigrationError('Docker returned invalid API settings')
    runtime_env = {}
    for item in raw_env:
        key, value = item.split('=', 1)
        if key in runtime_env:
            raise MigrationError('The running API contains duplicate environment keys')
        runtime_env[key] = value
    if runtime_env.get('PANEL_TRUSTED_PROXY_SECRET') or runtime_env.get('PANEL_TRUSTED_PROXY_SECRET_FILE'):
        raise MigrationError('Proxy-secret configurations require a separate coordinated migration')
    required = {'PANEL_DATA_DIR':str(data), 'PANEL_HOST':'0.0.0.0', 'PANEL_PORT':'4180',
                'PANEL_ALLOWED_ORIGINS':values['SERVUS_ALLOWED_ORIGINS'], 'PANEL_SECURE_COOKIES':values['SERVUS_SECURE_COOKIES']}
    if any(runtime_env.get(key) != value for key, value in required.items()):
        raise MigrationError('The running API configuration differs from the stored configuration; reconcile it first')
    ports = inspect_json(ids[0], '{{json .NetworkSettings.Ports}}')
    if not isinstance(ports, dict) or ports.get('4180/tcp') != [{'HostIp': '127.0.0.1', 'HostPort': '4180'}]:
        raise MigrationError('The running API must be published only on 127.0.0.1:4180')
    return running, ids[0]


CREATE_MARKER = r'''const fs=require('fs');const p=require('path');
for(const dir of ['/app','/app/dist','/app/dist/web']){const s=fs.lstatSync(dir);if(!s.isDirectory()||s.uid!==0||(s.mode&0o022))process.exit(2)}
const name=process.argv[1],value=process.argv[2];if(!/^__servus-origin-[a-f0-9]{32}[.]txt$/.test(name)||!/^[a-f0-9]{64}$/.test(value))process.exit(3);
fs.writeFileSync(p.join('/app/dist/web',name),value,{flag:'wx',mode:0o644});'''
REMOVE_MARKER = r'''const fs=require('fs');const p=require('path');const name=process.argv[1],value=process.argv[2];
if(!/^__servus-origin-[a-f0-9]{32}[.]txt$/.test(name)||!/^[a-f0-9]{64}$/.test(value))process.exit(3);
const file=p.join('/app/dist/web',name);let s;try{s=fs.lstatSync(file)}catch(e){if(e.code==='ENOENT')process.exit(0);throw e}
if(!s.isFile()||s.uid!==0||fs.readFileSync(file,'utf8')!==value)process.exit(2);fs.unlinkSync(file);'''


def marker_response(host, secure, name):
    context = tls_context() if secure else None
    connection = http.client.HTTPSConnection(host, 443, timeout=5, context=context) if secure else http.client.HTTPConnection(host, 4180, timeout=5)
    try:
        with http_deadline():
            connection.request('GET', '/' + name, headers={'Accept':'text/plain', 'Cache-Control':'no-store'})
            response = connection.getresponse()
            data = response.read(257)
            if response.status != 200 or len(data) > 256:
                raise MigrationError('The public proxy does not reach this API instance')
            return data
    except (OSError, ssl.SSLError, http.client.HTTPException) as error:
        raise MigrationError('The public proxy identity check failed') from error
    finally:
        connection.close()


def verify_proxy_instance(container):
    name = '__servus-origin-' + secrets.token_hex(16) + '.txt'
    value = secrets.token_hex(32)
    attempted = False
    try:
        attempted = True
        docker('exec', '--user', '0', container, '/usr/local/bin/node', '-e', CREATE_MARKER, name, value)
        expected = value.encode('ascii')
        if marker_response('127.0.0.1', False, name) != expected or marker_response(TARGET_HOST, True, name) != expected:
            raise MigrationError('The public proxy does not reach this API instance')
    finally:
        if attempted:
            docker('exec', '--user', '0', container, '/usr/local/bin/node', '-e', REMOVE_MARKER, name, value)


def restart_api(compose, config):
    docker('compose', '--env-file', str(config), '-f', str(compose), '-p', 'servus', 'up', '-d', '--no-deps', '--no-build', '--pull', 'never', 'api')


def wait_api(compose, values, original_image, original_health, verify_public):
    deadline = time.monotonic() + 60
    while True:
        try:
            if request_health('127.0.0.1', False) != original_health:
                raise MigrationError('The restarted API has an unexpected identity')
            image, container = running_image(compose, CONFIG, values)
            if image != original_image:
                raise MigrationError('The restarted API has an unexpected image')
            if verify_public and request_health(TARGET_HOST, True) != original_health:
                raise MigrationError('Public HTTPS does not lead to the restarted panel')
            if verify_public:
                verify_proxy_instance(container)
            return
        except MigrationError:
            if time.monotonic() >= deadline:
                raise
            time.sleep(1)


def clear_pending(path):
    trusted_file(path, 0o600)
    os.unlink(path)
    sync_directory(path.parent)


def migrate():
    if os.geteuid() != TRUSTED_UID:
        raise MigrationError('Run as root')
    os.umask(0o077)
    trusted_directory(CONFIG.parent)
    trusted_directory(INSTALL)
    trusted_directory(pathlib.Path(DOCKER).parent)
    trusted_file(pathlib.Path(DOCKER))
    marker = INSTALL / '.servus-install'
    trusted_file(marker)
    if marker.read_text().strip() != 'servus-installer-v1':
        raise MigrationError('The installation marker is invalid')
    lock = INSTALL / 'install.lock'
    trusted_file(lock, 0o600)
    lock_fd = os.open(lock, os.O_RDWR | os.O_NOFOLLOW)
    try:
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise MigrationError('Another installation operation is running') from error
        pending = CONFIG.parent / 'servus-origin-migration.pending'
        if os.path.lexists(pending):
            raise MigrationError('A previous origin migration is incomplete; reconcile it locally before retrying')
        compose = current_compose()
        original = read_configuration(CONFIG)
        text, values = parse_settings(original)
        original_health = request_health('127.0.0.1', False)
        public_health = request_health(TARGET_HOST, True)
        if original_health != public_health:
            raise MigrationError('Public HTTPS does not lead to this panel')
        original_image, container = running_image(compose, CONFIG, values)
        verify_proxy_instance(container)
        updated = make_updated_settings(text, values)
        if updated == original:
            return None
        original_snapshot = compose_snapshot(compose, original, values)
        updated_snapshot = None
        if original_snapshot is not None:
            if read_configuration(compose) != original_snapshot:
                raise MigrationError('The installed Compose snapshot differs from its template and settings')
            _, updated_values = parse_settings(updated)
            updated_snapshot = compose_snapshot(compose, updated, updated_values)
        backup = CONFIG.parent / ('servus.env.before-https-' + uuid.uuid4().hex)
        write_exclusive(backup, original)
        snapshot_backup = None
        if original_snapshot is not None:
            snapshot_backup = CONFIG.parent / ('compose.before-https-' + uuid.uuid4().hex + '.json')
            write_exclusive(snapshot_backup, original_snapshot)
        sync_directory(CONFIG.parent)
        record = {'format': 2, 'backup': backup.name}
        if snapshot_backup is not None:
            record.update({'composeBackup': snapshot_backup.name, 'compose': str(compose)})
        write_exclusive(pending, json.dumps(record).encode('ascii') + b'\n')
        sync_directory(CONFIG.parent)
        installed = False
        try:
            installed = True
            atomic_replace(CONFIG, updated)
            if updated_snapshot is not None:
                atomic_replace(compose, updated_snapshot)
            restart_api(compose, CONFIG)
            _, updated_values = parse_settings(updated)
            wait_api(compose, updated_values, original_image, original_health, True)
            clear_pending(pending)
        except Exception as error:
            if installed:
                try:
                    atomic_replace(CONFIG, original)
                    if original_snapshot is not None:
                        atomic_replace(compose, original_snapshot)
                    restart_api(compose, CONFIG)
                    wait_api(compose, values, original_image, original_health, False)
                    clear_pending(pending)
                except Exception as rollback_error:
                    raise MigrationError('Migration failed and rollback could not be verified; inspect the local installation') from rollback_error
            raise MigrationError('Migration failed; the previous configuration and API were restored') from error
        return backup
    finally:
        os.close(lock_fd)


def main():
    try:
        backup = migrate()
    except (MigrationError, OSError, subprocess.SubprocessError) as error:
        if isinstance(error, MigrationError):
            print(f'Origin migration failed: {error}', file=sys.stderr)
        else:
            print('Origin migration failed due to a local operation error.', file=sys.stderr)
        return 1
    if backup is None:
        print('The requested HTTPS origin is already configured and verified.')
    else:
        print(f'HTTPS origin configured. Previous settings saved at {backup}.')
        print('The allowed-origins setting excludes non-loopback HTTP origins.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
