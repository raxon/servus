#!/usr/bin/python3 -I
"""Journal reversible file masks for independently authorized host units.

The caller holds the updater and installation locks, supplies trusted original
unit bytes, and must separately reload systemd, stop processes and verify the
host fence. No service is started or stopped by this module.
"""
import hashlib
import json
import os
import re
import secrets
import stat
import subprocess
import sys

UNITS = ('servus-updater.service', 'servus-supervisor.service',
         'servus-updater-socket.service', 'servus-updater-bootstrap.service')
OPERATION = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
DIGEST = re.compile(r'^sha256:[a-f0-9]{64}$')
LIMIT = 1024 * 1024


class UnitMaskError(Exception):
    pass


def _guard(db, state, install, service_lock, install_lock, supervisor, coordinator):
    if sys.platform != 'linux' or os.geteuid() != 0 or not sys.flags.isolated or db.in_transaction or db.isolation_level is not None:
        raise UnitMaskError('An isolated, locked root coordinator is required')
    if db.execute('PRAGMA synchronous').fetchone()[0] < 2:
        raise UnitMaskError('The journal must use durable synchronization')
    coordinator._same_lock(supervisor, state, 'service.lock', service_lock)
    coordinator._same_lock(supervisor, install, 'install.lock', install_lock)
    fd = supervisor._open_root_file(state, 'journal.sqlite', 0o600)
    try:
        path = db.execute('PRAGMA database_list').fetchone()[2]
        named, opened = os.stat(path, follow_symlinks=False), os.fstat(fd)
        if (named.st_dev, named.st_ino) != (opened.st_dev, opened.st_ino):
            raise UnitMaskError('The journal identity differs')
    finally: os.close(fd)



def _systemctl(unit):
    try:
        result = subprocess.run(['/usr/bin/systemctl', 'show', unit, '--property=LoadState',
                                 '--property=ActiveState', '--property=SubState', '--property=UnitFileState'],
                                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                cwd='/', env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C', 'LC_ALL': 'C'},
                                timeout=10, check=True)
        if len(result.stdout) > 16384:
            raise UnitMaskError('Systemd unit state is too large')
        return result.stdout.decode('utf-8', 'strict')
    except (OSError, UnicodeError, subprocess.SubprocessError) as error:
        raise UnitMaskError('Systemd unit state is unavailable') from error


def capture_service_states(*, execute=_systemctl):
    """Read stable unit states before masking; never restart the bootstrap unit."""
    states = {}
    for unit in UNITS:
        properties = {}
        for line in execute(unit).splitlines():
            key, separator, value = line.partition('=')
            if not separator or key in properties:
                raise UnitMaskError('Systemd unit state is invalid')
            properties[key] = value
        if (set(properties) != {'LoadState', 'ActiveState', 'SubState', 'UnitFileState'} or
            properties['LoadState'] != 'loaded' or
            properties['UnitFileState'] not in ('enabled', 'static') or
            (properties['ActiveState'], properties['SubState']) not in
            (('active', 'running'), ('active', 'exited'), ('inactive', 'dead')) or
            (unit == 'servus-updater-bootstrap.service' and properties['ActiveState'] != 'inactive')):
            raise UnitMaskError('A host unit is not in a stable, unmasked state')
        states[unit] = properties['ActiveState']
    return states

def _metadata(operation_id, image_digest, originals, service_states):
    if (not isinstance(operation_id, str) or not OPERATION.fullmatch(operation_id) or
        not isinstance(image_digest, str) or not DIGEST.fullmatch(image_digest) or
        not isinstance(originals, dict) or set(originals) != set(UNITS) or
        any(not isinstance(value, bytes) or not 0 < len(value) <= LIMIT for value in originals.values()) or
        not isinstance(service_states, dict) or set(service_states) != set(UNITS) or
        any(value not in ('active', 'inactive') for value in service_states.values()) or
        service_states['servus-updater-bootstrap.service'] != 'inactive'):
        raise UnitMaskError('Invalid unit backup input')
    records = [{'name': name, 'size': len(originals[name]), 'sha256': hashlib.sha256(originals[name]).hexdigest(), 'activeState': service_states[name]} for name in UNITS]
    return (json.dumps({'schema': 1, 'operationId': operation_id, 'imageDigest': image_digest, 'units': records},
                       sort_keys=True, separators=(',', ':')) + '\n').encode()


