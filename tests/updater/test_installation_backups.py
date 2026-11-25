"""Approval protocol tests plus real protected journal tests on isolated Linux."""
import hashlib
import fcntl
import hmac
import importlib.util
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
from types import SimpleNamespace
import unittest
import uuid
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'apps/updater' / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


backups = load('servus_installation_backups', 'installation-backups.py')
supervisor = load('servus_installation_supervisor', 'supervisor.py')
TOKEN = '42' * 32
NOW = 1_794_923_000_000


def receipt(operation_id=None, actor_id=None, name='Before configuration change', issued=NOW):
    value = {'version': 1, 'operationId': operation_id or str(uuid.uuid4()), 'actorId': actor_id or str(uuid.uuid4()),
             'name': name, 'issuedAt': issued, 'proof': '0' * 64}
    value['proof'] = hmac.new(bytes.fromhex(TOKEN), backups.approval_message(value), hashlib.sha256).hexdigest()
    return value


class ApprovalTest(unittest.TestCase):
    def test_binds_actor_operation_name_and_api_role_key(self):
        value = receipt(name='Przed zmianą - żółć')
        approved = backups.verify_approval(value, TOKEN, now_ms=NOW)
        self.assertEqual(approved, {key: value[key] for key in ('operationId', 'actorId', 'name', 'issuedAt')})
        for key, replacement in (('operationId', str(uuid.uuid4())), ('actorId', str(uuid.uuid4())),
                                 ('name', 'Different operation'), ('issuedAt', NOW - 1)):
            with self.subTest(key=key), self.assertRaises(backups.BackupError):
                backups.verify_approval({**value, key: replacement}, TOKEN, now_ms=NOW)
        with self.assertRaises(backups.BackupError):
            backups.verify_approval(value, '24' * 32, now_ms=NOW)

    def test_rejects_stale_future_or_ambiguous_approval(self):
        value = receipt()
        for delta in (-60001, 60001):
            with self.subTest(delta=delta), self.assertRaises(backups.BackupError):
                backups.verify_approval(value, TOKEN, now_ms=NOW + delta)
        for changes in ({'path': '/etc'}, {'name': 'bad\nname'}, {'name': '\ud800'}, {'version': True},
                        {'issuedAt': True}, {'proof': '0' * 63}, {'name': ' name'}):
            with self.subTest(changes=changes), self.assertRaises(backups.BackupError):
                backups.verify_approval({**value, **changes}, TOKEN, now_ms=NOW)

    def test_rejects_an_ordinary_claimed_lease_before_any_capture(self):
        with self.assertRaisesRegex(backups.BackupError, 'authenticated maintenance lease'):
            backups.capture_stopped_snapshot(None, str(uuid.uuid4()), object(), '/ignored', -1,
                                            supervisor, None, None, None)


@unittest.skipUnless(sys.platform == 'linux' and os.geteuid() == 0 and sys.flags.isolated,
                     'Requires isolated Linux root and /proc flock evidence')
class ProtectedJournalTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='servus-installation-backup-', dir='/root')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for name, mode in (('install', 0o700), ('gate', 0o755), ('journal', 0o700)):
            (self.root / name).mkdir(mode=mode)
        (self.root / 'install' / 'install.lock').write_bytes(b'')
        (self.root / 'install' / 'install.lock').chmod(0o600)
        (self.root / 'gate' / 'lock').write_bytes(b'')
        (self.root / 'gate' / 'lock').chmod(0o644)
        (self.root / 'gate' / 'state').write_bytes(b'servus-lifecycle-v1 normal\n')
        (self.root / 'gate' / 'state').chmod(0o644)
        self.maintenance = supervisor.MaintenanceSupervisor(str(self.root / 'install'), str(self.root / 'gate'), str(self.root / 'journal'))
        self.addCleanup(self.maintenance.close)
        self.journal = backups.BackupJournal(self.maintenance, supervisor)
        self.addCleanup(self.journal.close)

    def test_history_survives_reopen_is_newest_first_and_respects_frame_budget(self):
        ids = []
        for index in range(13):
            record = self.journal.request(receipt(name='🚀' * 100), TOKEN, now_ms=NOW + index)
            ids.append(record['operationId'])
            self.journal.transition(record['operationId'], 'requested', 'failed', errorCode='capture_failed')
            self.journal.clear_terminal(record['operationId'])
        self.journal.close()
        self.journal = backups.BackupJournal(self.maintenance, supervisor)
        self.addCleanup(self.journal.close)
        seen, cursor = [], None
        while True:
            page = self.journal.history(cursor)
            self.assertLessEqual(len(json.dumps({'version': 1, 'status': 'history', 'history': page}).encode()), 4096)
            for item in page['operations']:
                self.assertEqual(set(item), {'operationId', 'actorId', 'name', 'state', 'createdAt', 'updatedAt', 'errorCode'})
                self.assertEqual(item['state'], 'failed')
                self.assertEqual(item['name'], '🚀' * 100)
            seen.extend(item['operationId'] for item in page['operations'])
            cursor = page['nextCursor']
            if cursor is None:
                break
        self.assertEqual(seen, list(reversed(ids)))
        with self.assertRaises(backups.BackupError):
            self.journal.history('../escape')
        with self.assertRaises(FileNotFoundError):
            self.journal.history(str(uuid.uuid4()))

    def test_persists_approval_and_idempotency_across_reopen(self):
        approval = receipt()
        first = self.journal.request(approval, TOKEN, now_ms=NOW)
        self.journal.close()
        self.journal = backups.BackupJournal(self.maintenance, supervisor)
        self.addCleanup(self.journal.close)
        self.assertEqual(self.journal.active(), first)
        self.assertEqual(self.journal.request(approval, TOKEN, now_ms=NOW), first)
        changed = receipt(approval['operationId'], approval['actorId'], 'Changed name')
        with self.assertRaisesRegex(backups.BackupError, 'different input'):
            self.journal.request(changed, TOKEN, now_ms=NOW)
        with self.assertRaisesRegex(backups.BackupError, 'Another installation backup'):
            self.journal.request(receipt(), TOKEN, now_ms=NOW)

    def test_validates_transition_before_writing_and_preserves_original_on_failure(self):
        value = self.journal.request(receipt(), TOKEN, now_ms=NOW)
        with self.assertRaises(backups.BackupError):
            self.journal.transition(value['operationId'], 'requested', 'capturing', containers={'api': []})
        self.assertEqual(self.journal.get(value['operationId']), value)

    def test_recovers_the_approved_record_after_interruption_before_active_pointer(self):
        approved = receipt()
        value = self.journal.request(approved, TOKEN, now_ms=NOW)
        os.unlink('active.json', dir_fd=self.journal.directory)
        self.assertEqual(self.journal.active(), value)
        self.assertEqual(self.journal.request(approved, TOKEN, now_ms=NOW), value)
        with self.assertRaisesRegex(backups.BackupError, 'Another installation backup'):
            self.journal.request(receipt(), TOKEN, now_ms=NOW)
        with self.assertRaisesRegex(backups.BackupError, 'stale'):
            self.journal.transition(value['operationId'], 'starting', 'completed')
        self.assertEqual(self.journal.get(value['operationId']), value)

    def test_serializes_work_and_does_not_clear_a_live_or_different_operation(self):
        value = self.journal.request(receipt(), TOKEN, now_ms=NOW)
        with self.assertRaises(backups.BackupError):
            self.journal.clear_terminal(value['operationId'])
        failed = self.journal.transition(value['operationId'], 'requested', 'failed', errorCode='capture_failed')
        self.assertEqual(failed['state'], 'failed')
        self.journal.clear_terminal(value['operationId'])
        self.assertIsNone(self.journal.active())
        self.assertEqual(self.journal.request(receipt(), TOKEN, now_ms=NOW)['state'], 'requested')

    def test_interrupted_drain_cannot_be_cleared_or_resumed_without_a_verified_snapshot(self):
        value = self.journal.request(receipt(), TOKEN, now_ms=NOW)
        record = self.journal.transition(value['operationId'], 'requested', 'recovery_required', errorCode='resume_required')
        self.assertIsNone(record['snapshotPath'])
        with self.assertRaises(backups.BackupError):
            self.journal.clear_terminal(value['operationId'])
        with self.assertRaises(backups.BackupError):
            self.journal.transition(value['operationId'], 'recovery_required', 'starting')
        self.assertEqual(self.journal.get(value['operationId']), record)
        with self.assertRaisesRegex(backups.BackupError, 'Another installation backup'):
            self.journal.request(receipt(), TOKEN, now_ms=NOW)

    def test_rejects_symlink_and_modified_lock_instead_of_following_application_data(self):
        value = self.journal.request(receipt(), TOKEN, now_ms=NOW)
        directory = self.root / 'journal' / 'installation-backups'
        record = directory / (value['operationId'] + '.json')
        original = record.read_bytes()
        record.unlink()
        record.symlink_to(self.root / 'gate' / 'state')
        with self.assertRaises(OSError):
            self.journal.get(value['operationId'])
        record.unlink()
        record.write_bytes(original)
        record.chmod(0o600)
        (self.root / 'install' / 'install.lock').unlink()
        (self.root / 'install' / 'install.lock').write_bytes(b'')
        with self.assertRaises(backups.BackupError):
            self.journal.get(value['operationId'])

    def test_rejects_corrupted_metadata_and_duplicate_json_fields(self):
        value = self.journal.request(receipt(), TOKEN, now_ms=NOW)
        record = self.root / 'journal' / 'installation-backups' / (value['operationId'] + '.json')
        record.write_text(json.dumps({**value, 'snapshotPath': '/etc/passwd'}))
        with self.assertRaisesRegex(backups.BackupError, 'snapshot path'):
            self.journal.get(value['operationId'])
        record.write_text('{"operationId":"one","operationId":"two"}')
        with self.assertRaisesRegex(backups.BackupError, 'Duplicate'):
            self.journal.get(value['operationId'])

    def ready_for_finalization(self, *, starting=True):
        approved = receipt()
        record = self.journal.request(approved, TOKEN, now_ms=NOW)
        operation_id = record['operationId']
        identities = {role: {'id': str(index + 1) * 64} for index, role in enumerate(supervisor.ROLES)}
        policy = object()
        binding = ('/etc/servus/policy.json', 'sha256:' + 'a' * 64, 'sha256:' + 'b' * 64, policy)
        containers = {role: item['id'] for role, item in identities.items()}
        self.journal.transition(operation_id, 'requested', 'capturing', policyBinding=list(binding[:3]), containers=containers)
        self.journal.transition(operation_id, 'capturing', 'verified',
                                snapshotPath='/root/installation-' + operation_id, manifestDigest='sha256:' + 'c' * 64)
        if starting:
            self.journal.transition(operation_id, 'verified', 'starting')
        self.maintenance._record(operation_id, 'starting' if starting else 'snapshot_verified', {role: str(uuid.uuid4()) for role in supervisor.ROLES}, 60000)
        supervisor._atomic_file(self.maintenance.gate, 'state', b'servus-lifecycle-v1 recovering\n' if starting else b'servus-lifecycle-v1 maintenance\n', 0o644)
        hub = object.__new__(supervisor.DrainHub)
        hub.used, hub.identities, hub.policy, hub.connections = False, identities, policy, {}
        peers = {}
        for role in supervisor.ROLES:
            channel, peer = socket.socketpair()
            hub.connections[role], peers[role] = channel, peer
            self.addCleanup(channel.close)
            self.addCleanup(peer.close)
        health = [{'Id': item['id'], 'State': {'Running': True, 'Health': {'Status': 'healthy'}}} for item in identities.values()]
        daemon = SimpleNamespace(approved_policy_binding=mock.Mock(return_value=binding))
        update = SimpleNamespace(verify_snapshot=mock.Mock())
        return operation_id, hub, peers, health, daemon, update

    def start_lease(self, hub, operation_id, daemon):
        hub.used = True
        binding = daemon.approved_policy_binding.return_value
        daemon.resolve_active_policy = mock.Mock(return_value=(binding[0], '/etc/servus/active.env', hub.policy))
        fcntl.flock(self.maintenance.gate_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        lease = supervisor.DrainLease(self.maintenance, operation_id,
                                      {role: str(uuid.uuid4()) for role in supervisor.ROLES}, 60000, binding, hub=hub)
        lease._state = 'snapshot_verified'
        ownership = SimpleNamespace(directory=self.maintenance.journal, assert_held=mock.Mock())
        return lease, ownership

    def test_restart_reverifies_snapshot_and_policy_but_keeps_work_fenced(self):
        operation_id, hub, _, _, daemon, update = self.ready_for_finalization(starting=False)
        lease, ownership = self.start_lease(hub, operation_id, daemon)
        with mock.patch.object(supervisor, 'inspect_servus', return_value=hub.identities) as inspect, \
             mock.patch.object(supervisor, '_docker') as docker:
            result = backups.start_captured_snapshot(self.journal, operation_id, lease, ownership, '/root/journal.sqlite',
                                                       '/etc/servus/active.env', supervisor, daemon, object(), update, -1)
        self.assertEqual(result, {'operationId': operation_id, 'state': 'starting'})
        inspect.assert_called_once_with(hub.policy, stopped=True)
        update.verify_snapshot.assert_called_once()
        self.assertEqual([call.args for call in docker.call_args_list],
                         [('start', hub.identities[role]['id']) for role in ('agent', 'api', 'worker')])
        self.assertEqual(self.journal.get(operation_id)['state'], 'starting')
        self.assertEqual(self.gate_state(), b'servus-lifecycle-v1 recovering\n')
        self.assertTrue(lease._settled)

    def test_changed_policy_or_corrupt_snapshot_never_releases_startup_gate(self):
        operation_id, hub, _, _, daemon, update = self.ready_for_finalization(starting=False)
        lease, ownership = self.start_lease(hub, operation_id, daemon)
        original = daemon.approved_policy_binding.return_value
        daemon.approved_policy_binding.return_value = ('/etc/servus/other.json', *original[1:])
        with mock.patch.object(supervisor, '_docker') as docker:
            with self.assertRaisesRegex(backups.BackupError, 'policy changed'):
                backups.start_captured_snapshot(self.journal, operation_id, lease, ownership, '/root/journal.sqlite',
                                                  '/etc/servus/active.env', supervisor, daemon, object(), update, -1)
            daemon.approved_policy_binding.return_value = original
            update.verify_snapshot.side_effect = ValueError('Invalid snapshot')
            with mock.patch.object(supervisor, 'inspect_servus', return_value=hub.identities), \
                 self.assertRaisesRegex(ValueError, 'Invalid snapshot'):
                backups.start_captured_snapshot(self.journal, operation_id, lease, ownership, '/root/journal.sqlite',
                                                  '/etc/servus/active.env', supervisor, daemon, object(), update, -1)
            docker.assert_not_called()
        self.assertEqual(self.journal.get(operation_id)['state'], 'verified')
        self.assertEqual(self.gate_state(), b'servus-lifecycle-v1 maintenance\n')

    def test_partial_restart_retains_snapshot_and_explicit_recovery_requirement(self):
        operation_id, hub, _, _, daemon, update = self.ready_for_finalization(starting=False)
        lease, ownership = self.start_lease(hub, operation_id, daemon)
        with mock.patch.object(supervisor, 'inspect_servus', return_value=hub.identities), \
             mock.patch.object(supervisor, '_docker', side_effect=[b'', OSError('fixture start failure')]), \
             self.assertRaisesRegex(OSError, 'fixture start failure'):
            backups.start_captured_snapshot(self.journal, operation_id, lease, ownership, '/root/journal.sqlite',
                                              '/etc/servus/active.env', supervisor, daemon, object(), update, -1)
        record = self.journal.get(operation_id)
        self.assertEqual(record['state'], 'recovery_required')
        self.assertEqual(record['errorCode'], 'resume_required')
        self.assertIsNotNone(record['manifestDigest'])
        self.assertEqual(self.gate_state(), b'servus-lifecycle-v1 recovering\n')

    def finalize(self, hub, health, daemon, update, *, inventory=None):
        with mock.patch.object(supervisor, 'inspect_servus', return_value=inventory or hub.identities), \
             mock.patch.object(supervisor, '_docker', return_value=json.dumps(health)):
            return backups.finalize_captured_snapshot(self.journal, hub, '/etc/servus/policy.json', '/root/journal.sqlite',
                                                       '/etc/servus/active.env', supervisor, daemon, object(), update, -1)

    def gate_state(self):
        return (self.root / 'gate' / 'state').read_bytes()

    def test_fresh_channels_health_and_verified_snapshot_release_work_and_clear_only_its_marker(self):
        operation_id, hub, _, health, daemon, update = self.ready_for_finalization()
        self.assertTrue(self.finalize(hub, health, daemon, update))
        update.verify_snapshot.assert_called_once()
        self.assertEqual(self.journal.get(operation_id)['state'], 'completed')
        self.assertIsNone(self.journal.active())
        self.assertFalse((self.root / 'journal' / 'maintenance.json').exists())
        self.assertEqual(self.gate_state(), b'servus-lifecycle-v1 normal\n')

    def test_unhealthy_or_changed_generation_never_opens_work_gate(self):
        operation_id, hub, _, health, daemon, update = self.ready_for_finalization()
        health[0]['State']['Health']['Status'] = 'unhealthy'
        with self.assertRaisesRegex(backups.BackupError, 'health'):
            self.finalize(hub, health, daemon, update)
        health[0]['State']['Health']['Status'] = 'healthy'
        changed = {**hub.identities, 'api': {'id': 'f' * 64}}
        with self.assertRaisesRegex(backups.BackupError, 'generation'):
            self.finalize(hub, health, daemon, update, inventory=changed)
        self.assertEqual(self.journal.get(operation_id)['state'], 'starting')
        self.assertEqual(self.gate_state(), b'servus-lifecycle-v1 recovering\n')

    def test_channel_disconnect_or_pending_message_does_not_finalize(self):
        operation_id, hub, peers, health, daemon, update = self.ready_for_finalization()
        peers['api'].sendall(b'unexpected')
        self.assertFalse(self.finalize(hub, health, daemon, update))
        self.assertEqual(hub.connections['api'].recv(32), b'unexpected')
        peers['api'].close()
        self.assertFalse(self.finalize(hub, health, daemon, update))
        self.assertEqual(self.journal.get(operation_id)['state'], 'starting')
        update.verify_snapshot.assert_not_called()
        self.assertEqual(self.gate_state(), b'servus-lifecycle-v1 recovering\n')

    def test_snapshot_corruption_or_maintenance_mismatch_keeps_receipts_and_gate(self):
        operation_id, hub, _, health, daemon, update = self.ready_for_finalization()
        update.verify_snapshot.side_effect = ValueError('Invalid snapshot')
        with self.assertRaisesRegex(ValueError, 'Invalid snapshot'):
            self.finalize(hub, health, daemon, update)
        update.verify_snapshot.side_effect = None
        self.maintenance._record(str(uuid.uuid4()), 'starting', {role: str(uuid.uuid4()) for role in supervisor.ROLES}, 60000)
        with self.assertRaisesRegex(backups.BackupError, 'receipt changed'):
            self.finalize(hub, health, daemon, update)
        self.assertEqual(self.journal.get(operation_id)['state'], 'starting')
        self.assertEqual(self.gate_state(), b'servus-lifecycle-v1 recovering\n')

    def test_resumes_finalization_after_completed_receipt_and_marker_unlink(self):
        operation_id, hub, _, health, daemon, update = self.ready_for_finalization()
        self.journal.transition(operation_id, 'starting', 'completed')
        os.unlink('maintenance.json', dir_fd=self.maintenance.journal)
        self.assertTrue(self.finalize(hub, health, daemon, update))
        self.assertIsNone(self.journal.active())
        self.assertEqual(self.gate_state(), b'servus-lifecycle-v1 normal\n')

    def test_missing_start_receipt_is_not_reconstructed_before_durable_completion(self):
        operation_id, hub, _, health, daemon, update = self.ready_for_finalization()
        os.unlink('maintenance.json', dir_fd=self.maintenance.journal)
        with self.assertRaisesRegex(backups.BackupError, 'receipt is unavailable'):
            self.finalize(hub, health, daemon, update)
        self.assertEqual(self.journal.get(operation_id)['state'], 'starting')
        self.assertEqual(self.gate_state(), b'servus-lifecycle-v1 recovering\n')


if __name__ == '__main__':
    unittest.main()
