import json
import importlib.util
import os
import pathlib
import signal
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
from concurrent.futures import ThreadPoolExecutor

ROOT = pathlib.Path(__file__).resolve().parents[2]
HELPER = ROOT / 'apps/updater/servus-updater.py'
UUID = '12345678-1234-4123-8123-123456789abc'
OTHER_UUID = '12345678-1234-4123-8123-123456789abd'
REQUEST = {'version': 1, 'action': 'submit', 'operationId': UUID, 'commit': 'a' * 40, 'digest': 'sha256:' + 'b' * 64, 'tag': 'v1.2.3'}
CLIENT = r'''import socket, sys
s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);s.settimeout(3);s.connect(sys.argv[1]);s.sendall(sys.argv[2].encode()+b'\n');print(s.recv(8192).decode().strip())'''



@unittest.skipUnless(os.geteuid() == 0, 'Requires root-owned journal')
class JournalContractTest(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location('servus_updater', HELPER)
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        self.tmp = tempfile.TemporaryDirectory(prefix='servus-updater-journal-')
        self.state = pathlib.Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_update_intent_is_migrated_durable_and_recovered_fail_closed(self):
        journal = self.module.Journal(self.state)
        journal.db.execute("INSERT INTO operations(id,commit_sha,digest,tag,status,attempt_id,attempt_nonce,config_digest) VALUES(?,?,?,?,?,?,?,?)", (UUID, REQUEST['commit'], REQUEST['digest'], REQUEST['tag'], 'verified', OTHER_UUID, 'a' * 64, REQUEST['digest']))
        journal.db.execute("INSERT INTO preparations(operation_id,attempt_id,attempt_nonce,preparation_id,status) VALUES(?,?,?,?,?)", (UUID, OTHER_UUID, 'a' * 64, UUID, 'prepared'))
        journal.db.execute('DROP TABLE update_transactions')
        journal.db.execute('PRAGMA user_version=6')
        journal.close()
        journal = self.module.Journal(self.state)
        try:
            self.assertEqual(journal.db.execute('PRAGMA user_version').fetchone()[0], 8)
            journal.claim_update(UUID)
            row = journal.db.execute('SELECT operation_id,preparation_id,attempt_id,attempt_nonce,root_digest,backup_path,backup_manifest_digest,phase FROM update_transactions').fetchone()
            self.assertEqual(row, (UUID, UUID, OTHER_UUID, 'a' * 64, REQUEST['digest'], None, None, 'intent'))
        finally:
            journal.close()
        journal = self.module.Journal(self.state)
        try:
            journal.recover()
            self.assertEqual(journal.db.execute('SELECT phase FROM update_transactions').fetchone(), ('recovery_required',))
            with self.assertRaises(self.module.ProtocolError):
                journal.claim_update(UUID)
        finally:
            journal.close()

    def test_tag_is_durable_and_all_release_fields_are_idempotent(self):
        journal = self.module.Journal(self.state)
        result = self.module.process(journal, REQUEST)
        self.assertEqual(result['tag'], REQUEST['tag'])
        journal.close()
        journal = self.module.Journal(self.state)
        try:
            self.assertEqual(self.module.process(journal, REQUEST), result)
            for field, value in [('tag', 'v1.2.4'), ('commit', 'c' * 40), ('digest', 'sha256:' + 'c' * 64)]:
                with self.assertRaises(self.module.ProtocolError) as error:
                    self.module.process(journal, {**REQUEST, field: value})
                self.assertEqual(error.exception.code, 'idempotency_conflict')
        finally:
            journal.close()

    def test_unfinished_host_exchange_blocks_new_update_work(self):
        journal = self.module.Journal(self.state)
        try:
            journal.db.execute("CREATE TABLE host_stops(operation_id TEXT, status TEXT)")
            journal.db.execute("CREATE TABLE host_preparations(operation_id TEXT, status TEXT)")
            journal.db.execute("CREATE TABLE host_switches(operation_id TEXT, phase TEXT)")
            journal.db.execute("CREATE TABLE host_unit_masks(operation_id TEXT, phase TEXT)")
            journal.db.execute("INSERT INTO host_stops VALUES(?, 'stopping')", (UUID,))
            with self.assertRaises(self.module.ProtocolError):self.module.process(journal, REQUEST)
            journal.db.execute("UPDATE host_stops SET status='restarting'")
            with self.assertRaises(self.module.ProtocolError):self.module.process(journal, REQUEST)
            journal.db.execute("UPDATE host_stops SET status='completed'")
            journal.db.execute("INSERT INTO host_preparations VALUES(?, 'prepared')", (UUID,))
            with self.assertRaises(self.module.ProtocolError) as error:
                self.module.process(journal, REQUEST)
            self.assertEqual(error.exception.code, 'recovery_required')
            self.assertIsNone(journal.claim());self.assertIsNone(journal.claim_apply_request())
            journal.db.execute("UPDATE host_preparations SET status='abandoned'")
            self.assertFalse(journal.host_update_pending())
            journal.db.execute("INSERT INTO host_switches VALUES(?, 'exchanged')", (UUID,))
            with self.assertRaises(self.module.ProtocolError):self.module.process(journal, REQUEST)
            journal.db.execute("UPDATE host_switches SET phase='completed'")
            journal.db.execute("INSERT INTO host_unit_masks VALUES(?, 'restoring')", (UUID,))
            with self.assertRaises(self.module.ProtocolError):self.module.process(journal, REQUEST)
            journal.db.execute("UPDATE host_unit_masks SET phase='restored'")
            self.assertEqual(self.module.process(journal, REQUEST)['status'], 'accepted')
        finally: journal.close()

    def test_legacy_journal_is_preserved_and_rejected(self):
        path = self.state / 'journal.sqlite'
        with sqlite3.connect(path) as db:
            db.execute('CREATE TABLE operations (id TEXT PRIMARY KEY, commit_sha TEXT NOT NULL, digest TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL)')
            db.execute('INSERT INTO operations VALUES(?,?,?,?,?)', (UUID, REQUEST['commit'], REQUEST['digest'], 'awaiting_executor', '2026-01-01'))
        os.chmod(path, 0o600)
        with self.assertRaises(RuntimeError):
            self.module.Journal(self.state)
        with sqlite3.connect(path) as db:
            self.assertEqual(db.execute('SELECT id, commit_sha, digest FROM operations').fetchall(), [(UUID, REQUEST['commit'], REQUEST['digest'])])
            self.assertNotIn('tag', [row[1] for row in db.execute('PRAGMA table_info(operations)')])

@unittest.skipUnless(sys.platform == 'linux' and os.geteuid() == 0 and hasattr(socket, 'SO_PEERCRED'), 'Requires isolated Linux as root')
class UpdaterTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='servus-updater-test-')
        self.root = pathlib.Path(self.tmp.name)
        os.chmod(self.root, 0o711)
        self.state, self.runtime = self.root / 'state', self.root / 'runtime'
        self.state.mkdir(mode=0o700)
        self.runtime.mkdir(mode=0o710)
        self.sock = self.runtime / 'updater.sock'
        self.server = None
        self.start()

    def tearDown(self):
        if self.server is not None and self.server.poll() is None:
            self.server.terminate()
            try:
                self.server.wait(timeout=4)
            except subprocess.TimeoutExpired:
                self.server.kill()
                self.server.wait()
        if self.server is not None and self.server.stderr is not None:
            self.server.stderr.close()
        self.tmp.cleanup()

    def command(self, state=None, runtime=None):
        return [sys.executable, '-I', '-B', '-c', '''import importlib.util, pathlib, subprocess, sys
spec=importlib.util.spec_from_file_location('helper',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
def launch(operation, output): return subprocess.Popen(['/bin/sleep','4'],stdout=output,stderr=subprocess.DEVNULL)
m.run(pathlib.Path(sys.argv[2]),pathlib.Path(sys.argv[3]),1000,int(sys.argv[4]),launcher=launch)''', str(HELPER), str(state or self.state), str(runtime or self.runtime), str(os.getgid())]

    def start(self):
        if self.server is not None and self.server.stderr is not None:
            self.server.stderr.close()
        self.server = subprocess.Popen(self.command(), stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            if self.server.poll() is not None:
                self.fail('Helper failed to start: ' + self.server.stderr.read())
            try:
                with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as probe:
                    probe.connect(str(self.sock))
                return
            except OSError:
                pass
            time.sleep(0.01)
        self.fail('Helper did not start listening')

    def request(self, data, as_authorized=True):
        def drop():
            if as_authorized:
                os.setgroups([])
                os.setgid(0)
                os.setuid(1000)
        raw = data if isinstance(data, str) else json.dumps(data, separators=(',', ':'))
        result = subprocess.run([sys.executable, '-c', CLIENT, str(self.sock), raw], preexec_fn=drop, capture_output=True, text=True, timeout=6, check=True)
        return json.loads(result.stdout)

    def test_auth_idempotency_concurrency_and_restart(self):
        self.assertEqual(self.request(REQUEST, as_authorized=False), {'ok': False, 'error': 'unauthorized'})
        with ThreadPoolExecutor(max_workers=8) as pool:
            replies = list(pool.map(lambda _: self.request(REQUEST), range(8)))
        self.assertTrue(all(value['ok'] for value in replies))
        self.assertEqual({value['operation']['operationId'] for value in replies}, {UUID})
        self.assertTrue({value['operation']['status'] for value in replies} <= {'accepted','verifying'})
        for field, value in [('digest', 'sha256:' + 'c' * 64), ('commit', 'c' * 40), ('tag', 'v1.2.4')]:
            self.assertEqual(self.request({**REQUEST, field: value})['error'], 'idempotency_conflict')
        self.assertEqual(self.request({**REQUEST, 'operationId': OTHER_UUID})['error'], 'operation_in_progress')
        self.server.kill()
        self.server.wait(timeout=4)
        self.start()
        status = self.request({'version': 1, 'action': 'status', 'operationId': UUID})
        self.assertTrue(status['ok'])
        self.assertEqual(status['operation']['status'], 'recovery_required')
        self.assertEqual(status['operation']['commit'], REQUEST['commit'])
        self.assertEqual(status['operation']['tag'], REQUEST['tag'])
        self.assertEqual(self.request(REQUEST), status)
        self.assertEqual(self.request({'version':1,'action':'retry','operationId':UUID})['error'], 'recovery_required')
        self.assertEqual((self.state / 'journal.sqlite').stat().st_mode & 0o777, 0o600)
        with sqlite3.connect(self.state / 'journal.sqlite') as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM operations').fetchone()[0], 1)
            self.assertEqual(db.execute('PRAGMA integrity_check').fetchone()[0], 'ok')

    def test_refuses_unknown_fields_secrets_and_malformed_input(self):
        with_secret = {**REQUEST, 'password': 'synthetic-do-not-save'}
        self.assertEqual(self.request(with_secret)['error'], 'invalid_request')
        self.assertEqual(self.request('{"version":1,"version":1}')['error'], 'invalid_request')
        self.assertEqual(self.request({key: value for key, value in REQUEST.items() if key != 'tag'})['error'], 'invalid_request')
        for tag in ['latest', 'v01.2.3', 'v1.2.3-rc.1', 'v1.2', 'v' + '9' * 65 + '.0.0', None]:
            self.assertEqual(self.request({**REQUEST, 'tag': tag})['error'], 'invalid_request')
        self.assertEqual(self.request({**REQUEST, 'commit': '../run-script'})['error'], 'invalid_request')
        self.assertEqual(self.request({**REQUEST, 'digest': 'https://example.test/'})['error'], 'invalid_request')
        self.assertEqual(self.request({'version': True, 'action': 'status', 'operationId': UUID})['error'], 'invalid_request')
        self.assertEqual(self.request({'version': 1, 'action': 'status', 'operationId': UUID})['error'], 'not_found')
        with sqlite3.connect(self.state / 'journal.sqlite') as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM operations').fetchone()[0], 0)
        self.assertNotIn(b'synthetic-do-not-save', (self.state / 'journal.sqlite').read_bytes())

    def test_backup_schema_observation_requires_authorized_peer(self):
        request={'version':1,'action':'backup_schema'}
        try:
            rejected=self.request(request,as_authorized=False)
        except subprocess.CalledProcessError:
            # The helper may close immediately after SO_PEERCRED rejection,
            # before the client manages to write the request.
            pass
        else:
            self.assertEqual(rejected,{'ok':False,'error':'unauthorized'})
        self.assertEqual(self.request(request),{'ok':True,'operation':{'backupFileDnsJournalVersion':0}})
        self.assertEqual(self.request({**request,'extra':True}),{'ok':False,'error':'invalid_request'})

    def test_slow_client_cannot_hold_server_by_sending_one_byte_at_a_time(self):
        slow_code = r'''import socket,sys,time
s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);s.connect(sys.argv[1]);s.sendall(b' ');print('ready',flush=True)
try:
 for _ in range(60): time.sleep(0.2);s.sendall(b' ')
except OSError: pass'''
        def drop():
            os.setgroups([])
            os.setgid(0)
            os.setuid(1000)
        slow = subprocess.Popen([sys.executable, '-c', slow_code, str(self.sock)], preexec_fn=drop, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            self.assertEqual(slow.stdout.readline().strip(), 'ready')
            start = time.monotonic()
            reply = self.request(REQUEST)
            elapsed = time.monotonic() - start
            self.assertTrue(reply['ok'])
            self.assertLess(elapsed, 4)
        finally:
            if slow.poll() is None:
                slow.terminate()
            slow.communicate(timeout=4)

    def test_singleton_and_untrusted_state_permissions(self):
        other = subprocess.run(self.command(), capture_output=True, text=True, timeout=5)
        self.assertNotEqual(other.returncode, 0)
        self.assertTrue(self.request(REQUEST)['ok'])
        self.server.terminate()
        self.server.wait(timeout=4)
        os.chmod(self.state, 0o777)
        denied = subprocess.run(self.command(), capture_output=True, text=True, timeout=5)
        self.assertNotEqual(denied.returncode, 0)

    def test_live_socket_and_unsafe_socket_file_are_not_removed(self):
        new_state = self.root / 'state2'
        new_state.mkdir(mode=0o700)
        other = subprocess.run(self.command(state=new_state), capture_output=True, text=True, timeout=5)
        self.assertNotEqual(other.returncode, 0)
        self.assertTrue(self.sock.exists())
        self.assertTrue(self.request(REQUEST)['ok'])
        self.server.terminate()
        self.server.wait(timeout=4)
        self.sock.write_text('not a socket')
        denied = subprocess.run(self.command(), capture_output=True, text=True, timeout=5)
        self.assertNotEqual(denied.returncode, 0)
        self.assertEqual(self.sock.read_text(), 'not a socket')


if __name__ == '__main__':
    unittest.main()
