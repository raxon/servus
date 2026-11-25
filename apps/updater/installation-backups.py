#!/usr/bin/python3 -I
"""Protected installation snapshot journal and authenticated capture coordinator.

The caller holds the installation lock and supplies root-approved policy,
modules and executables. Public requests supply an identity and a display name,
never a filesystem path. This module does not restore live application data.
"""
import gzip
import hashlib
import fcntl
import hmac
import io
import json
import os
import re
import select
import stat
import tarfile
import time

UUID = re.compile(r'^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$')
HEX = re.compile(r'^[a-f0-9]{64}$')
DIGEST = re.compile(r'^sha256:[a-f0-9]{64}$')
TERMINAL = ('completed', 'failed', 'cancelled')
STATES = ('requested', 'capturing', 'verified', 'starting', 'recovering', 'completed', 'failed', 'cancelled', 'recovery_required')
MAX_RECORD = 16384
MAX_DOWNLOAD_ARCHIVE = 64 * 1024 * 1024


class BackupError(Exception):
    pass


def _uuid(value):
    return isinstance(value, str) and UUID.fullmatch(value)


def _name(value):
    return (isinstance(value, str) and 1 <= len(value) <= 100 and value == value.strip() and
            not any(ord(char) < 32 or ord(char) == 127 or 0xd800 <= ord(char) <= 0xdfff for char in value))


def approval_message(receipt, *, purpose='submit'):
    """One fixed UTF-8 representation, shared with the administrator API."""
    required = {'version', 'operationId', 'actorId', 'name', 'issuedAt', 'proof'}
    if (not isinstance(receipt, dict) or set(receipt) != required or type(receipt['version']) is not int or
        receipt['version'] != 1 or not _uuid(receipt['operationId']) or not _uuid(receipt['actorId']) or
        not _name(receipt['name']) or type(receipt['issuedAt']) is not int or receipt['issuedAt'] < 0 or
        not isinstance(receipt['proof'], str) or not HEX.fullmatch(receipt['proof'])):
        raise BackupError('Invalid administrator approval')
    if purpose not in ('submit', 'cancel', 'delete', 'download'):
        raise BackupError('Invalid administrator approval purpose')
    prefix = ('servus-installation-backup-v1\0' if purpose == 'submit' else
              'servus-installation-backup-cancel-v1\0' if purpose == 'cancel' else
              'servus-installation-backup-delete-v1\0' if purpose == 'delete' else
              'servus-installation-backup-download-v1\0')
    return (prefix + receipt['operationId'] + '\0' + receipt['actorId'] + '\0' +
            str(receipt['issuedAt']) + '\0' + receipt['name']).encode('utf-8')


def verify_approval(receipt, api_token, *, now_ms=None, purpose='submit'):
    """Require the API role's separately mounted key, not only a peer UID.

    The API signs only after its administrator/session/CSRF/origin checks. The
    host treats that API process, its installed image and root as trusted.
    """
    message = approval_message(receipt, purpose=purpose)
    now = int(time.time() * 1000) if now_ms is None else now_ms
    if (type(now) is not int or not isinstance(api_token, str) or not HEX.fullmatch(api_token) or
        abs(now - receipt['issuedAt']) > 60000 or
        not hmac.compare_digest(hmac.new(bytes.fromhex(api_token), message, hashlib.sha256).hexdigest(), receipt['proof'])):
        raise BackupError('Administrator approval is unavailable or expired')
    return {key: receipt[key] for key in ('operationId', 'actorId', 'name', 'issuedAt')}


def _pairs(items):
    result = {}
    for key, value in items:
        if key in result:
            raise BackupError('Duplicate journal field')
        result[key] = value
    return result


