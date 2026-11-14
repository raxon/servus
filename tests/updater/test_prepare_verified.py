import importlib.util
import json
import os
import pathlib
import sys
import tempfile
import threading
import unittest
from test_executor_journal import load, ID, OTHER, COMMIT, DIGEST, TAG, CONFIG

ROOT = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('prepare_verified', ROOT / 'apps/updater/prepare-verified.py')
preparer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preparer)


class FakeExtractor:
    class ExtractionError(Exception): pass
    def __init__(self, image_id=DIGEST):
        self.image = {'Id': image_id, 'RepoDigests': [preparer.IMAGE + '@' + DIGEST], 'Os': 'linux', 'Architecture': 'amd64'}
        self.calls = []
        self.fail = False
    def _trusted_parent(self, path): return os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    def _docker(self, *args, **kwargs):
        self.calls.append((args, kwargs))
        if args[0] == 'pull':
            if self.fail: raise self.ExtractionError('pull failed')
            return b''
        return json.dumps(self.image).encode()
    def extract(self, image_id, parent):
        self.calls.append(('extract', image_id))
        if self.fail: raise self.ExtractionError('extract failed')
        return os.path.join(parent, 'servus-install-' + 'f' * 32)


@unittest.skipUnless(os.geteuid() == 0 and sys.platform == 'linux', 'Requires isolated Linux root')
class PreparationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='servus-prepare-')
        self.mod = load()
        self.journal = self.mod.Journal(pathlib.Path(self.tmp.name))
    def tearDown(self):
        self.journal.close()
        self.tmp.cleanup()
    def verified(self):
        self.journal.submit(ID, COMMIT, DIGEST, TAG)
        attempt = self.journal.claim()
        self.journal.finish(attempt, 'verified', CONFIG)
        return attempt
    def run_prepare(self, extractor):
        return preparer.prepare_verified(self.journal, ID, self.tmp.name, extractor)
    def test_pulls_only_attested_digest_and_binds_prepared_to_attempt(self):
        for image_id in (DIGEST, CONFIG):
            with self.subTest(image_id=image_id):
                attempt = self.verified()
                extractor = FakeExtractor(image_id)
                stage = self.run_prepare(extractor)
                self.assertEqual(extractor.calls[0][0], ('pull', '--platform=linux/amd64', preparer.IMAGE + '@' + DIGEST))
                self.assertEqual(extractor.calls[-1], ('extract', image_id))
                row = self.journal.db.execute('SELECT attempt_id,attempt_nonce,status,staging_path FROM preparations WHERE operation_id=?', (ID,)).fetchone()
                self.assertEqual(row, (attempt['attemptId'], attempt['attemptNonce'], 'prepared', stage))
                with self.assertRaises(self.mod.ProtocolError): self.journal.submit(OTHER, COMMIT, DIGEST, TAG)
                self.journal.db.execute('DELETE FROM preparations')
                self.journal.db.execute('DELETE FROM operations')
    def test_unverified_operation_does_not_contact_docker(self):
        self.journal.submit(ID, COMMIT, DIGEST, TAG)
        extractor = FakeExtractor()
        with self.assertRaises(self.mod.ProtocolError): self.run_prepare(extractor)
        self.assertEqual(extractor.calls, [])
    def test_incorrect_local_identity_fails_closed(self):
        variants = [
            {'Id':'sha256:' + 'd' * 64}, {'RepoDigests':[]},
            {'RepoDigests':[preparer.IMAGE + ':v1.2.3']},
            {'Os':'windows'}, {'Architecture':'arm64'},
        ]
        for override in variants:
            with self.subTest(override=override):
                self.verified()
                extractor = FakeExtractor()
                extractor.image.update(override)
                with self.assertRaises(preparer.PreparationError): self.run_prepare(extractor)
                self.assertEqual(self.journal.db.execute('SELECT status FROM preparations').fetchone()[0], 'recovery_required')
                self.assertNotIn('extract', [call[0] for call in extractor.calls])
                with self.assertRaises(self.mod.ProtocolError): self.journal.submit(OTHER, COMMIT, DIGEST, TAG)
                self.journal.db.execute('DELETE FROM preparations')
                self.journal.db.execute('DELETE FROM operations')
    def test_pull_failure_or_restart_requires_reconciliation(self):
        self.verified()
        extractor = FakeExtractor()
        extractor.fail = True
        with self.assertRaises(FakeExtractor.ExtractionError): self.run_prepare(extractor)
        with self.assertRaises(self.mod.ProtocolError): self.run_prepare(extractor)
        self.assertEqual(self.journal.db.execute('SELECT status FROM preparations').fetchone()[0], 'recovery_required')
    def test_restart_during_preparation_remains_blocked(self):
        self.verified()
        operation = self.journal.claim_preparation(ID)
        self.journal.close()
        self.journal = self.mod.Journal(pathlib.Path(self.tmp.name))
        self.journal.recover()
        self.assertEqual(self.journal.db.execute('SELECT status FROM preparations').fetchone()[0], 'recovery_required')
        with self.assertRaises(RuntimeError): self.journal.finish_preparation(operation, os.path.join(self.tmp.name, 'servus-install-' + 'f' * 32))
        with self.assertRaises(self.mod.ProtocolError): self.journal.submit(OTHER, COMMIT, DIGEST, TAG)
    def test_wrong_attempt_or_nonce_cannot_publish(self):
        self.verified()
        operation = self.journal.claim_preparation(ID)
        stage = os.path.join(self.tmp.name, 'servus-install-' + 'f' * 32)
        for key in ('attemptId', 'attemptNonce', 'configDigest', 'preparationId'):
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                self.journal.finish_preparation({**operation, key:'wrong'}, stage)
        self.assertEqual(self.journal.db.execute('SELECT status FROM preparations').fetchone()[0], 'preparing')

    def test_simultaneous_preparation_and_submission_are_serialized(self):
        self.verified()
        start = threading.Barrier(2)
        outcomes = []
        def work(kind):
            journal = self.mod.Journal(pathlib.Path(self.tmp.name))
            try:
                start.wait(timeout=5)
                if kind == 'prepare':
                    journal.claim_preparation(ID)
                else:
                    journal.submit(OTHER, COMMIT, DIGEST, TAG)
                outcomes.append((kind, 'success'))
            except self.mod.ProtocolError:
                outcomes.append((kind, 'blocked'))
            finally:
                journal.close()
        threads = [threading.Thread(target=work, args=(kind,)) for kind in ('prepare', 'submit')]
        for thread in threads: thread.start()
        for thread in threads: thread.join(10)
        self.assertTrue(all(not thread.is_alive() for thread in threads))
        self.assertEqual(sorted(result for _, result in outcomes), ['blocked', 'success'])


if __name__ == '__main__':
    unittest.main()
