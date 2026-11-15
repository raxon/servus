#!/usr/bin/python3 -I
"""Read host modules from a previously verified private release tree.

This is an integrity primitive, not an authorization or installation step.
The root coordinator must bind the supplied manifest and directory to the
verified image and the active update journal before using the returned bytes.
"""
import ast
import hashlib
import json
import os
import re
import stat

NAME = re.compile(r'^[a-z0-9][a-z0-9-]{0,63}\.py$')
MAX_MODULE = 4 * 1024 * 1024
MAX_TOTAL = 16 * 1024 * 1024
MAX_MODULES = 128
MAX_CLI = 64 * 1024 * 1024
OPERATION = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
DIGEST = re.compile(r'^sha256:[a-f0-9]{64}$')


class HostBundleError(Exception):
    pass


def _directory(parent, name, device):
    fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent)
    try:
        current = os.stat(name, dir_fd=parent, follow_symlinks=False)
        info = os.fstat(fd)
        if (not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_gid != 0 or
            stat.S_IMODE(info.st_mode) != 0o755 or info.st_dev != device or
            (info.st_dev, info.st_ino) != (current.st_dev, current.st_ino)):
            raise HostBundleError('Unsafe module directory')
        return fd
    except BaseException:
        os.close(fd)
        raise


def _read_module(directory, name, expected, device, *, allowed_modes=(0o644, 0o755), max_size=MAX_MODULE):
    mode, size, digest = expected
    if (type(mode) is not int or mode not in allowed_modes or type(size) is not int or
        not 0 <= size <= max_size or not isinstance(digest, str) or not re.fullmatch(r'[a-f0-9]{64}', digest)):
        raise HostBundleError('Invalid module manifest')
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=directory)
    try:
        before = os.fstat(fd)
        named = os.stat(name, dir_fd=directory, follow_symlinks=False)
        if (not stat.S_ISREG(before.st_mode) or before.st_uid != 0 or before.st_gid != 0 or
            before.st_dev != device or before.st_nlink != 1 or stat.S_IMODE(before.st_mode) != mode or
            before.st_size != size or (before.st_dev, before.st_ino) != (named.st_dev, named.st_ino)):
            raise HostBundleError('Unsafe module file')
        chunks = bytearray()
        while len(chunks) <= size:
            chunk = os.read(fd, min(65536, size + 1 - len(chunks)))
            if not chunk:
                break
            chunks.extend(chunk)
        after = os.fstat(fd)
        named = os.stat(name, dir_fd=directory, follow_symlinks=False)
        identity = lambda value: (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns)
        if (len(chunks) != size or identity(before) != identity(after) or
            (named.st_dev, named.st_ino) != (before.st_dev, before.st_ino) or
            hashlib.sha256(chunks).hexdigest() != digest):
            raise HostBundleError('Module changed or differs from its manifest')
        return mode, bytes(chunks)
    finally:
        os.close(fd)


def _write_file(directory, filename, mode, content):
    fd = os.open(filename, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, mode, dir_fd=directory)
    try:
        os.fchmod(fd, mode)
        view = memoryview(content)
        while view:
            written = os.write(fd, view)
            if written <= 0:
                raise HostBundleError('Generation write failed')
            view = view[written:]
        os.fsync(fd)
    finally:
        os.close(fd)


def collect(stage_fd, manifest, required):
    """Return validated module bytes without executing or installing them."""
    info = os.fstat(stage_fd)
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_gid != 0 or
        stat.S_IMODE(info.st_mode) != 0o700 or not isinstance(manifest, dict) or
        not isinstance(required, (tuple, list)) or not required or
        any(not isinstance(name, str) or not NAME.fullmatch(name) for name in required) or
        len(set(required)) != len(required)):
        raise HostBundleError('Invalid host bundle input')
    prefix = 'apps/updater/'
    selected = {path[len(prefix):]: value for path, value in manifest.items()
                if isinstance(path, str) and path.startswith(prefix)}
    if (not 1 <= len(selected) <= MAX_MODULES or
        any(not NAME.fullmatch(name) for name in selected) or not set(required).issubset(selected)):
        raise HostBundleError('Incomplete or invalid host bundle')
    apps = updater = None
    try:
        apps = _directory(stage_fd, 'apps', info.st_dev)
        updater = _directory(apps, 'updater', info.st_dev)
        result = {}
        total = 0
        for name in sorted(selected):
            expected = selected[name]
            if not isinstance(expected, tuple) or len(expected) != 3:
                raise HostBundleError('Invalid module manifest')
            mode, content = _read_module(updater, name, expected, info.st_dev)
            total += len(content)
            if total > MAX_TOTAL:
                raise HostBundleError('Host bundle is too large')
            result[name] = (mode, content)
        return result
    finally:
        if updater is not None:
            os.close(updater)
        if apps is not None:
            os.close(apps)


