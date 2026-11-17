import hashlib
import io
import importlib.util
import json
import pathlib
import sys
import threading
import time
import unittest
from unittest import mock
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('discover_release', ROOT / 'apps/updater/discover-release.py')
discovery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(discovery)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None


class FakeServer:
    def __init__(self):
        self.seen = []
        self.body = b'{"schemaVersion":2,"mediaType":"application/vnd.oci.image.manifest.v1+json"}'
        self.releases = []
        self.tags = [{'name': 'v0.1.4', 'commit': {'sha': 'a' * 40}}, {'name': 'v0.1.3', 'commit': {'sha': 'b' * 40}}]
        self.invalid_owner = False
        self.redirect = False
        self.manifest_status = None
        self.redirect_target = None
        self.digest_header = None
        self.delay = 0
        self.pages = None
        outer = self
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass
            def do_GET(self):
                outer.seen.append((self.path, self.headers.get('Authorization')))
                if outer.delay:
                    time.sleep(outer.delay)
                if self.path == '/repos/raxon/servus':
                    data = json.dumps({'id': discovery.REPOSITORY_ID, 'full_name': 'raxon/servus', 'owner': {'id': 1 if outer.invalid_owner else discovery.OWNER_ID, 'login': 'raxon'}}).encode()
                    kind = 'application/json'
                elif self.path.startswith('/repos/raxon/servus/releases?'):
                    data = json.dumps(outer.releases).encode()
                    kind = 'application/json'
                elif self.path.startswith('/repos/raxon/servus/tags?'):
                    page = int(self.path.rsplit('=', 1)[-1])
                    data = json.dumps(outer.tags if outer.pages is None else outer.pages.get(page, [])).encode()
                    kind = 'application/json'
                elif self.path.startswith('/token?'):
                    data = b'{"token":"synthetic-token"}'
                    kind = 'application/json'
                elif self.path.startswith('/v2/raxon/servus/manifests/'):
                    if outer.manifest_status:
                        self.send_error(outer.manifest_status)
                        return
                    if outer.redirect:
                        self.send_response(302)
                        self.send_header('Location', outer.redirect_target or '/attacker')
                        self.end_headers()
                        return
                    data = outer.body
                    kind = 'application/vnd.oci.image.manifest.v1+json'
                else:
                    self.send_error(404)
                    return
                self.send_response(200)
                self.send_header('Content-Type', kind)
                self.send_header('Content-Length', str(len(data)))
                if outer.digest_header and self.path.startswith('/v2/'):
                    self.send_header('Docker-Content-Digest', outer.digest_header)
                self.end_headers()
                try:
                    self.wfile.write(data)
                except (BrokenPipeError, ConnectionResetError):
                    pass
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = 'http://127.0.0.1:' + str(self.server.server_port)

    def transport(self):
        upstream = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        outer = self
        class RewritingOpener:
            def open(self, request, timeout):
                original = request.full_url
                assert original.startswith(discovery.GITHUB + '/') or original.startswith(discovery.REGISTRY + '/')
                path = original.split('/', 3)[3]
                rewritten = urllib.request.Request(outer.base + '/' + path, headers=dict(request.header_items()))
                return upstream.open(rewritten, timeout=timeout)
        return discovery.Transport(time.monotonic() + 4, opener=RewritingOpener())

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)