class BackupJournal:
    """Borrow a real maintenance context; every write rechecks install.lock."""
    def __init__(self, maintenance, supervisor):
        if not isinstance(maintenance, supervisor.MaintenanceSupervisor):
            raise BackupError('A protected maintenance context is required')
        self.maintenance, self.supervisor, self.directory = maintenance, supervisor, None
        self._locked()
        try:
            os.mkdir('installation-backups', 0o700, dir_fd=maintenance.journal)
            os.fsync(maintenance.journal)
        except FileExistsError:
            pass
        fd = os.open('installation-backups', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
                     dir_fd=maintenance.journal)
        info = os.fstat(fd)
        if info.st_uid != 0 or info.st_gid != 0 or stat.S_IMODE(info.st_mode) != 0o700:
            os.close(fd)
            raise BackupError('Unsafe installation backup journal')
        self.directory = fd

    def close(self):
        if self.directory is not None:
            os.close(self.directory)
            self.directory = None

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()

    def _locked(self):
        self.supervisor._assert_exclusive_flock(self.maintenance.install_lock)
        info = os.fstat(self.maintenance.install_lock)
        named = os.stat('install.lock', dir_fd=self.maintenance.install, follow_symlinks=False)
        if (info.st_dev, info.st_ino) != (named.st_dev, named.st_ino):
            raise BackupError('Installation lock changed')

    def _read(self, name):
        self._locked()
        fd = self.supervisor._open_root_file(self.directory, name, 0o600)
        try:
            raw = os.read(fd, MAX_RECORD + 1)
            if len(raw) > MAX_RECORD:
                raise BackupError('Backup journal exceeds its limit')
            value = json.loads(raw, object_pairs_hook=_pairs)
            if not isinstance(value, dict):
                raise BackupError('Invalid backup journal')
            return value
        except (ValueError, UnicodeError, RecursionError) as error:
            raise BackupError('Invalid backup journal') from error
        finally:
            os.close(fd)

    def _write(self, name, value):
        self._locked()
        raw = json.dumps(value, separators=(',', ':'), ensure_ascii=False).encode('utf-8') + b'\n'
        if len(raw) > MAX_RECORD:
            raise BackupError('Backup journal exceeds its limit')
        self.supervisor._atomic_file(self.directory, name, raw, 0o600)

    def get(self, operation_id):
        if not _uuid(operation_id):
            raise BackupError('Invalid backup identity')
        value = self._read(operation_id + '.json')
        return self._validate(value, operation_id)

    def _validate(self, value, operation_id):
        expected = {'version', 'operationId', 'actorId', 'name', 'issuedAt', 'state', 'createdAt', 'updatedAt',
                    'policyBinding', 'containers', 'snapshotPath', 'manifestDigest', 'errorCode'}
        if (set(value) != expected or type(value['version']) is not int or value['version'] != 1 or
            value['operationId'] != operation_id or not _uuid(value['actorId']) or not _name(value['name']) or
            value['state'] not in STATES or any(type(value[key]) is not int or value[key] < 0
                                                for key in ('issuedAt', 'createdAt', 'updatedAt')) or
            value['errorCode'] not in (None, 'capture_failed', 'resume_required')):
            raise BackupError('Invalid backup journal identity')
        binding, containers = value['policyBinding'], value['containers']
        if binding is not None and (not isinstance(binding, list) or len(binding) != 3 or
            not isinstance(binding[0], str) or not os.path.isabs(binding[0]) or os.path.normpath(binding[0]) != binding[0] or
            any(not isinstance(item, str) or not DIGEST.fullmatch(item) for item in binding[1:])):
            raise BackupError('Invalid backup policy binding')
        if containers is not None and (not isinstance(containers, dict) or set(containers) != set(self.supervisor.ROLES) or
            any(not isinstance(item, str) or not HEX.fullmatch(item) for item in containers.values()) or
            len(set(containers.values())) != len(self.supervisor.ROLES)):
            raise BackupError('Invalid backup container identity')
        if (binding is None) != (containers is None):
            raise BackupError('Backup generation is incomplete')
        if value['state'] in ('capturing', 'verified', 'starting', 'recovering', 'completed') and (binding is None or containers is None):
            raise BackupError('Backup lacks a captured generation')
        if value['snapshotPath'] is not None and (not isinstance(value['snapshotPath'], str) or
            not os.path.isabs(value['snapshotPath']) or os.path.normpath(value['snapshotPath']) != value['snapshotPath'] or
            os.path.basename(value['snapshotPath']) != 'installation-' + operation_id):
            raise BackupError('Invalid backup snapshot path')
        if value['manifestDigest'] is not None and (not isinstance(value['manifestDigest'], str) or not DIGEST.fullmatch(value['manifestDigest'])):
            raise BackupError('Invalid backup snapshot digest')
        if value['state'] in ('verified', 'starting', 'completed') and (value['snapshotPath'] is None or value['manifestDigest'] is None):
            raise BackupError('Backup lacks a verified snapshot')
        if value['state'] in ('requested', 'capturing', 'recovering', 'cancelled') and (value['snapshotPath'] is not None or value['manifestDigest'] is not None):
            raise BackupError('Unverified backup contains unexpected snapshot evidence')
        return value

    def history(self, cursor=None):
        """Read summaries in stable newest-first order within the wire frame limit."""
        self._locked()
        if cursor is not None and not _uuid(cursor):
            raise BackupError('Invalid backup history cursor')
        anchor = self.get(cursor) if cursor is not None else None
        names = os.listdir(self.directory)
        if len(names) > 10000:
            raise BackupError('Installation backup history exceeds its limit')
        records = []
        for name in names:
            if name == 'active.json' or re.fullmatch(r'\.servus-[a-f0-9]{32}', name):
                continue
            if not name.endswith('.json') or not _uuid(name[:-5]):
                raise BackupError('Unexpected installation backup journal entry')
            record = self.get(name[:-5])
            if anchor is None or (record['createdAt'], record['operationId']) < (anchor['createdAt'], anchor['operationId']):
                records.append(record)
        records.sort(key=lambda item: (item['createdAt'], item['operationId']), reverse=True)
        page = []
        fields = ('operationId', 'actorId', 'name', 'state', 'createdAt', 'updatedAt', 'errorCode')
        for record in records[:10]:
            summary = {key: record[key] for key in fields}
            # The private and public protocols both have a 4096-byte frame.
            # Reserve room for envelopes and the pagination cursor, including
            # worst-case escaped Unicode names rather than truncating names.
            if len(json.dumps(page + [summary], ensure_ascii=True).encode('ascii')) > 3500:
                if not page:
                    raise BackupError('Installation backup history entry exceeds its limit')
                break
            page.append(summary)
        return {'operations': page, 'nextCursor': page[-1]['operationId'] if len(records) > len(page) else None}

    def active(self):
        try:
            marker = self._read('active.json')
        except FileNotFoundError:
            # The durable record is written before its scheduling pointer. A
            # killed submitter must not lose an approved operation or allow a
            # second operation to pass it after a supervisor restart.
            names = os.listdir(self.directory)
            if len(names) > 10000:
                raise BackupError('Installation backup history exceeds its limit')
            pending = []
            for name in names:
                if re.fullmatch(r'\.servus-[a-f0-9]{32}', name):
                    continue
                if not name.endswith('.json') or not _uuid(name[:-5]):
                    raise BackupError('Unexpected installation backup journal entry')
                record = self.get(name[:-5])
                if record['state'] not in TERMINAL:
                    pending.append(record)
            if len(pending) > 1:
                raise BackupError('Ambiguous unfinished installation backups')
            if not pending:
                return None
            marker = {'operationId': pending[0]['operationId']}
            self._write('active.json', marker)
        if set(marker) != {'operationId'} or not _uuid(marker['operationId']):
            raise BackupError('Invalid active backup marker')
        return self.get(marker['operationId'])

    def request(self, receipt, api_token, *, now_ms=None):
        self._locked()
        approved = verify_approval(receipt, api_token, now_ms=now_ms)
        operation_id = approved['operationId']
        try:
            previous = self.get(operation_id)
        except FileNotFoundError:
            previous = None
        if previous is not None:
            if any(previous[key] != approved[key] for key in ('actorId', 'name')):
                raise BackupError('Backup identity was reused for different input')
            if previous['state'] not in TERMINAL:
                active = self.active()
                if active is None or active['operationId'] != operation_id:
                    raise BackupError('Installation backup scheduling identity changed')
            return previous
        if self.active() is not None:
            raise BackupError('Another installation backup requires completion or recovery')
        now = int(time.time() * 1000) if now_ms is None else now_ms
        record = {'version': 1, **approved, 'state': 'requested', 'createdAt': now, 'updatedAt': now,
                  'policyBinding': None, 'containers': None, 'snapshotPath': None, 'manifestDigest': None, 'errorCode': None}
        self._write(operation_id + '.json', record)
        self._write('active.json', {'operationId': operation_id})
        return record

    def transition(self, operation_id, expected, state, **changes):
        allowed = {'requested': ('capturing', 'failed', 'cancelled', 'recovery_required'), 'capturing': ('verified', 'recovery_required'),
                   'verified': ('starting', 'recovery_required'), 'starting': ('completed', 'recovery_required'),
                   'recovering': ('failed', 'recovery_required'), 'recovery_required': ('starting', 'recovering')}
        if state not in allowed.get(expected, ()) or not set(changes).issubset({'policyBinding', 'containers', 'snapshotPath', 'manifestDigest', 'errorCode'}):
            raise BackupError('Invalid backup transition')
        current = self.get(operation_id)
        active = self.active()
        if current['state'] != expected or active is None or active['operationId'] != operation_id:
            raise BackupError('The backup transition is stale')
        for field in ('policyBinding', 'containers', 'snapshotPath', 'manifestDigest'):
            if current[field] is not None and field in changes and changes[field] != current[field]:
                raise BackupError('Durable backup generation or snapshot evidence changed')
        next_record = {**current, **changes, 'state': state, 'updatedAt': int(time.time() * 1000)}
        self._validate(next_record, operation_id)
        self._write(operation_id + '.json', next_record)
        return self.get(operation_id)

    def bind_generation(self, operation_id, binding, containers):
        """Persist the approved generation before maintenance can write intent."""
        current, active = self.get(operation_id), self.active()
        if current['state'] != 'requested' or active is None or active['operationId'] != operation_id:
            raise BackupError('The backup generation reservation is stale')
        if current['policyBinding'] is not None and (current['policyBinding'] != list(binding) or current['containers'] != containers):
            raise BackupError('The backup generation changed')
        value = {**current, 'policyBinding': list(binding), 'containers': containers, 'updatedAt': int(time.time() * 1000)}
        self._validate(value, operation_id)
        self._write(operation_id + '.json', value)
        return self.get(operation_id)

    def assert_untouched(self):
        self._locked()
        self.maintenance._verify_no_previous_operation()
        fd = self.supervisor._open_root_file(self.maintenance.gate, 'state', 0o644)
        try:
            if os.read(fd, 64) != b'servus-lifecycle-v1 normal\n':
                raise BackupError('Installation startup gate requires recovery')
        finally:
            os.close(fd)

    def cancel(self, receipt, api_token, *, now_ms=None):
        """Cancel only before intent, retaining a separate protected actor receipt."""
        approved = verify_approval(receipt, api_token, now_ms=now_ms, purpose='cancel')
        current = self.get(approved['operationId'])
        if current['name'] != approved['name']:
            raise BackupError('Cancellation does not match the backup')
        if current['state'] not in ('requested', 'cancelled'):
            raise BackupError('Installation backup requires completion or recovery')
        active = self.active()
        if current['state'] == 'requested' and (active is None or active['operationId'] != current['operationId']):
            raise BackupError('The cancellation is stale')
        self.assert_untouched()
        if current['state'] == 'requested':
            # The audit lives outside active()'s operation scan. Persist it
            # before cancellation, so a killed requester cannot lose the actor.
            try:
                os.mkdir('installation-backup-cancellations', 0o700, dir_fd=self.maintenance.journal)
                os.fsync(self.maintenance.journal)
            except FileExistsError:
                pass
            directory = os.open('installation-backup-cancellations', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
                                dir_fd=self.maintenance.journal)
            try:
                info = os.fstat(directory)
                if info.st_uid != 0 or info.st_gid != 0 or stat.S_IMODE(info.st_mode) != 0o700:
                    raise BackupError('Unsafe cancellation audit directory')
                name = current['operationId'] + '.json'
                try:
                    fd = self.supervisor._open_root_file(directory, name, 0o600)
                except FileNotFoundError:
                    self.supervisor._atomic_file(directory, name,
                        (json.dumps({'version': 1, 'receipt': receipt, 'cancelledAt': int(time.time() * 1000)},
                                    separators=(',', ':'), ensure_ascii=False) + '\n').encode('utf-8'), 0o600)
                else:
                    try:
                        raw = os.read(fd, MAX_RECORD + 1)
                        audit = json.loads(raw, object_pairs_hook=_pairs)
                        if (len(raw) > MAX_RECORD or not isinstance(audit, dict) or
                            set(audit) != {'version', 'receipt', 'cancelledAt'} or type(audit['version']) is not int or
                            audit['version'] != 1 or type(audit['cancelledAt']) is not int or audit['cancelledAt'] < 0):
                            raise BackupError('Invalid cancellation audit receipt')
                        approval_message(audit['receipt'], purpose='cancel')
                        previous = verify_approval(audit['receipt'], api_token, now_ms=audit['receipt']['issuedAt'], purpose='cancel')
                        if previous['operationId'] != current['operationId'] or previous['name'] != current['name']:
                            raise BackupError('Cancellation audit identity changed')
                    finally:
                        os.close(fd)
            finally:
                os.close(directory)
            current = self.transition(current['operationId'], 'requested', 'cancelled')
        if active is not None and active['operationId'] == current['operationId']:
            self.clear_terminal(current['operationId'])
        return current

    def clear_terminal(self, operation_id):
        """Clear the scheduling fence only after its owner completed recovery."""
        current, active = self.get(operation_id), self.active()
        if current['state'] not in TERMINAL or active is None or active['operationId'] != operation_id:
            raise BackupError('The installation backup is not terminal')
        self.assert_untouched()
        os.unlink('active.json', dir_fd=self.directory)
        os.fsync(self.directory)

    def _deletion_audit_dir(self, *, create=False):
        if create:
            try:
                os.mkdir('installation-backup-deletions', 0o700, dir_fd=self.maintenance.journal)
                os.fsync(self.maintenance.journal)
            except FileExistsError:
                pass
        directory = os.open('installation-backup-deletions',
                            os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
                            dir_fd=self.maintenance.journal)
        info = os.fstat(directory)
        if info.st_uid != 0 or info.st_gid != 0 or stat.S_IMODE(info.st_mode) != 0o700:
            os.close(directory)
            raise BackupError('Unsafe deletion audit directory')
        return directory

    def is_deleted(self, operation_id):
        if not _uuid(operation_id):
            raise BackupError('Invalid backup identity')
        self._locked()
        try:
            directory = self._deletion_audit_dir(create=False)
        except FileNotFoundError:
            return False
        try:
            try:
                fd = self.supervisor._open_root_file(directory, operation_id + '.json', 0o600)
            except FileNotFoundError:
                return False
            os.close(fd)
            return True
        finally:
            os.close(directory)

    def _live_completed_snapshots(self, backup_fd, backup_root):
        names = os.listdir(self.directory)
        if len(names) > 10000:
            raise BackupError('Installation backup history exceeds its limit')
        normalized_root = os.path.normpath(backup_root)
        live = []
        for name in names:
            if name == 'active.json' or re.fullmatch(r'\.servus-[a-f0-9]{32}', name):
                continue
            if not name.endswith('.json') or not _uuid(name[:-5]):
                raise BackupError('Unexpected installation backup journal entry')
            record = self.get(name[:-5])
            if record['state'] != 'completed' or record['snapshotPath'] is None:
                continue
            expected_name = 'installation-' + record['operationId']
            if os.path.normpath(record['snapshotPath']) != os.path.join(normalized_root, expected_name):
                continue
            try:
                info = os.stat(expected_name, dir_fd=backup_fd, follow_symlinks=False)
            except FileNotFoundError:
                continue
            if stat.S_ISDIR(info.st_mode):
                live.append(record['operationId'])
        return live

    def delete_snapshot(self, receipt, api_token, backup_root, *, now_ms=None):
        """Delete one completed snapshot archive while protecting the last verified copy."""
        approved = verify_approval(receipt, api_token, now_ms=now_ms, purpose='delete')
        self._locked()
        self.assert_untouched()
        if self.active() is not None:
            raise BackupError('Another installation backup requires completion or recovery')
        current = self.get(approved['operationId'])
        if current['name'] != approved['name']:
            raise BackupError('Deletion does not match the backup')
        if current['state'] != 'completed' or current['snapshotPath'] is None:
            raise BackupError('Only completed installation backups can be deleted')
        expected_dir = 'installation-' + current['operationId']
        expected_path = os.path.join(os.path.normpath(backup_root), expected_dir)
        if os.path.normpath(current['snapshotPath']) != expected_path:
            raise BackupError('Backup snapshot path does not match the configured backup root')
        backup_fd = self.supervisor._trusted_directory(backup_root, 0o700)
        try:
            directory = self._deletion_audit_dir(create=True)
            try:
                audit_name = current['operationId'] + '.json'
                already_audited = False
                try:
                    fd = self.supervisor._open_root_file(directory, audit_name, 0o600)
                except FileNotFoundError:
                    live = self._live_completed_snapshots(backup_fd, backup_root)
                    if current['operationId'] not in live:
                        raise BackupError('Installation backup archive is already missing') from None
                    if len(live) <= 1:
                        raise BackupError('Cannot delete the last remaining verified installation backup') from None
                    self.supervisor._atomic_file(
                        directory,
                        audit_name,
                        (json.dumps({'version': 1, 'receipt': receipt, 'deletedAt': int(time.time() * 1000)},
                                    separators=(',', ':'), ensure_ascii=False) + '\n').encode('utf-8'),
                        0o600,
                    )
                else:
                    try:
                        raw = os.read(fd, MAX_RECORD + 1)
                        audit = json.loads(raw, object_pairs_hook=_pairs)
                        if (len(raw) > MAX_RECORD or not isinstance(audit, dict) or
                            set(audit) != {'version', 'receipt', 'deletedAt'} or type(audit['version']) is not int or
                            audit['version'] != 1 or type(audit['deletedAt']) is not int or audit['deletedAt'] < 0):
                            raise BackupError('Invalid deletion audit receipt')
                        approval_message(audit['receipt'], purpose='delete')
                        previous = verify_approval(audit['receipt'], api_token, now_ms=audit['receipt']['issuedAt'], purpose='delete')
                        if previous['operationId'] != current['operationId'] or previous['name'] != current['name']:
                            raise BackupError('Deletion audit identity changed')
                        already_audited = True
                    finally:
                        os.close(fd)
            finally:
                os.close(directory)
            try:
                _remove_snapshot_tree(backup_fd, expected_dir)
            except FileNotFoundError:
                if not already_audited:
                    raise BackupError('Installation backup archive disappeared during deletion') from None
            remaining = len(self._live_completed_snapshots(backup_fd, backup_root))
            return {'operationId': current['operationId'], 'name': current['name'], 'deleted': True, 'remainingSnapshots': remaining}
        finally:
            os.close(backup_fd)


