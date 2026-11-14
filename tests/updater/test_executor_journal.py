import importlib.util
import json
import os
import pathlib
import signal
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[2]
HELPER = ROOT / 'apps/updater/servus-updater.py'
ID = '12345678-1234-4123-8123-123456789abc'
OTHER = '12345678-1234-4123-8123-123456789abd'
COMMIT = 'a' * 40
DIGEST = 'sha256:' + 'b' * 64
TAG = 'v1.2.3'
CONFIG = 'sha256:' + 'c' * 64


def load():
    spec = importlib.util.spec_from_file_location('servus_executor_journal', HELPER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def finish(worker):
    for _ in range(300):
        worker.tick()
        if worker.process is None:
            return
        time.sleep(.01)
    raise AssertionError('Verification child did not exit')


@unittest.skipUnless(os.geteuid() == 0, 'Requires isolated root-owned journal')
class ExecutorJournalTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='servus-journal-')
        self.state = pathlib.Path(self.tmp.name)
        self.mod = load()
        self.journal = self.mod.Journal(self.state)

    def tearDown(self):
        self.journal.close()
        self.tmp.cleanup()

    def submit(self, identity=ID):
        return self.journal.submit(identity, COMMIT, DIGEST, TAG)

    def launcher(self, result, exit_code=0):
        def launch(operation, output):
            code = 'import sys; sys.stdout.write(' + repr(result) + ');sys.exit(' + str(exit_code) + ')'
            return subprocess.Popen([sys.executable, '-I', '-c', code], stdout=output, stderr=subprocess.DEVNULL)
        return launch

    def test_executor_receives_durable_operation_identity(self):
        self.submit()
        operation = self.journal.claim()
        with mock.patch.object(self.mod, 'trusted_root_file'), mock.patch.object(self.mod.subprocess, 'Popen') as spawn:
            self.mod.VerificationWorker.start_executor(operation, subprocess.PIPE)
            args = spawn.call_args.args[0]
            self.assertEqual(args[-6:], ['--operation-id', ID, '--attempt-id', operation['attemptId'], '--nonce', operation['attemptNonce']])
            self.assertEqual(spawn.call_args.kwargs['env'], self.mod.CLEAN_ENV)

    def test_rejection_before_fence_creation_is_a_failed_attempt(self):
        self.submit()
        def reject(_): raise self.mod.FencePreparationRejected('not created')
        def forbidden(_): raise AssertionError('No fence to revoke')
        worker = self.mod.VerificationWorker(self.journal, self.launcher(''), reject, forbidden)
        worker.tick()
        self.assertEqual(self.journal.status(ID)['status'], 'verification_failed')
        self.assertEqual(self.submit(OTHER)['status'], 'accepted')

    def test_attempt_identity_and_nonce_are_durable_but_not_exposed(self):
        self.submit()
        operation = self.journal.claim()
        self.assertRegex(operation['attemptId'], self.mod.UUID_PATTERN)
        self.assertRegex(operation['attemptNonce'], r'^[0-9a-f]{64}$')
        self.assertNotIn('attemptId', self.journal.status(ID))
        self.assertNotIn('attemptNonce', self.journal.status(ID))
        self.journal.close()
        self.journal = self.mod.Journal(self.state)
        row = self.journal.db.execute('SELECT attempt_id,attempt_nonce FROM operations WHERE id=?', (ID,)).fetchone()
        self.assertEqual(row, (operation['attemptId'], operation['attemptNonce']))
        self.journal.recover()
        with self.assertRaises(self.mod.ProtocolError): self.journal.retry(ID)

    def test_success_exact_match_idempotency_and_next_request(self):
        self.assertEqual(self.submit()['status'], 'accepted')
        with self.assertRaises(self.mod.ProtocolError): self.submit(OTHER)
        result = json.dumps({'image':'ghcr.io/raxon/servus','commit':COMMIT,'digest':DIGEST,'tag':TAG,'verified':True,'configDigest':CONFIG})
        worker = self.mod.VerificationWorker(self.journal, self.launcher(result), lambda _: None, lambda _: None)
        worker.tick()
        attempt = worker.operation.copy()
        self.assertEqual(self.journal.status(ID)['status'], 'verifying')
        finish(worker)
        self.assertEqual(self.journal.status(ID)['status'], 'verified')
        self.assertEqual(self.journal.verified_config_digest(ID), CONFIG)
        self.assertNotIn('configDigest', self.journal.status(ID))
        self.assertEqual(self.journal.db.execute('SELECT attempt_id,attempt_nonce,config_digest FROM operations WHERE id=?', (ID,)).fetchone(),
                         (attempt['attemptId'], attempt['attemptNonce'], CONFIG))
        self.journal.close()
        self.journal = self.mod.Journal(self.state)
        self.assertEqual(self.journal.verified_config_digest(ID), CONFIG)
        self.assertEqual(self.submit()['status'], 'verified')
        self.assertEqual(self.submit(OTHER)['status'], 'accepted')
        self.assertEqual(self.journal.db.execute('SELECT count(*) FROM operations').fetchone()[0], 2)

    def test_valid_output_with_revoke_failure_stays_recovery_required(self):
        self.submit()
        result=json.dumps({'image':'ghcr.io/raxon/servus','commit':COMMIT,'digest':DIGEST,'tag':TAG,'verified':True,'configDigest':CONFIG})
        def deny(_): raise RuntimeError('fence is held')
        worker=self.mod.VerificationWorker(self.journal,self.launcher(result),lambda _: None,deny)
        worker.tick(); finish(worker)
        self.assertEqual(self.journal.status(ID)['status'],'recovery_required')
        self.assertIsNone(self.journal.db.execute('SELECT config_digest FROM operations WHERE id=?', (ID,)).fetchone()[0])
        with self.assertRaises(self.mod.ProtocolError): self.journal.retry(ID)

    def test_recovery_keeps_durable_attempt_metadata(self):
        self.submit()
        claimed=self.journal.claim()
        self.journal.recover()
        self.assertEqual(self.journal.pending_recoveries(), [{'operationId':ID,'attemptId':claimed['attemptId'],'attemptNonce':claimed['attemptNonce']}])
        with self.assertRaises(self.mod.ProtocolError): self.journal.retry(ID)

    def test_mismatch_duplicate_json_and_failure_are_not_verified(self):
        good = {'image':'ghcr.io/raxon/servus','commit':COMMIT,'digest':DIGEST,'tag':TAG,'verified':True,'configDigest':CONFIG}
        bad_values = [json.dumps({**good,'commit':'c'*40}), json.dumps({key:value for key,value in good.items() if key != 'configDigest'}),
                      json.dumps({**good, 'configDigest':'sha256:'+'A'*64}), json.dumps({**good, 'configDigest':None}),
                      json.dumps({**good, 'extra':True}),
                      '{"verified":true,"verified":true}', 'x'*16385]
        for bad in bad_values:
            with tempfile.TemporaryDirectory(prefix='servus-journal-case-') as tmp:
                journal = self.mod.Journal(pathlib.Path(tmp))
                try:
                    journal.submit(ID, COMMIT, DIGEST, TAG)
                    worker = self.mod.VerificationWorker(journal, self.launcher(bad), lambda _: None, lambda _: None)
                    worker.tick(); finish(worker)
                    self.assertEqual(journal.status(ID)['status'], 'recovery_required')
                finally:
                    journal.close()

    def test_stale_attempt_cannot_commit_result(self):
        self.submit()
        operation = self.journal.claim()
        for changed in ({**operation, 'attemptId': OTHER}, {**operation, 'attemptNonce': 'f'*64}):
            with self.assertRaises(RuntimeError):
                self.journal.finish(changed, 'verified', CONFIG)
        self.assertEqual(self.journal.status(ID)['status'], 'verifying')
        self.assertIsNone(self.journal.db.execute('SELECT config_digest FROM operations WHERE id=?', (ID,)).fetchone()[0])
        self.journal.finish(operation, 'verified', CONFIG)
        with self.assertRaises(RuntimeError): self.journal.finish(operation, 'verified', CONFIG)

    def test_legacy_verified_records_are_reverified(self):
        for version in (2, 3):
            with self.subTest(version=version), tempfile.TemporaryDirectory(prefix='servus-legacy-journal-') as tmp:
                path = pathlib.Path(tmp) / 'journal.sqlite'
                with sqlite3.connect(path) as db:
                    attempts = ', attempt_id TEXT, attempt_nonce TEXT' if version == 3 else ''
                    db.execute("CREATE TABLE operations (id TEXT PRIMARY KEY, commit_sha TEXT NOT NULL, digest TEXT NOT NULL, tag TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL" + attempts + ")")
                    db.execute("INSERT INTO operations(id,commit_sha,digest,tag,status,created_at) VALUES(?,?,?,?,?,?)", (ID,COMMIT,DIGEST,TAG,'verified','2026-01-01'))
                    db.execute('PRAGMA user_version=' + str(version))
                os.chmod(path, 0o600)
                journal = self.mod.Journal(pathlib.Path(tmp))
                try:
                    self.assertEqual(journal.status(ID)['status'], 'verification_failed')
                    self.assertEqual(journal.db.execute('PRAGMA user_version').fetchone()[0], 8)
                    with self.assertRaises(self.mod.ProtocolError): journal.verified_config_digest(ID)
                    self.assertEqual(journal.retry(ID)['status'], 'accepted')
                finally: journal.close()

    def test_v5_preparations_migrate_transactionally_and_remain_blocking(self):
        with tempfile.TemporaryDirectory(prefix='servus-v5-journal-') as tmp:
            path = pathlib.Path(tmp) / 'journal.sqlite'
            with sqlite3.connect(path) as db:
                db.execute("CREATE TABLE operations (id TEXT PRIMARY KEY, commit_sha TEXT NOT NULL, digest TEXT NOT NULL, tag TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, attempt_id TEXT, attempt_nonce TEXT, config_digest TEXT)")
                db.execute("CREATE TABLE preparations (operation_id TEXT PRIMARY KEY REFERENCES operations(id), attempt_id TEXT NOT NULL, attempt_nonce TEXT NOT NULL, preparation_id TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('preparing','prepared','recovery_required')), staging_path TEXT)")
                db.execute("INSERT INTO operations VALUES (?,?,?,?,?,?,?,?,?)", (ID,COMMIT,DIGEST,TAG,'verified','2026-01-01',OTHER,'f'*64,CONFIG))
                db.execute("INSERT INTO preparations VALUES (?,?,?,?,?,?)", (ID,OTHER,'f'*64,OTHER,'prepared','/srv/stage'))
                db.execute('PRAGMA user_version=5')
            os.chmod(path, 0o600)
            journal = self.mod.Journal(pathlib.Path(tmp))
            try:
                self.assertEqual(journal.db.execute('PRAGMA user_version').fetchone()[0], 8)
                self.assertEqual(journal.db.execute('SELECT status,staging_path FROM preparations').fetchone(), ('prepared','/srv/stage'))
                with self.assertRaises(self.mod.ProtocolError): journal.submit(OTHER, COMMIT, DIGEST, TAG)
                journal.db.execute("UPDATE preparations SET status='completed' WHERE operation_id=?", (ID,))
                self.assertEqual(journal.submit(OTHER, COMMIT, DIGEST, TAG)['status'], 'accepted')
            finally:
                journal.close()

    def test_interrupted_verification_requires_explicit_retry_and_blocks_other(self):
        self.submit()
        self.journal.claim()
        self.journal.close()
        self.journal = self.mod.Journal(self.state)
        self.journal.recover()
        self.assertEqual(self.journal.status(ID)['status'], 'recovery_required')
        with self.assertRaises(self.mod.ProtocolError): self.submit(OTHER)
        with self.assertRaises(self.mod.ProtocolError) as error: self.journal.retry(ID)
        self.assertEqual(error.exception.code, 'recovery_required')
        self.assertEqual(self.submit()['status'], 'recovery_required')
        with self.assertRaises(self.mod.ProtocolError): self.journal.submit(ID,'c'*40,DIGEST,TAG)

    def test_kill_after_claim_before_launch_survives_restart(self):
        self.submit()
        code = '''import importlib.util,pathlib,sys,os,signal
spec=importlib.util.spec_from_file_location('m',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
j=m.Journal(pathlib.Path(sys.argv[2]));j.claim();os.kill(os.getpid(),signal.SIGKILL)'''
        process = subprocess.run([sys.executable, '-I', '-c', code, str(HELPER), str(self.state)], timeout=5)
        self.assertEqual(process.returncode, -signal.SIGKILL)
        self.journal.close()
        self.journal = self.mod.Journal(self.state)
        self.journal.recover()
        self.assertEqual(self.journal.status(ID)['status'], 'recovery_required')
        self.assertEqual(self.journal.db.execute('PRAGMA integrity_check').fetchone()[0], 'ok')

    def test_live_executor_after_sigkill_prevents_retry(self):
        self.submit()
        marker = self.state / 'child.pid'
        code = r"""import importlib.util,pathlib,sys,subprocess,time
spec=importlib.util.spec_from_file_location('m',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
j=m.Journal(pathlib.Path(sys.argv[2]))
def launch(op, output):
 p=subprocess.Popen(['/bin/sleep','30'],stdout=output,stderr=subprocess.DEVNULL)
 pathlib.Path(sys.argv[3]).write_text(str(p.pid));return p
w=m.VerificationWorker(j,launch,lambda _: None,lambda _: None);w.tick();print('started',flush=True);time.sleep(30)
"""
        parent = subprocess.Popen([sys.executable, '-I', '-c', code, str(HELPER), str(self.state), str(marker)], stdout=subprocess.PIPE, text=True)
        child_pid = None
        try:
            self.assertEqual(parent.stdout.readline().strip(), 'started')
            child_pid = int(marker.read_text())
            os.kill(child_pid, 0)
            parent.kill(); parent.wait(timeout=3)
            self.assertEqual(parent.returncode, -signal.SIGKILL)
            os.kill(child_pid, 0)
            self.journal.close()
            self.journal = self.mod.Journal(self.state)
            self.journal.recover()
            self.assertEqual(self.journal.status(ID)['status'], 'recovery_required')
            with self.assertRaises(self.mod.ProtocolError) as error: self.journal.retry(ID)
            self.assertEqual(error.exception.code, 'recovery_required')
            with self.assertRaises(self.mod.ProtocolError): self.submit(OTHER)
            os.kill(child_pid, 0)
        finally:
            if parent.poll() is None:
                parent.kill(); parent.wait(timeout=3)
            parent.stdout.close()
            if child_pid:
                try: os.kill(child_pid, signal.SIGKILL)
                except ProcessLookupError: pass

    def test_executor_flood_is_bounded_without_files(self):
        self.submit()
        def launch(operation, output):
            return subprocess.Popen([sys.executable, '-I', '-c', "import os; b=b'x'*65536\nwhile True: os.write(1,b)"], stdout=output, stderr=subprocess.DEVNULL)
        worker = self.mod.VerificationWorker(self.journal, launch, lambda _: None, lambda _: None)
        worker.tick()
        for _ in range(300):
            worker.tick()
            self.assertLessEqual(len(worker.output), self.mod.EXECUTOR_OUTPUT_LIMIT + 1)
            if worker.process is None: break
            time.sleep(.01)
        self.assertIsNone(worker.process)
        self.assertEqual(self.journal.status(ID)['status'], 'recovery_required')
        self.assertEqual(sorted(p.name for p in self.state.iterdir()), ['journal.sqlite','journal.sqlite-shm','journal.sqlite-wal'])

    def test_legacy_tagged_record_is_migrated_atomically(self):
        self.journal.close()
        for name in ('journal.sqlite','journal.sqlite-wal','journal.sqlite-shm'):
            (self.state / name).unlink(missing_ok=True)
        path = self.state / 'journal.sqlite'
        with sqlite3.connect(path) as db:
            db.execute('CREATE TABLE operations(id TEXT PRIMARY KEY, commit_sha TEXT NOT NULL, digest TEXT NOT NULL, tag TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL)')
            db.execute('INSERT INTO operations VALUES(?,?,?,?,?,?)',(ID,COMMIT,DIGEST,TAG,'awaiting_executor','2026-01-01'))
        os.chmod(path,0o600)
        self.journal = self.mod.Journal(self.state)
        self.assertEqual(self.journal.status(ID)['status'], 'accepted')


if __name__ == '__main__': unittest.main()