class DiscoveryTest(unittest.TestCase):
    def setUp(self):
        self.server = FakeServer()
        self.addCleanup(self.server.close)

    def test_production_excludes_tags_drafts_and_prereleases(self):
        self.server.releases = [
            {'tag_name': 'v0.1.3', 'draft': False, 'prerelease': False, 'published_at': '2026-11-15T12:00:00Z'},
            {'tag_name': 'v0.1.4', 'draft': False, 'prerelease': True, 'published_at': '2026-11-15T12:00:00Z'},
            {'tag_name': 'v0.1.4', 'draft': True, 'prerelease': False, 'published_at': None},
        ]
        production = discovery.discover(self.server.transport(), 'v0.1.2', channel='production')
        beta = discovery.discover(self.server.transport(), 'v0.1.2', channel='beta')
        self.assertEqual(production['tag'], 'v0.1.3')
        self.assertEqual(production['commit'], 'b' * 40)
        self.assertEqual(beta['tag'], 'v0.1.4')

    def test_production_never_falls_back_to_unreleased_tags(self):
        with self.assertRaises(discovery.DiscoveryError):
            discovery.discover(self.server.transport(), 'v0.1.2', channel='production')

    def test_candidate_hashes_exact_bytes_and_never_claims_verification(self):
        result = discovery.discover(self.server.transport(), 'v0.1.3')
        self.assertEqual(result, {'status': 'candidate', 'verified': False, 'tag': 'v0.1.4', 'commit': 'a' * 40, 'digest': 'sha256:' + hashlib.sha256(self.server.body).hexdigest()})
        self.assertTrue(all(auth is None for path, auth in self.server.seen if not path.startswith('/v2/')))
        self.assertEqual([auth for path, auth in self.server.seen if path.startswith('/v2/')], ['Bearer synthetic-token'])
        self.assertEqual(sum(path == '/repos/raxon/servus' for path, _ in self.server.seen), 2)

    def test_initial_discovery_accepts_first_stable_version_without_claiming_verification(self):
        self.server.tags = [{'name': 'v0.0.0', 'commit': {'sha': 'a' * 40}}]
        result = discovery.discover_initial(self.server.transport())
        self.assertEqual(result, {'status': 'candidate', 'verified': False, 'tag': 'v0.0.0', 'commit': 'a' * 40, 'digest': 'sha256:' + hashlib.sha256(self.server.body).hexdigest()})

    def test_explicit_release_fetches_exact_older_tag_and_commit(self):
        self.server.pages = {
            1: [{'name': f'build-{i}', 'commit': {'sha': 'c' * 40}} for i in range(100)],
            2: [{'name': 'v0.1.3', 'commit': {'sha': 'b' * 40}}],
        }
        result = discovery.discover_release(self.server.transport(), 'v0.1.3')
        self.assertEqual(result, {'status': 'candidate', 'verified': False, 'tag': 'v0.1.3', 'commit': 'b' * 40, 'digest': 'sha256:' + hashlib.sha256(self.server.body).hexdigest()})
        manifests = [path for path, _ in self.server.seen if path.startswith('/v2/')]
        self.assertEqual(manifests, ['/v2/raxon/servus/manifests/v0.1.3'])
        self.assertTrue(any(path.endswith('page=2') for path, _ in self.server.seen))

    def test_explicit_release_rejects_invalid_missing_and_duplicate_tags(self):
        for invalid in ('latest', 'v01.1.0', 'v1.2.3-rc1', 'v1.2.3\n'):
            with self.subTest(tag=invalid), self.assertRaises(discovery.DiscoveryError):
                discovery.discover_release(self.server.transport(), invalid)
        self.assertFalse(self.server.seen)

        with self.assertRaises(discovery.DiscoveryError):
            discovery.discover_release(self.server.transport(), 'v0.1.2')
        self.assertFalse(any(path.startswith('/token') or path.startswith('/v2/') for path, _ in self.server.seen))

        self.server.tags.append({'name': 'v0.1.3', 'commit': {'sha': 'b' * 40}})
        with self.assertRaises(discovery.DiscoveryError):
            discovery.discover_release(self.server.transport(), 'v0.1.3')
        self.assertFalse(any(path.startswith('/token') or path.startswith('/v2/') for path, _ in self.server.seen))

    def test_explicit_release_manifest_missing_does_not_fall_back_to_latest(self):
        self.server.manifest_status = 404
        result = discovery.discover_release(self.server.transport(), 'v0.1.3')
        self.assertEqual(result, {'status': 'release_pending', 'verified': False, 'tag': 'v0.1.3', 'commit': 'b' * 40, 'reason': 'manifest_not_available'})
        manifests = [path for path, _ in self.server.seen if path.startswith('/v2/')]
        self.assertEqual(manifests, ['/v2/raxon/servus/manifests/v0.1.3'])

    def test_cli_release_option_routes_to_explicit_discovery(self):
        output = io.StringIO()
        result = {'status': 'candidate', 'verified': False, 'tag': 'v0.1.3', 'commit': 'b' * 40, 'digest': 'sha256:' + 'c' * 64}
        with mock.patch.object(sys, 'argv', ['discover-release.py', '--release', 'v0.1.3']), \
                mock.patch.object(discovery, 'Transport', return_value=object()), \
                mock.patch.object(discovery, 'discover_release', return_value=result) as discover_release, \
                mock.patch('sys.stdout', output):
            self.assertEqual(discovery.main(), 0)
        discover_release.assert_called_once()
        self.assertEqual(discover_release.call_args.args[1], 'v0.1.3')
        self.assertEqual(json.loads(output.getvalue()), result)

    def test_initial_discovery_refuses_wrong_owner_and_reports_missing_image(self):
        self.server.invalid_owner = True
        with self.assertRaises(discovery.DiscoveryError): discovery.discover_initial(self.server.transport())
        self.server.invalid_owner = False
        self.server.manifest_status = 404
        result = discovery.discover_initial(self.server.transport())
        self.assertEqual(result['status'], 'release_pending')
        self.assertFalse(result['verified'])

    def test_no_downgrade_or_repeat_and_no_registry_call(self):
        for current, status in [('v0.1.4', 'no_newer_version'), ('v0.2.0', 'ahead')]:
            result = discovery.discover(self.server.transport(), current)
            self.assertEqual(result['status'], status)
        self.assertFalse(any(path.startswith('/token') or path.startswith('/v2/') for path, _ in self.server.seen))

    def test_rejects_wrong_owner_duplicate_tags_and_json_keys(self):
        self.server.invalid_owner = True
        with self.assertRaises(discovery.DiscoveryError): discovery.discover(self.server.transport(), 'v0.1.0')
        self.server.invalid_owner = False
        self.server.tags.append(self.server.tags[0])
        with self.assertRaises(discovery.DiscoveryError): discovery.discover(self.server.transport(), 'v0.1.0')
        with self.assertRaises(discovery.DiscoveryError): discovery.decode_json(b'{"id":1,"id":2}')

    def test_redirect_never_forwards_registry_bearer(self):
        self.server.redirect = True
        self.server.redirect_target = self.server.base + '/attacker'
        with self.assertRaises(discovery.DiscoveryError): discovery.discover(self.server.transport(), 'v0.1.0')
        self.assertFalse(any(path == '/attacker' for path, _ in self.server.seen))

    def test_manifest_digest_disagreement_and_oversize_fail(self):
        self.server.digest_header = 'sha256:' + '0' * 64
        with self.assertRaises(discovery.DiscoveryError): discovery.discover(self.server.transport(), 'v0.1.0')
        self.server.digest_header = None
        self.server.body = b'x' * (discovery.MAX_MANIFEST + 1)
        with self.assertRaises(discovery.DiscoveryError): discovery.discover(self.server.transport(), 'v0.1.0')

    def test_paginates_all_tags_and_rejects_page_limit(self):
        self.server.pages = {1: [{'name': f'build-{i}', 'commit': {'sha': 'c' * 40}} for i in range(100)], 2: [{'name': 'v0.1.5', 'commit': {'sha': 'd' * 40}}]}
        result = discovery.discover(self.server.transport(), 'v0.1.4')
        self.assertEqual(result['tag'], 'v0.1.5')
        self.server.pages = {p: [{'name': f'build-{p}-{i}'} for i in range(100)] for p in range(1, discovery.MAX_PAGES + 1)}
        with self.assertRaises(discovery.DiscoveryError): discovery.discover(self.server.transport(), 'v0.1.4')

    def test_absolute_deadline_interrupts_blocking_request(self):
        self.server.delay = 1
        start = time.monotonic()
        with self.assertRaises(discovery.DiscoveryError):
            discovery.discover(self.server.transport(), 'v0.1.0', timeout_seconds=0.15)
        self.assertLess(time.monotonic() - start, 0.8)

    def test_absent_highest_manifest_is_pending_not_success_or_fallback(self):
        self.server.manifest_status = 404
        result = discovery.discover(self.server.transport(), 'v0.1.3')
        self.assertEqual(result, {'status': 'release_pending', 'verified': False, 'tag': 'v0.1.4', 'commit': 'a' * 40, 'reason': 'manifest_not_available'})
        self.assertTrue(any(path.endswith('/v0.1.4') for path, _ in self.server.seen))
        self.assertFalse(any(path.endswith('/v0.1.3') for path, _ in self.server.seen))
        self.server.manifest_status = 403
        with self.assertRaises(discovery.DiscoveryError): discovery.discover(self.server.transport(), 'v0.1.3')

    def test_library_refuses_missing_process_deadline_capability(self):
        failures = []
        def invoke():
            try: discovery.discover(self.server.transport(), 'v0.1.3')
            except discovery.DiscoveryError as error: failures.append(str(error))
        worker = threading.Thread(target=invoke)
        worker.start()
        worker.join(timeout=2)
        self.assertEqual(len(failures), 1)
        self.assertFalse(self.server.seen)
        for invalid in (0, -1, float('inf'), True, discovery.TIMEOUT + 1):
            with self.assertRaises(discovery.DiscoveryError): discovery.discover(self.server.transport(), 'v0.1.3', timeout_seconds=invalid)

    def test_rejects_bad_current_and_invalid_commit(self):
        for bad in ('0.1.0', 'v01.1.0', 'v1.2.3-rc1', 'v1.2.3\n', 'v' + '9' * 100 + '.1.1'):
            with self.assertRaises(discovery.DiscoveryError): discovery.discover(self.server.transport(), bad)
        self.server.tags[0]['commit']['sha'] = 'f' * 39
        with self.assertRaises(discovery.DiscoveryError): discovery.discover(self.server.transport(), 'v0.1.0')


if __name__ == '__main__':
    unittest.main()
