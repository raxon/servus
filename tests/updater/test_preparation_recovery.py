"""Run in an isolated root Linux container with python3 -I."""
import fcntl
import importlib.util
import json
import os
import pathlib
import sqlite3
import sys
import tempfile
import unittest
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[2]


def load(name, relative):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


recovery = load('recovery', 'apps/updater/preparation-recovery.py')
updater = load('recovery_fixture_updater', 'apps/updater/servus-updater.py')
OP = '12345678-1234-4123-8123-123456789abc'
OTHER = '12345678-1234-4123-8123-123456789def'
ROOT_DIGEST = 'sha256:' + 'b' * 64
CONFIG = 'sha256:' + 'c' * 64


@unittest.skipUnless(sys.platform == 'linux' and os.geteuid() == 0 and sys.flags.isolated,
                     'Requires isolated Linux root fixture')
class PreparationRecoveryTest(unittest.TestCase):
    def setUp(self):
        # Avoid /tmp: production path validation rejects world-writable parents.
        self.tmp = tempfile.TemporaryDirectory(dir='/root')
        self.root = pathlib.Path(self.tmp.name)
        self.state = self.root / 'state'; self.state.mkdir(mode=0o700)
        self.install = self.root / 'install'; self.install.mkdir(mode=0o700)
        (self.state / 'staging').mkdir(mode=0o700)
        (self.state / 'maintenance').mkdir(mode=0o700)
        (self.install / 'install.lock').touch(mode=0o600)
        self.journal = updater.Journal(self.state)
        self.journal.submit(OP, 'a' * 40, ROOT_DIGEST, 'v0.1.54')
        attempt = self.journal.claim()
        self.journal.finish(attempt, 'verified', CONFIG)
        self.old = self.journal.claim_preparation(OP)
        self.journal.finish_preparation(self.old)
        self.commands = []
        self.unit = 'LoadState=not-found\nActiveState=inactive\nControlGroup=\n'
        self.image = dict(Id=ROOT_DIGEST, RepoDigests=[recovery.IMAGE + '@' + ROOT_DIGEST],
                          Os='linux', Architecture='amd64', RootFS=dict(Type='layers', Layers=[CONFIG]))
        # Module trust is real; executable files in this offline fixture are
        # never run. All host commands are injected and asserted read-only.
        original = recovery.trusted_file
        self.executable_check = mock.patch.object(recovery, 'trusted_file', side_effect=lambda path, **kw:
            None if str(path) in ('/usr/bin/docker', '/usr/bin/systemctl') else original(path, **kw))
        self.executable_check.start()
        self.resolve = mock.patch.object(pathlib.Path, 'resolve', autospec=True,
                                         side_effect=lambda path, **kw: path)
        self.resolve.start()

    def tearDown(self):
        self.resolve.stop(); self.executable_check.stop()
        self.journal.close(); self.tmp.cleanup()

    def execute(self, command):
        self.commands.append(command)
        if command[0] == '/usr/bin/systemctl':
            self.assertIn(self.old['preparationId'].replace('-', ''), command[2])
            return self.unit
        self.assertEqual(command[:3], ['/usr/bin/docker', 'image', 'inspect'])
        self.assertEqual(command[-1], recovery.IMAGE + '@' + ROOT_DIGEST)
        return json.dumps(self.image)

    def recover(self, **kw):
        return recovery.recover(OP, str(self.state), str(self.install), execute=self.execute,
                                module_dir=ROOT / 'apps/updater', **kw)

    def unchanged(self):
        return self.journal.db.execute('SELECT * FROM operations').fetchall(), self.journal.db.execute('SELECT * FROM preparations').fetchall()

    def refused(self, reason=None):
        before = self.unchanged()
        with self.assertRaises(recovery.RecoveryError) as caught:
            self.recover()
        if reason:
            self.assertEqual(caught.exception.reason, reason)
        self.assertEqual(self.unchanged(), before)
        self.assertFalse((self.state / 'preparation-recovery-audit.jsonl').exists())

    def test_valid_recovery_preserves_verification_and_fences_old_executor(self):
        operations = self.unchanged()[0]
        schema = self.journal.db.execute('SELECT sql FROM sqlite_master ORDER BY name').fetchall()
        result = self.recover()
        self.assertTrue(result['ok'])
        self.assertNotEqual(result['preparationId'], self.old['preparationId'])
        self.assertEqual(self.unchanged()[0], operations)
        self.assertEqual(self.journal.db.execute('SELECT sql FROM sqlite_master ORDER BY name').fetchall(), schema)
        self.assertEqual(self.journal.db.execute('SELECT count(*) FROM extraction_probes').fetchone(), (0,))
        self.assertIsNone(self.journal.preparing(OP, self.old['preparationId']))
        with self.assertRaises(RuntimeError): self.journal.assert_preparation(self.old)
        self.assertEqual(self.journal.preparing(OP)['preparationId'], result['preparationId'])
        audit = json.loads((self.state / 'preparation-recovery-audit.jsonl').read_text())
        self.assertEqual(audit['oldPreparationId'], self.old['preparationId'])
        self.assertEqual(audit['newPreparationId'], result['preparationId'])
        self.assertEqual(audit['attemptNonce'], self.old['attemptNonce'])
        self.assertEqual(audit['attemptId'], self.old['attemptId'])
        self.assertEqual(len(self.commands), 6)

    def test_config_image_id_and_failed_empty_unit_are_accepted(self):
        self.image['Id'] = CONFIG
        self.unit = 'LoadState=loaded\nActiveState=failed\nControlGroup=\n'
        self.assertTrue(self.recover()['ok'])

    def test_dry_run_leaves_claim_and_audit_untouched(self):
        before = self.unchanged()
        self.assertEqual(self.recover(dry_run=True)['action'], 'eligible')
        self.assertEqual(self.unchanged(), before)
        self.assertFalse((self.state / 'preparation-recovery-audit.jsonl').exists())

    def test_intent_and_removed_extraction_probes_both_forbid_recovery(self):
        for status in ('intent', 'removed'):
            with self.subTest(status=status):
                self.journal.db.execute('INSERT INTO extraction_probes VALUES(?,?,?,?,?,?,?)',
                    ('servus-extract-' + 'a' * 32, OP, self.old['attemptId'], self.old['attemptNonce'], self.old['preparationId'], 'prepare', status))
                self.refused('operation_already_progressed')
                self.journal.db.execute('DELETE FROM extraction_probes')

    def test_staging_wrong_attempt_nonverified_are_rejected(self):
        cases = [("UPDATE preparations SET staging_path='/stage'", 'staging_already_recorded'),
                 ("UPDATE preparations SET attempt_id=?", 'preparation_binding_mismatch'),
                 ("UPDATE operations SET status='verification_failed'", 'verified_identity_unavailable')]
        for query, reason in cases:
            with self.subTest(reason=reason):
                self.journal.db.execute(query, (OTHER,) if '?' in query else ())
                self.refused(reason)
                self.journal.db.execute("UPDATE operations SET status='verified' WHERE id=?", (OP,))
                self.journal.db.execute('UPDATE preparations SET staging_path=NULL,attempt_id=? WHERE operation_id=?', (self.old['attemptId'], OP))

    def test_wrong_image_or_platform_or_reference_is_rejected(self):
        for key, value in [('Id', 'sha256:' + 'd' * 64), ('Architecture', 'arm64'),
                           ('RepoDigests', []), ('RootFS', None)]:
            with self.subTest(key=key):
                old = self.image[key]; self.image[key] = value
                self.refused('cached_image_identity_mismatch'); self.image[key] = old

    def test_apply_transaction_and_policy_history_for_target_are_rejected(self):
        statements = ["INSERT INTO apply_requests VALUES(?, 'completed')",
            "INSERT INTO update_transactions(operation_id,preparation_id,attempt_id,attempt_nonce,root_digest,phase) VALUES(?, 'p', 'a', 'n', 'r', 'completed')",
            "CREATE TABLE policy_approvals(operation_id TEXT,state TEXT)",
            "CREATE TABLE initial_generations(operation_id TEXT,phase TEXT)"]
        for query in statements:
            with self.subTest(query=query):
                self.journal.db.execute(query, (OP,) if '?' in query else ())
                if 'CREATE TABLE' in query:
                    table = query.split('(')[0].split()[-1]
                    self.journal.db.execute('INSERT INTO ' + table + ' VALUES(?,?)', (OP, 'active' if table == 'policy_approvals' else 'started'))
                self.refused('operation_already_progressed')
                if 'CREATE TABLE' in query:
                    self.journal.db.execute('DROP TABLE ' + table)
                else:
                    self.journal.db.execute('DELETE FROM ' + ('apply_requests' if 'apply_requests' in query else 'update_transactions'))

    def test_other_active_claims_and_maintenance_are_rejected(self):
        self.journal.db.execute("INSERT INTO operations(id,commit_sha,digest,tag,status) VALUES(?, 'a', 'b', 'v0.1.55', 'accepted')", (OTHER,))
        self.refused('other_active_operation')
        self.journal.db.execute("UPDATE operations SET status='verified' WHERE id=?", (OTHER,))
        self.journal.db.execute("UPDATE preparations SET status='completed' WHERE operation_id=?", (OP,))
        self.journal.db.execute("INSERT INTO preparations VALUES(?, 'a', 'b', ?, 'prepared', NULL)", (OTHER, OTHER))
        self.journal.db.execute('DROP INDEX one_active_preparation')
        self.journal.db.execute("UPDATE preparations SET status='recovery_required' WHERE operation_id=?", (OP,))
        self.refused('other_active_preparation')
        self.journal.db.execute('DELETE FROM preparations WHERE operation_id=?', (OTHER,))
        (self.state / 'maintenance' / 'maintenance.json').write_text('{}')
        self.refused('host_maintenance_pending')

    def test_unsafe_journal_unit_and_installation_lock_are_rejected(self):
        database = self.state / 'journal.sqlite'; database.chmod(0o644)
        self.refused('unsafe_private_file'); database.chmod(0o600)
        for unit in ('LoadState=loaded\nActiveState=active\nControlGroup=\n',
                     'LoadState=loaded\nActiveState=failed\nControlGroup=/leftover\n'):
            self.unit = unit; self.refused('old_executor_not_fenced')
        self.unit = 'LoadState=not-found\nActiveState=inactive\nControlGroup=\n'
        fd = os.open(self.install / 'install.lock', os.O_RDONLY)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.refused('recovery_lock_busy')
        finally: os.close(fd)

    def test_completed_other_generation_history_is_preserved(self):
        self.journal.db.execute("INSERT INTO operations(id,commit_sha,digest,tag,status) VALUES(?,'old','old','v0.1.53','verified')", (OTHER,))
        self.journal.db.execute("INSERT INTO preparations VALUES(?,'old','old',?,'completed','/old/stage')", (OTHER, OTHER))
        self.journal.db.execute('CREATE TABLE initial_generations(operation_id TEXT,phase TEXT)')
        self.journal.db.execute("INSERT INTO initial_generations VALUES(?,'started')", (OTHER,))
        self.journal.db.execute('CREATE TABLE policy_approvals(operation_id TEXT,state TEXT)')
        self.journal.db.execute("INSERT INTO policy_approvals VALUES(?,'active')", (OTHER,))
        before = self.unchanged()
        self.recover()
        self.assertEqual(self.unchanged()[0], before[0])
        self.assertEqual(self.journal.db.execute('SELECT * FROM preparations WHERE operation_id=?', (OTHER,)).fetchone(), before[1][1])

    def test_global_apply_transaction_policy_and_host_work_are_rejected(self):
        cases = [('apply_requests', 'state', 'requested'), ('update_transactions', 'phase', 'intent'),
                 ('policy_approvals', 'state', 'candidate'), ('host_stops', 'status', 'stopping'),
                 ('host_preparations', 'status', 'prepared'), ('host_unit_masks', 'phase', 'masked'),
                 ('initial_generations', 'phase', 'starting')]
        for table, column, value in cases:
            with self.subTest(table=table):
                if table in ('apply_requests', 'update_transactions'):
                    if table == 'apply_requests':
                        self.journal.db.execute('INSERT INTO apply_requests VALUES(?,?)', (OTHER, value))
                    else:
                        self.journal.db.execute("INSERT INTO update_transactions(operation_id,preparation_id,attempt_id,attempt_nonce,root_digest,phase) VALUES(?,'p','a','n','r',?)", (OTHER,value))
                else:
                    self.journal.db.execute('CREATE TABLE ' + table + '(operation_id TEXT,' + column + ' TEXT)')
                    self.journal.db.execute('INSERT INTO ' + table + ' VALUES(?,?)', (OTHER, value))
                self.refused('other_work_or_maintenance_pending')
                if table in ('apply_requests', 'update_transactions'):
                    self.journal.db.execute('DELETE FROM ' + table)
                else:
                    self.journal.db.execute('DROP TABLE ' + table)

    def test_remaining_cgroup_must_have_no_processes_in_hierarchy(self):
        group = self.root / 'cgroup'; group.mkdir()
        (group / 'cgroup.events').write_text('populated 0\nfrozen 0\n')
        (group / 'cgroup.procs').write_text('')
        recovery.assert_empty_cgroup(group)
        (group / 'cgroup.events').write_text('populated 1\nfrozen 0\n')
        with self.assertRaises(recovery.RecoveryError): recovery.assert_empty_cgroup(group)
        (group / 'cgroup.events').write_text('populated 0\nfrozen 0\n')
        (group / 'cgroup.procs').write_text('123\n')
        with self.assertRaises(recovery.RecoveryError): recovery.assert_empty_cgroup(group)

    def test_failed_audit_fsync_does_not_requeue(self):
        sync = os.fsync
        def fail_audit(fd):
            if os.readlink('/proc/self/fd/' + str(fd)).endswith('preparation-recovery-audit.jsonl'):
                raise OSError('synthetic audit sync failure')
            return sync(fd)
        before = self.unchanged()
        with mock.patch.object(recovery.os, 'fsync', side_effect=fail_audit):
            with self.assertRaises(OSError): self.recover()
        self.assertEqual(self.unchanged(), before)

    def test_audit_is_durable_before_claim_changes(self):
        write = os.write
        def observe(fd, data):
            self.assertIsNone(self.journal.preparing(OP))
            return write(fd, data)
        with mock.patch.object(recovery.os, 'write', side_effect=observe):
            self.recover()

    def test_transaction_rechecks_host_and_journal(self):
        original = self.execute; calls = 0
        def race(command):
            nonlocal calls
            calls += 1
            if calls == 3:
                self.journal.db.execute("INSERT INTO extraction_probes VALUES('fixture',?,?,?,?,'prepare','removed')", (OP, self.old['attemptId'], self.old['attemptNonce'], self.old['preparationId']))
            return original(command)
        self.execute = race
        with self.assertRaises(recovery.RecoveryError): self.recover()
        self.assertEqual(self.journal.preparation_status(OP)['status'], 'recovery_required')
        self.assertFalse((self.state / 'preparation-recovery-audit.jsonl').exists())


if __name__ == '__main__':
    unittest.main()