def _directory(fd, mode):
    info = os.fstat(fd)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_gid != 0 or stat.S_IMODE(info.st_mode) != mode:
        raise UnitMaskError('Unsafe unit directory')
    return info


def _read(parent, name, mode, expected):
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=parent)
    try:
        before = os.fstat(fd); named = os.stat(name, dir_fd=parent, follow_symlinks=False)
        if (not stat.S_ISREG(before.st_mode) or before.st_uid != 0 or before.st_gid != 0 or before.st_nlink != 1 or
            stat.S_IMODE(before.st_mode) != mode or before.st_size != len(expected) or
            (before.st_dev, before.st_ino) != (named.st_dev, named.st_ino)):
            raise UnitMaskError('Unsafe unit file')
        data = bytearray()
        while len(data) <= len(expected):
            chunk = os.read(fd, min(65536, len(expected) + 1 - len(data)))
            if not chunk: break
            data.extend(chunk)
        after = os.fstat(fd); named = os.stat(name, dir_fd=parent, follow_symlinks=False)
        identity = lambda item: (item.st_dev, item.st_ino, item.st_size, item.st_mtime_ns, item.st_ctime_ns)
        if identity(before) != identity(after) or (named.st_dev, named.st_ino) != (before.st_dev, before.st_ino) or bytes(data) != expected:
            raise UnitMaskError('Unit file changed')
    finally: os.close(fd)


def _read_bounded(parent, name, mode, limit):
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=parent)
    try:
        before = os.fstat(fd); named = os.stat(name, dir_fd=parent, follow_symlinks=False)
        if (not stat.S_ISREG(before.st_mode) or before.st_uid != 0 or before.st_gid != 0 or before.st_nlink != 1 or
            stat.S_IMODE(before.st_mode) != mode or not 0 < before.st_size <= limit or
            (before.st_dev, before.st_ino) != (named.st_dev, named.st_ino)):
            raise UnitMaskError('Unsafe unit backup file')
        data = bytearray()
        while len(data) <= limit:
            chunk = os.read(fd, min(65536, limit + 1 - len(data)))
            if not chunk: break
            data.extend(chunk)
        after = os.fstat(fd); named = os.stat(name, dir_fd=parent, follow_symlinks=False)
        identity = lambda item: (item.st_dev, item.st_ino, item.st_size, item.st_mtime_ns, item.st_ctime_ns)
        if (len(data) != before.st_size or identity(before) != identity(after) or
            (named.st_dev, named.st_ino) != (before.st_dev, before.st_ino)):
            raise UnitMaskError('Unit backup file changed')
        return bytes(data)
    finally: os.close(fd)


def _write(parent, name, mode, data):
    fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, mode, dir_fd=parent)
    try:
        os.fchmod(fd, mode); remaining = memoryview(data)
        while remaining:
            count = os.write(fd, remaining)
            if count <= 0: raise UnitMaskError('Unit file write failed')
            remaining = remaining[count:]
        os.fsync(fd)
    finally: os.close(fd)


def _backup(state, operation_id, metadata, originals):
    name = 'unit-backup-' + operation_id
    os.mkdir(name, 0o700, dir_fd=state); os.fsync(state)
    fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=state)
    try:
        _directory(fd, 0o700)
        for unit in UNITS: _write(fd, unit, 0o600, originals[unit])
        os.fsync(fd); _write(fd, 'complete.json', 0o600, metadata); os.fsync(fd); os.fsync(state)
    finally: os.close(fd)
    return name


def _verify_backup(state, operation_id, metadata, originals):
    name = 'unit-backup-' + operation_id
    fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=state)
    try:
        _directory(fd, 0o700)
        if set(os.listdir(fd)) != set(UNITS) | {'complete.json'}: raise UnitMaskError('Incomplete unit backup')
        _read(fd, 'complete.json', 0o600, metadata)
        for unit in UNITS: _read(fd, unit, 0o600, originals[unit])
    finally: os.close(fd)


