"""Strict public-to-root adapter checks; no Docker or real installation state."""
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('installation_proxy_updater', ROOT / 'apps/updater/servus-updater.py')
updater = importlib.util.module_from_spec(spec)
spec.loader.exec_module(updater)
ID = '12345678-1234-4123-8123-123456789abc'
ACTOR = '22345678-1234-4123-8123-123456789abc'
APPROVAL = {'version': 1, 'operationId': ID, 'actorId': ACTOR, 'name': 'Przed zmianą', 'issuedAt': 1794923000000, 'proof': '4' * 64}
OPERATION = {'operationId': ID, 'actorId': ACTOR, 'name': APPROVAL['name'], 'state': 'requested',
             'createdAt': 1794923000000, 'updatedAt': 1794923000000, 'errorCode': None}


class InstallationProxyTest(unittest.TestCase):
    def setUp(self):
        self.proxy = updater.InstallationBackupProxy('/run/servus-supervisor/command')

    def assert_code(self, code, call):
        with self.assertRaises(updater.ProtocolError) as caught:
            call()
        self.assertEqual(caught.exception.code, code)

    def test_forwards_only_receipt_and_returns_redacted_correlated_operation(self):
        with mock.patch.object(updater, 'supervisor_request', return_value={'version': 1, 'status': 'queued', 'backup': OPERATION}) as request:
            self.assertEqual(self.proxy.submit(APPROVAL), OPERATION)
            request.assert_called_once_with('/run/servus-supervisor/command',
                {'version': 1, 'type': 'installation_backup_submit', 'receipt': APPROVAL}, 2)
        self.assertNotIn('proof', OPERATION)

    def test_invalid_public_approval_never_reaches_root(self):
        for change in ({'path': '/etc'}, {'actorId': 'root'}, {'issuedAt': True}, {'name': ' bad'},
                       {'name': 'bad\nname'}, {'name': '\ud800'}, {'proof': 'bad'}, {'version': True}):
            with self.subTest(change=change), mock.patch.object(updater, 'supervisor_request') as request:
                self.assert_code('invalid_request', lambda: self.proxy.submit({**APPROVAL, **change}))
                request.assert_not_called()

    def test_cancel_preserves_creator_and_accepts_a_different_administrator(self):
        approval = {**APPROVAL, 'actorId': ID}
        cancelled = {**OPERATION, 'state': 'cancelled'}
        with mock.patch.object(updater, 'supervisor_request', return_value={'version': 1, 'status': 'cancelled', 'backup': cancelled}) as request:
            self.assertEqual(self.proxy.cancel(approval), cancelled)
            request.assert_called_once_with('/run/servus-supervisor/command',
                {'version': 1, 'type': 'installation_backup_cancel', 'receipt': approval}, 2)
        for changes in ({'operationId': ACTOR}, {'name': 'Other'}, {'snapshotPath': '/private'}):
            with self.subTest(changes=changes), mock.patch.object(updater, 'supervisor_request',
                return_value={'version': 1, 'status': 'cancelled', 'backup': {**cancelled, **changes}}):
                self.assert_code('unavailable', lambda: self.proxy.cancel(approval))
        with mock.patch.object(updater, 'supervisor_request') as request:
            self.assert_code('invalid_request', lambda: self.proxy.cancel({**approval, 'path': '/etc'}))
            request.assert_not_called()

    def test_public_cancel_requires_enabled_host_and_exact_request_shape(self):
        proxy = SimpleNamespace(cancel=mock.Mock(return_value={**OPERATION, 'state': 'cancelled'}))
        request = {'version': 1, 'action': 'installation_backup_cancel', 'approval': APPROVAL}
        self.assert_code('unavailable', lambda: updater.process(None, request, installation_backups=proxy))
        self.assert_code('unavailable', lambda: updater.process(None, request, allow_apply=True))
        self.assertEqual(updater.process(None, request, allow_apply=True, installation_backups=proxy)['state'], 'cancelled')
        proxy.cancel.assert_called_once_with(APPROVAL)
        self.assert_code('invalid_request', lambda: updater.process(None, {**request, 'path': '/etc'}, allow_apply=True, installation_backups=proxy))

    def test_mismatched_or_path_leaking_root_record_is_unavailable(self):
        for changes in ({'operationId': ACTOR}, {'actorId': ID}, {'name': 'Different'}, {'snapshotPath': '/root/secret'},
                        {'createdAt': True}, {'state': 'imagined'}, {'errorCode': 'private text'}):
            with self.subTest(changes=changes), mock.patch.object(updater, 'supervisor_request',
                return_value={'version': 1, 'status': 'queued', 'backup': {**OPERATION, **changes}}):
                self.assert_code('unavailable', lambda: self.proxy.submit(APPROVAL))

    def test_active_query_fails_closed_and_distinguishes_idle_from_busy(self):
        with mock.patch.object(updater, 'supervisor_request', return_value={'version': 1, 'status': 'idle'}):
            self.assertFalse(self.proxy.active())
        with mock.patch.object(updater, 'supervisor_request', return_value={'version': 1, 'status': 'busy'}):
            self.assertTrue(self.proxy.active())
        for result in ({'version': True, 'status': 'idle'}, {'version': 1, 'status': 'unknown'}, {'version': 1, 'status': 'idle', 'path': '/root'}):
            with self.subTest(result=result), mock.patch.object(updater, 'supervisor_request', return_value=result):
                self.assert_code('unavailable', self.proxy.active)
        with mock.patch.object(updater, 'supervisor_request', side_effect=OSError('private host details')):
            self.assert_code('unavailable', self.proxy.active)

    def test_status_is_exact_and_missing_receipt_is_not_success(self):
        with mock.patch.object(updater, 'supervisor_request', return_value={'version': 1, 'status': 'requested', 'backup': OPERATION}):
            self.assertEqual(self.proxy.status(ID), OPERATION)
        with mock.patch.object(updater, 'supervisor_request', return_value={'version': 1, 'status': 'not_found'}):
            self.assert_code('not_found', lambda: self.proxy.status(ID))
        with mock.patch.object(updater, 'supervisor_request', return_value={'version': True, 'status': 'not_found'}):
            self.assert_code('unavailable', lambda: self.proxy.status(ID))
        with mock.patch.object(updater, 'supervisor_request') as request:
            self.assert_code('invalid_request', lambda: self.proxy.status('../outside'))
            request.assert_not_called()

    def test_public_actions_require_enabled_host_and_exact_shape(self):
        proxy = SimpleNamespace(submit=mock.Mock(return_value=OPERATION), status=mock.Mock(return_value=OPERATION))
        submit = {'version': 1, 'action': 'installation_backup_submit', 'approval': APPROVAL}
        status = {'version': 1, 'action': 'installation_backup_status', 'operationId': ID}
        for request in (submit, status):
            self.assert_code('unavailable', lambda: updater.process(None, request, installation_backups=proxy))
            self.assert_code('unavailable', lambda: updater.process(None, request, allow_apply=True))
            self.assertEqual(updater.process(None, request, allow_apply=True, installation_backups=proxy), OPERATION)
            self.assert_code('invalid_request', lambda: updater.process(None, {**request, 'path': '/root'}, allow_apply=True, installation_backups=proxy))
        proxy.submit.assert_called_once_with(APPROVAL)
        proxy.status.assert_called_once_with(ID)

    def test_busy_or_unavailable_backup_fences_all_update_mutations(self):
        proxy = SimpleNamespace(active=mock.Mock(return_value=True))
        journal = mock.Mock()
        for action in ('submit', 'retry', 'prepare', 'apply', 'legacy_recovery'):
            with self.subTest(action=action):
                self.assert_code('operation_in_progress', lambda: updater.process(journal, {'version': 1, 'action': action},
                    allow_apply=True, installation_backups=proxy))
        proxy.active.side_effect = updater.ProtocolError('unavailable')
        self.assert_code('unavailable', lambda: updater.process(journal, {'version': 1, 'action': 'apply'},
            allow_apply=True, installation_backups=proxy))
        journal.assert_not_called()

    def test_invalid_apply_probe_never_queries_host_admission(self):
        proxy = SimpleNamespace(active=mock.Mock(side_effect=AssertionError('Host admission must not be queried')))
        recovery = SimpleNamespace(active=mock.Mock(side_effect=AssertionError('Recovery must not be queried')))
        journal = mock.Mock()
        for operation in ('invalid', None, True, '../outside'):
            with self.subTest(operation=operation):
                self.assert_code('invalid_request', lambda: updater.process(journal,
                    {'version': 1, 'action': 'apply', 'operationId': operation},
                    allow_apply=True, installation_backups=proxy, recovery=recovery))
        proxy.active.assert_not_called();recovery.active.assert_not_called()
        journal.request_apply.assert_not_called()

    def test_valid_apply_still_requires_idle_backup_admission(self):
        proxy = SimpleNamespace(active=mock.Mock(return_value=True))
        journal = mock.Mock()
        request = {'version': 1, 'action': 'apply', 'operationId': ID}
        self.assert_code('operation_in_progress', lambda: updater.process(journal, request,
            allow_apply=True, installation_backups=proxy))
        proxy.active.assert_called_once_with();journal.request_apply.assert_not_called()
        proxy.active.side_effect = updater.ProtocolError('unavailable')
        self.assert_code('unavailable', lambda: updater.process(journal, request,
            allow_apply=True, installation_backups=proxy))
        journal.request_apply.assert_not_called()
        proxy.active.side_effect = None;proxy.active.return_value = False
        self.assertEqual(updater.process(journal, request, allow_apply=True,
            installation_backups=proxy), journal.request_apply.return_value)
        journal.request_apply.assert_called_once_with(ID)

    def test_disabled_apply_probe_remains_unavailable_without_host_queries(self):
        proxy = SimpleNamespace(active=mock.Mock(side_effect=AssertionError('Host admission must not be queried')))
        journal = mock.Mock()
        self.assert_code('unavailable', lambda: updater.process(journal,
            {'version': 1, 'action': 'apply', 'operationId': 'invalid'},
            allow_apply=False, installation_backups=proxy))
        proxy.active.assert_not_called();journal.request_apply.assert_not_called()

    def test_legacy_recovery_fences_backup_admission_before_forwarding(self):
        proxy = SimpleNamespace(submit=mock.Mock())
        recovery = SimpleNamespace(active=mock.Mock(return_value=True))
        self.assert_code('operation_in_progress', lambda: updater.process(None,
            {'version': 1, 'action': 'installation_backup_submit', 'approval': APPROVAL},
            allow_apply=True, installation_backups=proxy, recovery=recovery))
        proxy.submit.assert_not_called()


if __name__ == '__main__':
    unittest.main()
