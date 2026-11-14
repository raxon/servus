#!/usr/bin/python3 -I
"""Extract installation inputs from an already verified local image.

This module does not verify an attestation, resolve a registry manifest to a
config digest, pull an image, or authorize an update. The trusted caller must
independently verify those steps and provide the exact local image ID. Docker,
root and the private staging directory are part of the trust boundary.
"""
import io
import hashlib
import json
import os
import re
import secrets
import selectors
import shutil
import stat
import subprocess
import tarfile
import time

DOCKER = '/usr/bin/docker'
ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'DOCKER_HOST': 'unix:///var/run/docker.sock', 'LANG': 'C', 'DOCKER_CONFIG': '/dev/null'}
IMAGE_ID = re.compile(r'^sha256:[0-9a-f]{64}$')
CONTAINER_ID = re.compile(r'^[0-9a-f]{64}$')
PROBE_NAME = re.compile(r'^servus-extract-[a-f0-9]{32}$')
MAX_ARCHIVE = 16 * 1024 * 1024
MAX_FILE = 4 * 1024 * 1024
FILES = {
    'Dockerfile': 0o644,
    'apps/panel/package.json': 0o644,
    'apps/updater/backup.py': 0o644,
    'apps/updater/discover-release.py': 0o644,
    'apps/updater/extract-install.py': 0o644,
    'apps/updater/guarded-verifier.py': 0o644,
    'apps/updater/preflight.py': 0o644,
    'apps/updater/prepare-verified.py': 0o644,
    'apps/updater/preparation-fence.py': 0o644,
    'apps/updater/provision-verifier-group.py': 0o644,
    'apps/updater/runtime-policy.py': 0o644,
    'apps/updater/servus-updater.py': 0o755,
    'apps/updater/supervisor-daemon.py': 0o644,
    'apps/updater/supervisor.py': 0o644,
    'apps/updater/validate-compose.py': 0o644,
    'apps/updater/verification-executor.py': 0o644,
    'apps/updater/verification-fence.py': 0o644,
    'apps/updater/verify-release.py': 0o644,
    'deployment/compose.yaml': 0o644,
    'deployment/lifecycle-gate.sh': 0o644,
    'deployment/systemd/servus-supervisor.service': 0o644,
    'scripts/install.sh': 0o755,
}
# The published v0.1.5 image predates manifest-v1. This set is frozen and is
# accepted only when the trusted caller explicitly selects the legacy format.
LEGACY_V015_FILES = {
    'Dockerfile': 0o644,
    'apps/panel/package.json': 0o644,
    'apps/updater/backup.py': 0o644,
    'apps/updater/discover-release.py': 0o644,
    'apps/updater/extract-install.py': 0o644,
    'apps/updater/guarded-verifier.py': 0o644,
    'apps/updater/preflight.py': 0o644,
    'apps/updater/prepare-verified.py': 0o644,
    'apps/updater/preparation-fence.py': 0o644,
    'apps/updater/provision-verifier-group.py': 0o644,
    'apps/updater/servus-updater.py': 0o755,
    'apps/updater/supervisor-daemon.py': 0o644,
    'apps/updater/supervisor.py': 0o644,
    'apps/updater/verification-executor.py': 0o644,
    'apps/updater/verification-fence.py': 0o644,
    'apps/updater/verify-release.py': 0o644,
    'deployment/compose.yaml': 0o644,
    'deployment/lifecycle-gate.sh': 0o644,
    'deployment/systemd/servus-supervisor.service': 0o644,
    'scripts/install.sh': 0o755,
}
UPDATER_ABI = 1
MANIFEST_LIMIT = 256 * 1024
LEGACY_V015_DIGEST = 'sha256:32f7cccf97841716ffae6bbff4f4234d5c3575e3b3ad9daa61dcf5afba72a13c'


class ExtractionError(Exception):
    """Do not expose archive contents or Docker output in errors."""


def format_for_verified_digest(digest):
    """Select legacy only for the exact previously authenticated image digest."""
    if not isinstance(digest, str) or not IMAGE_ID.fullmatch(digest):
        raise ExtractionError('A verified image digest is required')
    return 'legacy-v0.1.5' if digest == LEGACY_V015_DIGEST else 'manifest-v1'