def _remove_snapshot_tree(parent_fd, name, *, depth=0):
    """Safely remove a root-owned snapshot directory without following symlinks."""
    if depth > 8 or not name or '/' in name or name in ('.', '..'):
        raise BackupError('Unsafe snapshot directory structure')
    info = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    if not stat.S_ISDIR(info.st_mode):
        raise BackupError('Snapshot entry is not a directory')
    child_fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent_fd)
    try:
        for entry in os.listdir(child_fd):
            entry_info = os.stat(entry, dir_fd=child_fd, follow_symlinks=False)
            if stat.S_ISLNK(entry_info.st_mode):
                raise BackupError('Unexpected symbolic link inside snapshot directory')
            if stat.S_ISDIR(entry_info.st_mode):
                _remove_snapshot_tree(child_fd, entry, depth=depth + 1)
            elif stat.S_ISREG(entry_info.st_mode):
                os.unlink(entry, dir_fd=child_fd)
            else:
                raise BackupError('Unexpected special file inside snapshot directory')
        os.fsync(child_fd)
    finally:
        os.close(child_fd)
    os.rmdir(name, dir_fd=parent_fd)
    os.fsync(parent_fd)


def verify_completed_snapshot(journal, operation_id, backup_module, update_module, node_fd, supervisor):
    """Verify one completed installation backup's manifest, SQLite integrity and secrets."""
    if not isinstance(journal, BackupJournal):
        raise BackupError('A protected backup journal is required')
    journal._locked()
    record = journal.get(operation_id)
    if record['state'] != 'completed' or record['snapshotPath'] is None or record['manifestDigest'] is None:
        raise BackupError('Installation backup is not a completed verified snapshot')
    if journal.is_deleted(operation_id):
        raise BackupError('Installation backup archive was deleted')
    update_module.verify_snapshot(record['snapshotPath'], record['manifestDigest'], backup_module, node_fd, supervisor)
    return {
        'operationId': record['operationId'],
        'name': record['name'],
        'verified': True,
        'manifestDigest': record['manifestDigest'],
    }


