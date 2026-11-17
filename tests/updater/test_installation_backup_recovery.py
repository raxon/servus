"""Real protected journals/flocks; Docker and process quiescence are explicit boundaries."""
import copy
import hashlib
import hmac
import importlib.util
import json
import os
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
import uuid
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


base = load('installation_recovery_base', ROOT / 'tests/updater/test_installation_backups.py')
policy_fixture = load('installation_recovery_policy', ROOT / 'tests/updater/test_supervisor.py')
backups, supervisor = base.backups, base.supervisor


@unittest.skipUnless(sys.platform == 'linux' and os.geteuid() == 0 and sys.flags.isolated,
                     'Requires isolated Linux root and real install/gate flock evidence')
class InstallationBackupRecoveryTest(unittest.TestCase):
    setUp = base.ProtectedJournalTest.setUp
    ready_for_finalization = base.ProtectedJournalTest.ready_for_finalization
    finalize = base.ProtectedJournalTest.finalize
    gate_state = base.ProtectedJournalTest.gate_state

    def approve_cancel(self, record, **changes):
        value = base.receipt(operation_id=record['operationId'], name=record['name'], **changes)
        value['proof'] = hmac.new(bytes.fromhex(base.TOKEN), backups.approval_message(value, purpose='cancel'), hashlib.sha256).hexdigest()
        return value

    def interrupted(self, *, verified=False):
        record = self.journal.request(base.receipt(), base.TOKEN, now_ms=base.NOW)
        operation_id = record['operationId']
        policy = supervisor.RuntimePolicy(
            image_reference=policy_fixture.POLICY.image_reference, image_id=policy_fixture.POLICY.image_id,
            install_dir='/opt/servus', data_dir='/var/lib/servus', gate_dir='/etc/servus/lifecycle', control_dir='/run/servus-supervisor',
            secret_sources={role: '/etc/servus/secrets/' + role for role in supervisor.ROLES},
            config_hashes={role: 'c' * 64 for role in supervisor.ROLES},
            environments={role: {'PANEL_DATA_DIR': '/var/lib/servus'} for role in supervisor.ROLES},
            host_configs=copy.deepcopy(policy_fixture.HOST_CONFIGS),
            healthchecks={role: copy.deepcopy(policy_fixture.HEALTHCHECK) for role in supervisor.ROLES})
        binding = ('/etc/servus/policy.json', 'sha256:' + 'a' * 64, 'sha256:' + 'b' * 64, policy)
        containers = {role: str(index + 1) * 64 for index, role in enumerate(supervisor.ROLES)}
        self.journal.bind_generation(operation_id, binding[:3], containers)
        self.maintenance._record(operation_id, 'intent', {role: str(uuid.uuid4()) for role in supervisor.ROLES}, 60000)
        if verified:
            self.journal.transition(operation_id, 'requested', 'capturing')
            self.journal.transition(operation_id, 'capturing', 'verified',
                                    snapshotPath='/root/installation-' + operation_id, manifestDigest='sha256:' + 'd' * 64)
        current = self.journal.get(operation_id)
        self.journal.transition(operation_id, current['state'], 'recovery_required', errorCode='resume_required')
        self.daemon = SimpleNamespace(resolve_active_policy=mock.Mock(return_value=(binding[0], '/etc/servus/active.env', policy)),
                                      approved_policy_binding=mock.Mock(return_value=binding))
        self.ownership = SimpleNamespace(directory=self.maintenance.journal, assert_held=mock.Mock())
        self.update = SimpleNamespace(verify_snapshot=mock.Mock())
        self.quiescence = SimpleNamespace(**{key: mock.Mock() for key in ('ensure_host_namespaces', 'ensure_no_other_data_mounts',
            'ensure_no_mount_aliases', 'ensure_no_open_data', 'ensure_no_uid_writers')})
        self.inventory = {role: {'id': cid} for role, cid in containers.items()}
        return operation_id

    def recover(self, operation_id):
        with mock.patch.object(supervisor, 'inspect_servus', return_value=self.inventory), mock.patch.object(supervisor, '_docker') as docker:
            result = backups.recover_original_generation(self.journal, operation_id, self.ownership, '/root/journal.sqlite',
                '/etc/servus/active.env', supervisor, self.daemon, self.quiescence, object(), self.update, -1)
        return result, docker

    def test_cancel_uses_distinct_hmac_and_retains_creator_and_cancelling_actor(self):
        record = self.journal.request(base.receipt(name='Przed zmianą - Łódź'), base.TOKEN, now_ms=base.NOW)
        approval = self.approve_cancel(record)
        self.assertNotEqual(approval['actorId'], record['actorId'])
        with self.assertRaises(backups.BackupError): self.journal.cancel(base.receipt(record['operationId'], record['actorId'], record['name']), base.TOKEN, now_ms=base.NOW)
        with self.assertRaises(backups.BackupError): self.journal.request(approval, base.TOKEN, now_ms=base.NOW)
        result = self.journal.cancel(approval, base.TOKEN, now_ms=base.NOW)
        self.assertEqual((result['state'], result['actorId']), ('cancelled', record['actorId']))
        self.assertIsNone(self.journal.active())
        audit = json.loads((self.root / 'journal/installation-backup-cancellations' / (record['operationId'] + '.json')).read_text())
        self.assertEqual(audit['receipt'], approval)
        self.assertEqual(self.journal.cancel(approval, base.TOKEN, now_ms=base.NOW), result)
        self.assertEqual(self.journal.request(base.receipt(), base.TOKEN, now_ms=base.NOW)['state'], 'requested')

    def test_cancel_after_generation_reservation_is_safe_only_before_any_intent(self):
        record = self.journal.request(base.receipt(), base.TOKEN, now_ms=base.NOW)
        containers = {role: str(index + 1) * 64 for index, role in enumerate(supervisor.ROLES)}
        self.journal.bind_generation(record['operationId'], ('/root/policy.json', 'sha256:' + 'a' * 64, 'sha256:' + 'b' * 64), containers)
        self.maintenance._record(record['operationId'], 'intent', {role: str(uuid.uuid4()) for role in supervisor.ROLES}, 60000)
        with self.assertRaises(supervisor.SupervisorError): self.journal.cancel(self.approve_cancel(record), base.TOKEN, now_ms=base.NOW)
        self.assertEqual(self.journal.active()['state'], 'requested')
        os.unlink('maintenance.json', dir_fd=self.maintenance.journal)
        supervisor._atomic_file(self.maintenance.gate, 'state', b'servus-lifecycle-v1 recovering\n', 0o644)
        with self.assertRaises(backups.BackupError): self.journal.cancel(self.approve_cancel(record), base.TOKEN, now_ms=base.NOW)
        supervisor._atomic_file(self.maintenance.gate, 'state', b'servus-lifecycle-v1 normal\n', 0o644)
        self.assertEqual(self.journal.cancel(self.approve_cancel(record), base.TOKEN, now_ms=base.NOW)['state'], 'cancelled')

    def test_cancel_crash_before_pointer_cleanup_recovers_bound_terminal_queue(self):
        operation_id = self.interrupted()
        record = self.journal.get(operation_id)
        # Model a crash after the cancelled write; this record was bound while
        # requested, and maintenance intent had never been entered.
        self.journal._write(operation_id + '.json', {**record, 'state': 'cancelled', 'errorCode': None})
        os.unlink('maintenance.json', dir_fd=self.maintenance.journal)
        result = backups.recover_original_generation(self.journal, operation_id, None, None, None, supervisor, None, None, None, None, -1)
        self.assertEqual(result['state'], 'cancelled'); self.assertIsNone(self.journal.active())
        self.assertIsNotNone(result['policyBinding'])

    def test_cancellation_audit_survives_interruption_before_terminal_write(self):
        record = self.journal.request(base.receipt(), base.TOKEN, now_ms=base.NOW)
        approval = self.approve_cancel(record)
        with mock.patch.object(self.journal, 'transition', side_effect=OSError('crash before cancelled write')):
            with self.assertRaises(OSError): self.journal.cancel(approval, base.TOKEN, now_ms=base.NOW)
        self.assertEqual(self.journal.active()['state'], 'requested')
        retry = self.approve_cancel(record)
        self.assertNotEqual(retry['actorId'], approval['actorId'])
        self.assertEqual(self.journal.cancel(retry, base.TOKEN, now_ms=base.NOW)['state'], 'cancelled')
        audit = json.loads((self.root / 'journal/installation-backup-cancellations' / (record['operationId'] + '.json')).read_text())
        self.assertEqual(audit['receipt'], approval)

    def test_unverified_capture_resumes_original_but_never_invents_snapshot(self):
        operation_id = self.interrupted()
        partial = self.root / 'partial-fixture'; partial.write_bytes(b'preserved partial snapshot')
        result, docker = self.recover(operation_id)
        self.assertEqual((result['state'], result['errorCode']), ('recovering', 'capture_failed'))
        self.assertIsNone(result['snapshotPath']); self.assertIsNone(result['manifestDigest'])
        self.update.verify_snapshot.assert_not_called()
        self.assertEqual([call.args for call in docker.call_args_list],
            [('stop', '--time', '30', result['containers'][role]) for role in supervisor.ROLES] +
            [('start', result['containers'][role]) for role in ('agent', 'api', 'worker')])
        self.quiescence.ensure_no_uid_writers.assert_has_calls([mock.call(1000), mock.call(1000)])
        self.assertEqual(self.gate_state(), b'servus-lifecycle-v1 recovering\n')
        self.assertEqual(partial.read_bytes(), b'preserved partial snapshot')
        self.assertEqual(self.journal.active()['operationId'], operation_id)
        with self.assertRaises(backups.BackupError): self.journal.clear_terminal(operation_id)

    def test_verified_capture_is_reverified_before_resuming_as_starting(self):
        operation_id = self.interrupted(verified=True)
        result, _ = self.recover(operation_id)
        self.assertEqual(result['state'], 'starting')
        self.assertIsNone(result['errorCode']); self.assertEqual(self.update.verify_snapshot.call_count, 2)
        self.assertEqual(self.journal.active()['operationId'], operation_id)

    def test_interrupted_recovery_start_is_retryable_without_losing_original_identity(self):
        operation_id = self.interrupted()
        with mock.patch.object(supervisor, 'inspect_servus', return_value=self.inventory), \
                mock.patch.object(supervisor, '_docker', side_effect=[b'', b'', b'', b'', OSError('interrupted original start')]):
            with self.assertRaisesRegex(OSError, 'interrupted original start'):
                backups.recover_original_generation(self.journal, operation_id, self.ownership, '/root/journal.sqlite', '/etc/servus/active.env',
                    supervisor, self.daemon, self.quiescence, object(), self.update, -1)
        failed = self.journal.get(operation_id)
        self.assertEqual((failed['state'], failed['errorCode']), ('recovery_required', 'resume_required'))
        self.assertEqual(self.gate_state(), b'servus-lifecycle-v1 recovering\n')
        recovered, _ = self.recover(operation_id)
        self.assertEqual((recovered['state'], recovered['containers']), ('recovering', failed['containers']))
        self.assertIsNone(recovered['snapshotPath']); self.update.verify_snapshot.assert_not_called()

    def test_generation_cannot_change_and_terminal_queue_cannot_clear_a_closed_gate(self):
        operation_id = self.interrupted(verified=True)
        current = self.journal.get(operation_id)
        with self.assertRaisesRegex(backups.BackupError, 'evidence changed'):
            self.journal.transition(operation_id, 'recovery_required', 'starting', containers={**current['containers'], 'api': 'f' * 64})
        self.assertEqual(self.journal.get(operation_id), current)
        with self.assertRaisesRegex(backups.BackupError, 'evidence changed'):
            self.journal.transition(operation_id, 'recovery_required', 'starting', manifestDigest='sha256:' + 'e' * 64)
        # A terminal durable write alone never opens maintenance or releases
        # its scheduling pointer. The fresh healthy finalizer owns that step.
        self.journal.transition(operation_id, 'recovery_required', 'starting')
        self.journal.transition(operation_id, 'starting', 'completed')
        with self.assertRaises(supervisor.SupervisorError): self.journal.clear_terminal(operation_id)
        self.assertEqual(self.journal.active()['state'], 'completed')

    def test_changed_policy_generation_or_corrupt_snapshot_never_stops_or_starts(self):
        operation_id = self.interrupted(verified=True)
        binding = self.daemon.approved_policy_binding.return_value
        for variant in ('policy', 'containers', 'snapshot'):
            with self.subTest(variant=variant), mock.patch.object(supervisor, '_docker') as docker, \
                 mock.patch.object(supervisor, 'inspect_servus', return_value=self.inventory):
                if variant == 'policy': self.daemon.approved_policy_binding.return_value = ('/root/other.json', *binding[1:])
                if variant == 'containers': self.inventory['api'] = {'id': 'f' * 64}
                if variant == 'snapshot': self.update.verify_snapshot.side_effect = ValueError('corrupt snapshot')
                with self.assertRaises((backups.BackupError, ValueError)):
                    backups.recover_original_generation(self.journal, operation_id, self.ownership, '/root/journal.sqlite', '/etc/servus/active.env',
                        supervisor, self.daemon, self.quiescence, object(), self.update, -1)
                docker.assert_not_called()
                self.daemon.approved_policy_binding.return_value = binding
                self.inventory = {role: {'id': cid} for role, cid in self.journal.get(operation_id)['containers'].items()}
                self.update.verify_snapshot.side_effect = None
        self.assertEqual(self.gate_state(), b'servus-lifecycle-v1 normal\n')
        self.assertEqual(self.journal.get(operation_id)['state'], 'recovery_required')

    def test_other_maintenance_and_legacy_writer_never_get_cleared(self):
        operation_id = self.interrupted()
        other = str(uuid.uuid4())
        self.maintenance._record(other, 'intent', {role: str(uuid.uuid4()) for role in supervisor.ROLES}, 60000)
        with self.assertRaisesRegex(backups.BackupError, 'receipt changed'): self.recover(operation_id)
        self.assertEqual(json.loads((self.root / 'journal/maintenance.json').read_text())['operationId'], other)
        self.maintenance._record(operation_id, 'intent', {role: str(uuid.uuid4()) for role in supervisor.ROLES}, 60000)
        marker = self.root / 'journal/legacy-upload-recovery.json'; marker.write_text('{}'); marker.chmod(0o600)
        with self.assertRaisesRegex(backups.BackupError, 'Another maintenance'): self.recover(operation_id)
        self.assertTrue(marker.exists())

    def test_foreign_data_writer_blocks_start_and_keeps_real_fence(self):
        operation_id = self.interrupted()
        self.quiescence.ensure_no_open_data.side_effect = ValueError('foreign writer')
        with mock.patch.object(supervisor, 'inspect_servus', return_value=self.inventory), mock.patch.object(supervisor, '_docker') as docker:
            with self.assertRaisesRegex(ValueError, 'foreign writer'):
                backups.recover_original_generation(self.journal, operation_id, self.ownership, '/root/journal.sqlite', '/etc/servus/active.env',
                    supervisor, self.daemon, self.quiescence, object(), self.update, -1)
        self.assertFalse(any(call.args[0] == 'start' for call in docker.call_args_list))
        self.assertEqual(self.journal.get(operation_id)['state'], 'recovery_required')
        self.assertEqual(self.gate_state(), b'servus-lifecycle-v1 maintenance\n')

    def test_older_interrupted_record_without_generation_cannot_recover_or_cancel(self):
        record = self.journal.request(base.receipt(), base.TOKEN, now_ms=base.NOW)
        self.journal.transition(record['operationId'], 'requested', 'recovery_required', errorCode='resume_required')
        with self.assertRaisesRegex(backups.BackupError, 'original approved generation'):
            backups.recover_original_generation(self.journal, record['operationId'], None, None, None, supervisor, None, None, None, None, -1)
        with self.assertRaises(backups.BackupError): self.journal.cancel(self.approve_cancel(record), base.TOKEN, now_ms=base.NOW)
        self.assertEqual(self.journal.active()['state'], 'recovery_required')

    def test_fresh_health_finishes_failed_recovery_without_a_verified_snapshot(self):
        operation_id, hub, _, health, daemon, update = self.ready_for_finalization()
        record = self.journal.get(operation_id)
        self.journal._write(operation_id + '.json', {**record, 'state': 'recovering', 'snapshotPath': None, 'manifestDigest': None, 'errorCode': 'capture_failed'})
        self.assertTrue(self.finalize(hub, health, daemon, update))
        self.assertEqual((self.journal.get(operation_id)['state'], self.journal.get(operation_id)['errorCode']), ('failed', 'capture_failed'))
        update.verify_snapshot.assert_not_called()
        self.assertIsNone(self.journal.active()); self.assertEqual(self.gate_state(), b'servus-lifecycle-v1 normal\n')

    def test_failed_recovery_pointer_cleanup_requires_fresh_health_again(self):
        operation_id, hub, _, health, daemon, update = self.ready_for_finalization()
        record = self.journal.get(operation_id)
        self.journal._write(operation_id + '.json', {**record, 'state': 'recovering', 'snapshotPath': None, 'manifestDigest': None, 'errorCode': 'capture_failed'})
        self.journal.transition(operation_id, 'recovering', 'failed', errorCode='capture_failed')
        health[0]['State']['Health']['Status'] = 'unhealthy'
        with self.assertRaisesRegex(backups.BackupError, 'health'): self.finalize(hub, health, daemon, update)
        self.assertEqual(self.journal.active()['state'], 'failed')
        health[0]['State']['Health']['Status'] = 'healthy'
        self.assertTrue(self.finalize(hub, health, daemon, update)); self.assertIsNone(self.journal.active())


if __name__ == '__main__':
    unittest.main()
