import hashlib
import io
import os
import time
import tempfile
import stat
import urllib.error
from email.message import Message
import importlib.util
import json
import pathlib
import signal
import socket
import subprocess
import sys
import threading
import unittest
from unittest.mock import patch

PATH = pathlib.Path(__file__).resolve().parents[2] / 'apps/updater/verify-release.py'
spec = importlib.util.spec_from_file_location('verify_release', PATH)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

COMMIT = 'a' * 40
TAG = 'v1.2.3'

def packed(value):
    return json.dumps(value, separators=(',', ':')).encode()

def digest(data):
    return 'sha256:' + hashlib.sha256(data).hexdigest()

def signed_result(image_digest):
    ref = 'refs/tags/' + TAG
    workflow = 'https://github.com/' + module.WORKFLOW + '@' + ref
    return [{'verificationResult': {
        'signature': {'certificate': {
            'issuer': 'https://token.actions.githubusercontent.com',
            'subjectAlternativeName': workflow,
            'buildSignerURI': workflow,
            'sourceRepositoryURI': 'https://github.com/raxon/servus',
            'sourceRepositoryIdentifier': '1457036654',
            'sourceRepositoryOwnerURI': 'https://github.com/raxon',
            'sourceRepositoryOwnerIdentifier': '1338844',
            'sourceRepositoryDigest': COMMIT,
            'sourceRepositoryRef': ref,
            'runnerEnvironment': 'github-hosted',
        }},
        'statement': {'predicateType': module.PREDICATE, 'subject': [{'name': module.IMAGE, 'digest': {'sha256': image_digest[7:]}}]},
    }}]

class FakeRegistry:
    def __init__(self):
        self.image = packed({'schemaVersion': 2, 'mediaType': module.DOCKER_MANIFEST})
        self.image_digest = digest(self.image)
        self.bundle = b'{"test":"synthetic"}'
        self.bundle_digest = digest(self.bundle)
        self.artifact = packed({'schemaVersion': 2, 'mediaType': module.OCI_MANIFEST, 'artifactType': module.BUNDLE_MEDIA,
                                'subject': {'digest': self.image_digest, 'size': len(self.image), 'mediaType': module.DOCKER_MANIFEST},
                                'layers': [{'mediaType': module.BUNDLE_MEDIA, 'digest': self.bundle_digest, 'size': len(self.bundle)}]})
        self.artifact_digest = digest(self.artifact)
        self.index = packed({'schemaVersion': 2, 'mediaType': module.OCI_INDEX,
                             'manifests': [{'mediaType': module.OCI_MANIFEST, 'artifactType': module.BUNDLE_MEDIA,
                                            'digest': self.artifact_digest, 'size': len(self.artifact)}]})
        self.authenticated = False
    def authenticate(self): self.authenticated = True
    def manifest(self, reference, limit=0):
        if reference == self.image_digest: return self.image
        if reference == 'sha256-' + self.image_digest[7:]: return self.index
        if reference == self.artifact_digest: return self.artifact
        raise AssertionError('Unexpected registry reference')
    def blob(self, reference):
        if reference != self.bundle_digest: raise AssertionError('Unexpected blob reference')
        return self.bundle