def _collect_snapshot_files(dir_fd, prefix='', *, depth=0, budget=None):
    """Read a root-owned verified snapshot directory without following symlinks or writing temp files."""
    if budget is None:
        budget = [0]
    if depth > 8:
        raise BackupError('Snapshot directory exceeds maximum nesting depth')
    entries = sorted(os.listdir(dir_fd))
    if len(entries) > 8192:
        raise BackupError('Snapshot directory exceeds maximum entry count')
    collected = []
    for entry in entries:
        if not entry or '/' in entry or entry in ('.', '..'):
            raise BackupError('Unsafe snapshot entry name')
        info = os.stat(entry, dir_fd=dir_fd, follow_symlinks=False)
        if info.st_uid != 0 or stat.S_ISLNK(info.st_mode):
            raise BackupError('Unsafe ownership or symlink inside snapshot directory')
        rel = f'{prefix}/{entry}' if prefix else entry
        if stat.S_ISDIR(info.st_mode):
            child_fd = os.open(entry, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=dir_fd)
            try:
                child_info = os.fstat(child_fd)
                if child_info.st_uid != 0 or not stat.S_ISDIR(child_info.st_mode):
                    raise BackupError('Snapshot subdirectory changed during read')
                collected.extend(_collect_snapshot_files(child_fd, rel, depth=depth + 1, budget=budget))
            finally:
                os.close(child_fd)
        elif stat.S_ISREG(info.st_mode):
            if info.st_size < 0 or budget[0] + info.st_size > MAX_DOWNLOAD_ARCHIVE:
                raise BackupError('Snapshot archive exceeds download size limit')
            file_fd = os.open(entry, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=dir_fd)
            try:
                file_info = os.fstat(file_fd)
                if file_info.st_uid != 0 or not stat.S_ISREG(file_info.st_mode) or file_info.st_nlink != 1:
                    raise BackupError('Snapshot file changed during read')
                chunks = []
                remaining = MAX_DOWNLOAD_ARCHIVE - budget[0]
                while True:
                    chunk = os.read(file_fd, 65536)
                    if not chunk:
                        break
                    if len(chunk) > remaining:
                        raise BackupError('Snapshot archive exceeds download size limit')
                    remaining -= len(chunk)
                    budget[0] += len(chunk)
                    chunks.append(chunk)
                data = b''.join(chunks)
                collected.append((rel, stat.S_IMODE(file_info.st_mode) & 0o600 or 0o600, data))
            finally:
                os.close(file_fd)
        else:
            raise BackupError('Unexpected special file inside snapshot directory')
    return collected


