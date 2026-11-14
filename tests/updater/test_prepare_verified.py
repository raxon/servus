import importlib.util
import json
import os
import pathlib
import sqlite3
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
    def extract(self, image_id, parent, **kwargs):
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
    def run_prepare(self, extractor, **kwargs):
        return preparer.prepare_verified(self.journal, ID, self.tmp.name, extractor, **kwargs)
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
    def test_index_uses_attested_root_id_when_platform_inspection_returns_child(self):
        self.verified()
        extractor = FakeExtractor(DIGEST)
        original = extractor._docker
        def inspect(*args, **kwargs):
            if args[:2] == ('image', 'inspect') and '--platform=linux/amd64' in args:
                result = json.loads(original(*args, **kwargs))
                result['Id'] = 'sha256:' + 'e' * 64
                return json.dumps(result).encode()
            return original(*args, **kwargs)
        extractor._docker = inspect
        resolved = []
        def resolve(root, config):
            resolved.append((root, config))
            return 'sha256:' + 'e' * 64
        self.run_prepare(extractor, resolve_child=resolve)
        self.assertEqual(resolved, [(DIGEST, CONFIG)])
        self.assertEqual(extractor.calls[-1], ('extract', DIGEST))
    def test_index_rejects_unverified_child(self):
        self.verified()
        extractor = FakeExtractor(DIGEST)
        original = extractor._docker
        def inspect(*args, **kwargs):
            if args[:2] == ('image', 'inspect') and '--platform=linux/amd64' in args:
                value = json.loads(original(*args, **kwargs)); value['Id'] = 'sha256:' + 'd' * 64
                return json.dumps(value).encode()
            return original(*args, **kwargs)
        extractor._docker = inspect
        with self.assertRaises(preparer.PreparationError):
            self.run_prepare(extractor, resolve_child=lambda root, config: 'sha256:' + 'c' * 64)
        self.assertEqual(self.journal.db.execute('SELECT status FROM preparations').fetchone()[0], 'recovery_required')
    def test_index_without_resolver_and_nonobject_platform_fail_closed(self):
        for bad in ('missing_resolver', 'nonobject'):
            with self.subTest(bad=bad):
                self.verified()
                extractor = FakeExtractor(DIGEST)
                original = extractor._docker
                def inspect(*args, **kwargs):
                    if args[:2] == ('image', 'inspect') and '--platform=linux/amd64' in args:
                        if bad == 'nonobject': return b'[]'
                        value = json.loads(original(*args, **kwargs)); value['Id'] = 'sha256:' + 'e' * 64
                        return json.dumps(value).encode()
                    return original(*args, **kwargs)
                extractor._docker = inspect
                with self.assertRaises(preparer.PreparationError): self.run_prepare(extractor)
                self.assertEqual(self.journal.db.execute('SELECT status FROM preparations').fetchone()[0], 'recovery_required')
                self.journal.db.execute('DELETE FROM preparations')
                self.journal.db.execute('DELETE FROM operations')
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
    def test_extraction_probe_intent_is_recorded_before_create_and_removed_after(self):
        self.verified()
        extractor = FakeExtractor()
        original = extractor.extract
        def inspect(image_id, parent, **kwargs):
            row = self.journal.db.execute('SELECT name,purpose,status FROM extraction_probes').fetchone()
            self.assertEqual(row, (kwargs['probe_name'], 'prepare', 'intent'))
            return original(image_id, parent, **kwargs)
        extractor.extract = inspect
        self.run_prepare(extractor)
        self.assertEqual(self.journal.db.execute('SELECT status FROM extraction_probes').fetchone()[0], 'removed')

    def test_interrupted_extraction_keeps_identity_and_blocks_retry(self):
        self.verified()
        extractor = FakeExtractor()
        def interrupted(image_id, parent, **kwargs):
            self.assertEqual(self.journal.db.execute('SELECT name FROM extraction_probes').fetchone()[0], kwargs['probe_name'])
            raise extractor.ExtractionError('interrupted')
        extractor.extract = interrupted
        with self.assertRaises(extractor.ExtractionError): self.run_prepare(extractor)
        self.assertEqual(self.journal.db.execute('SELECT status FROM extraction_probes').fetchone()[0], 'intent')
        self.assertEqual(self.journal.db.execute('SELECT status FROM preparations').fetchone()[0], 'recovery_required')
        with self.assertRaises(self.mod.ProtocolError): self.run_prepare(extractor)
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

    def test_orphaned_extraction_prevents_prepared_status(self):
        self.verified()
        operation = self.journal.claim_preparation(ID)
        probe = self.journal.record_extraction_probe(operation, 'prepare')
        stage = os.path.join(self.tmp.name, 'servus-install-' + 'f' * 32)
        with self.assertRaises(RuntimeError): self.journal.finish_preparation(operation, stage)
        self.assertEqual(self.journal.db.execute('SELECT status FROM preparations').fetchone()[0], 'preparing')
        self.journal.complete_extraction_probe(operation, probe)
        self.journal.finish_preparation(operation, stage)
        self.assertEqual(self.journal.db.execute('SELECT status FROM preparations').fetchone()[0], 'prepared')

    def test_prepared_requires_completed_prepare_probe_for_same_attempt(self):
        self.verified()
        operation = self.journal.claim_preparation(ID)
        stage = os.path.join(self.tmp.name, 'servus-install-' + 'f' * 32)
        with self.assertRaises(RuntimeError): self.journal.finish_preparation(operation, stage)
        other = self.journal.record_extraction_probe(operation, 'policy')
        self.journal.complete_extraction_probe(operation, other)
        with self.assertRaises(RuntimeError): self.journal.finish_preparation(operation, stage)
        probe = self.journal.record_extraction_probe(operation, 'prepare')
        self.journal.complete_extraction_probe(operation, probe)
        self.journal.finish_preparation(operation, stage)
        self.assertEqual(self.journal.db.execute('SELECT status FROM preparations').fetchone()[0], 'prepared')

    def test_concurrent_extraction_intents_allow_only_one(self):
        self.verified()
        operation = self.journal.claim_preparation(ID)
        barrier = threading.Barrier(2)
        outcomes = []
        def run():
            journal = self.mod.Journal(pathlib.Path(self.tmp.name))
            try:
                barrier.wait(timeout=5)
                journal.record_extraction_probe(operation, 'prepare')
                outcomes.append('success')
            except sqlite3.IntegrityError:
                outcomes.append('blocked')
            finally:
                journal.close()
        workers = [threading.Thread(target=run) for _ in range(2)]
        for worker in workers: worker.start()
        for worker in workers: worker.join(10)
        self.assertTrue(all(not worker.is_alive() for worker in workers))
        self.assertEqual(sorted(outcomes), ['blocked', 'success'])
        self.assertEqual(self.journal.db.execute("SELECT COUNT(*) FROM extraction_probes WHERE status='intent'").fetchone()[0], 1)

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
