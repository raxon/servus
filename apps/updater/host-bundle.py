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
import secrets
import stat
import sys

NAME = re.compile(r'^[a-z0-9][a-z0-9-]{0,63}\.py$')
UNIT_NAME = re.compile(r'^servus-[a-z0-9][a-z0-9-]{0,63}\.(?:service|timer)$')
MAX_MODULE = 4 * 1024 * 1024
MAX_TOTAL = 16 * 1024 * 1024
MAX_MODULES = 128
MAX_CLI = 64 * 1024 * 1024
OPERATION = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
DIGEST = re.compile(r'^sha256:[a-f0-9]{64}$')
STAGE = re.compile(r'^servus-install-[a-f0-9]{32}$')


class HostBundleError(Exception):
    pass


def completed_update(db, operation_id, staging_parent, policy_path, active_env, image_reference):
    """Bind a host candidate to one completed, verified active panel update.

    The caller must trust the journal and paths, hold the updater and install
    locks, and independently verify the live approved policy and generation.
    """
    if (not isinstance(operation_id, str) or not OPERATION.fullmatch(operation_id) or
        any(not isinstance(path, str) or not os.path.isabs(path) or os.path.normpath(path) != path
            for path in (staging_parent, policy_path, active_env)) or
        not isinstance(image_reference, str) or not re.fullmatch(r'ghcr\.io/raxon/servus@sha256:[a-f0-9]{64}', image_reference)):
        raise HostBundleError('Invalid completed update input')
    row = db.execute("SELECT o.digest,o.config_digest,o.attempt_id,o.attempt_nonce,p.preparation_id,p.staging_path "
        "FROM operations o JOIN preparations p ON p.operation_id=o.id "
        "JOIN update_transactions t ON t.operation_id=o.id JOIN apply_requests r ON r.operation_id=o.id "
        "JOIN policy_approvals a ON a.operation_id=o.id WHERE o.id=? AND o.status='verified' "
        "AND p.status='completed' AND t.phase='completed' AND r.state='completed' AND a.state='active' "
        "AND a.policy_path=? AND a.source_env_path=? AND o.digest=t.root_digest AND o.digest=a.root_digest "
        "AND o.config_digest=a.image_config_digest AND o.attempt_id=p.attempt_id AND o.attempt_id=t.attempt_id "
        "AND o.attempt_id=a.attempt_id AND o.attempt_nonce=p.attempt_nonce AND o.attempt_nonce=t.attempt_nonce "
        "AND o.attempt_nonce=a.attempt_nonce AND p.preparation_id=t.preparation_id AND p.preparation_id=a.preparation_id",
        (operation_id, policy_path, active_env)).fetchone()
    if not row:
        raise HostBundleError('Completed update is unavailable')
    digest, config_digest, attempt, nonce, preparation, stage = row
    if (not isinstance(digest, str) or not DIGEST.fullmatch(digest) or image_reference != 'ghcr.io/raxon/servus@' + digest or
        not isinstance(config_digest, str) or not DIGEST.fullmatch(config_digest) or
        not isinstance(attempt, str) or not OPERATION.fullmatch(attempt) or
        not isinstance(preparation, str) or not OPERATION.fullmatch(preparation) or
        not isinstance(nonce, str) or not re.fullmatch(r'[a-f0-9]{64}', nonce) or
        not isinstance(stage, str) or not os.path.isabs(stage) or os.path.normpath(stage) != stage or
        os.path.dirname(stage) != staging_parent or not STAGE.fullmatch(os.path.basename(stage))):
        raise HostBundleError('Completed update identity differs')
    return digest, stage


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