def build_verified_archive(journal, receipt, api_token, backup_root, backup_module, update_module, node_fd, supervisor, *, now_ms=None):
    """Verify one completed snapshot and package it deterministically in memory with zero temp files."""
    if not isinstance(journal, BackupJournal):
        raise BackupError('A protected backup journal is required')
    approved = verify_approval(receipt, api_token, now_ms=now_ms, purpose='download')
    journal._locked()
    journal.assert_untouched()
    if journal.active() is not None:
        raise BackupError('Another installation backup requires completion or recovery')
    record = journal.get(approved['operationId'])
    if record['name'] != approved['name']:
        raise BackupError('Download request does not match the backup')
    if record['state'] != 'completed' or record['snapshotPath'] is None or record['manifestDigest'] is None:
        raise BackupError('Only completed verified installation backups can be downloaded')
    if journal.is_deleted(approved['operationId']):
        raise BackupError('Installation backup archive was deleted')
    expected_dir = 'installation-' + record['operationId']
    expected_path = os.path.join(os.path.normpath(backup_root), expected_dir)
    if os.path.normpath(record['snapshotPath']) != expected_path:
        raise BackupError('Backup snapshot path does not match the configured backup root')
    update_module.verify_snapshot(record['snapshotPath'], record['manifestDigest'], backup_module, node_fd, supervisor)
    backup_fd = supervisor._trusted_directory(backup_root, 0o700)
    snap_fd = None
    try:
        snap_fd = os.open(expected_dir, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=backup_fd)
        snap_info = os.fstat(snap_fd)
        if snap_info.st_uid != 0 or snap_info.st_gid != 0 or stat.S_IMODE(snap_info.st_mode) != 0o700:
            raise BackupError('Unsafe snapshot directory permissions')
        files = _collect_snapshot_files(snap_fd)
    finally:
        if snap_fd is not None:
            os.close(snap_fd)
        os.close(backup_fd)
    manifest_entry = next((data for rel, _mode, data in files if rel == 'manifest.json'), None)
    if manifest_entry is None or ('sha256:' + hashlib.sha256(manifest_entry).hexdigest()) != record['manifestDigest']:
        raise BackupError('Snapshot manifest changed during download packaging')
    buf = io.BytesIO()
    with gzip.GzipFile(filename='', mode='wb', fileobj=buf, mtime=0) as gz:
        with tarfile.open(fileobj=gz, mode='w', format=tarfile.PAX_FORMAT) as archive:
            for rel, mode, data in files:
                info = tarfile.TarInfo(name=f'{expected_dir}/{rel}')
                info.size = len(data)
                info.mode = mode
                info.uid = 0
                info.gid = 0
                info.uname = 'root'
                info.gname = 'root'
                info.mtime = 0
                archive.addfile(info, io.BytesIO(data))
    archive_bytes = buf.getvalue()
    if not archive_bytes or len(archive_bytes) > MAX_DOWNLOAD_ARCHIVE:
        raise BackupError('Packaged installation backup exceeds download size limit')
    metadata = {
        'operationId': record['operationId'],
        'name': record['name'],
        'manifestDigest': record['manifestDigest'],
        'archiveSha256': 'sha256:' + hashlib.sha256(archive_bytes).hexdigest(),
        'sizeBytes': len(archive_bytes),
    }
    return metadata, archive_bytes