def _docker(*args, limit=1024 * 1024, timeout=30):
    try:
        proc = subprocess.Popen([DOCKER, *args], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                stderr=subprocess.DEVNULL, env=ENV, cwd='/', close_fds=True)
    except OSError as error:
        raise ExtractionError('Docker operation failed') from error
    selector = selectors.DefaultSelector()
    output = bytearray()
    deadline = time.monotonic() + timeout
    try:
        selector.register(proc.stdout, selectors.EVENT_READ)
        while selector.get_map():
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not selector.select(remaining):
                raise ExtractionError('Docker operation timed out')
            data = os.read(proc.stdout.fileno(), 65536)
            if not data:
                selector.unregister(proc.stdout)
                break
            output.extend(data)
            if len(output) > limit:
                raise ExtractionError('Docker output exceeded its limit')
        remaining = deadline - time.monotonic()
        if remaining <= 0 or proc.wait(timeout=remaining) != 0:
            raise ExtractionError('Docker operation failed')
        return bytes(output)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise ExtractionError('Docker operation failed') from error
    finally:
        selector.close()
        if proc.poll() is None:
            proc.kill()
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                pass
        proc.stdout.close()


def _trusted_parent(path):
    if os.geteuid() != 0 or not isinstance(path, str) or not path.startswith('/') or path == '/' or os.path.normpath(path) != path:
        raise ExtractionError('Private staging directory is required')
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        root = os.fstat(fd)
        if root.st_uid != 0 or root.st_mode & 0o022:
            raise ExtractionError('Private staging directory is required')
        for part in path[1:].split('/'):
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
            info = os.fstat(fd)
            if info.st_uid != 0 or info.st_mode & 0o022:
                raise ExtractionError('Private staging directory is required')
        if stat.S_IMODE(os.fstat(fd).st_mode) != 0o700:
            raise ExtractionError('Private staging directory is required')
        return fd
    except BaseException:
        os.close(fd)
        raise


def _allowed_addition(name):
    return bool(name == 'deployment/compose-supervised.yaml' or
                re.fullmatch(r'apps/updater/[a-z0-9][a-z0-9-]{0,63}\.py', name) or
                re.fullmatch(r'deployment/systemd/servus-[a-z0-9][a-z0-9-]{0,63}\.(?:service|socket|timer)', name) or
                re.fullmatch(r'scripts/[a-z0-9][a-z0-9-]{0,63}\.(?:sh|py)', name))


def _unique_pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ExtractionError('Duplicate installation manifest field')
        result[key] = value
    return result


def _manifest_files(data):
    if len(data) > MANIFEST_LIMIT:
        raise ExtractionError('Invalid installation manifest')
    try:
        document = json.loads(data, object_pairs_hook=_unique_pairs,
                              parse_constant=lambda _: (_ for _ in ()).throw(ExtractionError('Invalid installation manifest')))
    except (UnicodeError, ValueError, RecursionError) as error:
        raise ExtractionError('Invalid installation manifest') from error
    if (not isinstance(document, dict) or set(document) != {'schema', 'minimumUpdaterAbi', 'files'} or
        type(document['schema']) is not int or document['schema'] != 1 or
        type(document['minimumUpdaterAbi']) is not int or not 1 <= document['minimumUpdaterAbi'] <= UPDATER_ABI or
        not isinstance(document['files'], list) or not 1 <= len(document['files']) <= 256):
        raise ExtractionError('Unsupported installation manifest')
    result = {}
    for item in document['files']:
        if not isinstance(item, dict) or set(item) != {'path', 'type', 'mode', 'size', 'sha256'}:
            raise ExtractionError('Invalid installation manifest')
        name, mode, size, digest = item['path'], item['mode'], item['size'], item['sha256']
        if (not isinstance(name, str) or name in result or name == 'manifest.json' or
            not (name in FILES or _allowed_addition(name)) or item['type'] != 'file' or
            type(mode) is not int or mode not in (0o644, 0o755) or
            (name in FILES and mode != FILES[name]) or type(size) is not int or not 0 <= size <= MAX_FILE or
            not isinstance(digest, str) or not re.fullmatch(r'[a-f0-9]{64}', digest)):
            raise ExtractionError('Invalid installation manifest')
        result[name] = (mode, size, digest)
    if not set(FILES).issubset(result):
        raise ExtractionError('Incomplete installation manifest')
    return result