def load_verified_backup(db, operation_id, image_digest, state):
    """Load only an intact backup bound to the durable unit mask journal."""
    _directory(state, 0o700)
    if (not isinstance(operation_id, str) or not OPERATION.fullmatch(operation_id) or
        not isinstance(image_digest, str) or not DIGEST.fullmatch(image_digest)):
        raise UnitMaskError('Invalid unit recovery identity')
    row = db.execute('SELECT image_digest,backup_digest,phase FROM host_unit_masks WHERE operation_id=?', (operation_id,)).fetchone()
    if (not row or row[0] != image_digest or not isinstance(row[1], str) or not re.fullmatch(r'[a-f0-9]{64}', row[1]) or
        row[2] not in ('backed_up', 'masking', 'masked', 'restoring', 'restored')):
        raise UnitMaskError('Unit recovery is unavailable')
    fd = os.open('unit-backup-' + operation_id, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=state)
    try:
        _directory(fd, 0o700)
        if set(os.listdir(fd)) != set(UNITS) | {'complete.json'}: raise UnitMaskError('Incomplete unit backup')
        raw = _read_bounded(fd, 'complete.json', 0o600, 32768)
        if hashlib.sha256(raw).hexdigest() != row[1]: raise UnitMaskError('Unit backup metadata differs')
        def unique(pairs):
            result = {}
            for key, value in pairs:
                if key in result: raise UnitMaskError('Duplicate unit backup field')
                result[key] = value
            return result
        try: document = json.loads(raw, object_pairs_hook=unique)
        except (ValueError, UnicodeError, RecursionError) as error: raise UnitMaskError('Invalid unit backup metadata') from error
        if (not isinstance(document, dict) or set(document) != {'schema', 'operationId', 'imageDigest', 'units'} or
            type(document['schema']) is not int or document['schema'] != 1 or document['operationId'] != operation_id or
            document['imageDigest'] != image_digest or not isinstance(document['units'], list) or len(document['units']) != len(UNITS)):
            raise UnitMaskError('Invalid unit backup metadata')
        originals = {}
        service_states = {}
        for name, item in zip(UNITS, document['units']):
            if (not isinstance(item, dict) or set(item) != {'name', 'size', 'sha256', 'activeState'} or item['name'] != name or
                type(item['size']) is not int or not 0 < item['size'] <= LIMIT or
                not isinstance(item['sha256'], str) or not re.fullmatch(r'[a-f0-9]{64}', item['sha256'])):
                raise UnitMaskError('Invalid unit backup metadata')
            data = _read_bounded(fd, name, 0o600, LIMIT)
            if len(data) != item['size'] or hashlib.sha256(data).hexdigest() != item['sha256']:
                raise UnitMaskError('Unit backup differs')
            originals[name] = data
            service_states[name] = item['activeState']
        if _metadata(operation_id, image_digest, originals, service_states) != raw: raise UnitMaskError('Unit backup metadata is not canonical')
        return originals, service_states
    finally: os.close(fd)


def _masked(parent, unit):
    try: info = os.stat(unit, dir_fd=parent, follow_symlinks=False)
    except FileNotFoundError: return False
    return stat.S_ISLNK(info.st_mode) and info.st_uid == 0 and info.st_gid == 0 and os.readlink(unit, dir_fd=parent) == '/dev/null'


def _replace_with_mask(parent, unit):
    temporary = '.servus-mask-' + secrets.token_hex(16)
    os.symlink('/dev/null', temporary, dir_fd=parent)
    try: os.replace(temporary, unit, src_dir_fd=parent, dst_dir_fd=parent); os.fsync(parent)
    finally:
        try: os.unlink(temporary, dir_fd=parent)
        except FileNotFoundError: pass


def _replace_with_original(parent, unit, content):
    temporary = '.servus-unit-' + secrets.token_hex(16)
    try:
        _write(parent, temporary, 0o644, content)
        if not _masked(parent, unit): raise UnitMaskError('Unit mask changed')
        os.replace(temporary, unit, src_dir_fd=parent, dst_dir_fd=parent); os.fsync(parent)
    finally:
        try: os.unlink(temporary, dir_fd=parent)
        except FileNotFoundError: pass