def collect_units(stage_fd, manifest, required):
    """Read signed systemd units without installing or executing them."""
    info=os.fstat(stage_fd)
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid!=0 or info.st_gid!=0 or
        stat.S_IMODE(info.st_mode)!=0o700 or not isinstance(manifest,dict) or
        not isinstance(required,(tuple,list)) or not 1<=len(required)<=MAX_MODULES or
        any(not isinstance(name,str) or not UNIT_NAME.fullmatch(name) for name in required) or
        len(set(required))!=len(required)):
        raise HostBundleError('Invalid systemd unit bundle input')
    prefix='deployment/systemd/'
    selected={name:manifest.get(prefix+name) for name in required}
    if any(not isinstance(value,tuple) or len(value)!=3 or value[0]!=0o644 for value in selected.values()):
        raise HostBundleError('Incomplete or invalid systemd unit bundle')
    deployment=units=None
    try:
        deployment=_directory(stage_fd,'deployment',info.st_dev)
        units=_directory(deployment,'systemd',info.st_dev)
        result={};total=0
        for name,expected in sorted(selected.items()):
            mode,content=_read_module(units,name,expected,info.st_dev,allowed_modes=(0o644,))
            total+=len(content)
            if total>MAX_TOTAL:raise HostBundleError('Systemd unit bundle is too large')
            result[name]=(mode,content)
        return result
    finally:
        if units is not None:os.close(units)
        if deployment is not None:os.close(deployment)


def inspect_unit_adoption(units_fd, old_units, new_units, *, read_file):
    """Validate a resumable transition between two verified unit inventories.

    The caller must obtain both inventories from trusted release manifests and
    serialize this check with any later installation of the returned units.
    """
    info=os.fstat(units_fd)
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid!=0 or info.st_gid!=0 or
        stat.S_IMODE(info.st_mode)!=0o755 or not isinstance(old_units,dict) or
        not isinstance(new_units,dict) or not new_units or len(new_units)>MAX_MODULES or
        not set(old_units).issubset(new_units) or not callable(read_file)):
        raise HostBundleError('Invalid unit adoption input')
    for inventory in (old_units,new_units):
        total=0
        for name,value in inventory.items():
            if (not isinstance(name,str) or not UNIT_NAME.fullmatch(name) or
                not isinstance(value,tuple) or len(value)!=2 or value[0]!=0o644 or
                not isinstance(value[1],bytes) or len(value[1])>MAX_MODULE):
                raise HostBundleError('Invalid unit adoption inventory')
            total+=len(value[1])
            if total>MAX_TOTAL:raise HostBundleError('Unit adoption inventory is too large')
    pending=[]
    for name,(_,target) in sorted(new_units.items()):
        try:current=read_file(units_fd,name,0o644)
        except FileNotFoundError:
            if name in old_units:raise HostBundleError('Existing unit is missing') from None
            pending.append(name);continue
        if current==target:continue
        if name not in old_units or current!=old_units[name][1]:
            raise HostBundleError('Existing unit differs from verified release')
        pending.append(name)
    return tuple(pending)


def apply_unit_adoption(units_fd, old_units, new_units, *, read_file, authorize):
    """Atomically publish verified units while the caller holds adoption locks.

    The caller must first install and verify all referenced boot guards, retain
    the verified old release for recovery, and keep systemd from reloading the
    units until this operation finishes. Interrupted calls may be retried with
    the same two verified inventories. This function never reloads systemd.
    """
    if sys.platform!='linux' or os.geteuid()!=0 or not sys.flags.isolated or not callable(authorize):
        raise HostBundleError('Invalid unit adoption context')
    if authorize() is not None:raise HostBundleError('Unit adoption is not authorized')
    pending=inspect_unit_adoption(units_fd,old_units,new_units,read_file=read_file)
    for name in pending:
        if authorize() is not None:raise HostBundleError('Unit adoption is not authorized')
        remaining=inspect_unit_adoption(units_fd,old_units,new_units,read_file=read_file)
        if name not in remaining:continue
        target=new_units[name][1]
        temporary='.servus-adopt-'+secrets.token_hex(16)
        try:
            _write_file(units_fd,temporary,0o644,target)
            os.fsync(units_fd)
            if authorize() is not None:raise HostBundleError('Unit adoption is not authorized')
            if name not in inspect_unit_adoption(units_fd,old_units,new_units,read_file=read_file):
                raise HostBundleError('Unit changed during adoption')
            if name in old_units:
                os.replace(temporary,name,src_dir_fd=units_fd,dst_dir_fd=units_fd)
            else:
                os.link(temporary,name,src_dir_fd=units_fd,dst_dir_fd=units_fd,follow_symlinks=False)
                os.unlink(temporary,dir_fd=units_fd)
            os.fsync(units_fd)
        finally:
            try:os.unlink(temporary,dir_fd=units_fd)
            except FileNotFoundError:pass
    if authorize() is not None:raise HostBundleError('Unit adoption is not authorized')
    if inspect_unit_adoption(units_fd,old_units,new_units,read_file=read_file):
        raise HostBundleError('Unit adoption is incomplete')


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



