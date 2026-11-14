import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import shutil
import stat
import sys
import tempfile
import unittest
import uuid
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'apps/updater' / path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


backup = load('restore_backup', 'backup.py')
supervisor = load('restore_supervisor', 'supervisor.py')
coordinator = load('restore_coordinator', 'update-coordinator.py')
restore = load('restore_snapshot', 'restore-snapshot.py')


@unittest.skipUnless(sys.platform == 'linux' and os.geteuid() == 0 and sys.flags.isolated, 'Requires isolated Linux root')
class RestoreSnapshotTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir='/root')
        self.root = Path(self.temp.name)
        self.source = self.root / 'snapshot'
        self.parent = self.root / 'migrations'
        self.source.mkdir(mode=0o700)
        self.parent.mkdir(mode=0o711)
        for folder in ('secrets', 'database-roots'):
            (self.source / folder).mkdir(mode=0o700)
        for name in ('panel.sqlite', 'agent.sqlite'):
            with sqlite3.connect(self.source / name) as db:
                db.execute('CREATE TABLE fixture (id INTEGER PRIMARY KEY)')
                db.execute('INSERT INTO fixture VALUES (1)')
            (self.source / name).chmod(0o600)
        for name in ('secret-key', 'agent-token'):
            (self.source / name).write_bytes(b'a' * 64)
            (self.source / name).chmod(0o600)
        self.secret = str(uuid.uuid4())
        (self.source / 'secrets' / self.secret).write_bytes(b'encrypted fixture')
        (self.source / 'secrets' / self.secret).chmod(0o600)
        names = ('panel.sqlite', 'agent.sqlite', 'secret-key', 'agent-token', 'secrets/' + self.secret)
        self.files = {name: hashlib.sha256((self.source / name).read_bytes()).hexdigest() for name in names}
        raw = json.dumps({'format': 1, 'files': self.files}, sort_keys=True, separators=(',', ':')).encode() + b'\n'
        (self.source / 'manifest.json').write_bytes(raw)
        (self.source / 'manifest.json').chmod(0o600)
        self.digest = 'sha256:' + hashlib.sha256(raw).hexdigest()
        self.operation = str(uuid.uuid4())

    def tearDown(self):
        self.temp.cleanup()

    def run_stage(self):
        with mock.patch.object(backup, '_validate_staging'):
            return Path(restore.stage(str(self.source), self.digest, str(self.parent), self.operation,
                                      backup, -1, supervisor, coordinator))

    def test_restores_exact_inventory_under_root_owned_traversable_parent(self):
        target = self.run_stage()
        self.assertEqual(stat.S_IMODE(self.parent.stat().st_mode), 0o711)
        self.assertEqual((target.stat().st_uid, target.stat().st_gid, stat.S_IMODE(target.stat().st_mode)), (1000, 1000, 0o700))
        self.assertFalse((target / 'manifest.json').exists())
        self.assertEqual(set(path.name for path in target.iterdir()), {'panel.sqlite', 'agent.sqlite', 'secret-key', 'agent-token', 'secrets', 'database-roots'})
        for name, digest in self.files.items():
            path = target / name
            self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), digest)
            self.assertEqual((path.stat().st_uid, path.stat().st_gid, stat.S_IMODE(path.stat().st_mode)), (1000, 1000, 0o600))
        supervisor._verify_data_directory(str(target))
        self.assertEqual((self.source / 'secrets' / self.secret).read_bytes(), b'encrypted fixture')

    def test_corrupted_snapshot_is_rejected_before_destination_exists(self):
        (self.source / 'agent-token').write_bytes(b'changed')
        with self.assertRaises(coordinator.UpdateError): self.run_stage()
        self.assertEqual(list(self.parent.iterdir()), [])

    def test_existing_destination_is_never_replaced(self):
        target = self.parent / ('restore-' + self.operation)
        target.mkdir(mode=0o700)
        (target / 'sentinel').write_text('existing')
        with self.assertRaises(FileExistsError): self.run_stage()
        self.assertEqual((target / 'sentinel').read_text(), 'existing')

    def test_failed_second_verification_keeps_partial_directory_root_owned(self):
        verifier = coordinator.verify_snapshot
        def verify(*args):
            if args[0] != str(self.source): raise restore.RestoreError('Injected failure')
            return verifier(*args)
        with mock.patch.object(coordinator, 'verify_snapshot', side_effect=verify):
            with self.assertRaises(restore.RestoreError): self.run_stage()
        target = self.parent / ('restore-' + self.operation)
        self.assertEqual((target.stat().st_uid, stat.S_IMODE(target.stat().st_mode)), (0, 0o700))
        self.assertEqual((self.source / 'agent-token').read_bytes(), b'a' * 64)

    def test_modified_copy_is_rejected_before_ownership_transfer(self):
        verifier = coordinator.verify_snapshot
        def verify(*args):
            if args[0] != str(self.source): (Path(args[0]) / 'agent-token').write_bytes(b'changed')
            return verifier(*args)
        with mock.patch.object(coordinator, 'verify_snapshot', side_effect=verify):
            with self.assertRaises(coordinator.UpdateError): self.run_stage()
        target = self.parent / ('restore-' + self.operation)
        self.assertEqual(target.stat().st_uid, 0)
        self.assertEqual((self.source / 'agent-token').read_bytes(), b'a' * 64)

    @unittest.skipUnless(Path('/.dockerenv').is_file(), 'Requires a disposable Docker container')
    def test_data_owner_can_read_sqlite_without_listing_migration_parent(self):
        with tempfile.TemporaryDirectory(prefix='servus-restore-fixture-', dir='/var/lib') as path:
            root = Path(path); root.chmod(0o711)
            snapshot = root / 'snapshot'; shutil.copytree(self.source, snapshot)
            parent = root / 'migrations'; parent.mkdir(mode=0o711)
            with mock.patch.object(backup, '_validate_staging'):
                target = restore.stage(str(snapshot), self.digest, str(parent), self.operation,
                                       backup, -1, supervisor, coordinator)
            pid = os.fork()
            if pid == 0:
                try:
                    os.setgroups([]); os.setgid(1000); os.setuid(1000)
                    try: os.listdir(parent)
                    except PermissionError: pass
                    else: os._exit(1)
                    with sqlite3.connect('file:' + target + '/panel.sqlite?mode=ro', uri=True) as db:
                        if db.execute('SELECT id FROM fixture').fetchone() != (1,): os._exit(1)
                    os._exit(0)
                except BaseException: os._exit(1)
            _, status = os.waitpid(pid, 0)
            self.assertTrue(os.WIFEXITED(status) and os.WEXITSTATUS(status) == 0)


if __name__ == '__main__': unittest.main()