def mask_units(db, operation_id, image_digest, originals, *, state, install, units,
               service_lock, install_lock, supervisor, coordinator, execute=_systemctl,
               initial_states=None, host_lock=None):
    """Back up expected files, then install persistent masks under journal intent."""
    _guard(db, state, install, service_lock, install_lock, supervisor, coordinator)
    _directory(state, 0o700); _directory(install, 0o700); _directory(units, 0o755)
    observed_states = capture_service_states(execute=execute)
    if initial_states is None:
        service_states = observed_states
    else:
        coordinator._same_lock(supervisor, state, 'host.lock', host_lock)
        _metadata(operation_id, image_digest, originals, initial_states)
        expected = dict(initial_states)
        if any(initial_states[unit] != 'active' for unit in UNITS[:-1]):
            raise UnitMaskError('The host services were not active before startup')
        expected['servus-updater.service'] = 'inactive'
        if observed_states != expected:
            raise UnitMaskError('Host unit states changed during updater stop')
        service_states = initial_states
    metadata = _metadata(operation_id, image_digest, originals, service_states)
    row = db.execute('SELECT image_digest,generation,status FROM host_preparations WHERE operation_id=?', (operation_id,)).fetchone()
    if row != (image_digest, 'runtime-' + operation_id, 'prepared'): raise UnitMaskError('Prepared host generation is unavailable')
    for unit in UNITS: _read(units, unit, 0o644, originals[unit])
    _guard(db, state, install, service_lock, install_lock, supervisor, coordinator)
    db.execute('BEGIN IMMEDIATE')
    try:
        db.execute("CREATE TABLE IF NOT EXISTS host_unit_masks (operation_id TEXT PRIMARY KEY,image_digest TEXT NOT NULL,backup_digest TEXT,phase TEXT NOT NULL CHECK(phase IN ('intent','backed_up','masking','masked','restoring','restored'))) ")
        db.execute("CREATE UNIQUE INDEX IF NOT EXISTS one_active_host_unit_mask ON host_unit_masks ((1)) WHERE phase != 'restored'")
        db.execute("INSERT INTO host_unit_masks VALUES(?,?,NULL,'intent')", (operation_id, image_digest))
        db.execute('COMMIT')
    except BaseException:
        if db.in_transaction: db.execute('ROLLBACK')
        raise
    _backup(state, operation_id, metadata, originals)
    _verify_backup(state, operation_id, metadata, originals)
    digest = hashlib.sha256(metadata).hexdigest()
    if db.execute("UPDATE host_unit_masks SET phase='backed_up',backup_digest=? WHERE operation_id=? AND phase='intent'", (digest, operation_id)).rowcount != 1:
        raise UnitMaskError('Unit mask journal changed')
    _guard(db, state, install, service_lock, install_lock, supervisor, coordinator)
    for unit in UNITS: _read(units, unit, 0o644, originals[unit])
    if capture_service_states(execute=execute) != observed_states:
        raise UnitMaskError('Host unit states changed before masking')
    if initial_states is not None:
        coordinator._same_lock(supervisor, state, 'host.lock', host_lock)
    if db.execute("UPDATE host_unit_masks SET phase='masking' WHERE operation_id=? AND phase='backed_up' AND backup_digest=?", (operation_id, digest)).rowcount != 1:
        raise UnitMaskError('Unit mask journal changed')
    for unit in UNITS:
        _guard(db, state, install, service_lock, install_lock, supervisor, coordinator)
        _read(units, unit, 0o644, originals[unit]); _replace_with_mask(units, unit)
    if not all(_masked(units, unit) for unit in UNITS): raise UnitMaskError('A unit mask changed')
    if db.execute("UPDATE host_unit_masks SET phase='masked' WHERE operation_id=? AND phase='masking'", (operation_id,)).rowcount != 1:
        raise UnitMaskError('Unit mask journal changed')