def read_pinned_cli(host_fd, pinned):
    """Read the existing CLI only when it matches trusted pinned metadata.

    The caller supplies the architecture-specific entry from the trusted host
    installer. A release manifest or panel request must not choose this pin.
    """
    host = os.fstat(host_fd)
    if (not stat.S_ISDIR(host.st_mode) or host.st_uid != 0 or host.st_gid != 0 or
        stat.S_IMODE(host.st_mode) != 0o755 or not isinstance(pinned, tuple) or len(pinned) != 3 or
        any(not isinstance(value, str) or not re.fullmatch(r'[a-f0-9]{64}', value) for value in pinned[:2]) or
        type(pinned[2]) is not int or not 0 < pinned[2] <= MAX_CLI):
        raise HostBundleError('Invalid pinned CLI input')
    directory = _directory(host_fd, 'bin', host.st_dev)
    try:
        if set(os.listdir(directory)) != {'gh'}:
            raise HostBundleError('Unexpected CLI directory contents')
        return _read_module(directory, 'gh', (0o755, pinned[2], pinned[1]), host.st_dev,
                            allowed_modes=(0o755,), max_size=MAX_CLI)[1]
    finally:
        os.close(directory)


def check_cli_compatibility(modules, architecture, current_pin):
    """Reject a candidate that changes the current trusted CLI pin.

    Parsing uses only literal data; no code from the candidate is executed.
    Updating the CLI itself requires a separate verified migration.
    """
    if (not isinstance(modules, dict) or architecture not in ('amd64', 'arm64') or
        not isinstance(current_pin, tuple) or len(current_pin) != 3):
        raise HostBundleError('Invalid CLI compatibility input')
    value = modules.get('install-gh.py')
    if (not isinstance(value, tuple) or len(value) != 2 or value[0] != 0o644 or
        not isinstance(value[1], bytes) or len(value[1]) > MAX_MODULE):
        raise HostBundleError('CLI installer is unavailable')
    try:
        tree = ast.parse(value[1], filename='install-gh.py')
        assignments = [node for node in tree.body if isinstance(node, ast.Assign) and
                       len(node.targets) == 1 and isinstance(node.targets[0], ast.Name) and node.targets[0].id == 'PINNED']
        if len(assignments) != 1 or not isinstance(assignments[0].value, ast.Dict):
            raise HostBundleError('CLI pin is not a static mapping')
        target = assignments[0].targets[0]
        defaults = [default for node in tree.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == 'install'
                    for argument, default in zip(node.args.kwonlyargs, node.args.kw_defaults) if argument.arg == 'pinned']
        if len(defaults) != 1 or not isinstance(defaults[0], ast.Name) or defaults[0].id != 'PINNED':
            raise HostBundleError('CLI installer does not use the static pin')
        if any((isinstance(node, ast.Name) and node.id == 'PINNED' and node is not target and node is not defaults[0]) or
               (isinstance(node, ast.Global) and 'PINNED' in node.names) for node in ast.walk(tree)):
            raise HostBundleError('CLI pin is modified dynamically')
        mapping = assignments[0].value
        keys = [ast.literal_eval(key) for key in mapping.keys]
        if any(not isinstance(key, str) for key in keys) or len(set(keys)) != len(keys):
            raise HostBundleError('CLI pin has duplicate or invalid architectures')
        pins = ast.literal_eval(mapping)
        if not isinstance(pins, dict) or pins.get(architecture) != current_pin:
            raise HostBundleError('Candidate CLI pin requires a separate migration')
    except (SyntaxError, ValueError, TypeError, MemoryError, RecursionError) as error:
        raise HostBundleError('Candidate CLI pin is invalid') from error


