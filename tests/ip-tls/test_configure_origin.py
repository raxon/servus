import fcntl
import http.client
import http.server
import importlib.util
import json
import os
import pathlib
import signal
import ssl
import subprocess
import tempfile
import threading
import time
import unittest
from unittest import mock

PATH = pathlib.Path(__file__).resolve().parents[2] / 'deployment/ip-tls/configure-origin.py'
spec = importlib.util.spec_from_file_location('servus_configure_origin', PATH)
origin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(origin)


class ConfigureOriginTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='servus-origin-test-')
        self.addCleanup(self.tmp.cleanup)
        self.root = pathlib.Path(self.tmp.name).resolve()
        self.install, self.config_dir = self.root / 'install', self.root / 'config'
        release = self.install / 'releases/release1'
        (release / 'deployment').mkdir(parents=True)
        self.config_dir.mkdir(mode=0o700)
        (self.install / 'current').symlink_to(release)
        (self.install / '.servus-install').write_text('servus-installer-v1\n')
        (self.install / 'install.lock').write_text('')
        (self.install / 'install.lock').chmod(0o600)
        (release / 'deployment/compose.yaml').write_text('services: {}\n')
        self.config = self.config_dir / 'servus.env'
        self.before = ('SERVUS_IMAGE=servus:install-demo\nSERVUS_DATA_DIR=/var/lib/servus\n'
                       'SERVUS_PORT=4180\nSERVUS_INGRESS_PORT=80\nSERVUS_BIND_ADDRESS=127.0.0.1\n'
                       'SERVUS_PUBLIC_URL=http://159.65.115.230:4180\n'
                       'SERVUS_ALLOWED_ORIGINS=http://159.65.115.230:4180,http://127.0.0.1:4180,http://localhost:14480\n'
                       'SERVUS_SECURE_COOKIES=false\nSERVUS_SOURCE_REF=stable\nSERVUS_CUSTOM=synthetic-private-value\n').encode()
        self.config.write_bytes(self.before)
        self.config.chmod(0o600)
        docker = self.root / 'docker'
        docker.write_text('test executable\n')
        docker.chmod(0o755)
        self.patches = [mock.patch.object(origin, 'CONFIG', self.config), mock.patch.object(origin, 'INSTALL', self.install),
                        mock.patch.object(origin, 'DOCKER', str(docker)), mock.patch.object(origin, 'TRUSTED_UID', os.geteuid()),
                        mock.patch.object(origin, 'request_health', return_value={'status': 'ok', 'version': '0.1.1'}),
                        mock.patch.object(origin, 'running_image', return_value=('sha256:'+'a'*64, 'b'*64)), mock.patch.object(origin, 'verify_proxy_instance'), mock.patch.object(origin, 'restart_api')]
        for patch in self.patches:
            patch.start()
            self.addCleanup(patch.stop)

    def backups(self):
        return list(self.config_dir.glob('servus.env.before-https-*'))

    def test_success_preserves_other_settings_and_uses_private_backup(self):
        output = origin.migrate()
        self.assertEqual(output.read_bytes(), self.before)
        self.assertEqual(output.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.config.stat().st_mode & 0o777, 0o600)
        _, settings = origin.parse_settings(self.config.read_bytes())
        self.assertEqual(settings['SERVUS_PUBLIC_URL'], origin.TARGET_ORIGIN)
        self.assertEqual(settings['SERVUS_SECURE_COOKIES'], 'true')
        self.assertEqual(settings['SERVUS_ALLOWED_ORIGINS'], 'https://159.65.115.230,http://127.0.0.1:4180,http://localhost:14480')
        self.assertEqual(settings['SERVUS_CUSTOM'], 'synthetic-private-value')
        origin.restart_api.assert_called_once()
        self.assertEqual(origin.migrate(), None)
        self.assertEqual(len(self.backups()), 1)

    def test_restart_failure_restores_original_configuration(self):
        origin.restart_api.side_effect = [origin.MigrationError('fake'), None]
        with self.assertRaisesRegex(origin.MigrationError, 'previous configuration and API were restored'):
            origin.migrate()
        self.assertEqual(self.config.read_bytes(), self.before)
        self.assertEqual(origin.restart_api.call_count, 2)
        self.assertEqual(self.backups()[0].read_bytes(), self.before)

    def test_snapshot_migration_replaces_and_restores_both_files(self):
        compose = self.install / 'releases/release1/deployment/compose.yaml'
        compose.chmod(0o600)
        old, new = b'{"old":true}\n', b'{"new":true}\n'
        compose.write_bytes(old)
        with mock.patch.object(origin, 'compose_snapshot', side_effect=[old, new]):
            origin.migrate()
        self.assertEqual(compose.read_bytes(), new)
        self.assertEqual(len(list(self.config_dir.glob('compose.before-https-*.json'))), 1)
        self.assertEqual(next(self.config_dir.glob('compose.before-https-*.json')).read_bytes(), old)
        self.config.write_bytes(self.before)
        compose.write_bytes(old)
        origin.restart_api.side_effect = [origin.MigrationError('failed'), None]
        with mock.patch.object(origin, 'compose_snapshot', side_effect=[old, new]):
            with self.assertRaisesRegex(origin.MigrationError, 'previous configuration and API were restored'):
                origin.migrate()
        self.assertEqual(compose.read_bytes(), old)
        self.assertEqual(self.config.read_bytes(), self.before)

    def test_snapshot_drift_rejected_before_writes(self):
        compose = self.install / 'releases/release1/deployment/compose.yaml'
        compose.chmod(0o600)
        before = compose.read_bytes()
        with mock.patch.object(origin, 'compose_snapshot', return_value=b'{"unexpected":true}\n'):
            with self.assertRaisesRegex(origin.MigrationError, 'differs from its template'):
                origin.migrate()
        self.assertEqual(compose.read_bytes(), before)
        self.assertEqual(self.config.read_bytes(), self.before)
        self.assertFalse(self.backups())
        origin.restart_api.assert_not_called()

    def test_interrupted_snapshot_update_keeps_both_backups_and_marker(self):
        compose = self.install / 'releases/release1/deployment/compose.yaml'
        compose.chmod(0o600)
        old, new = b'{"old":true}\n', b'{"new":true}\n'
        compose.write_bytes(old)
        child = os.fork()
        if child == 0:
            with mock.patch.object(origin, 'compose_snapshot', side_effect=[old, new]):
                origin.restart_api.side_effect = lambda *_: os.kill(os.getpid(), 9)
                origin.migrate()
            os._exit(1)
        _, status = os.waitpid(child, 0)
        self.assertTrue(os.WIFSIGNALED(status))
        pending = self.config_dir / 'servus-origin-migration.pending'
        record = json.loads(pending.read_bytes())
        self.assertEqual(record['format'], 2)
        self.assertEqual((self.config_dir / record['backup']).read_bytes(), self.before)
        self.assertEqual((self.config_dir / record['composeBackup']).read_bytes(), old)
        self.assertEqual(compose.read_bytes(), new)
        with self.assertRaisesRegex(origin.MigrationError, 'previous origin migration is incomplete'):
            origin.migrate()

    def test_health_failure_and_rollback_failure_are_distinct(self):
        with mock.patch.object(origin, 'wait_api', side_effect=[origin.MigrationError('health failed'), None]):
            with self.assertRaisesRegex(origin.MigrationError, 'previous configuration and API were restored'):
                origin.migrate()
        self.assertEqual(self.config.read_bytes(), self.before)
        origin.restart_api.reset_mock()
        origin.restart_api.side_effect = [origin.MigrationError('failure'), origin.MigrationError('rollback failure')]
        with self.assertRaisesRegex(origin.MigrationError, 'rollback could not be verified'):
            origin.migrate()
        self.assertEqual(self.config.read_bytes(), self.before)

    def test_unverified_public_tls_fails_without_backup_or_mutation(self):
        origin.request_health.side_effect = [{'status':'ok','version':'0.1.1'}, origin.MigrationError('bad certificate')]
        with self.assertRaises(origin.MigrationError):
            origin.migrate()
        self.assertEqual(self.config.read_bytes(), self.before)
        self.assertEqual(self.backups(), [])
        origin.restart_api.assert_not_called()

    def test_tls_uses_explicit_trust_and_does_not_enable_key_logging(self):
        ca = self.root / 'ca.pem'
        key = self.root / 'ca.key'
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', str(key), '-out', str(ca), '-days', '1', '-subj', '/CN=Isolated CA'], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        log = self.root / 'tls-keys.log'
        with mock.patch.object(origin, 'CA_BUNDLE', ca), mock.patch.dict(os.environ, {'SSLKEYLOGFILE':str(log)}):
            context = origin.tls_context()
        self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(context.check_hostname)
        if hasattr(context, 'keylog_filename'):
            self.assertIsNone(context.keylog_filename)
        self.assertFalse(log.exists())

    def test_http_deadline_interrupts_slow_stream_for_health_and_marker(self):
        spec = importlib.util.spec_from_file_location('origin_http_deadline', PATH)
        fresh = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(fresh)
        class SlowHandler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200)
                self.send_header('Content-Length', '100')
                self.end_headers()
                try:
                    for _ in range(100):
                        self.wfile.write(b'x');self.wfile.flush();time.sleep(0.03)
                except (BrokenPipeError, ConnectionResetError):
                    pass
            def log_message(self, *_args):
                pass
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), SlowHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        real_connection = http.client.HTTPConnection
        try:
            with mock.patch.object(fresh, 'HTTP_DEADLINE_SECONDS', 0.15), mock.patch.object(fresh.http.client, 'HTTPConnection', side_effect=lambda _host, _port, timeout: real_connection('127.0.0.1', server.server_port, timeout=timeout)):
                for request in (lambda: fresh.request_health('127.0.0.1', False), lambda: fresh.marker_response('127.0.0.1', False, 'marker.txt')):
                    started = time.monotonic()
                    with self.assertRaises(fresh.MigrationError): request()
                    self.assertLess(time.monotonic()-started, 2)
        finally:
            server.shutdown();server.server_close();thread.join()

    def test_http_deadline_does_not_replace_an_existing_timer(self):
        signal.setitimer(signal.ITIMER_REAL, 3)
        try:
            with self.assertRaisesRegex(origin.MigrationError, 'existing timer'):
                with origin.http_deadline():
                    self.fail('An existing alarm must not be replaced')
            self.assertGreater(signal.getitimer(signal.ITIMER_REAL)[0], 0)
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)

    def test_mismatched_image_and_public_health_fail_before_change(self):
        origin.request_health.side_effect = [{'status':'ok','version':'0.1.1'}, {'status':'ok','version':'wrong'}]
        with self.assertRaises(origin.MigrationError):
            origin.migrate()
        self.assertEqual(self.config.read_bytes(), self.before)
        self.assertEqual(self.backups(), [])
        origin.request_health.side_effect = None
        origin.running_image.side_effect = origin.MigrationError('image mismatch')
        with self.assertRaises(origin.MigrationError):
            origin.migrate()
        self.assertEqual(self.backups(), [])

    def test_rejects_symlinks_duplicate_keys_unsafe_values_and_public_bind(self):
        self.config.unlink()
        target = self.root / 'other'
        target.write_bytes(self.before)
        self.config.symlink_to(target)
        with self.assertRaises(origin.MigrationError):
            origin.migrate()
        self.assertEqual(target.read_bytes(), self.before)
        self.config.unlink()
        for raw in [self.before + b'SERVUS_PORT=1234\n', self.before + b'INJECTION=$(bad)\n', self.before.replace(b'SERVUS_BIND_ADDRESS=127.0.0.1',b'SERVUS_BIND_ADDRESS=0.0.0.0')]:
            self.config.write_bytes(raw)
            self.config.chmod(0o600)
            with self.assertRaises(origin.MigrationError):
                origin.migrate()
        origin.restart_api.assert_not_called()
        self.assertEqual(self.backups(), [])

    def test_conflicting_installer_lock_fails_before_mutation(self):
        with (self.install / 'install.lock').open('r+') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(origin.MigrationError):
                origin.migrate()
        self.assertEqual(self.config.read_bytes(), self.before)
        self.assertEqual(self.backups(), [])

    def test_sigkill_after_config_replace_leaves_durable_pending_and_refuses_retry(self):
        child = os.fork()
        if child == 0:
            origin.restart_api.side_effect = lambda *_args: os.kill(os.getpid(), 9)
            origin.migrate()
            os._exit(1)
        _pid, status = os.waitpid(child, 0)
        self.assertTrue(os.WIFSIGNALED(status))
        self.assertEqual(os.WTERMSIG(status), 9)
        pending = self.config_dir / 'servus-origin-migration.pending'
        self.assertTrue(pending.is_file())
        self.assertEqual(pending.stat().st_mode & 0o777, 0o600)
        self.assertEqual(len(self.backups()), 1)
        self.assertEqual(self.backups()[0].read_bytes(), self.before)
        self.assertNotEqual(self.config.read_bytes(), self.before)
        with self.assertRaisesRegex(origin.MigrationError, 'previous origin migration is incomplete'):
            origin.migrate()
        origin.restart_api.assert_not_called()

    def test_running_metadata_rejects_wrong_mount_and_split_brain_settings(self):
        spec = importlib.util.spec_from_file_location('verify_origin_metadata', PATH)
        fresh = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(fresh)
        data = self.root / 'data'
        data.mkdir(mode=0o700)
        image = 'sha256:' + 'a'*64
        container = 'b'*64
        config_hash = 'c'*64
        values = {'SERVUS_IMAGE':'image:test','SERVUS_DATA_DIR':str(data),'SERVUS_ALLOWED_ORIGINS':'http://localhost:4180','SERVUS_SECURE_COOKIES':'false'}
        env = ['PANEL_DATA_DIR='+str(data),'PANEL_HOST=0.0.0.0','PANEL_PORT=4180','PANEL_ALLOWED_ORIGINS=http://localhost:4180','PANEL_SECURE_COOKIES=false']
        mounts = [{'Type':'bind','Source':str(data),'Destination':str(data),'RW':True}]
        ports = {'4180/tcp':[{'HostIp':'127.0.0.1','HostPort':'4180'}]}
        def docker(*args):
            if args[0] == 'compose': return ('api '+config_hash) if 'config' in args else container
            if args[0] == 'image': return image
            if args[2] == '{{index .Config.Labels "com.docker.compose.config-hash"}}': return config_hash
            if args[2] == '{{.Image}}': return image
            if args[2] == '{{json .Mounts}}': return json.dumps(mounts)
            if args[2] == '{{json .Config.Env}}': return json.dumps(env)
            if args[2] == '{{json .NetworkSettings.Ports}}': return json.dumps(ports)
            raise AssertionError(args)
        with mock.patch.object(fresh, 'docker', side_effect=docker):
            self.assertEqual(fresh.running_image(pathlib.Path('/compose'), self.config, values), (image,container))
            mounts[0]['Source'] = str(self.root / 'other')
            with self.assertRaises(fresh.MigrationError):
                fresh.running_image(pathlib.Path('/compose'), self.config, values)
            mounts[0]['Source'] = str(data)
            env[-1] = 'PANEL_SECURE_COOKIES=true'
            with self.assertRaises(fresh.MigrationError):
                fresh.running_image(pathlib.Path('/compose'), self.config, values)
            env[-1] = 'PANEL_SECURE_COOKIES=false'
            ports['4180/tcp'] = [{'HostIp':'0.0.0.0','HostPort':'4180'}]
            with self.assertRaises(fresh.MigrationError):
                fresh.running_image(pathlib.Path('/compose'), self.config, values)
            ports['4180/tcp'] = [{'HostIp':'127.0.0.1','HostPort':'4180'}]
            env.append('PANEL_TRUSTED_PROXY_SECRET=synthetic')
            with self.assertRaises(fresh.MigrationError):
                fresh.running_image(pathlib.Path('/compose'), self.config, values)

    def test_missing_compose_hash_and_configured_proxy_secret_are_rejected(self):
        _, values = origin.parse_settings(self.before)
        for key in ('SERVUS_TRUSTED_PROXY_SECRET', 'SERVUS_TRUSTED_PROXY_SECRET_FILE'):
            invalid = self.before + (key + '=synthetic\n').encode()
            with self.assertRaises(origin.MigrationError):
                origin.parse_settings(invalid)
        spec = importlib.util.spec_from_file_location('origin_missing_hash', PATH)
        fresh = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(fresh)
        container = 'a'*64
        def docker(*args):
            if args[0] == 'compose': return '' if 'config' in args else container
            raise AssertionError('Unexpected inspect for missing hash')
        with mock.patch.object(fresh, 'docker', side_effect=docker):
            with self.assertRaises(fresh.MigrationError):
                fresh.running_image(pathlib.Path('/compose'), self.config, values)
        def missing_label(*args):
            if args[0] == 'compose': return ('api '+'b'*64) if 'config' in args else container
            if args[0] == 'inspect': return '<no value>'
            raise AssertionError(args)
        with mock.patch.object(fresh, 'docker', side_effect=missing_label):
            with self.assertRaises(fresh.MigrationError):
                fresh.running_image(pathlib.Path('/compose'), self.config, values)

    def test_same_health_on_different_proxy_cannot_pass_instance_challenge(self):
        spec = importlib.util.spec_from_file_location('verify_origin_marker', PATH)
        fresh = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(fresh)
        with mock.patch.object(fresh.secrets, 'token_hex', side_effect=['a'*32, 'b'*64]), \
             mock.patch.object(fresh, 'docker') as invoke, \
             mock.patch.object(fresh, 'marker_response', side_effect=[b'b'*64, b'other instance']):
            with self.assertRaises(fresh.MigrationError):
                fresh.verify_proxy_instance('c'*64)
            self.assertEqual(invoke.call_count, 2)
            self.assertEqual(invoke.call_args_list[1].args[6], fresh.REMOVE_MARKER)

    def test_uncertain_marker_creation_still_attempts_safe_cleanup(self):
        spec = importlib.util.spec_from_file_location('verify_origin_uncertain_marker', PATH)
        fresh = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(fresh)
        with mock.patch.object(fresh.secrets, 'token_hex', side_effect=['a'*32, 'b'*64]), \
             mock.patch.object(fresh, 'docker', side_effect=[fresh.MigrationError('connection lost'), '']) as invoke:
            with self.assertRaises(fresh.MigrationError):
                fresh.verify_proxy_instance('c'*64)
            self.assertEqual(invoke.call_count, 2)
            self.assertEqual(invoke.call_args_list[1].args[6], fresh.REMOVE_MARKER)

    def test_restart_only_uses_api_with_no_dependencies_build_or_pull(self):
        with mock.patch.object(origin, 'docker') as call:
            # This bypasses setUp's replacement of restart_api.
            import importlib.util
            fresh_spec = importlib.util.spec_from_file_location('fresh_origin', PATH)
            fresh = importlib.util.module_from_spec(fresh_spec)
            fresh_spec.loader.exec_module(fresh)
            with mock.patch.object(fresh, 'docker') as fresh_docker:
                fresh.restart_api(pathlib.Path('/opt/servus/current/deployment/compose.yaml'), pathlib.Path('/etc/servus/servus.env'))
                fresh_docker.assert_called_once_with('compose','--env-file','/etc/servus/servus.env','-f','/opt/servus/current/deployment/compose.yaml','-p','servus','up','-d','--no-deps','--no-build','--pull','never','api')


if __name__ == '__main__':
    unittest.main()