class VerificationTests(unittest.TestCase):
    def setUp(self): self.registry = FakeRegistry()
    def run_verify(self, result=None):
        expected = signed_result(self.registry.image_digest) if result is None else result
        def verify(manifest, bundle, commit, tag, tempdir, deadline):
            self.assertEqual(pathlib.Path(manifest).read_bytes(), self.registry.image)
            self.assertEqual(pathlib.Path(bundle).read_bytes(), self.registry.bundle)
            self.assertEqual((commit, tag), (COMMIT, TAG))
            return expected
        return module._verify_release(self.registry.image_digest, COMMIT, TAG, self.registry, verify)
    def test_valid_public_identity(self):
        result = self.run_verify()
        self.assertTrue(self.registry.authenticated)
        self.assertEqual(result, {'image': module.IMAGE, 'digest': self.registry.image_digest, 'commit': COMMIT, 'tag': TAG, 'verified': True})
    def test_invalid_inputs_fail_before_registry_authentication(self):
        for digest_value, commit, tag in [('sha256:' + 'A'*64, COMMIT, TAG), (self.registry.image_digest, 'f'*39, TAG), (self.registry.image_digest, COMMIT, 'v1.2.3;echo'), (self.registry.image_digest, COMMIT, 'v01.2.3')]:
            with self.subTest(tag=tag), self.assertRaises(module.VerificationError):
                module._verify_release(digest_value, commit, tag, self.registry)
            self.assertFalse(self.registry.authenticated)
    def test_rejects_mismatched_cert_identity_and_subject(self):
        for key, value in [('sourceRepositoryIdentifier','1'), ('sourceRepositoryOwnerIdentifier','1'), ('sourceRepositoryDigest','f'*40), ('sourceRepositoryRef','refs/tags/v0.0.0'), ('runnerEnvironment','self-hosted'), ('subjectAlternativeName','https://github.com/evil'), ('buildSignerURI','https://github.com/evil')]:
            result = signed_result(self.registry.image_digest)
            result[0]['verificationResult']['signature']['certificate'][key] = value
            with self.subTest(key=key), self.assertRaises(module.VerificationError): self.run_verify(result)
        result = signed_result(self.registry.image_digest)
        result[0]['verificationResult']['statement']['subject'][0]['name'] = 'ghcr.io/attacker/servus'
        with self.assertRaises(module.VerificationError): self.run_verify(result)
        result = signed_result(self.registry.image_digest)
        result[0]['verificationResult']['statement']['subject'][0]['digest']['sha256'] = 'f'*64
        with self.assertRaises(module.VerificationError): self.run_verify(result)
    def test_corrupted_image_artifact_or_bundle_fails(self):
        for part in ['image','artifact','bundle']:
            self.registry = FakeRegistry()
            setattr(self.registry, part, getattr(self.registry, part) + b'x')
            with self.subTest(part=part), self.assertRaises(module.VerificationError): self.run_verify()
    def test_rejects_invalid_or_excessive_attestation_descriptors(self):
        variants = [
            {'schemaVersion': 2, 'mediaType': module.OCI_INDEX, 'manifests': []},
            {'schemaVersion': 2, 'mediaType': module.OCI_INDEX, 'manifests': [{}] * 17},
            {'schemaVersion': 2, 'mediaType': module.OCI_INDEX, 'manifests': [{'mediaType': module.OCI_MANIFEST, 'artifactType': module.BUNDLE_MEDIA, 'digest': 'https://evil', 'size': 1}]},
        ]
        for value in variants:
            self.registry = FakeRegistry();self.registry.index = packed(value)
            with self.subTest(index=value), self.assertRaises(module.VerificationError): self.run_verify()
    def test_rejects_valid_digest_with_wrong_attestation_subject(self):
        value = json.loads(self.registry.artifact)
        value['subject']['digest'] = 'sha256:'+'f'*64
        self.registry.artifact = packed(value)
        self.registry.artifact_digest = digest(self.registry.artifact)
        self.registry.index = packed({'schemaVersion': 2, 'mediaType': module.OCI_INDEX, 'manifests': [{'mediaType': module.OCI_MANIFEST, 'artifactType': module.BUNDLE_MEDIA, 'digest': self.registry.artifact_digest, 'size': len(self.registry.artifact)}]})
        with self.assertRaises(module.VerificationError): self.run_verify()
    def test_blob_redirect_allowlist(self):
        self.assertTrue(module.allowed_blob_redirect('https://pkg-containers.githubusercontent.com/path?sig=synthetic'))
        for url in ['http://pkg-containers.githubusercontent.com/path', 'https://pkg-containers.githubusercontent.com.evil.test/path', 'https://user@pkg-containers.githubusercontent.com/path', 'https://pkg-containers.githubusercontent.com:8443/path', 'https://pkg-containers.githubusercontent.com/path#fragment', '//pkg-containers.githubusercontent.com/path']:
            with self.subTest(url=url): self.assertFalse(module.allowed_blob_redirect(url))
    def test_gh_arguments_and_environment_are_restricted(self):
        with patch.object(module, 'find_gh', return_value='/usr/bin/gh'), patch.object(module.subprocess, 'Popen', side_effect=OSError('synthetic')) as process:
            with patch.dict(os.environ, {'GH_TOKEN': 'must-not-pass', 'HTTPS_PROXY': 'must-not-pass', 'TMPDIR': '/tmp/untrusted-path'}):
                with self.assertRaises(module.VerificationError):
                    module.run_gh('/tmp/manifest', '/tmp/bundle.json', COMMIT, TAG, '/tmp/private', time.monotonic()+10)
        command = process.call_args.args[0]
        options = process.call_args.kwargs
        self.assertEqual(command[:3], ['/usr/bin/gh', 'attestation', 'verify'])
        self.assertIn('--deny-self-hosted-runners', command)
        self.assertEqual(command[command.index('--source-digest')+1], COMMIT)
        self.assertEqual(command[command.index('--source-ref')+1], 'refs/tags/'+TAG)
        self.assertNotIn('shell', options)
        self.assertNotIn('GH_TOKEN', options['env'])
        self.assertNotIn('HTTPS_PROXY', options['env'])
        self.assertNotIn('TMPDIR', options['env'])
        self.assertEqual(options['cwd'], '/tmp/private')
        self.assertEqual(set(options['env']), {'PATH', 'HOME', 'GH_CONFIG_DIR', 'GH_PROMPT_DISABLED', 'GH_NO_UPDATE_NOTIFIER'})

    def test_tls_ignores_caller_certificates_and_keylog(self):
        with tempfile.TemporaryDirectory(prefix='verifier-tls-') as tempdir:
            log = pathlib.Path(tempdir, 'keylog')
            with patch.dict(os.environ, {'SSL_CERT_FILE': '/nonexistent/untrusted-cert',
                                         'SSL_CERT_DIR': '/nonexistent/untrusted-certs',
                                         'SSLKEYLOGFILE': str(log)}):
                context = module.registry_tls_context()
                if hasattr(context, 'keylog_filename'):
                    self.assertIsNone(context.keylog_filename)
                self.assertGreater(context.cert_store_stats()['x509_ca'], 0)
                self.assertFalse(log.exists())

    @unittest.skipUnless(os.geteuid() == 0 and sys.platform.startswith('linux'), 'requires isolated Linux root')
    def test_trusted_root_files_reject_symlinks_writable_dirs_and_hardlinks(self):
        with tempfile.TemporaryDirectory(prefix='servus-trust-', dir='/root') as root:
            binary = pathlib.Path(root, 'gh'); binary.write_bytes(b'fixture'); binary.chmod(0o700)
            self.assertTrue(module.root_owned_file(str(binary), executable=True))
            with patch.object(module, 'GH_CANDIDATES', (str(binary),)):
                self.assertEqual(module.find_gh(), str(binary))
            alias = pathlib.Path(root, 'alias'); alias.symlink_to(binary)
            self.assertFalse(module.root_owned_file(str(alias), executable=True))
            self.assertTrue(module.root_owned_file(str(alias), allow_symlink=True))
            with patch.object(module, 'GH_CANDIDATES', (str(alias),)):
                with self.assertRaises(module.VerificationError): module.find_gh()
            hardlink = pathlib.Path(root, 'hardlink'); os.link(binary, hardlink)
            self.assertFalse(module.root_owned_file(str(binary), executable=True))
            hardlink.unlink()
            binary.chmod(0o720)
            self.assertFalse(module.root_owned_file(str(binary), executable=True))
            binary.chmod(0o700)
            nested = pathlib.Path(root, 'writable'); nested.mkdir(mode=0o777); nested.chmod(0o777)
            nested_file = nested / 'gh'; nested_file.write_bytes(b'fixture'); nested_file.chmod(0o700)
            self.assertFalse(module.root_owned_file(str(nested_file), executable=True))
            # A symlink chain that crosses /tmp must not regain trust by ending in /root.
            with tempfile.TemporaryDirectory(prefix='servus-untrusted-', dir='/tmp') as attacker:
                crossing = pathlib.Path(attacker, 'target'); crossing.symlink_to(binary)
                relay = pathlib.Path(root, 'relay'); relay.symlink_to(crossing)
                self.assertFalse(module.root_owned_file(str(relay), allow_symlink=True))

    @unittest.skipUnless(os.geteuid() == 0 and sys.platform.startswith('linux') and os.path.exists('/usr/bin/python3'), 'requires isolated Linux root and system Python')
    def test_shebang_uses_isolated_python_despite_caller_environment(self):
        with tempfile.TemporaryDirectory(prefix='servus-isolated-', dir='/root') as root:
            fixture = pathlib.Path(root, 'verify-release.py')
            fixture.write_bytes(PATH.read_bytes()); fixture.chmod(0o700)
            marker = pathlib.Path(root, 'injected')
            pathlib.Path(root, 'sitecustomize.py').write_text("open(" + repr(str(marker)) + ", 'w').write('executed')\n")
            env = {'PATH': root, 'PYTHONPATH': root, 'PYTHONINSPECT': '1', 'SSLKEYLOGFILE': str(marker)}
            result = subprocess.run([str(fixture), '--help'], env=env, cwd=root, stdin=subprocess.DEVNULL,
                                    stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr.decode(errors='replace'))
            self.assertFalse(marker.exists())

    @unittest.skipUnless(hasattr(os, 'fork'), 'requires POSIX process isolation')
    def test_absolute_deadline_interrupts_blocked_open_or_dns(self):
        class SlowOpener:
            def open(self, request, timeout):
                time.sleep(3)
                raise AssertionError('The deadline should interrupt this open')
        registry = module.Registry(time.monotonic() + 10)
        registry.opener = SlowOpener()
        started = time.monotonic()
        with self.assertRaises(module.VerificationError):
            module.bounded_verification(lambda: {'data': registry._request('https://ghcr.io/', 1024).decode()}, 0.25)
        self.assertLess(time.monotonic() - started, 1.5)

    @unittest.skipUnless(hasattr(os, 'fork'), 'requires POSIX process isolation')
    def test_absolute_deadline_interrupts_blocked_dns_resolution(self):
        registry = module.Registry(time.monotonic() + 10)
        def blocked_dns(*_args, **_kwargs):
            time.sleep(3)
            raise AssertionError('The deadline should interrupt DNS resolution')
        started = time.monotonic()
        with patch.object(socket, 'getaddrinfo', side_effect=blocked_dns):
            with self.assertRaises(module.VerificationError):
                module.bounded_verification(lambda: {'data': registry._request('https://ghcr.io/', 1024).decode()}, 0.25)
        self.assertLess(time.monotonic() - started, 1.5)

    @unittest.skipUnless(hasattr(os, 'fork'), 'requires POSIX process isolation')
    def test_absolute_deadline_interrupts_trickling_response(self):
        class SlowResponse:
            headers = Message()
            def __enter__(self): return self
            def __exit__(self, *args): return False
            def read1(self, count):
                time.sleep(0.04)
                return b'x'
        class Opener:
            def open(self, request, timeout): return SlowResponse()
        registry = module.Registry(time.monotonic() + 10)
        registry.opener = Opener()
        started = time.monotonic()
        with self.assertRaises(module.VerificationError):
            module.bounded_verification(lambda: {'data': registry._request('https://ghcr.io/', 1024).decode()}, 0.25)
        self.assertLess(time.monotonic() - started, 1.5)

    @unittest.skipUnless(hasattr(os, 'fork'), 'requires POSIX process isolation')
    def test_bounded_verification_propagates_valid_result_and_rejects_failure(self):
        self.assertEqual(module.bounded_verification(lambda: {'verified': True}, 2), {'verified': True})
        def failed(): raise RuntimeError('sensitive internal details')
        with self.assertRaises(module.VerificationError) as error:
            module.bounded_verification(failed, 2)
        self.assertNotIn('sensitive', str(error.exception))

    @unittest.skipUnless(hasattr(os, 'fork'), 'requires POSIX process isolation')
    def test_nondefault_sigchld_refuses_before_fork(self):
        original = signal.getsignal(signal.SIGCHLD)
        try:
            for handler in (signal.SIG_IGN, lambda *_args: None):
                with self.subTest(handler=handler):
                    signal.signal(signal.SIGCHLD, handler)
                    with patch.object(module.os, 'fork', side_effect=AssertionError('must not fork')):
                        with self.assertRaisesRegex(module.VerificationError, 'default SIGCHLD'):
                            module.bounded_verification(lambda: {'verified': True}, 1)
        finally:
            signal.signal(signal.SIGCHLD, original)

    @unittest.skipUnless(hasattr(os, 'fork'), 'requires POSIX process isolation')
    def test_concurrent_thread_refuses_before_fork(self):
        ready, stop = threading.Event(), threading.Event()
        def waiter():
            ready.set(); stop.wait(3)
        other = threading.Thread(target=waiter)
        other.start(); self.assertTrue(ready.wait(1))
        try:
            with patch.object(module.os, 'fork', side_effect=AssertionError('must not fork')):
                with self.assertRaisesRegex(module.VerificationError, 'single-threaded'):
                    module.bounded_verification(lambda: {'verified': True}, 1)
        finally:
            stop.set(); other.join(timeout=2)

    @unittest.skipUnless(sys.platform.startswith('linux'), 'requires Linux /proc')
    def test_native_thread_or_unavailable_proc_refuses_before_fork(self):
        with patch.object(module.threading, 'active_count', return_value=1), patch.object(module.os, 'fork', side_effect=AssertionError('must not fork')):
            for listing in (['1', '2'], OSError('proc unavailable')):
                with self.subTest(listing=listing), patch.object(module.os, 'listdir', side_effect=listing if isinstance(listing, Exception) else None, return_value=listing):
                    with self.assertRaises(module.VerificationError):
                        module.bounded_verification(lambda: {'verified': True}, 1)

    def test_public_library_call_refuses_before_fork_or_network(self):
        with patch.object(module.os, 'geteuid', return_value=1000), patch.object(module.os, 'fork', side_effect=AssertionError('must not fork')), patch.object(module, 'Registry', side_effect=AssertionError('must not use network')):
            with self.assertRaisesRegex(module.VerificationError, 'isolated CLI'):
                module.verify_release('sha256:' + 'a'*64, COMMIT, TAG)

    @unittest.skipUnless(sys.platform.startswith('linux') and os.path.isdir('/proc'), 'requires isolated Linux')
    def test_terminated_or_killed_parent_stops_child_and_its_process_group(self):
        with tempfile.TemporaryDirectory(prefix='servus-watch-') as tempdir:
            pidfile = pathlib.Path(tempdir, 'pids')
            script = '''
import importlib.util, pathlib, os, subprocess, sys, time
spec = importlib.util.spec_from_file_location('test_verifier', sys.argv[1])
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
def task():
    process = subprocess.Popen([sys.executable, '-I', '-c', 'import time; time.sleep(30)'])
    target = pathlib.Path(sys.argv[2]); temporary = target.with_name('pids.tmp')
    temporary.write_text(str(os.getpid()) + ' ' + str(process.pid)); os.replace(temporary, target)
    time.sleep(30)
    return {'verified': True}
module.bounded_verification(task, 30)
'''
            for termination in (signal.SIGTERM, signal.SIGKILL):
                with self.subTest(signal=termination):
                    pidfile.unlink(missing_ok=True)
                    parent = subprocess.Popen([sys.executable, '-I', '-c', script, str(PATH), str(pidfile)],
                                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                    try:
                        deadline = time.monotonic() + 5
                        while not pidfile.exists() and time.monotonic() < deadline: time.sleep(0.02)
                        self.assertTrue(pidfile.exists(), 'worker did not start')
                        worker, descendant = map(int, pidfile.read_text().split())
                        os.kill(parent.pid, termination)
                        parent.wait(timeout=5)
                        def alive(pid):
                            try:
                                # A zombie has already stopped and awaits reaping by init.
                                return pathlib.Path(f'/proc/{pid}/stat').read_text().split(') ', 1)[1][0] != 'Z'
                            except FileNotFoundError:
                                return False
                        deadline = time.monotonic() + 3
                        while (alive(worker) or alive(descendant)) and time.monotonic() < deadline: time.sleep(0.02)
                        self.assertFalse(alive(worker), 'verification child survived its parent')
                        self.assertFalse(alive(descendant), 'verification descendant survived its parent')
                    finally:
                        if parent.poll() is None:
                            parent.kill(); parent.wait(timeout=5)

    @unittest.skipUnless(hasattr(os, 'fork'), 'requires POSIX process isolation')
    def test_late_child_exit_is_reaped_without_blocking_caller(self):
        actual_waitpid = os.waitpid
        reaped = threading.Event()
        def delayed_wait(pid, options):
            if options == os.WNOHANG:
                return (0, 0)
            try:
                return actual_waitpid(pid, options)
            finally:
                reaped.set()
        started = time.monotonic()
        with patch.object(module.os, 'waitpid', side_effect=delayed_wait):
            with self.assertRaises(module.VerificationError):
                module.bounded_verification(lambda: time.sleep(3), 0.1)
            self.assertTrue(reaped.wait(2), 'background reaper did not finish')
        self.assertLess(time.monotonic() - started, 1.5)

    @unittest.skipUnless(os.geteuid() == 0 and sys.platform.startswith('linux'), 'requires isolated Linux root')
    def test_root_cli_refuses_actual_verification_without_cgroup_supervisor(self):
        result = subprocess.run([sys.executable, '-I', str(PATH), '--digest', 'sha256:' + 'a'*64,
                                 '--commit', COMMIT, '--tag', TAG], stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, timeout=5)
        self.assertEqual(result.returncode, 1)
        self.assertIn(b'cgroup supervisor', result.stderr)
        self.assertEqual(result.stdout, b'')
        with patch.object(module, 'Registry', side_effect=AssertionError('network must not be used')):
            with self.assertRaisesRegex(module.VerificationError, 'cgroup supervisor'):
                module.verify_release('sha256:' + 'a'*64, COMMIT, TAG)

    @unittest.skipUnless(sys.platform.startswith('linux') and os.path.isdir('/proc'), 'requires isolated Linux')
    def test_killed_verification_child_does_not_leave_a_running_descendant(self):
        with tempfile.TemporaryDirectory(prefix='servus-child-exit-') as tempdir:
            pidfile = pathlib.Path(tempdir, 'pid')
            def task():
                process = subprocess.Popen([sys.executable, '-I', '-c', 'import time; time.sleep(30)'])
                pidfile.write_text(str(process.pid))
                os.kill(os.getpid(), signal.SIGKILL)
            with self.assertRaises(module.VerificationError):
                module.bounded_verification(task, 3)
            self.assertTrue(pidfile.exists())
            descendant = int(pidfile.read_text())
            def alive():
                try:
                    return pathlib.Path(f'/proc/{descendant}/stat').read_text().split(') ', 1)[1][0] != 'Z'
                except FileNotFoundError:
                    return False
            deadline = time.monotonic() + 3
            while alive() and time.monotonic() < deadline: time.sleep(0.02)
            self.assertFalse(alive(), 'descendant survived an unexpectedly killed verifier')
    def test_blob_redirect_drops_registry_authorization(self):
        class Response(io.BytesIO):
            def __init__(self, body):
                super().__init__(body)
                self.headers = Message()
        class Opener:
            def __init__(self): self.requests = []
            def open(self, request, timeout):
                self.requests.append(request)
                if len(self.requests) == 1:
                    headers = Message(); headers['Location'] = 'https://pkg-containers.githubusercontent.com/blob?signature=synthetic'
                    raise urllib.error.HTTPError(request.full_url, 307, 'redirect', headers, None)
                return Response(b'bundle')
        registry = module.Registry(time.monotonic()+10)
        registry.token = 'synthetic-token'
        registry.opener = Opener()
        self.assertEqual(registry.blob('sha256:'+'a'*64), b'bundle')
        first, second = registry.opener.requests
        self.assertTrue(first.has_header('Authorization'))
        self.assertFalse(second.has_header('Authorization'))
    def test_temporary_directory_ignores_untrusted_environment(self):
        registry = self.registry
        with tempfile.TemporaryDirectory(prefix='untrusted-tmp-') as attacker_dir:
            def verify(manifest, bundle, commit, tag, tempdir, deadline):
                self.assertNotEqual(pathlib.Path(tempdir).parent, pathlib.Path(attacker_dir))
                self.assertEqual(pathlib.Path(tempdir).parent, pathlib.Path(module.trusted_temp_root()))
                info = os.lstat(tempdir)
                self.assertEqual(info.st_uid, os.geteuid())
                self.assertEqual(stat.S_IMODE(info.st_mode), 0o700)
                return signed_result(registry.image_digest)
            with patch.dict(os.environ, {'TMPDIR': attacker_dir, 'TMP': attacker_dir, 'TEMP': attacker_dir}):
                result = module._verify_release(registry.image_digest, COMMIT, TAG, registry, verify)
            self.assertTrue(result['verified'])
    def test_untrusted_or_symlinked_temp_directories_fail_closed(self):
        with patch.object(module.os, 'lstat', side_effect=OSError('inaccessible')):
            with self.assertRaises(module.VerificationError): module.trusted_temp_root()
        with tempfile.TemporaryDirectory(prefix='temp-check-') as root:
            target = pathlib.Path(root, 'target');target.mkdir(mode=0o700)
            link = pathlib.Path(root, 'link');link.symlink_to(target, target_is_directory=True)
            with self.assertRaises(module.VerificationError): module.validate_private_temp(str(link), root)
            target.chmod(0o755)
            with self.assertRaises(module.VerificationError): module.validate_private_temp(str(target), root)
    def test_registry_rejects_untrusted_reference_without_network(self):
        registry = module.Registry(float('inf'))
        with patch.object(registry, '_request', side_effect=AssertionError('network must not be used')):
            with self.assertRaises(module.VerificationError): registry.manifest('../../evil')
            with self.assertRaises(module.VerificationError): registry.blob('https://evil.test')

if __name__ == '__main__': unittest.main()
