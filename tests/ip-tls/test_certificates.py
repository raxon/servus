import os
import pathlib
import shutil
import socket
import ssl
import subprocess
import tempfile
import threading
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
SCRIPT = ROOT / 'deployment/ip-tls/certificates.sh'


class CertificateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = pathlib.Path(self.tmp.name).resolve()
        self.base = self.root / 'data'
        for item in ['production/config/live/servus-ip', 'production/work', 'production/logs', 'webroot']:
            (self.base / item).mkdir(parents=True, exist_ok=True)
        (self.base / 'production/config/live/servus-ip/fullchain.pem').write_text('cert')
        (self.base / 'production/config/live/servus-ip/privkey.pem').write_text('key')
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        self.log = self.root / 'commands'
        mocks = {
            'id': 'echo 0',
            'stat': 'if [ "$2" = %u ]; then echo 0; else case "$3" in *.lock) echo 600 ;; *production*|*staging*) echo 700 ;; *) echo 755 ;; esac; fi',
            'flock': 'exit 0',
            'sleep': 'exit 0',
            'docker': 'echo docker >> "$MOCK_LOG"; exit "${DOCKER_EXIT:-0}"',
            'openssl': '''case "$1" in
verify) exit "${CHECK_EXIT:-0}" ;;
s_client) [ "${HANDSHAKE_EXIT:-0}" = 0 ] || exit 1; count=0; [ ! -f "$MOCK_COUNT" ] || count=$(cat "$MOCK_COUNT"); count=$((count+1)); printf %s "$count" > "$MOCK_COUNT"; if [ "${HANDSHAKE_MISMATCH:-0}" = 1 ] || [ "$count" -le "${HANDSHAKE_DELAY:-0}" ]; then printf wrong; else printf publickey; fi ;;
x509) input=; output=; while [ "$#" -gt 0 ]; do case "$1" in -in) input=$2; shift ;; -out) output=$2; shift ;; esac; shift; done; if [ -n "$output" ]; then case "$input" in *.handshake.*) cat "$input" > "$output" ;; *) printf publickey > "$output" ;; esac; else printf publickey; fi ;;
*) printf publickey ;;
esac''',
            'systemctl': 'echo "systemctl $*" >> "$MOCK_LOG"; case "$*" in reload*) exit "${RELOAD_EXIT:-0}" ;; *) exit 0 ;; esac',
        }
        for name, body in mocks.items():
            path = self.bin / name
            path.write_text('#!/bin/sh\n' + body + '\n')
            path.chmod(0o755)
        script = SCRIPT.read_text().replace('BASE=/var/lib/servus-ip-tls', 'BASE=' + str(self.base))
        script = script.replace('in /var /var/lib "$BASE"', 'in "$BASE"')
        script = script.replace('/run/lock/servus-ip-tls.lock', str(self.root / 'lock'))
        self.script = self.root / 'certificates.sh'
        self.script.write_text(script)
        self.env = dict(os.environ, PATH=str(self.bin) + ':' + os.environ['PATH'], MOCK_LOG=str(self.log), MOCK_COUNT=str(self.root / 'count'))

    def run_script(self, *args, **extra):
        return subprocess.run(['sh', str(self.script), *args], env=dict(self.env, **extra), capture_output=True, text=True)

    def test_renew_reloads_once_and_records_state(self):
        self.assertEqual(self.run_script('renew', 'production').returncode, 0)
        self.assertEqual(self.run_script('renew', 'production').returncode, 0)
        self.assertEqual(self.log.read_text().count('systemctl reload'), 1)
        self.assertTrue((self.base / 'production/reloaded.sha256').is_file())

    def test_failed_reload_retries_without_recording_state(self):
        self.assertNotEqual(self.run_script('renew', 'production', RELOAD_EXIT='1').returncode, 0)
        self.assertFalse((self.base / 'production/reloaded.sha256').exists())
        self.assertEqual(self.run_script('renew', 'production').returncode, 0)
        self.assertEqual(self.log.read_text().count('systemctl reload'), 2)

    def test_renewal_or_ip_failure_never_reloads(self):
        self.assertNotEqual(self.run_script('renew', 'production', DOCKER_EXIT='1').returncode, 0)
        self.assertNotEqual(self.run_script('renew', 'production', CHECK_EXIT='1').returncode, 0)
        self.assertNotIn('systemctl reload', self.log.read_text())

    def test_staging_renewal_never_reloads_production(self):
        for item in ['staging/config', 'staging/work', 'staging/logs']:
            (self.base / item).mkdir(parents=True, exist_ok=True)
        self.assertEqual(self.run_script('renew', 'staging').returncode, 0)
        self.assertNotIn('systemctl', self.log.read_text())

    def test_lock_symlink_is_rejected_without_changing_target(self):
        target = self.root / 'existing'
        target.write_text('keep')
        (self.base / '.certificates.lock').symlink_to(target)
        self.assertNotEqual(self.run_script('renew', 'production').returncode, 0)
        self.assertEqual(target.read_text(), 'keep')
        self.assertFalse(self.log.exists())

    def test_failed_handshake_and_mismatch_retry_without_recording_state(self):
        for option in ('HANDSHAKE_EXIT', 'HANDSHAKE_MISMATCH'):
            result = self.run_script('renew', 'production', **{option: '1'})
            self.assertNotEqual(result.returncode, 0, result.stderr)
            self.assertFalse((self.base / 'production/reloaded.sha256').exists())
        self.assertEqual(self.run_script('renew', 'production').returncode, 0)
        self.assertEqual(self.log.read_text().count('systemctl reload'), 3)

    def test_reload_waits_for_new_certificate(self):
        result = self.run_script('renew', 'production', HANDSHAKE_DELAY='2')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.root / 'count').read_text(), '3')

    def test_real_certificate_verification_and_key_match(self):
        openssl = shutil.which('openssl')
        self.assertIsNotNone(openssl)
        ca_key, ca_cert = self.root / 'ca.key', self.root / 'ca.pem'
        wrong_key, wrong_cert = self.root / 'wrong.key', self.root / 'wrong.pem'
        leaf_key, request, leaf = self.root / 'leaf.key', self.root / 'leaf.csr', self.root / 'leaf.pem'
        extensions = self.root / 'extensions'
        extensions.write_text('subjectAltName=IP:159.65.115.230\nextendedKeyUsage=serverAuth\n')

        def run(*args):
            subprocess.run([openssl, *map(str, args)], check=True,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

        for key, certificate in [(ca_key, ca_cert), (wrong_key, wrong_cert)]:
            run('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key,
                '-out', certificate, '-days', '1', '-subj', '/CN=Test CA')
        run('req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', leaf_key,
            '-out', request, '-subj', '/CN=Test Server')
        run('x509', '-req', '-in', request, '-CA', ca_cert, '-CAkey', ca_key,
            '-CAcreateserial', '-out', leaf, '-days', '1', '-extfile', extensions)
        cert_path = self.base / 'production/config/live/servus-ip/fullchain.pem'
        key_path = self.base / 'production/config/live/servus-ip/privkey.pem'
        cert_path.write_bytes(leaf.read_bytes())
        key_path.write_bytes(leaf_key.read_bytes())
        (self.bin / 'openssl').write_text(
            f'#!/bin/sh\nif [ "$1" = s_client ]; then cat "$MOCK_SERVE_CERT"; else exec "{openssl}" "$@"; fi\n')
        self.env['MOCK_SERVE_CERT'] = str(cert_path)
        original = self.script.read_text()
        trusted = original.replace('openssl verify -purpose', f'openssl verify -CAfile {ca_cert} -purpose')
        self.script.write_text(trusted)
        result = self.run_script('renew', 'production')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.log.read_text().count('systemctl reload'), 1)

        # Exercise the actual TLS client against a temporary loopback server.
        (self.base / 'production/reloaded.sha256').unlink()
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(str(leaf), str(leaf_key))
        listener = socket.socket()
        listener.bind(('127.0.0.1', 0))
        listener.listen(1)
        listener.settimeout(10)
        self.addCleanup(listener.close)
        port = listener.getsockname()[1]
        def serve():
            try:
                connection, _ = listener.accept()
                with context.wrap_socket(connection, server_side=True) as connection:
                    connection.unwrap().close()
            except OSError:
                pass
        worker = threading.Thread(target=serve, daemon=True)
        worker.start()
        (self.bin / 'openssl').unlink()
        local = trusted.replace('openssl s_client -connect 127.0.0.1:443',
                                f'openssl s_client -CAfile {ca_cert} -connect 127.0.0.1:{port}')
        self.script.write_text(local)
        result = self.run_script('renew', 'production')
        worker.join(timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(worker.is_alive())
        self.assertEqual(self.log.read_text().count('systemctl reload'), 2)

        self.script.write_text(trusted.replace('IP=159.65.115.230', 'IP=203.0.113.1'))
        self.assertNotEqual(self.run_script('renew', 'production').returncode, 0)
        self.script.write_text(original.replace('openssl verify -purpose', f'openssl verify -CAfile {wrong_cert} -purpose'))
        self.assertNotEqual(self.run_script('renew', 'production').returncode, 0)
        self.script.write_text(trusted)
        key_path.write_bytes(wrong_key.read_bytes())
        self.assertNotEqual(self.run_script('renew', 'production').returncode, 0)
        self.assertEqual(self.log.read_text().count('systemctl reload'), 2)


if __name__ == '__main__':
    unittest.main()