def load_generation(parent_fd, operation_id, image_digest, metadata_size, metadata_sha256, required):
    """Load an intact private generation bound to protected journal metadata."""
    if (not isinstance(operation_id,str) or not OPERATION.fullmatch(operation_id) or
        not isinstance(image_digest,str) or not DIGEST.fullmatch(image_digest) or
        type(metadata_size) is not int or not 0 < metadata_size <= 65536 or
        not isinstance(metadata_sha256,str) or not re.fullmatch(r'[a-f0-9]{64}',metadata_sha256) or
        not isinstance(required,(tuple,list)) or not required or
        any(not isinstance(name,str) or not NAME.fullmatch(name) for name in required) or len(set(required))!=len(required)):
        raise HostBundleError('Invalid saved generation identity')
    parent=os.fstat(parent_fd)
    if (not stat.S_ISDIR(parent.st_mode) or parent.st_uid!=0 or parent.st_gid!=0 or stat.S_IMODE(parent.st_mode)!=0o700):
        raise HostBundleError('Unsafe generation parent')
    name='host-'+operation_id
    directory=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=parent_fd)
    try:
        info=os.fstat(directory);named=os.stat(name,dir_fd=parent_fd,follow_symlinks=False)
        if (info.st_uid!=0 or info.st_gid!=0 or stat.S_IMODE(info.st_mode)!=0o700 or info.st_dev!=parent.st_dev or
            (info.st_dev,info.st_ino)!=(named.st_dev,named.st_ino)):
            raise HostBundleError('Unsafe saved generation')
        raw=_read_module(directory,'complete.json',(0o600,metadata_size,metadata_sha256),info.st_dev,allowed_modes=(0o600,),max_size=65536)[1]
        def unique(pairs):
            result={}
            for key,value in pairs:
                if key in result:raise HostBundleError('Duplicate generation metadata field')
                result[key]=value
            return result
        try:document=json.loads(raw,object_pairs_hook=unique)
        except (ValueError,UnicodeError,RecursionError) as error:raise HostBundleError('Invalid generation metadata') from error
        if (not isinstance(document,dict) or set(document)!={'schema','operationId','imageDigest','modules'} or
            type(document['schema']) is not int or document['schema']!=1 or document['operationId']!=operation_id or
            document['imageDigest']!=image_digest or not isinstance(document['modules'],list) or
            not 1 <= len(document['modules']) <= MAX_MODULES):
            raise HostBundleError('Invalid generation metadata')
        modules={}
        for item in document['modules']:
            if (not isinstance(item,dict) or set(item)!={'name','mode','size','sha256'} or
                not isinstance(item['name'],str) or not NAME.fullmatch(item['name']) or item['name'] in modules):
                raise HostBundleError('Invalid generation record')
            mode,content=_read_module(directory,item['name'],(item['mode'],item['size'],item['sha256']),info.st_dev)
            modules[item['name']]=(mode,content)
        if not set(required).issubset(modules) or set(os.listdir(directory))!=set(modules)|{'complete.json'}:
            raise HostBundleError('Incomplete saved generation')
    finally:os.close(directory)
    verify_generation(parent_fd,operation_id,image_digest,modules)
    return modules

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
