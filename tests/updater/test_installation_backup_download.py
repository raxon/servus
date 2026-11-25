#!/usr/bin/env python3
"""Unit tests for P1.1 secure installation backup archive download."""
import fcntl
import gzip
import hashlib
import hmac
import importlib.util
import io
import json
import os
from pathlib import Path
import tarfile
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('installation_backups_download', ROOT / 'apps/updater/installation-backups.py')
MOD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MOD)


class FakeMaintenance:
    def __init__(self, install_fd, install_lock_fd, journal_fd, gate_fd):
        self.install = install_fd
        self.install_lock = install_lock_fd
        self.journal = journal_fd
        self.gate = gate_fd

    def _verify_no_previous_operation(self):
        return None


class FakeSupervisor:
    MaintenanceSupervisor = FakeMaintenance
    ROLES = ('api', 'worker', 'agent')

    @staticmethod
    def _assert_exclusive_flock(_fd):
        return None

    @staticmethod
    def _open_root_file(dir_fd, name, _mode):
        return os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=dir_fd)

    @staticmethod
    def _atomic_file(dir_fd, name, data, mode):
        tmp = '.tmp-' + name
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, mode, dir_fd=dir_fd)
        try:
            os.write(fd, data)
            os.fsync(fd)
        finally:
            os.close(fd)
        os.rename(tmp, name, src_dir_fd=dir_fd, dst_dir_fd=dir_fd)
        os.fsync(dir_fd)

    @staticmethod
    def _trusted_directory(path, _mode):
        return os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)


class FakeUpdateCoordinator:
    def __init__(self, *, should_fail=False):
        self.should_fail = should_fail
        self.verified_calls = []

    def verify_snapshot(self, path, digest, _backup_module, _node_fd, _supervisor):
        self.verified_calls.append((path, digest))
        if self.should_fail:
            raise MOD.BackupError('Snapshot integrity check failed')
        manifest_bytes = (Path(path) / 'manifest.json').read_bytes()
        if ('sha256:' + hashlib.sha256(manifest_bytes).hexdigest()) != digest:
            raise MOD.BackupError('Manifest digest mismatch')


def sign_receipt(operation_id, actor_id, name, api_token, *, purpose='download', issued_at=None):
    issued = int(time.time() * 1000) if issued_at is None else issued_at
    receipt = {
        'version': 1,
        'operationId': operation_id,
        'actorId': actor_id,
        'name': name,
        'issuedAt': issued,
        'proof': '0' * 64,
    }
    msg = MOD.approval_message(receipt, purpose=purpose)
    receipt['proof'] = hmac.new(bytes.fromhex(api_token), msg, hashlib.sha256).hexdigest()
    return receipt


class InstallationBackupDownloadTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.install_dir = self.root / 'install'
        self.journal_dir = self.root / 'journal'
        self.gate_dir = self.root / 'gate'
        self.backup_root = self.root / 'backups'
        for d in (self.install_dir, self.journal_dir, self.gate_dir, self.backup_root):
            d.mkdir(mode=0o700)
        (self.install_dir / 'install.lock').write_bytes(b'')
        (self.gate_dir / 'state').write_bytes(b'servus-lifecycle-v1 normal\n')
        self.install_fd = os.open(self.install_dir, os.O_RDONLY | os.O_DIRECTORY)
        self.lock_fd = os.open(self.install_dir / 'install.lock', os.O_RDWR)
        fcntl.flock(self.lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        self.journal_fd = os.open(self.journal_dir, os.O_RDONLY | os.O_DIRECTORY)
        self.gate_fd = os.open(self.gate_dir, os.O_RDONLY | os.O_DIRECTORY)
        self.maintenance = FakeMaintenance(self.install_fd, self.lock_fd, self.journal_fd, self.gate_fd)
        self.api_token = 'ab' * 32
        self.op_id = '12345678-1234-4123-8123-123456789abc'
        self.actor_id = '87654321-4321-4321-8321-cba987654321'
        self.name = 'Nightly installation backup'

    def tearDown(self):
        for fd in (self.install_fd, self.lock_fd, self.journal_fd, self.gate_fd):
            os.close(fd)
        self.tmp.cleanup()

    def _create_completed_snapshot(self, op_id=None, name=None):
        op_id = op_id or self.op_id
        name = name or self.name
        snap_dir = self.backup_root / f'installation-{op_id}'
        snap_dir.mkdir(mode=0o700)
        (snap_dir / 'secrets').mkdir(mode=0o700)
        manifest_bytes = json.dumps({'version': 1, 'operationId': op_id}).encode('utf-8')
        (snap_dir / 'manifest.json').write_bytes(manifest_bytes)
        (snap_dir / 'panel.sqlite').write_bytes(b'SQLite format 3\x00panel-fixture')
        (snap_dir / 'agent.sqlite').write_bytes(b'SQLite format 3\x00agent-fixture')
        (snap_dir / 'secrets' / 'vault.key').write_bytes(b'encrypted-secret-material')
        digest = 'sha256:' + hashlib.sha256(manifest_bytes).hexdigest()
        now = int(time.time() * 1000)
        record = {
            'version': 1,
            'operationId': op_id,
            'actorId': self.actor_id,
            'name': name,
            'issuedAt': now,
            'state': 'completed',
            'createdAt': now,
            'updatedAt': now,
            'policyBinding': ['/etc/servus/policy.json', 'sha256:' + '1' * 64, 'sha256:' + '2' * 64],
            'containers': {'api': 'a' * 64, 'worker': 'b' * 64, 'agent': 'c' * 64},
            'snapshotPath': str(snap_dir),
            'manifestDigest': digest,
            'errorCode': None,
        }
        op_dir = self.journal_dir / 'installation-backups'
        op_dir.mkdir(exist_ok=True, mode=0o700)
        (op_dir / f'{op_id}.json').write_text(json.dumps(record), encoding='utf-8')
        return snap_dir, digest

    def test_download_builds_verified_deterministic_archive_with_no_temp_files(self):
        if os.geteuid() != 0:
            self.skipTest('Root ownership check requires root (runs in isolated Linux container)')
        snap_dir, digest = self._create_completed_snapshot()
        before_entries = set(os.listdir(self.backup_root))
        updater = FakeUpdateCoordinator()
        with MOD.BackupJournal(self.maintenance, FakeSupervisor) as journal:
            receipt = sign_receipt(self.op_id, self.actor_id, self.name, self.api_token, purpose='download')
            metadata, archive = MOD.build_verified_archive(
                journal, receipt, self.api_token, str(self.backup_root), object(), updater, -1, FakeSupervisor
            )
            # Re-running produces identical deterministic bytes
            metadata2, archive2 = MOD.build_verified_archive(
                journal, receipt, self.api_token, str(self.backup_root), object(), updater, -1, FakeSupervisor
            )
        self.assertEqual(archive, archive2)
        self.assertEqual(metadata['archiveSha256'], metadata2['archiveSha256'])
        self.assertEqual(metadata['operationId'], self.op_id)
        self.assertEqual(metadata['name'], self.name)
        self.assertEqual(metadata['manifestDigest'], digest)
        self.assertEqual(metadata['sizeBytes'], len(archive))
        self.assertEqual(metadata['archiveSha256'], 'sha256:' + hashlib.sha256(archive).hexdigest())
        self.assertEqual(len(updater.verified_calls), 2)
        # Zero temporary files left on disk
        self.assertEqual(set(os.listdir(self.backup_root)), before_entries)
        # Verify archive contents
        with gzip.GzipFile(fileobj=io.BytesIO(archive), mode='rb') as gz:
            with tarfile.open(fileobj=gz, mode='r') as tf:
                names = tf.getnames()
                self.assertEqual(names, [
                    f'installation-{self.op_id}/agent.sqlite',
                    f'installation-{self.op_id}/manifest.json',
                    f'installation-{self.op_id}/panel.sqlite',
                    f'installation-{self.op_id}/secrets/vault.key',
                ])
                self.assertEqual(tf.extractfile(f'installation-{self.op_id}/panel.sqlite').read(), b'SQLite format 3\x00panel-fixture')

    def test_download_rejects_wrong_purpose_symlink_and_corrupted_manifest(self):
        self._create_completed_snapshot()
        updater = FakeUpdateCoordinator()
        with MOD.BackupJournal(self.maintenance, FakeSupervisor) as journal:
            # Submit/delete/cancel receipts must NEVER authorize download
            for wrong_purpose in ('submit', 'cancel', 'delete'):
                bad = sign_receipt(self.op_id, self.actor_id, self.name, self.api_token, purpose=wrong_purpose)
                with self.assertRaises(MOD.BackupError):
                    MOD.build_verified_archive(
                        journal, bad, self.api_token, str(self.backup_root), object(), updater, -1, FakeSupervisor
                    )
            if os.geteuid() == 0:
                # Corrupted manifest rejected
                (self.backup_root / f'installation-{self.op_id}' / 'manifest.json').write_bytes(b'{"tampered":true}')
                good = sign_receipt(self.op_id, self.actor_id, self.name, self.api_token, purpose='download')
                with self.assertRaises(MOD.BackupError):
                    MOD.build_verified_archive(
                        journal, good, self.api_token, str(self.backup_root), object(), updater, -1, FakeSupervisor
                    )

    def test_download_rejects_symlink_inside_snapshot(self):
        if os.geteuid() != 0:
            self.skipTest('Root ownership check requires root (runs in isolated Linux container)')
        snap_dir, _ = self._create_completed_snapshot()
        os.symlink('/etc/passwd', snap_dir / 'escape')
        updater = FakeUpdateCoordinator()
        with MOD.BackupJournal(self.maintenance, FakeSupervisor) as journal:
            good = sign_receipt(self.op_id, self.actor_id, self.name, self.api_token, purpose='download')
            with self.assertRaises(MOD.BackupError):
                MOD.build_verified_archive(
                    journal, good, self.api_token, str(self.backup_root), object(), updater, -1, FakeSupervisor
                )

    def test_updater_proxy_streams_verified_binary_download_over_unix_socket(self):
        if os.geteuid() != 0:
            self.skipTest('Root-owned Unix socket test requires root (runs in isolated Linux container)')
        import socket as sock_mod
        import threading
        up_spec = importlib.util.spec_from_file_location('servus_updater_dl', ROOT / 'apps/updater/servus-updater.py')
        updater_mod = importlib.util.module_from_spec(up_spec)
        up_spec.loader.exec_module(updater_mod)

        sock_dir = self.root / 'sup-sock'
        sock_dir.mkdir(mode=0o750)
        sock_path = sock_dir / 'command'
        payload = b'\x1f\x8b\x08\x00synthetic-verified-tar-gz-bytes'
        sha = 'sha256:' + hashlib.sha256(payload).hexdigest()
        manifest_digest = 'sha256:' + 'e' * 64
        receipt = sign_receipt(self.op_id, self.actor_id, self.name, self.api_token, purpose='download')

        def run_server(corrupt=False):
            if sock_path.exists():
                sock_path.unlink()
            srv = sock_mod.socket(sock_mod.AF_UNIX, sock_mod.SOCK_STREAM)
            srv.bind(str(sock_path))
            os.chmod(sock_path, 0o600)
            srv.listen(1)
            def serve():
                with srv:
                    conn, _ = srv.accept()
                    with conn:
                        raw = conn.recv(4096)
                        req = json.loads(raw.decode('utf-8'))
                        assert req['type'] == 'installation_backup_download'
                        meta = {
                            'operationId': self.op_id,
                            'name': self.name,
                            'manifestDigest': manifest_digest,
                            'archiveSha256': ('sha256:' + '0' * 64) if corrupt else sha,
                            'sizeBytes': len(payload),
                        }
                        conn.sendall((json.dumps({'version': 1, 'status': 'ready', 'download': meta}) + '\n').encode('utf-8'))
                        conn.sendall(payload)
            t = threading.Thread(target=serve, daemon=True)
            t.start()
            return t

        t1 = run_server(corrupt=False)
        proxy = updater_mod.InstallationBackupProxy(str(sock_path))
        res = proxy.download(receipt)
        t1.join(timeout=5)
        self.assertIsInstance(res, updater_mod.BinaryStreamResponse)
        self.assertEqual(res.payload, payload)
        self.assertEqual(res.metadata['archiveSha256'], sha)
        self.assertEqual(res.metadata['sizeBytes'], len(payload))

        t2 = run_server(corrupt=True)
        with self.assertRaises(updater_mod.ProtocolError) as ctx:
            proxy.download(receipt)
        t2.join(timeout=5)
        self.assertEqual(ctx.exception.code, 'unavailable')


if __name__ == '__main__':
    unittest.main()