def capture_stopped_snapshot(journal, operation_id, lease, backup_root, node_fd,
                             supervisor, quiescence, backup_module, update_module, *, trusted_ingress=None):
    """Capture under the real startup fence and publish only a verified directory.

    Resume is a separate durable step. Any interruption leaves the current
    maintenance marker in place, and partial output never has a published name.
    """
    if not isinstance(lease, supervisor.DrainLease) or getattr(lease, '_legacy_upload_id', None) is not None:
        raise BackupError('An authenticated maintenance lease is required')
    lease.assert_locked(operation_id, 'stopped_unverified')
    hub = lease._hub
    if (not isinstance(hub, supervisor.DrainHub) or not hub.used or hub.expected_uid != 1000 or
        not isinstance(hub.policy, supervisor.RuntimePolicy) or set(hub.identities) != set(supervisor.ROLES) or
        lease._policy_binding is None):
        raise BackupError('Authenticated snapshot generation is unavailable')
    expected = {hub.identities[role]['id'] for role in supervisor.ROLES}
    if len(expected) != len(supervisor.ROLES):
        raise BackupError('Authenticated snapshot generation is ambiguous')
    supervisor._verify_data_directory(hub.policy.data_dir)
    backup_fd = supervisor._trusted_directory(backup_root, 0o700)
    source_fd = destination_fd = None
    partial = '.installation-' + operation_id + '.partial'
    final = 'installation-' + operation_id
    try:
        for name in (partial, final):
            try:
                os.stat(name, dir_fd=backup_fd, follow_symlinks=False)
            except FileNotFoundError:
                continue
            raise BackupError('Installation backup output already exists')
        journal.transition(operation_id, 'requested', 'capturing', policyBinding=list(lease._policy_binding),
                           containers={role: hub.identities[role]['id'] for role in supervisor.ROLES})
        os.mkdir(partial, 0o700, dir_fd=backup_fd)
        os.fsync(backup_fd)
        destination = os.path.join(backup_root, partial)
        destination_fd = supervisor._trusted_directory(destination, 0o700)
        source_fd = os.open(hub.policy.data_dir, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
        lease.record('snapshotting')

        class DockerInspection:
            @staticmethod
            def call(*args):
                return supervisor._docker(*args)

            @staticmethod
            def inspect(*ids):
                return json.loads(supervisor._docker('inspect', *ids), object_pairs_hook=_pairs)

        def check():
            lease.assert_locked(operation_id, 'snapshotting')
            quiescence.ensure_host_namespaces()
            quiescence.ensure_no_other_data_mounts(DockerInspection(), expected, hub.policy.data_dir, trusted_ingress=trusted_ingress)
            quiescence.ensure_no_mount_aliases(DockerInspection(), hub.policy.data_dir)
            quiescence.ensure_no_open_data(hub.policy.data_dir)
            quiescence.ensure_no_uid_writers(hub.expected_uid)
            lease.assert_locked(operation_id, 'snapshotting')

        check()
        backup_module._capture_quiescent(source_fd, destination_fd, node_fd, source_uid=1000, reader_gid=65534)
        check()
        fd, _ = backup_module._file(destination_fd, 'manifest.json', 0, os.fstat(destination_fd).st_dev)
        try:
            digest = 'sha256:' + hashlib.sha256(backup_module._read(fd)).hexdigest()
        finally:
            os.close(fd)
        update_module.verify_snapshot(destination, digest, backup_module, node_fd, supervisor)
        check()
        os.rename(partial, final, src_dir_fd=backup_fd, dst_dir_fd=backup_fd)
        os.fsync(backup_fd)
        path = os.path.join(backup_root, final)
        update_module.verify_snapshot(path, digest, backup_module, node_fd, supervisor)
        journal.transition(operation_id, 'capturing', 'verified', snapshotPath=path, manifestDigest=digest)
        lease.record('snapshot_verified')
        return {'snapshotPath': path, 'manifestDigest': digest}
    except BaseException:
        try:
            current = journal.get(operation_id)
            if current['state'] in ('capturing', 'verified'):
                journal.transition(operation_id, current['state'], 'recovery_required', errorCode='capture_failed')
        except BaseException:
            pass
        raise
    finally:
        for fd in (source_fd, destination_fd, backup_fd):
            if fd is not None:
                os.close(fd)


def start_captured_snapshot(journal, operation_id, lease, daemon_ownership, approval_journal, active_env,
                            supervisor, daemon, backup_module, update_module, node_fd):
    """Restart the captured generation with application work fenced until health confirmation.

    This does not switch images, policies or data directories. The daemon must
    subsequently finalize the backup using three fresh authenticated channels.
    An interrupted start keeps both the snapshot and the recovery barrier.
    """
    if (not isinstance(lease, supervisor.DrainLease) or not isinstance(journal, BackupJournal) or
        journal.maintenance is not lease._owner or getattr(lease, '_legacy_upload_id', None) is not None):
        raise BackupError('An authenticated snapshot lease is required')
    lease.assert_locked(operation_id, 'snapshot_verified')
    record = journal.get(operation_id)
    hub = lease._hub
    if (record['state'] != 'verified' or not isinstance(hub, supervisor.DrainHub) or not hub.used or
        record['policyBinding'] != list(lease._policy_binding or ()) or
        record['containers'] != {role: hub.identities[role]['id'] for role in supervisor.ROLES}):
        raise BackupError('Captured generation does not match the maintenance lease')
    control_dir = os.readlink('/proc/self/fd/' + str(daemon_ownership.directory))
    daemon_ownership.assert_held(control_dir)
    policy_path, accepted_env, policy = daemon.resolve_active_policy(approval_journal, active_env)
    binding = daemon.approved_policy_binding(hub, policy_path, approval_journal, accepted_env)
    if (policy != hub.policy or not isinstance(binding, tuple) or len(binding) != 4 or
        list(binding[:3]) != record['policyBinding'] or binding[3] != policy):
        raise BackupError('Active snapshot policy changed')
    stopped = supervisor.inspect_servus(policy, stopped=True)
    if {role: item['id'] for role, item in stopped.items()} != record['containers']:
        raise BackupError('Captured containers changed before restart')
    update_module.verify_snapshot(record['snapshotPath'], record['manifestDigest'], backup_module, node_fd, supervisor)
    lease.assert_locked(operation_id, 'snapshot_verified')
    daemon_ownership.assert_held(control_dir)
    if daemon.approved_policy_binding(hub, policy_path, approval_journal, accepted_env) != binding:
        raise BackupError('Active snapshot policy changed')
    try:
        # This standalone operation deliberately has no update transaction and
        # never records a fictitious image switch to authorize its restart.
        journal.transition(operation_id, 'verified', 'starting')
        lease._owner._record(operation_id, 'starting', lease._request_ids, lease._timeout_ms)
        lease._state = 'starting'
        lease.release_for_start(recovering=True)
        for role in ('agent', 'api', 'worker'):
            supervisor._docker('start', record['containers'][role], timeout=30)
        return {'operationId': operation_id, 'state': 'starting'}
    except BaseException:
        current = journal.get(operation_id)
        if current['state'] == 'starting':
            journal.transition(operation_id, 'starting', 'recovery_required', errorCode='resume_required')
        raise


def _maintenance_receipt(maintenance, supervisor, operation_id, *, optional=False):
    try:
        fd = supervisor._open_root_file(maintenance.journal, 'maintenance.json', 0o600)
    except FileNotFoundError:
        if optional:
            return None
        raise BackupError('Installation backup maintenance receipt is unavailable') from None
    try:
        raw = os.read(fd, MAX_RECORD + 1)
        marker = json.loads(raw, object_pairs_hook=_pairs)
        named, opened = os.stat('maintenance.json', dir_fd=maintenance.journal, follow_symlinks=False), os.fstat(fd)
        if len(raw) > MAX_RECORD or (named.st_dev, named.st_ino) != (opened.st_dev, opened.st_ino):
            raise BackupError('Installation backup maintenance receipt changed')
    except (ValueError, UnicodeError, RecursionError) as error:
        raise BackupError('Invalid installation backup maintenance receipt') from error
    finally:
        os.close(fd)
    if (not isinstance(marker, dict) or set(marker) != {'version', 'operationId', 'state', 'requestIds', 'timeoutMs'} or
        type(marker['version']) is not int or marker['version'] != 1 or marker['operationId'] != operation_id or
        marker['state'] not in ('intent', 'maintenance', 'drained', 'stopping', 'stopped_unverified', 'snapshotting',
                                'snapshot_verified', 'starting', 'recovery_required') or
        not isinstance(marker['requestIds'], dict) or set(marker['requestIds']) != set(supervisor.ROLES) or
        not all(_uuid(value) for value in marker['requestIds'].values()) or
        len(set(marker['requestIds'].values())) != len(supervisor.ROLES) or
        type(marker['timeoutMs']) is not int or not 1 <= marker['timeoutMs'] <= 60000):
        raise BackupError('Installation backup maintenance receipt changed')
    return marker


def recover_original_generation(journal, operation_id, daemon_ownership, approval_journal, active_env,
                                supervisor, daemon, quiescence, backup_module, update_module, node_fd,
                                *, trusted_ingress=None):
    """Root-only reconciliation; resume original data, never restore a snapshot.

    An unverified capture remains failed even after the original processes are
    healthy. Only a previously durable, reverified snapshot can complete.
    """
    if not isinstance(journal, BackupJournal) or not _uuid(operation_id):
        raise BackupError('A protected backup recovery is required')
    journal._locked()
    current, active = journal.get(operation_id), journal.active()
    if active is not None and active['operationId'] != operation_id:
        raise BackupError('Installation backup recovery identity changed')
    if current['state'] == 'cancelled' or current['state'] in ('requested', 'failed') and current['policyBinding'] is None:
        journal.assert_untouched()
        if current['state'] in TERMINAL:
            if active is not None:
                journal.clear_terminal(operation_id)
            return current
        raise BackupError('Untouched requested backups may be cancelled with administrator approval')
    if active is None and current['state'] not in ('completed', 'failed'):
        raise BackupError('Installation backup recovery identity changed')
    if current['policyBinding'] is None or current['containers'] is None:
        raise BackupError('Interrupted backup lacks its original approved generation')
    owner = journal.maintenance
    for name in ('legacy-upload-recovery.json',):
        try:
            os.stat(name, dir_fd=owner.journal, follow_symlinks=False)
        except FileNotFoundError:
            continue
        raise BackupError('Another maintenance recovery is pending')
    control_dir = os.readlink('/proc/self/fd/' + str(daemon_ownership.directory))
    daemon_ownership.assert_held(control_dir)
    policy_path, accepted_env, policy = daemon.resolve_active_policy(approval_journal, active_env)
    # approved_policy_binding only needs the exact policy, not a fabricated
    # authenticated hub. No fake DrainLease or component proof is constructed.
    class PolicyReference:
        pass
    reference = PolicyReference()
    reference.policy = policy
    binding = daemon.approved_policy_binding(reference, policy_path, approval_journal, accepted_env)
    if (not isinstance(policy, supervisor.RuntimePolicy) or not isinstance(binding, tuple) or len(binding) != 4 or
        binding[3] != policy or list(binding[:3]) != current['policyBinding']):
        raise BackupError('Original backup policy changed')
    marker = _maintenance_receipt(owner, supervisor, operation_id, optional=current['state'] in TERMINAL)
    state_fd = supervisor._open_root_file(owner.gate, 'state', 0o644)
    try:
        gate_state = os.read(state_fd, 64)
    finally:
        os.close(state_fd)
    if gate_state not in (b'servus-lifecycle-v1 normal\n', b'servus-lifecycle-v1 maintenance\n', b'servus-lifecycle-v1 recovering\n'):
        raise BackupError('Unknown installation backup startup gate')
    if current['state'] in ('completed', 'failed'):
        # A killed finalizer may have written terminal before removing its own
        # marker. Completion still requires fresh channels in the normal loop.
        if gate_state == b'servus-lifecycle-v1 maintenance\n' or marker is not None and marker['state'] != 'starting':
            raise BackupError('Terminal backup maintenance requires reconciliation')
        inventory = supervisor.inspect_servus(policy)
        if {role: item['id'] for role, item in inventory.items()} != current['containers']:
            raise BackupError('Original backup containers changed')
        if current['state'] == 'completed':
            update_module.verify_snapshot(current['snapshotPath'], current['manifestDigest'], backup_module, node_fd, supervisor)
        if active is None:
            # An idempotent root retry after finalization changes nothing. The
            # original terminal receipt remains, and normal admission is proven.
            journal.assert_untouched()
            _healthy_original(current['containers'], supervisor)
        return current
    if marker is None:
        raise BackupError('Installation backup maintenance receipt is unavailable')
    quiescence.ensure_host_namespaces()
    # Verify the full approved configuration before stopping any exact original
    # ID. Mixed running/exited is accepted only in this explicit root path.
    inventory = supervisor.inspect_servus(policy, recovering=True)
    if {role: item['id'] for role, item in inventory.items()} != current['containers']:
        raise BackupError('Original backup containers changed')
    if (current['snapshotPath'] is None) != (current['manifestDigest'] is None):
        raise BackupError('Backup snapshot evidence is incomplete')
    verified = current['snapshotPath'] is not None
    if verified:
        update_module.verify_snapshot(current['snapshotPath'], current['manifestDigest'], backup_module, node_fd, supervisor)
    if current['state'] != 'recovery_required':
        journal.transition(operation_id, current['state'], 'recovery_required', errorCode='resume_required')
    # First close application work. Existing processes may hold shared startup
    # locks; exclusive ownership is acquired only after all originals stop.
    fcntl.flock(owner.gate_lock, fcntl.LOCK_SH | fcntl.LOCK_NB)
    try:
        named, opened = os.stat('lock', dir_fd=owner.gate, follow_symlinks=False), os.fstat(owner.gate_lock)
        if (named.st_dev, named.st_ino) != (opened.st_dev, opened.st_ino):
            raise BackupError('Installation startup lock changed')
        supervisor._atomic_file(owner.gate, 'state', b'servus-lifecycle-v1 maintenance\n', 0o644)
    finally:
        fcntl.flock(owner.gate_lock, fcntl.LOCK_UN)
    owner._record(operation_id, 'recovery_required', marker['requestIds'], marker['timeoutMs'])
    for role in supervisor.ROLES:
        supervisor._docker('stop', '--time', '30', current['containers'][role], timeout=45)
    exclusive = False
    try:
        fcntl.flock(owner.gate_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        exclusive = True
        def check():
            journal._locked()
            supervisor._assert_exclusive_flock(owner.gate_lock)
            named, opened = os.stat('lock', dir_fd=owner.gate, follow_symlinks=False), os.fstat(owner.gate_lock)
            if (named.st_dev, named.st_ino) != (opened.st_dev, opened.st_ino):
                raise BackupError('Installation startup lock changed')
            receipt = _maintenance_receipt(owner, supervisor, operation_id)
            if (receipt['state'] != 'recovery_required' or receipt['requestIds'] != marker['requestIds'] or
                receipt['timeoutMs'] != marker['timeoutMs']):
                raise BackupError('Installation recovery receipt changed')
            fd = supervisor._open_root_file(owner.gate, 'state', 0o644)
            try:
                if os.read(fd, 64) != b'servus-lifecycle-v1 maintenance\n':
                    raise BackupError('Installation recovery startup gate changed')
            finally:
                os.close(fd)
            stopped = supervisor.inspect_servus(policy, stopped=True)
            if {role: item['id'] for role, item in stopped.items()} != current['containers']:
                raise BackupError('Original backup containers changed')
            if daemon.approved_policy_binding(reference, policy_path, approval_journal, accepted_env) != binding:
                raise BackupError('Original backup policy changed')
            class DockerInspection:
                @staticmethod
                def call(*args):
                    return supervisor._docker(*args)
                @staticmethod
                def inspect(*ids):
                    return json.loads(supervisor._docker('inspect', *ids), object_pairs_hook=_pairs)
            quiescence.ensure_host_namespaces()
            quiescence.ensure_no_other_data_mounts(DockerInspection(), set(current['containers'].values()), policy.data_dir,
                                                  trusted_ingress=trusted_ingress)
            quiescence.ensure_no_mount_aliases(DockerInspection(), policy.data_dir)
            quiescence.ensure_no_open_data(policy.data_dir)
            quiescence.ensure_no_uid_writers(1000)
            journal._locked()
            daemon_ownership.assert_held(control_dir)
        check()
        if verified:
            update_module.verify_snapshot(current['snapshotPath'], current['manifestDigest'], backup_module, node_fd, supervisor)
        check()
        target = 'starting' if verified else 'recovering'
        journal.transition(operation_id, 'recovery_required', target,
                           errorCode=None if verified else 'capture_failed')
        owner._record(operation_id, 'starting', marker['requestIds'], marker['timeoutMs'])
        supervisor._atomic_file(owner.gate, 'state', b'servus-lifecycle-v1 recovering\n', 0o644)
        fcntl.flock(owner.gate_lock, fcntl.LOCK_UN)
        exclusive = False
        for role in ('agent', 'api', 'worker'):
            supervisor._docker('start', current['containers'][role], timeout=30)
        return journal.get(operation_id)
    except BaseException:
        record = journal.get(operation_id)
        if record['state'] in ('starting', 'recovering'):
            journal.transition(operation_id, record['state'], 'recovery_required', errorCode='resume_required')
        raise
    finally:
        if exclusive:
            fcntl.flock(owner.gate_lock, fcntl.LOCK_UN)


def _healthy_original(identities, supervisor):
    records = json.loads(supervisor._docker('inspect', *identities.values()), object_pairs_hook=_pairs)
    if not isinstance(records, list) or len(records) != len(supervisor.ROLES):
        raise BackupError('Snapshot restart health is unavailable')
    by_id = {item.get('Id'): item for item in records if isinstance(item, dict)}
    if set(by_id) != set(identities.values()):
        raise BackupError('Snapshot restart generation changed')
    for role in supervisor.ROLES:
        state = by_id[identities[role]].get('State')
        if (not isinstance(state, dict) or state.get('Running') is not True or
            (role in ('api', 'agent') and (not isinstance(state.get('Health'), dict) or state['Health'].get('Status') != 'healthy'))):
            raise BackupError('Snapshot restart health is unavailable')


def finalize_captured_snapshot(journal, hub, policy_path, approval_journal, accepted_env,
                               supervisor, daemon, backup_module, update_module, node_fd):
    """Release application work only after the original roles reconnect healthy.

    The completed receipt is durable before removing maintenance metadata. A
    repeat after interruption rechecks health and finishes those same steps.
    The installation lock serializes finalization with updates and new backups.
    """
    if not isinstance(journal, BackupJournal):
        raise BackupError('A protected backup journal is required')
    record = journal.active()
    if record is None or record['state'] not in ('starting', 'recovering', 'completed', 'failed'):
        return False
    if (not isinstance(hub, supervisor.DrainHub) or hub.used or set(hub.connections) != set(supervisor.ROLES) or
        select.select(list(hub.connections.values()), [], [], 0)[0]):
        return False
    identities = {role: hub.identities[role]['id'] for role in supervisor.ROLES}
    binding = daemon.approved_policy_binding(hub, policy_path, approval_journal, accepted_env)
    if (identities != record['containers'] or supervisor.inspect_servus(hub.policy) != hub.identities or
        not isinstance(binding, tuple) or len(binding) != 4 or list(binding[:3]) != record['policyBinding'] or
        binding[3] != hub.policy):
        raise BackupError('Snapshot restart generation changed')
    maintenance = journal.maintenance
    state_fd = supervisor._open_root_file(maintenance.gate, 'state', 0o644)
    try:
        gate_state = os.read(state_fd, 64)
    finally:
        os.close(state_fd)
    if (gate_state not in (b'servus-lifecycle-v1 recovering\n', b'servus-lifecycle-v1 normal\n') or
        (gate_state == b'servus-lifecycle-v1 normal\n' and record['state'] not in ('completed', 'failed'))):
        raise BackupError('Snapshot startup gate changed')
    marker_info = None
    try:
        marker_fd = supervisor._open_root_file(maintenance.journal, 'maintenance.json', 0o600)
    except FileNotFoundError:
        if record['state'] not in ('completed', 'failed'):
            raise BackupError('Snapshot maintenance receipt is unavailable') from None
    else:
        try:
            marker_info = os.fstat(marker_fd)
            raw = os.read(marker_fd, MAX_RECORD + 1)
            if len(raw) > MAX_RECORD:
                raise BackupError('Invalid snapshot maintenance receipt')
            marker = json.loads(raw, object_pairs_hook=_pairs)
        finally:
            os.close(marker_fd)
        if (not isinstance(marker, dict) or set(marker) != {'version', 'operationId', 'state', 'requestIds', 'timeoutMs'} or
            type(marker['version']) is not int or marker['version'] != 1 or marker['operationId'] != record['operationId'] or
            marker['state'] != 'starting' or not isinstance(marker['requestIds'], dict) or
            set(marker['requestIds']) != set(supervisor.ROLES) or
            not all(_uuid(value) for value in marker['requestIds'].values()) or
            len(set(marker['requestIds'].values())) != len(supervisor.ROLES) or
            type(marker['timeoutMs']) is not int or not 1 <= marker['timeoutMs'] <= 60000):
            raise BackupError('Snapshot maintenance receipt changed')

    def healthy():
        _healthy_original(identities, supervisor)

    healthy()
    if record['state'] in ('starting', 'completed'):
        update_module.verify_snapshot(record['snapshotPath'], record['manifestDigest'], backup_module, node_fd, supervisor)
    healthy()
    if (supervisor.inspect_servus(hub.policy) != hub.identities or
        select.select(list(hub.connections.values()), [], [], 0)[0] or
        daemon.approved_policy_binding(hub, policy_path, approval_journal, accepted_env) != binding):
        raise BackupError('Snapshot restart changed during completion')
    journal._locked()
    if record['state'] == 'starting':
        journal.transition(record['operationId'], 'starting', 'completed')
    elif record['state'] == 'recovering':
        journal.transition(record['operationId'], 'recovering', 'failed', errorCode='capture_failed')
    if marker_info is not None:
        named = os.stat('maintenance.json', dir_fd=maintenance.journal, follow_symlinks=False)
        if (named.st_dev, named.st_ino) != (marker_info.st_dev, marker_info.st_ino):
            raise BackupError('Snapshot maintenance receipt changed')
        os.unlink('maintenance.json', dir_fd=maintenance.journal)
        os.fsync(maintenance.journal)
    # The processes hold shared startup locks. No exclusive lock is needed to
    # permit their work after authenticated health checks; install.lock still
    # excludes another maintenance coordinator throughout this transition.
    if gate_state != b'servus-lifecycle-v1 normal\n':
        supervisor._atomic_file(maintenance.gate, 'state', b'servus-lifecycle-v1 normal\n', 0o644)
    journal.clear_terminal(record['operationId'])
    return True