class InstallationFiles(dict):
    def __init__(self, files, modes):
        super().__init__(files)
        self.modes = modes


def _read_archive(payload, *, artifact_format='manifest-v1'):
    if not isinstance(payload, bytes) or len(payload) > MAX_ARCHIVE:
        raise ExtractionError('Invalid installation archive')
    if artifact_format not in ('manifest-v1', 'legacy-v0.1.5'):
        raise ExtractionError('Unsupported installation format')
    seen = set()
    files = {}
    modes = {}
    directories = set()
    total = 0
    try:
        with tarfile.open(fileobj=io.BytesIO(payload), mode='r:') as archive:
            for item in archive:
                name = item.name
                if name in ('.', './'):
                    name = ''
                elif name.startswith('./'):
                    name = name[2:]
                if (name.startswith('/') or '\x00' in name or any(part in ('', '.', '..') for part in name.split('/')) and name != '' or
                    name in seen or item.uid != 0 or item.gid != 0 or item.pax_headers or getattr(item, 'sparse', None)):
                    raise ExtractionError('Invalid installation archive')
                seen.add(name)
                if item.isdir():
                    if item.mode & 0o7777 != 0o755:
                        raise ExtractionError('Invalid installation archive')
                    directories.add(name)
                    continue
                if (not item.isfile() or not name or item.mode & 0o7777 not in (0o644, 0o755) or
                    item.size < 0 or item.size > MAX_FILE):
                    raise ExtractionError('Invalid installation archive')
                total += item.size
                if total > MAX_ARCHIVE:
                    raise ExtractionError('Invalid installation archive')
                source = archive.extractfile(item)
                data = source.read(item.size + 1) if source else None
                if data is None or len(data) != item.size:
                    raise ExtractionError('Invalid installation archive')
                files[name] = data
                modes[name] = item.mode & 0o7777
            # A single tar stream ends with zero blocks. Do not accept an
            # appended second stream or other content ignored by tarfile.
            trailer = payload[archive.offset:]
            if len(trailer) < 1024 or len(trailer) % 512 or any(trailer):
                raise ExtractionError('Invalid installation archive')
    except (tarfile.TarError, OSError, ValueError, OverflowError) as error:
        raise ExtractionError('Invalid installation archive') from error
    if artifact_format == 'legacy-v0.1.5':
        expected = {name: (mode, len(files.get(name, b'')), None) for name, mode in LEGACY_V015_FILES.items()}
    else:
        data = files.pop('manifest.json', None)
        manifest_mode = modes.pop('manifest.json', None)
        if data is None or manifest_mode != 0o644:
            raise ExtractionError('Installation manifest is required')
        expected = _manifest_files(data)
    if set(files) != set(expected):
        raise ExtractionError('Incomplete installation archive')
    for name, (mode, size, digest) in expected.items():
        if (modes[name] != mode or len(files[name]) != size or
            (digest is not None and hashlib.sha256(files[name]).hexdigest() != digest)):
            raise ExtractionError('Installation file differs from manifest')
    required_dirs = {''}
    for name in files:
        parts = name.split('/')[:-1]
        required_dirs.update('/'.join(parts[:end]) for end in range(1, len(parts) + 1))
    if directories != required_dirs:
        raise ExtractionError('Invalid installation directories')
    if artifact_format == 'manifest-v1':
        files['manifest.json'] = data
        modes['manifest.json'] = 0o644
    return InstallationFiles(files, modes)