def restore_units(db, operation_id, image_digest, originals, service_states, *, state, install, units,
                  service_lock, install_lock, supervisor, coordinator):
    """Restore only verified backups and exact masks, including partial masking."""
    _guard(db, state, install, service_lock, install_lock, supervisor, coordinator)
    _directory(state, 0o700); _directory(install, 0o700); _directory(units, 0o755)
    metadata = _metadata(operation_id, image_digest, originals, service_states); digest = hashlib.sha256(metadata).hexdigest()
    row = db.execute('SELECT image_digest,backup_digest,phase FROM host_unit_masks WHERE operation_id=?', (operation_id,)).fetchone()
    if not row or row[:2] != (image_digest, digest) or row[2] not in ('backed_up', 'masking', 'masked', 'restoring'):
        raise UnitMaskError('Unit recovery is unavailable')
    _verify_backup(state, operation_id, metadata, originals)
    for unit in UNITS:
        if not _masked(units, unit): _read(units, unit, 0o644, originals[unit])
    if row[2] != 'restoring' and db.execute("UPDATE host_unit_masks SET phase='restoring' WHERE operation_id=? AND phase=?", (operation_id, row[2])).rowcount != 1:
        raise UnitMaskError('Unit mask journal changed')
    for unit in UNITS:
        _guard(db, state, install, service_lock, install_lock, supervisor, coordinator)
        if _masked(units, unit): _replace_with_original(units, unit, originals[unit])
        _read(units, unit, 0o644, originals[unit])
    if db.execute("UPDATE host_unit_masks SET phase='restored' WHERE operation_id=? AND phase='restoring'", (operation_id,)).rowcount != 1:
        raise UnitMaskError('Unit mask journal changed')


def restore_from_journal(db, operation_id, image_digest, *, state, install, units,
                         service_lock, install_lock, supervisor, coordinator):
    """Recover from the protected journal and backup without external unit bytes."""
    _guard(db, state, install, service_lock, install_lock, supervisor, coordinator)
    originals, service_states = load_verified_backup(db, operation_id, image_digest, state)
    restore_units(db, operation_id, image_digest, originals, service_states, state=state, install=install, units=units,
                  service_lock=service_lock, install_lock=install_lock, supervisor=supervisor, coordinator=coordinator)
    return service_states


def reconcile_unmasked_intent(db, operation_id, image_digest, originals, service_states, *, state, install, units,
                              service_lock, install_lock, supervisor, coordinator):
    """Retire a pre-backup intent only after every trusted original is intact.

    The caller supplies originals from the previously authenticated host
    generation and independently checks that no host switch began. Any
    partial backup is retained for independent inspection.
    """
    _guard(db, state, install, service_lock, install_lock, supervisor, coordinator)
    _directory(state, 0o700); _directory(install, 0o700); _directory(units, 0o755)
    _metadata(operation_id, image_digest, originals, service_states)
    row = db.execute('SELECT image_digest,backup_digest,phase FROM host_unit_masks WHERE operation_id=?', (operation_id,)).fetchone()
    if row != (image_digest, None, 'intent'):
        raise UnitMaskError('Unit intent is not eligible for reconciliation')
    for unit in UNITS: _read(units, unit, 0o644, originals[unit])
    _guard(db, state, install, service_lock, install_lock, supervisor, coordinator)
    if db.execute("UPDATE host_unit_masks SET phase='restored' WHERE operation_id=? AND image_digest=? AND phase='intent' AND backup_digest IS NULL", (operation_id, image_digest)).rowcount != 1:
        raise UnitMaskError('Unit mask journal changed')


def assert_restored(db, operation_id, image_digest, *, state, units, execute=_systemctl):
    """Check protected unit bytes and their recorded stable runtime states.

    The caller must hold the installation and updater locks and separately
    verify the authenticated control plane before completing the exchange.
    """
    _directory(state, 0o700); _directory(units, 0o755)
    originals, expected = load_verified_backup(db, operation_id, image_digest, state)
    row = db.execute('SELECT image_digest,phase FROM host_unit_masks WHERE operation_id=?', (operation_id,)).fetchone()
    if row != (image_digest, 'restored'):
        raise UnitMaskError('Unit restoration is not complete')
    for unit in UNITS:
        _read(units, unit, 0o644, originals[unit])
    if capture_service_states(execute=execute) != expected:
        raise UnitMaskError('Host unit state differs from its recorded state')
    for unit in UNITS:
        _read(units, unit, 0o644, originals[unit])
    if capture_service_states(execute=execute) != expected:
        raise UnitMaskError('Host unit state changed during verification')