def _generation_metadata(parent_fd, operation_id, image_digest, modules):
    parent = os.fstat(parent_fd)
    if (not stat.S_ISDIR(parent.st_mode) or parent.st_uid != 0 or parent.st_gid != 0 or
        stat.S_IMODE(parent.st_mode) != 0o700 or not isinstance(operation_id, str) or
        not OPERATION.fullmatch(operation_id) or not isinstance(image_digest, str) or
        not DIGEST.fullmatch(image_digest) or not isinstance(modules, dict) or
        not 1 <= len(modules) <= MAX_MODULES):
        raise HostBundleError('Invalid generation input')
    total = 0
    records = []
    if any(not isinstance(name, str) for name in modules):
        raise HostBundleError('Invalid generation module')
    for name, value in sorted(modules.items()):
        if (not isinstance(name, str) or not NAME.fullmatch(name) or not isinstance(value, tuple) or
            len(value) != 2 or type(value[0]) is not int or value[0] not in (0o644, 0o755) or
            not isinstance(value[1], bytes) or len(value[1]) > MAX_MODULE):
            raise HostBundleError('Invalid generation module')
        mode, content = value
        total += len(content)
        if total > MAX_TOTAL:
            raise HostBundleError('Host bundle is too large')
        records.append({'name': name, 'mode': mode, 'size': len(content), 'sha256': hashlib.sha256(content).hexdigest()})
    return parent, records, (json.dumps({'schema': 1, 'operationId': operation_id, 'imageDigest': image_digest,
                                        'modules': records}, sort_keys=True, separators=(',', ':')) + '\n').encode()


def verify_generation(parent_fd, operation_id, image_digest, modules):
    """Recheck a candidate against bytes from the authenticated release."""
    parent, records, content = _generation_metadata(parent_fd, operation_id, image_digest, modules)
    name = 'host-' + operation_id
    directory = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent_fd)
    try:
        info = os.fstat(directory)
        named = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
        if (info.st_uid != 0 or info.st_gid != 0 or stat.S_IMODE(info.st_mode) != 0o700 or
            info.st_dev != parent.st_dev or (info.st_dev, info.st_ino) != (named.st_dev, named.st_ino) or
            set(os.listdir(directory)) != {record['name'] for record in records} | {'complete.json'}):
            raise HostBundleError('Invalid generation directory')
        metadata = _read_module(directory, 'complete.json', (0o600, len(content), hashlib.sha256(content).hexdigest()), info.st_dev, allowed_modes=(0o600,))
        if metadata[1] != content:
            raise HostBundleError('Generation metadata differs')
        for record in records:
            expected = (record['mode'], record['size'], record['sha256'])
            if _read_module(directory, record['name'], expected, info.st_dev)[1] != modules[record['name']][1]:
                raise HostBundleError('Generation module differs')
        return name
    finally:
        os.close(directory)


def stage_generation(parent_fd, operation_id, image_digest, modules):
    """Write a candidate; the caller must separately authorize activation.

    A crash may leave an incomplete directory. The completion record is written
    last, and an existing generation is never replaced or silently repaired.
    """
    parent, records, content = _generation_metadata(parent_fd, operation_id, image_digest, modules)
    name = 'host-' + operation_id
    os.mkdir(name, 0o700, dir_fd=parent_fd)
    os.fsync(parent_fd)
    directory = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent_fd)
    try:
        info = os.fstat(directory)
        named = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
        if (info.st_uid != 0 or info.st_gid != 0 or stat.S_IMODE(info.st_mode) != 0o700 or
            info.st_dev != parent.st_dev or (info.st_dev, info.st_ino) != (named.st_dev, named.st_ino)):
            raise HostBundleError('Unsafe generation directory')
        for record in records:
            _write_file(directory, record['name'], record['mode'], modules[record['name']][1])
        os.fsync(directory)
        _write_file(directory, 'complete.json', 0o600, content)
        os.fsync(directory)
        os.fsync(parent_fd)
    finally:
        os.close(directory)
    return verify_generation(parent_fd, operation_id, image_digest, modules)