def extract(image_id, parent, *, verified_platform_ids=(), probe_name=None, artifact_format='manifest-v1'):
    """Create a private installation tree from a caller-verified image ID.

    Returns an absolute path. A failed cleanup or extraction publishes no tree.
    An abrupt process or host failure can leave a stopped probe container or a
    private staging directory; a future coordinator must reconcile these before
    attempting an update. No invocation of this function starts a container.
    """
    if not isinstance(image_id, str) or not IMAGE_ID.fullmatch(image_id):
        raise ExtractionError('A verified image ID is required')
    if (not isinstance(verified_platform_ids, (tuple, list)) or len(verified_platform_ids) > 2 or
        any(not isinstance(item, str) or not IMAGE_ID.fullmatch(item) for item in verified_platform_ids)):
        raise ExtractionError('Verified platform identity is invalid')
    if probe_name is not None and (not isinstance(probe_name, str) or not PROBE_NAME.fullmatch(probe_name)):
        raise ExtractionError('Extraction probe identity is invalid')
    try:
        parent_fd = _trusted_parent(parent)
    except OSError as error:
        raise ExtractionError('Private staging directory is required') from error
    container = None
    stage = None
    try:
        observed = _docker('image', 'inspect', '--format', '{{.Id}}', image_id).decode('ascii').strip()
        selected = json.loads(_docker('image', 'inspect', '--platform=linux/amd64', '--format', '{{json .}}', image_id))
        selected_id = selected.get('Id') if isinstance(selected, dict) else None
        config = selected.get('Config') if isinstance(selected, dict) else None
        if (observed != image_id or selected_id not in (image_id, *verified_platform_ids) or
            selected.get('Os') != 'linux' or selected.get('Architecture') != 'amd64' or
            not isinstance(config, dict) or config.get('Volumes') not in (None, {})):
            raise ExtractionError('Image identity or configuration rejected')
        name_options = ('--name', probe_name, '--label', 'io.servus.updater.extraction=' + probe_name) if probe_name else ()
        created = _docker('create', '--pull=never', '--platform=linux/amd64', '--network=none', '--read-only', '--entrypoint=/bin/false', *name_options, image_id)
        container = created.decode('ascii').strip()
        if not CONTAINER_ID.fullmatch(container):
            container = None
            raise ExtractionError('Invalid probe container identity')
        state = _docker('inspect', '--format', '{{.Image}} {{.State.Status}}', container).decode('ascii').strip()
        if state not in (image_id + ' created', selected_id + ' created'):
            raise ExtractionError('Probe container identity rejected')
        if probe_name:
            identity = json.loads(_docker('inspect', '--format', '{{json .}}', container))
            if (not isinstance(identity, dict) or identity.get('Name') != '/' + probe_name or
                not isinstance(identity.get('Config'), dict) or not isinstance(identity['Config'].get('Labels'), dict) or
                identity['Config']['Labels'].get('io.servus.updater.extraction') != probe_name):
                raise ExtractionError('Probe container identity rejected')
        archive = _docker('cp', container + ':/opt/servus/install/.', '-', limit=MAX_ARCHIVE)
        files = _read_archive(archive, artifact_format=artifact_format)
        # The full set is validated before any extracted content reaches disk.
        nonce = secrets.token_hex(16)
        stage = '.servus-install-' + nonce
        os.mkdir(stage, 0o700, dir_fd=parent_fd)
        stage_path = os.path.join(parent, stage)
        for name, data in files.items():
            target = os.path.join(stage_path, name)
            os.makedirs(os.path.dirname(target), mode=0o755, exist_ok=True)
            fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, files.modes[name])
            try:
                view = memoryview(data)
                while view:
                    written = os.write(fd, view)
                    if written <= 0:
                        raise ExtractionError('Installation staging failed')
                    view = view[written:]
                os.fchmod(fd, files.modes[name])
                os.fsync(fd)
            finally:
                os.close(fd)
        for base, _, _ in os.walk(stage_path, topdown=False):
            fd = os.open(base, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
        _docker('rm', '-v', container)
        container = None
        result = 'servus-install-' + nonce
        if os.path.lexists(os.path.join(parent, result)):
            raise ExtractionError('Installation staging collision')
        os.rename(stage, result, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
        stage = result
        os.fsync(parent_fd)
        stage = None
        return os.path.join(parent, result)
    except (UnicodeError, json.JSONDecodeError, OSError, ValueError) as error:
        raise ExtractionError('Installation extraction failed') from error
    finally:
        cleanup_failed = False
        if container is not None:
            try:
                _docker('rm', '-v', container)
            except ExtractionError:
                cleanup_failed = True
        if stage is not None:
            try:
                shutil.rmtree(os.path.join(parent, stage))
                os.fsync(parent_fd)
            except OSError:
                cleanup_failed = True
        os.close(parent_fd)
        if cleanup_failed:
            raise ExtractionError('Probe container requires reconciliation')
