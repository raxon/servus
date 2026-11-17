"""Root daemon admission and scheduling checks; Docker capture is a separate acceptance test."""
import hashlib
import hmac
import importlib.util
import json
import os
from pathlib import Path
import shutil
import socket
import sqlite3
import struct
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
import uuid
from unittest import mock
from contextlib import contextmanager

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'apps/updater'))
import supervisor
spec = importlib.util.spec_from_file_location('backup_daemon_under_test', ROOT / 'apps/updater/supervisor-daemon.py')
daemon = importlib.util.module_from_spec(spec)
spec.loader.exec_module(daemon)
TOKEN = '42' * 32


@unittest.skipUnless(sys.platform == 'linux' and os.geteuid() == 0, 'Requires isolated Linux root')
class InstallationBackupDaemonTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(dir='/root')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        for name, mode in (('install', 0o700), ('gate', 0o755), ('journal', 0o700), ('state', 0o700),
                           ('control', 0o750), ('backup', 0o700), ('policy', 0o700), ('docker', 0o700), ('modules', 0o755)):
            (self.root / name).mkdir(mode=mode)
        os.chown(self.root / 'control', 0, 1000)
        for name, value, mode in (('install/install.lock', b'', 0o600), ('gate/lock', b'', 0o644),
                                   ('gate/state', b'servus-lifecycle-v1 normal\n', 0o644)):
            path = self.root / name
            path.write_bytes(value)
            path.chmod(mode)
        shutil.copyfile(ROOT / 'apps/updater/installation-backups.py', self.root / 'modules/installation-backups.py')
        (self.root / 'modules/installation-backups.py').chmod(0o644)
        self.approval = self.root / 'state/journal.sqlite'
        with sqlite3.connect(self.approval) as db:
            db.executescript('CREATE TABLE operations(id TEXT,status TEXT); CREATE TABLE preparations(operation_id TEXT,status TEXT); '
                             'CREATE TABLE policy_approvals(operation_id TEXT,state TEXT,source_env_path TEXT); '
                             'CREATE TABLE update_transactions(operation_id TEXT,phase TEXT); '
                             'CREATE TABLE extraction_probes(status TEXT); CREATE TABLE apply_requests(state TEXT);')
            db.execute("INSERT INTO operations VALUES('initial','verified')")
            db.execute("INSERT INTO preparations VALUES('initial','completed')")
            db.execute("INSERT INTO policy_approvals VALUES('initial','active','/root/active.env')")
        self.approval.chmod(0o600)
        node = Path(os.path.realpath(sys.executable))
        config = {'backupRoot': str(self.root / 'backup'), 'policyRoot': str(self.root / 'policy'),
                  'dockerConfig': str(self.root / 'docker'), 'nodePath': str(node),
                  'nodeSha256': hashlib.sha256(node.read_bytes()).hexdigest(), 'trustedIngress': None}
        self.config = self.root / 'apply.json'
        self.config.write_text(json.dumps(config)); self.config.chmod(0o600)
        self.ownership = daemon.DaemonOwnership(str(self.root / 'control'), str(self.root / 'journal'), 1000)
        self.addCleanup(self.ownership.close)
        self.runner = daemon.HostApply(str(self.config), str(self.approval), '/root/active.env', self.ownership)
        self.runner.module_dir = str(self.root / 'modules')
        self.module = self.runner._backup_module()
        self.policy = SimpleNamespace(install_dir=str(self.root / 'install'), gate_dir=str(self.root / 'gate'),
                                      control_dir=str(self.root / 'control'), data_dir='/root/panel-data')
        self.policy_path, self.accepted = str(self.root / 'policy/current.json'), '/root/accepted.env'
        self.binding = (self.policy_path, 'sha256:' + 'a' * 64, 'sha256:' + 'b' * 64, self.policy)
        self.resolve = mock.patch.object(daemon, 'resolve_active_policy', return_value=(self.policy_path, self.accepted, self.policy))
        self.resolve.start(); self.addCleanup(self.resolve.stop)
        self.bind = mock.patch.object(daemon, 'approved_policy_binding', return_value=self.binding)
        self.bind.start(); self.addCleanup(self.bind.stop)

    def maintenance(self):
        return supervisor.MaintenanceSupervisor(str(self.root / 'install'), str(self.root / 'gate'), str(self.root / 'journal'))

    def receipt(self, **changes):
        value = {'version': 1, 'operationId': str(uuid.uuid4()), 'actorId': str(uuid.uuid4()),
                 'name': 'Przed zmianą - Łódź', 'issuedAt': int(time.time() * 1000), 'proof': '0' * 64, **changes}
        value['proof'] = hmac.new(bytes.fromhex(TOKEN), self.module.approval_message(value), hashlib.sha256).hexdigest()
        return value

    def submit(self, value=None):
        value = value or self.receipt()
        with self.maintenance() as operation:
            return self.runner.submit_installation_backup(value, TOKEN, operation)

    def hub(self):
        pairs = [socket.socketpair() for _ in supervisor.ROLES]
        for pair in pairs:
            for sock in pair:
                self.addCleanup(sock.close)
        return SimpleNamespace(used=False, connections={role: pair[0] for role, pair in zip(supervisor.ROLES, pairs)},
                               policy=self.policy, identities={role: {'id': str(index + 1) * 64} for index, role in enumerate(supervisor.ROLES)},
                               peers=[pair[1] for pair in pairs])

    def command(self, value, *, api_token=TOKEN, uid=0):
        server, client = socket.socketpair()
        class Peer:
            def getsockopt(_self, *_): return struct.pack('3i', os.getpid(), uid, uid)
            def __getattr__(_self, key): return getattr(server, key)
        listener = SimpleNamespace(accept=lambda: (Peer(), None))
        client.sendall(json.dumps(value).encode() + b'\n')
        try:
            with mock.patch.object(daemon, 'load_approved_policy', return_value=self.policy):
                daemon.handle_command(listener, self.hub(), str(self.root / 'install'), str(self.root / 'gate'),
                                      str(self.root / 'journal'), self.policy_path, str(self.approval), self.accepted,
                                      apply=self.runner, api_token=api_token)
            return json.loads(client.recv(16384))
        finally:
            server.close(); client.close()

    def stage(self, operation_id, phase):
        with self.maintenance() as operation, self.module.BackupJournal(operation, supervisor) as journal:
            journal.transition(operation_id, 'requested', 'capturing', policyBinding=list(self.binding[:3]),
                               containers={role: str(index + 1) * 64 for index, role in enumerate(supervisor.ROLES)})
            if phase in ('verified', 'starting', 'completed'):
                journal.transition(operation_id, 'capturing', 'verified', snapshotPath=str(self.root / 'backup' / ('installation-' + operation_id)), manifestDigest='sha256:' + 'c' * 64)
            if phase in ('starting', 'completed'): journal.transition(operation_id, 'verified', 'starting')
            if phase == 'completed': journal.transition(operation_id, 'starting', 'completed')

    def test_queue_reply_is_safe_authenticated_idempotent_and_precedes_drain(self):
        value = self.receipt()
        with mock.patch.object(self.runner, 'capture_installation_backup') as capture:
            response = self.command({'version': 1, 'type': 'installation_backup_submit', 'receipt': value})
            repeat = self.command({'version': 1, 'type': 'installation_backup_submit', 'receipt': value})
        capture.assert_not_called()
        self.assertEqual(response, repeat)
        self.assertEqual(response['status'], 'queued')
        self.assertEqual(set(response['backup']), {'operationId', 'actorId', 'name', 'state', 'createdAt', 'updatedAt', 'errorCode'})
        self.assertEqual(response['backup']['actorId'], value['actorId'])
        self.assertNotIn('proof', json.dumps(response)); self.assertNotIn('snapshotPath', json.dumps(response))
        self.assertEqual(self.command({'version': 1, 'type': 'installation_backup_active'}), {'version': 1, 'status': 'busy'})
        status = self.command({'version': 1, 'type': 'installation_backup_status', 'operationId': value['operationId']})
        self.assertEqual(status['backup'], response['backup'])

    def test_rejects_missing_wrong_or_changed_api_proof_and_nonroot_peer(self):
        for token in (None, '24' * 32):
            self.assertEqual(self.command({'version': 1, 'type': 'installation_backup_submit', 'receipt': self.receipt()}, api_token=token)['status'], 'failed')
        value = self.receipt(); value['name'] = 'Changed after approval'
        self.assertEqual(self.command({'version': 1, 'type': 'installation_backup_submit', 'receipt': value})['status'], 'failed')
        self.assertEqual(self.command({'version': 1, 'type': 'installation_backup_submit', 'receipt': self.receipt()}, uid=1000)['status'], 'failed')
        self.assertEqual(self.command({'version': 1, 'type': 'installation_backup_active'})['status'], 'idle')

    def test_cancel_command_requires_its_own_approval_and_returns_original_creator(self):
        value = self.receipt(); self.submit(value)
        approval = self.receipt(operationId=value['operationId'], name=value['name'])
        request = {'version': 1, 'type': 'installation_backup_cancel', 'receipt': approval}
        self.assertEqual(self.command(request)['status'], 'failed')
        approval['proof'] = hmac.new(bytes.fromhex(TOKEN), self.module.approval_message(approval, purpose='cancel'), hashlib.sha256).hexdigest()
        self.assertEqual(self.command(request, uid=1000)['status'], 'failed')
        self.assertEqual(self.command(request, api_token='24' * 32)['status'], 'failed')
        response = self.command(request)
        self.assertEqual((response['status'], response['backup']['actorId']), ('cancelled', value['actorId']))
        self.assertNotEqual(approval['actorId'], value['actorId'])
        self.assertEqual(set(response['backup']), {'operationId', 'actorId', 'name', 'state', 'createdAt', 'updatedAt', 'errorCode'})
        self.assertEqual(self.command(request), response)
        self.assertEqual(self.command({'version': 1, 'type': 'installation_backup_active'})['status'], 'idle')
        audit = json.loads((self.root / 'journal/installation-backup-cancellations' / (value['operationId'] + '.json')).read_text())
        self.assertEqual(audit['receipt']['actorId'], approval['actorId'])

    def test_public_root_command_cannot_invoke_recovery_or_cancel_started_work(self):
        value = self.submit(); self.stage(value['operationId'], 'capturing')
        approval = self.receipt(operationId=value['operationId'], name=value['name'])
        approval['proof'] = hmac.new(bytes.fromhex(TOKEN), self.module.approval_message(approval, purpose='cancel'), hashlib.sha256).hexdigest()
        self.assertEqual(self.command({'version': 1, 'type': 'installation_backup_cancel', 'receipt': approval})['status'], 'failed')
        with mock.patch.object(self.runner, 'recover_installation_backup') as recovery:
            self.assertEqual(self.command({'version': 1, 'type': 'installation_backup_recover', 'operationId': value['operationId']})['status'], 'failed')
        recovery.assert_not_called()
        with self.maintenance() as operation: self.assertEqual(self.runner.installation_backup_active(operation)['state'], 'capturing')

    def test_explicit_recovery_singleton_accepts_only_its_matching_protected_marker(self):
        value = self.submit(); other = str(uuid.uuid4()); self.ownership.close()
        with self.maintenance() as operation:
            operation._record(value['operationId'], 'recovery_required', {role: str(uuid.uuid4()) for role in supervisor.ROLES}, 60000)
        for recovery_id in (None, other, '../invalid'):
            with self.subTest(recovery_id=recovery_id), self.assertRaises(supervisor.SupervisorError):
                daemon.DaemonOwnership(str(self.root / 'control'), str(self.root / 'journal'), 1000, recovery_operation_id=recovery_id)
        ownership = daemon.DaemonOwnership(str(self.root / 'control'), str(self.root / 'journal'), 1000, recovery_operation_id=value['operationId'])
        try:
            ownership.assert_held(str(self.root / 'control'))
            self.assertEqual(json.loads((self.root / 'journal/maintenance.json').read_text())['operationId'], value['operationId'])
            with self.assertRaises(OSError): daemon.DaemonOwnership(str(self.root / 'control'), str(self.root / 'journal'), 1000, recovery_operation_id=value['operationId'])
        finally: ownership.close()

    def test_exact_command_fields_and_not_found_are_distinct_from_invalid_input(self):
        self.assertEqual(self.command({'version': 1, 'type': 'installation_backup_status', 'operationId': str(uuid.uuid4())})['status'], 'not_found')
        for request in ({'version': 1, 'type': 'installation_backup_active', 'path': '/etc'},
                        {'version': 1, 'type': 'installation_backup_status', 'operationId': '../escape'},
                        {'version': True, 'type': 'installation_backup_active'},
                        {'version': 1, 'type': 'installation_backup_submit', 'receipt': {**self.receipt(), 'path': '/etc'}}):
            self.assertEqual(self.command(request)['status'], 'failed')

    def test_pending_or_uncertain_root_writers_fence_queue_without_touching_the_gate(self):
        cases = [('operations', 'status', state) for state in ('accepted', 'verifying', 'recovery_required', None)]
        cases += [('preparations', 'status', state) for state in ('preparing', 'recovery_required', None)]
        cases += [('policy_approvals', 'state', state) for state in ('activating', 'recovery_required', None)]
        cases += [('extraction_probes', 'status', 'intent'), ('update_transactions', 'phase', 'starting'), ('apply_requests', 'state', 'requested')]
        for table, column, state in cases:
            with self.subTest(table=table, state=state):
                with sqlite3.connect(self.approval) as db: db.execute(f'INSERT INTO {table}({column}) VALUES(?)', (state,))
                try:
                    with self.assertRaises(supervisor.SupervisorError): self.submit()
                finally:
                    with sqlite3.connect(self.approval) as db: db.execute(f'DELETE FROM {table} WHERE {column} IS ?', (state,))
                self.assertEqual((self.root / 'gate/state').read_bytes(), b'servus-lifecycle-v1 normal\n')

    def test_incomplete_initial_preparation_and_legacy_requests_are_not_ignored(self):
        with sqlite3.connect(self.approval) as db: db.execute("UPDATE preparations SET status='prepared'")
        with self.assertRaises(supervisor.SupervisorError): self.submit()
        with sqlite3.connect(self.approval) as db: db.execute("UPDATE preparations SET status='completed'")
        path = self.approval.parent / 'legacy-recovery-requests.sqlite'
        with sqlite3.connect(path) as db:
            db.execute('PRAGMA user_version=1'); db.execute('CREATE TABLE requests(state TEXT)'); db.execute("INSERT INTO requests VALUES('requested')")
        path.chmod(0o600)
        with self.assertRaises(supervisor.SupervisorError): self.submit()

    def test_pending_backup_fences_apply_complete_stop_and_legacy_recovery(self):
        self.submit()
        for kind in ('apply', 'complete', 'stop', 'recover_legacy_upload'):
            request = {'version': 1, 'type': kind, 'operationId': str(uuid.uuid4())}
            if kind == 'stop': request['timeoutMs'] = 100
            if kind == 'recover_legacy_upload': request.update(restoreId='a' * 32, serviceId=str(uuid.uuid4()))
            self.assertEqual(self.command(request)['status'], 'failed')
        with sqlite3.connect(self.approval) as db: self.assertEqual(db.execute('SELECT * FROM update_transactions').fetchall(), [])

    def test_startup_journal_recovery_requires_local_reconciliation(self):
        value = self.submit(); self.stage(value['operationId'], 'capturing')
        self.ownership.close()
        args = SimpleNamespace(uid=1000, gid=1000, policy=self.policy_path, install_dir=str(self.root / 'install'), gate_dir=str(self.root / 'gate'), journal_dir=str(self.root / 'journal'), secret_dir='/unused', socket_dir=str(self.root / 'control'), approval_journal=str(self.approval), accepted_env=self.accepted, active_env='/root/active.env', apply_config=str(self.config))
        with mock.patch.object(daemon, 'HostApply', return_value=self.runner), mock.patch.object(daemon.signal, 'signal'), mock.patch.object(supervisor.ComponentEndpoint, 'read_component_tokens') as tokens:
            with self.assertRaisesRegex(supervisor.SupervisorError, 'local reconciliation'): daemon.run(args)
        tokens.assert_not_called()
        self.assertTrue((self.root / 'journal/installation-backups/active.json').exists())

    def test_missing_host_configuration_cannot_ignore_previous_backup_history(self):
        self.submit(); self.ownership.close()
        args = SimpleNamespace(uid=1000, gid=1000, policy=self.policy_path, install_dir=str(self.root / 'install'), gate_dir=str(self.root / 'gate'), journal_dir=str(self.root / 'journal'), secret_dir='/unused', socket_dir=str(self.root / 'control'), approval_journal=str(self.approval), accepted_env=self.accepted)
        with mock.patch.object(daemon.signal, 'signal'), mock.patch.object(daemon, 'load_approved_policy', return_value=self.policy):
            with self.assertRaisesRegex(supervisor.SupervisorError, 'protected host configuration'): daemon.run(args)

    def test_only_fresh_complete_role_channels_can_capture(self):
        self.submit(); hub = self.hub()
        with self.maintenance() as operation, mock.patch.object(self.runner, '_node') as node:
            self.assertFalse(self.runner.capture_installation_backup(None, operation))
            hub.used = True; self.assertFalse(self.runner.capture_installation_backup(hub, operation)); hub.used = False
            hub.peers[0].sendall(b'pending message')
            self.assertFalse(self.runner.capture_installation_backup(hub, operation))
        node.assert_not_called()

    def test_active_backup_suppresses_update_finalization_in_every_state(self):
        self.submit(); hub = self.hub()
        with mock.patch.object(self.runner, 'capture_installation_backup', return_value=False) as capture:
            self.assertTrue(daemon.advance_installation_backup(self.runner, hub, str(self.root / 'install'), str(self.root / 'gate'), str(self.root / 'journal'), self.policy_path, self.accepted))
        capture.assert_called_once()
        with mock.patch.object(daemon, 'complete_healthy_preparation') as finalize:
            with self.assertRaises(supervisor.SupervisorError):
                daemon.finalize_started_update(hub, str(self.root / 'install'), str(self.root / 'gate'), str(self.root / 'journal'), self.policy_path, str(self.approval), self.accepted, backup_guard=self.runner.assert_no_installation_backup)
        finalize.assert_not_called()

    def test_finalization_dispatches_only_after_fresh_channels_and_closes_node(self):
        value = self.submit(); self.stage(value['operationId'], 'starting'); hub = self.hub()
        final = mock.Mock(return_value=True)
        module = self.runner._backup_module()
        module.finalize_captured_snapshot = final
        with mock.patch.object(self.runner, '_backup_module', return_value=module), mock.patch.object(self.runner, '_load', return_value=object()):
            with self.maintenance() as operation:
                hub.used = True; self.assertFalse(self.runner.finalize_installation_backup(hub, operation, self.policy_path, self.accepted)); final.assert_not_called()
                hub.used = False; self.assertTrue(self.runner.finalize_installation_backup(hub, operation, self.policy_path, self.accepted))
        with self.assertRaises(OSError): os.fstat(final.call_args.args[-1])
        self.assertEqual(final.call_args.args[1:5], (hub, self.policy_path, str(self.approval), self.accepted))

    def test_capture_preflight_precedes_drain_and_start_uses_the_same_verified_lease(self):
        value = self.submit(); hub = self.hub(); events = []; lease = object(); seen_node = []
        module = self.runner._backup_module()
        def capture(journal, operation_id, passed_lease, backup_root, node_fd, *_args, **_kwargs):
            events.append('capture'); self.assertEqual(operation_id, value['operationId']); self.assertIs(passed_lease, lease)
            self.assertEqual(backup_root, str(self.root / 'backup')); os.fstat(node_fd); seen_node.append(node_fd)
        def start(journal, operation_id, passed_lease, ownership, *_args):
            events.append('start'); self.assertIs(passed_lease, lease); self.assertIs(ownership, self.ownership)
        @contextmanager
        def window(passed_hub, operation_id, *, policy_binding):
            events.append('drain'); self.assertIs(passed_hub, hub); self.assertEqual(policy_binding, self.binding)
            with module.BackupJournal(operation, supervisor) as proof:
                reserved = proof.get(operation_id)
                self.assertEqual(reserved['policyBinding'], list(policy_binding[:3]))
                self.assertEqual(reserved['containers'], {role: hub.identities[role]['id'] for role in supervisor.ROLES})
            self.assertEqual(operation_id, value['operationId']); hub.used = True; yield lease
        coordinator = SimpleNamespace(preflight_external_containers=mock.Mock(side_effect=lambda *_args, **_kwargs: events.append('preflight')))
        modules = {'backup.py': object(), 'quiescence.py': object(), 'update-coordinator.py': coordinator,
                   'provision-host.py': SimpleNamespace(trusted_ingress=lambda *_args, **_kwargs: None), 'runtime-policy.py': object()}
        with self.maintenance() as operation, mock.patch.object(operation, 'drained_window', side_effect=window), \
                mock.patch.object(self.runner, '_backup_module', return_value=module), \
                mock.patch.object(self.runner, '_load', side_effect=lambda _name, filename, _mode: modules[filename]), \
                mock.patch.object(module, 'capture_stopped_snapshot', side_effect=capture), \
                mock.patch.object(module, 'start_captured_snapshot', side_effect=start):
            self.assertTrue(self.runner.capture_installation_backup(hub, operation))
        self.assertEqual(events, ['preflight', 'drain', 'capture', 'start'])
        with self.assertRaises(OSError): os.fstat(seen_node[0])

    def test_definitive_preflight_failure_releases_only_its_queue_and_allows_new_work(self):
        value = self.submit(); hub = self.hub(); module = self.runner._backup_module()
        coordinator = SimpleNamespace(preflight_external_containers=mock.Mock(side_effect=supervisor.SupervisorError('Unverified external writer.')))
        modules = {'backup.py': object(), 'quiescence.py': object(), 'update-coordinator.py': coordinator,
                   'provision-host.py': SimpleNamespace(trusted_ingress=lambda *_args, **_kwargs: None), 'runtime-policy.py': object()}
        with self.maintenance() as operation, mock.patch.object(operation, 'drained_window') as drain, \
                mock.patch.object(self.runner, '_backup_module', return_value=module), \
                mock.patch.object(self.runner, '_load', side_effect=lambda _name, filename, _mode: modules[filename]), \
                mock.patch.object(supervisor, '_docker') as docker:
            with self.assertRaisesRegex(supervisor.SupervisorError, 'external writer'):
                self.runner.capture_installation_backup(hub, operation)
            self.assertIsNone(self.runner.installation_backup_active(operation))
            failed = self.runner.installation_backup_status(value['operationId'], operation)
            self.assertEqual((failed['state'], failed['errorCode']), ('failed', 'capture_failed'))
            self.runner.assert_no_installation_backup(operation)
            fresh = self.runner.submit_installation_backup(self.receipt(), TOKEN, operation)
            self.assertEqual(fresh['state'], 'requested'); self.assertNotEqual(fresh['operationId'], value['operationId'])
        drain.assert_not_called(); docker.assert_not_called(); self.assertFalse(hub.used)
        self.assertEqual((self.root / 'gate/state').read_bytes(), b'servus-lifecycle-v1 normal\n')
        self.assertFalse((self.root / 'journal/maintenance.json').exists())

    def test_declared_quiescence_error_is_safe_before_and_after_capture_intent(self):
        spec = importlib.util.spec_from_file_location('real_backup_quiescence_error', ROOT / 'apps/updater/quiescence.py')
        quiescence = importlib.util.module_from_spec(spec); spec.loader.exec_module(quiescence)
        module = self.runner._backup_module()
        for after_intent in (False, True):
            value = self.submit(); hub = self.hub()
            coordinator = SimpleNamespace(preflight_external_containers=mock.Mock(
                side_effect=None if after_intent else quiescence.QuiescenceError('Private fixture diagnostics')))
            modules = {'backup.py': object(), 'quiescence.py': quiescence, 'update-coordinator.py': coordinator,
                       'provision-host.py': SimpleNamespace(trusted_ingress=lambda *_args, **_kwargs: None), 'runtime-policy.py': object()}
            with self.maintenance() as operation:
                @contextmanager
                def window(*_args, **_kwargs):
                    operation._record(value['operationId'], 'intent', {role: str(uuid.uuid4()) for role in supervisor.ROLES}, 60000)
                    supervisor._atomic_file(operation.gate, 'state', b'servus-lifecycle-v1 maintenance\n', 0o644)
                    hub.used = True
                    yield object()
                def capture(journal, operation_id, *_args, **_kwargs):
                    journal.transition(operation_id, 'requested', 'capturing')
                    journal.transition(operation_id, 'capturing', 'recovery_required', errorCode='capture_failed')
                    raise quiescence.QuiescenceError('Private fixture diagnostics')
                with mock.patch.object(operation, 'drained_window', side_effect=window), \
                        mock.patch.object(self.runner, '_backup_module', return_value=module), \
                        mock.patch.object(self.runner, '_load', side_effect=lambda _name, filename, _mode: modules[filename]), \
                        mock.patch.object(module, 'capture_stopped_snapshot', side_effect=capture):
                    with self.assertRaises(supervisor.SupervisorError) as caught:
                        self.runner.capture_installation_backup(hub, operation)
                    self.assertNotIn('Private fixture', str(caught.exception))
                    self.assertIsInstance(caught.exception.__cause__, quiescence.QuiescenceError)
                    pending = self.runner.installation_backup_active(operation)
                    if after_intent:
                        self.assertEqual((pending['state'], pending['errorCode']), ('recovery_required', 'capture_failed'))
                        self.assertEqual((self.root / 'gate/state').read_bytes(), b'servus-lifecycle-v1 maintenance\n')
                        self.assertTrue((self.root / 'journal/maintenance.json').exists())
                    else:
                        self.assertIsNone(pending)
                        self.assertEqual(self.runner.installation_backup_status(value['operationId'], operation)['state'], 'failed')
                        self.assertEqual((self.root / 'gate/state').read_bytes(), b'servus-lifecycle-v1 normal\n')

    def test_operational_translation_does_not_swallow_process_exit(self):
        self.submit(); hub = self.hub(); module = self.runner._backup_module()
        modules = {'backup.py': object(), 'quiescence.py': object(),
                   'update-coordinator.py': SimpleNamespace(preflight_external_containers=mock.Mock(side_effect=SystemExit(7))),
                   'provision-host.py': SimpleNamespace(trusted_ingress=lambda *_args, **_kwargs: None), 'runtime-policy.py': object()}
        with self.maintenance() as operation, mock.patch.object(self.runner, '_backup_module', return_value=module), \
                mock.patch.object(self.runner, '_load', side_effect=lambda _name, filename, _mode: modules[filename]):
            with self.assertRaises(SystemExit) as caught: self.runner.capture_installation_backup(hub, operation)
            self.assertEqual(caught.exception.code, 7)

    def test_failure_entering_drain_keeps_its_intent_and_requires_explicit_recovery(self):
        value = self.submit(); hub = self.hub(); module = self.runner._backup_module()
        coordinator = SimpleNamespace(preflight_external_containers=mock.Mock())
        modules = {'backup.py': object(), 'quiescence.py': object(), 'update-coordinator.py': coordinator,
                   'provision-host.py': SimpleNamespace(trusted_ingress=lambda *_args, **_kwargs: None), 'runtime-policy.py': object()}
        with self.maintenance() as operation:
            @contextmanager
            def window(*_args, **_kwargs):
                operation._record(value['operationId'], 'intent', {role: str(uuid.uuid4()) for role in supervisor.ROLES}, 60000)
                supervisor._atomic_file(operation.gate, 'state', b'servus-lifecycle-v1 maintenance\n', 0o644)
                hub.used = True
                raise supervisor.SupervisorError('Drain failed after durable intent.')
                yield  # Establish a context manager that fails before yielding a lease.
            with mock.patch.object(operation, 'drained_window', side_effect=window), \
                    mock.patch.object(self.runner, '_backup_module', return_value=module), \
                    mock.patch.object(self.runner, '_load', side_effect=lambda _name, filename, _mode: modules[filename]), \
                    mock.patch.object(module, 'capture_stopped_snapshot') as capture:
                with self.assertRaisesRegex(supervisor.SupervisorError, 'durable intent'):
                    self.runner.capture_installation_backup(hub, operation)
                pending = self.runner.installation_backup_active(operation)
                self.assertEqual((pending['operationId'], pending['state'], pending['errorCode']), (value['operationId'], 'recovery_required', 'resume_required'))
                with self.assertRaises(supervisor.SupervisorError): self.runner.assert_no_installation_backup(operation)
                with self.assertRaises(supervisor.SupervisorError): self.runner.submit_installation_backup(self.receipt(), TOKEN, operation)
            capture.assert_not_called()
        self.assertEqual((self.root / 'gate/state').read_bytes(), b'servus-lifecycle-v1 maintenance\n')
        marker = json.loads((self.root / 'journal/maintenance.json').read_text())
        self.assertEqual((marker['operationId'], marker['state']), (value['operationId'], 'intent'))

    def test_preflight_failure_never_clears_an_unrelated_maintenance_marker(self):
        value = self.submit(); hub = self.hub(); module = self.runner._backup_module(); other = str(uuid.uuid4())
        with self.maintenance() as operation:
            def preflight(*_args, **_kwargs):
                operation._record(other, 'intent', {role: str(uuid.uuid4()) for role in supervisor.ROLES}, 60000)
                raise supervisor.SupervisorError('Another maintenance receipt appeared.')
            coordinator = SimpleNamespace(preflight_external_containers=mock.Mock(side_effect=preflight))
            modules = {'backup.py': object(), 'quiescence.py': object(), 'update-coordinator.py': coordinator,
                       'provision-host.py': SimpleNamespace(trusted_ingress=lambda *_args, **_kwargs: None), 'runtime-policy.py': object()}
            with mock.patch.object(operation, 'drained_window') as drain, \
                    mock.patch.object(self.runner, '_backup_module', return_value=module), \
                    mock.patch.object(self.runner, '_load', side_effect=lambda _name, filename, _mode: modules[filename]):
                with self.assertRaisesRegex(supervisor.SupervisorError, 'Another maintenance'):
                    self.runner.capture_installation_backup(hub, operation)
                pending = self.runner.installation_backup_active(operation)
                self.assertEqual((pending['operationId'], pending['state']), (value['operationId'], 'requested'))
            drain.assert_not_called()
        self.assertEqual(json.loads((self.root / 'journal/maintenance.json').read_text())['operationId'], other)
        self.assertEqual((self.root / 'gate/state').read_bytes(), b'servus-lifecycle-v1 normal\n')

    def test_real_daemon_loop_resets_used_hub_and_finalizes_backup_before_any_update(self):
        value = self.submit(); self.ownership.close(); events = []; hubs = []; iteration = [0]
        args = SimpleNamespace(uid=1000, gid=1000, policy=self.policy_path, install_dir=str(self.root / 'install'), gate_dir=str(self.root / 'gate'), journal_dir=str(self.root / 'journal'), secret_dir='/unused', socket_dir=str(self.root / 'control'), approval_journal=str(self.approval), accepted_env=self.accepted, active_env='/root/active.env', apply_config=str(self.config))
        def host(_config, _approval, _env, ownership):
            self.runner.ownership = ownership; return self.runner
        def new_hub(*_args):
            hub = self.hub(); hub.close = mock.Mock(); hubs.append(hub); return hub
        def select(inputs, *_args):
            iteration[0] += 1
            if iteration[0] == 1: return [inputs[0]], [], []
            if iteration[0] == 2: return [], [], []
            raise StopIteration()
        def acknowledged(*_args, **kwargs):
            self.assertEqual(kwargs['api_token'], TOKEN); events.append('acknowledged')
        def capture(hub, operation):
            events.append('capture'); self.assertIs(hub, hubs[0]); hub.used = True
            with self.module.BackupJournal(operation, supervisor) as journal:
                journal.transition(value['operationId'], 'requested', 'capturing', policyBinding=list(self.binding[:3]), containers={role: str(index + 1) * 64 for index, role in enumerate(supervisor.ROLES)})
                journal.transition(value['operationId'], 'capturing', 'verified', snapshotPath=str(self.root / 'backup' / ('installation-' + value['operationId'])), manifestDigest='sha256:' + 'c' * 64)
                journal.transition(value['operationId'], 'verified', 'starting')
            return True
        def finalize(hub, operation, *_args):
            events.append('finalize'); self.assertIs(hub, hubs[1]); self.assertFalse(hub.used)
            with self.module.BackupJournal(operation, supervisor) as journal:
                journal.transition(value['operationId'], 'starting', 'completed'); journal.clear_terminal(value['operationId'])
            return True
        with mock.patch.object(daemon, 'HostApply', side_effect=host), mock.patch.object(daemon.signal, 'signal'), \
                mock.patch.object(supervisor.ComponentEndpoint, 'read_component_tokens', return_value={'api': TOKEN}), \
                mock.patch.object(supervisor, 'DrainHub', side_effect=new_hub), mock.patch.object(daemon.select, 'select', side_effect=select), \
                mock.patch.object(daemon, 'handle_command', side_effect=acknowledged), \
                mock.patch.object(self.runner, 'capture_installation_backup', side_effect=capture), \
                mock.patch.object(self.runner, 'finalize_installation_backup', side_effect=finalize), \
                mock.patch.object(daemon, 'finalize_started_update') as update:
            with self.assertRaises(StopIteration): daemon.run(args)
        self.assertEqual(events, ['acknowledged', 'capture', 'finalize']); self.assertEqual(len(hubs), 2)
        hubs[0].close.assert_called_once(); update.assert_not_called()


if __name__ == '__main__':
    unittest.main()