def _runtime_metadata(parent_fd, operation_id, image_digest, modules, cli, pin):
    parent, records, _ = _generation_metadata(parent_fd, operation_id, image_digest, modules)
    if (not isinstance(pin, tuple) or len(pin) != 3 or
        any(not isinstance(value, str) or not re.fullmatch(r'[a-f0-9]{64}', value) for value in pin[:2]) or
        type(pin[2]) is not int or not 0 < pin[2] <= MAX_CLI or not isinstance(cli, bytes) or
        len(cli) != pin[2] or hashlib.sha256(cli).hexdigest() != pin[1]):
        raise HostBundleError('Pinned CLI differs')
    document = {'schema': 1, 'operationId': operation_id, 'imageDigest': image_digest,
                'modules': records, 'cli': {'sha256': pin[1], 'size': pin[2]}}
    return parent, records, (json.dumps(document, sort_keys=True, separators=(',', ':')) + '\n').encode()


def verify_runtime_tree(parent_fd, operation_id, image_digest, modules, cli, pin):
    """Recheck every executable byte in a candidate before any activation."""
    parent, records, metadata = _runtime_metadata(parent_fd, operation_id, image_digest, modules, cli, pin)
    name = 'runtime-' + operation_id
    directory = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent_fd)
    try:
        info = os.fstat(directory)
        named = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
        if (info.st_uid != 0 or info.st_gid != 0 or stat.S_IMODE(info.st_mode) != 0o755 or
            info.st_dev != parent.st_dev or (info.st_dev, info.st_ino) != (named.st_dev, named.st_ino) or
            set(os.listdir(directory)) != {record['name'] for record in records} | {'complete.json', 'bin'}):
            raise HostBundleError('Invalid runtime generation')
        expected = (0o600, len(metadata), hashlib.sha256(metadata).hexdigest())
        if _read_module(directory, 'complete.json', expected, info.st_dev, allowed_modes=(0o600,))[1] != metadata:
            raise HostBundleError('Runtime metadata differs')
        for record in records:
            expected = (record['mode'], record['size'], record['sha256'])
            if _read_module(directory, record['name'], expected, info.st_dev)[1] != modules[record['name']][1]:
                raise HostBundleError('Runtime module differs')
        if read_pinned_cli(directory, pin) != cli:
            raise HostBundleError('Runtime CLI differs')
        return name
    finally:
        os.close(directory)


def stage_runtime_tree(parent_fd, operation_id, image_digest, modules, cli, pin):
    """Stage a readable runtime tree but do not start or activate it."""
    parent, records, metadata = _runtime_metadata(parent_fd, operation_id, image_digest, modules, cli, pin)
    name = 'runtime-' + operation_id
    os.mkdir(name, 0o700, dir_fd=parent_fd)
    os.fsync(parent_fd)
    directory = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent_fd)
    try:
        info = os.fstat(directory)
        named = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
        if (info.st_uid != 0 or info.st_gid != 0 or info.st_dev != parent.st_dev or
            (info.st_dev, info.st_ino) != (named.st_dev, named.st_ino)):
            raise HostBundleError('Unsafe runtime generation')
        os.fchmod(directory, 0o755)
        for record in records:
            _write_file(directory, record['name'], record['mode'], modules[record['name']][1])
        os.mkdir('bin', 0o700, dir_fd=directory)
        binary = os.open('bin', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=directory)
        try:
            os.fchmod(binary, 0o755)
            _write_file(binary, 'gh', 0o755, cli)
            os.fsync(binary)
        finally:
            os.close(binary)
        os.fsync(directory)
        _write_file(directory, 'complete.json', 0o600, metadata)
        os.fsync(directory)
        os.fsync(parent_fd)
    finally:
        os.close(directory)
    return verify_runtime_tree(parent_fd, operation_id, image_digest, modules, cli, pin)
