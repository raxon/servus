import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest import mock

PATH = Path(__file__).resolve().parents[2] / 'apps/updater/verification-executor.py'
spec = importlib.util.spec_from_file_location('verification_executor', PATH)
executor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(executor)
DIGEST = 'sha256:' + 'a' * 64
COMMIT = 'b' * 40
TAG = 'v1.2.3'
EXPECTED = {'image': 'ghcr.io/raxon/servus', 'digest': DIGEST, 'commit': COMMIT, 'tag': TAG, 'verified': True}


class VerificationExecutorTest(unittest.TestCase):
    def test_request_validation_rejects_options_and_malformed_identities(self):
        for digest, commit, tag in [(DIGEST, COMMIT, '--bad'), (DIGEST.upper(), COMMIT, TAG),
                                    (DIGEST, COMMIT + 'x', TAG), (DIGEST, COMMIT, 'v01.2.3'),
                                    (DIGEST, COMMIT, 'v1.2.3\n')]:
            with self.subTest(tag=tag), self.assertRaises(executor.ExecutorError):
                executor.validate_request(digest, commit, tag)

    def test_result_must_match_every_identity_with_no_extra_or_duplicate_fields(self):
        self.assertEqual(executor.validate_result(json.dumps(EXPECTED).encode(), DIGEST, COMMIT, TAG), EXPECTED)
        for value in ({**EXPECTED, 'commit': 'c' * 40}, {**EXPECTED, 'verified': False}, {**EXPECTED, 'verified': 1},
                      {**EXPECTED, 'extra': True}):
            with self.subTest(value=value), self.assertRaises(executor.ExecutorError):
                executor.validate_result(json.dumps(value).encode(), DIGEST, COMMIT, TAG)
        with self.assertRaises(executor.ExecutorError):
            executor.validate_result(b'{"verified":false,"verified":true}', DIGEST, COMMIT, TAG)

    def test_unit_requires_dynamic_user_isolation_and_bounded_cgroup(self):
        command = executor.command_for('servus-verify-test.service', DIGEST, COMMIT, TAG)
        self.assertIn('--property=DynamicUser=yes', command)
        self.assertIn('--property=KillMode=control-group', command)
        self.assertIn('--property=RuntimeMaxSec=100', command)
        self.assertIn('--property=PrivateTmp=yes', command)
        self.assertIn('--property=ProtectSystem=strict', command)
        self.assertIn('--property=NoNewPrivileges=yes', command)
        self.assertIn('--setenv=PATH=/usr/bin:/bin', command)
        self.assertEqual(command[-8:], [executor.PYTHON, '-I', executor.VERIFIER, '--digest', DIGEST, '--commit', COMMIT, '--tag', TAG][-8:])
        self.assertNotIn('GITHUB_TOKEN', executor.ENV)

    def test_operation_identity_binds_transient_unit_and_rejects_invalid_id(self):
        operation_id='12345678-1234-4123-8123-123456789abc'
        with mock.patch.object(executor.sys, 'platform', 'linux'), \
             mock.patch.object(executor.sys, 'flags', types.SimpleNamespace(isolated=1)), \
             mock.patch.object(executor.os, 'geteuid', return_value=0), \
             mock.patch.object(executor, 'check_paths'), \
             mock.patch.object(executor, 'check_manager_environment'), \
             mock.patch.object(executor, 'trusted_path', return_value=True), \
             mock.patch.object(executor, 'command_for', return_value=[sys.executable, '-c', 'import json; print(' + repr(json.dumps(EXPECTED)) + ')']) as command, \
             mock.patch.object(executor.subprocess, 'run') as stop:
            attempt_id='12345678-1234-4123-8123-123456789abd'
            self.assertEqual(executor.verify(DIGEST, COMMIT, TAG, operation_id, attempt_id, 'a'*64), EXPECTED)
            name='servus-verify-12345678123441238123123456789abc-12345678123441238123123456789abd.service'
            self.assertEqual(command.call_args.args[0], name)
            stop.assert_not_called()
        with self.assertRaises(executor.ExecutorError):
            executor.verify(DIGEST, COMMIT, TAG, 'bad/operation')

    def test_existing_unit_conflict_never_stops_another_unit(self):
        operation_id='12345678-1234-4123-8123-123456789abc'
        with mock.patch.object(executor.sys, 'platform', 'linux'), \
             mock.patch.object(executor.sys, 'flags', types.SimpleNamespace(isolated=1)), \
             mock.patch.object(executor.os, 'geteuid', return_value=0), \
             mock.patch.object(executor, 'check_paths'), \
             mock.patch.object(executor, 'check_manager_environment'), \
             mock.patch.object(executor, 'command_for', return_value=[sys.executable, '-c', 'raise SystemExit(1)']), \
             mock.patch.object(executor.subprocess, 'run') as stop:
            with self.assertRaises(executor.ExecutorError):
                executor.verify(DIGEST, COMMIT, TAG, operation_id)
            stop.assert_not_called()

    def test_guarded_attempt_uses_dedicated_group_and_nonce(self):
        operation='12345678-1234-4123-8123-123456789abc'
        attempt='12345678-1234-4123-8123-123456789abd'
        nonce='a'*64
        cmd=executor.command_for('servus-verify-fixture.service', DIGEST, COMMIT, TAG, operation, attempt, nonce)
        self.assertIn('--property=SupplementaryGroups=servus-verifier',cmd)
        self.assertIn(executor.GUARD,cmd)
        self.assertEqual(cmd[-12:],['--operation-id',operation,'--attempt-id',attempt,'--nonce',nonce,'--digest',DIGEST,'--commit',COMMIT,'--tag',TAG])
        self.assertNotIn(executor.VERIFIER,cmd)
        with self.assertRaises(executor.ExecutorError): executor.verify(DIGEST,COMMIT,TAG,operation,attempt)

    def test_manager_environment_is_strict_and_never_emits_values(self):
        executor.validate_manager_environment(b'LANG=C.UTF-8\nPATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin\n')
        executor.validate_manager_environment(b'LANG=C.UTF-8\nPATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/snap/bin\n')
        for value in (b'LD_AUDIT=/tmp/hidden.so\n', b'LD_DEBUG_OUTPUT=/tmp/hidden\n',
                      b'LANG=C.UTF-8\nLANG=C\n', b'PATH=/tmp\n', b'LANG=C', b'LANG=invalid\n',
                      b'UNKNOWN=secret-value\n', b'X=' + b'a' * 16384):
            with self.subTest(value=value[:32]), self.assertRaises(executor.ExecutorError) as error:
                executor.validate_manager_environment(value)
            self.assertNotIn('secret-value', str(error.exception))

    def run_process(self, script, timeout=3):
        with mock.patch.object(executor.sys, 'platform', 'linux'), \
             mock.patch.object(executor.sys, 'flags', types.SimpleNamespace(isolated=1)), \
             mock.patch.object(executor.os, 'geteuid', return_value=0), \
             mock.patch.object(executor, 'check_paths'), \
             mock.patch.object(executor, 'check_manager_environment'), \
             mock.patch.object(executor, 'command_for', return_value=[sys.executable, '-c', script]), \
             mock.patch.object(executor.subprocess, 'run') as stop, \
             mock.patch.object(executor, 'PARENT_TIMEOUT', timeout):
            try:
                return executor.verify(DIGEST, COMMIT, TAG)
            finally:
                stop.assert_not_called()

    def test_real_child_returns_matching_result(self):
        self.assertEqual(self.run_process('import json; print(' + repr(json.dumps(EXPECTED)) + ')'), EXPECTED)

    def test_nonzero_child_and_oversized_output_fail_closed(self):
        for script in ('raise SystemExit(2)', "print('x' * 17000)"):
            with self.subTest(script=script), self.assertRaises(executor.ExecutorError):
                self.run_process(script)

    def test_mismatched_result_and_total_timeout_fail_closed(self):
        with self.assertRaises(executor.ExecutorError):
            self.run_process("print('{}')")
        with self.assertRaises(executor.ExecutorError):
            self.run_process('import time; time.sleep(3)', timeout=0.2)

    def test_symlinks_and_writable_ancestors_are_rejected(self):
        # /tmp has a writable ancestor, so it is unsuitable regardless of UID.
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'executable'
            path.write_text('fixture')
            path.chmod(0o755)
            self.assertFalse(executor.trusted_path(str(path), executable=True))
            self.assertFalse(executor.trusted_path('relative/path', executable=True))

    def test_non_root_or_nonisolated_refused_before_process(self):
        with mock.patch.object(executor.os, 'geteuid', return_value=1000), \
             mock.patch.object(executor, 'check_paths') as check:
            with self.assertRaises(executor.ExecutorError):
                executor.verify(DIGEST, COMMIT, TAG)
            check.assert_not_called()

    def test_untrusted_manager_environment_rejects_before_unit_start(self):
        with mock.patch.object(executor.sys, 'platform', 'linux'), \
             mock.patch.object(executor.sys, 'flags', types.SimpleNamespace(isolated=1)), \
             mock.patch.object(executor.os, 'geteuid', return_value=0), \
             mock.patch.object(executor, 'check_paths'), \
             mock.patch.object(executor, 'check_manager_environment', side_effect=executor.ExecutorError('unsafe')), \
             mock.patch.object(executor.subprocess, 'Popen') as spawn:
            with self.assertRaises(executor.ExecutorError):
                executor.verify(DIGEST, COMMIT, TAG)
            spawn.assert_not_called()


if __name__ == '__main__':
    unittest.main()
