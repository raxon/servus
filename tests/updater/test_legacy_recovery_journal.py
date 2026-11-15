import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
import uuid

ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('legacy_recovery_journal',ROOT/'apps/updater/servus-updater.py')
updater=importlib.util.module_from_spec(spec);spec.loader.exec_module(updater)


class LegacyRecoveryJournalTest(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='servus-recovery-journal-');self.path=Path(self.temp.name)
        self.update=updater.Journal(self.path);self.journal=updater.LegacyRecoveryJournal(self.path)
        self.op=str(uuid.uuid4());self.restore='a'*32;self.service=str(uuid.uuid4())
    def tearDown(self):self.journal.close();self.update.close();self.temp.cleanup()
    def submit(self):return self.journal.submit(self.op,self.restore,self.service,self.update)

    def test_request_is_durable_idempotent_and_excludes_other_requests(self):
        expected={'operationId':self.op,'restoreId':self.restore,'serviceId':self.service,'status':'requested'}
        self.assertEqual(self.submit(),expected);self.assertEqual(self.submit(),expected)
        with self.assertRaises(updater.ProtocolError):self.journal.submit(self.op,self.restore,str(uuid.uuid4()),self.update)
        with self.assertRaises(updater.ProtocolError):self.journal.submit(str(uuid.uuid4()),'b'*32,self.service,self.update)
        self.journal.close();self.journal=updater.LegacyRecoveryJournal(self.path)
        self.assertEqual(self.journal.status(self.op),expected)

    def test_dispatched_request_is_not_replayed_after_process_restart(self):
        self.submit();self.assertEqual(self.journal.claim(),(self.op,self.restore,self.service))
        self.journal.close();self.journal=updater.LegacyRecoveryJournal(self.path);self.journal.recover()
        self.assertEqual(self.journal.status(self.op)['status'],'recovery_required');self.assertIsNone(self.journal.claim())
        self.journal.confirm(self.op,'unknown');self.assertTrue(self.journal.active())
        self.journal.confirm(self.op,'completed');self.assertFalse(self.journal.active())

    def test_claimed_dispatch_is_completed_only_by_confirmation(self):
        self.submit();self.journal.claim();self.journal.finish_dispatch(self.op,True)
        self.assertEqual(self.journal.status(self.op)['status'],'awaiting_completion')
        self.journal.confirm(self.op,'in_progress');self.assertEqual(self.journal.status(self.op)['status'],'awaiting_completion')
        self.journal.confirm(self.op,'completed');self.assertEqual(self.journal.status(self.op)['status'],'completed')
        with self.assertRaises(updater.ProtocolError):self.journal.submit(str(uuid.uuid4()),self.restore,self.service,self.update)

    def test_existing_update_blocks_new_recovery_without_creating_a_request(self):
        self.update.submit(str(uuid.uuid4()),'b'*40,'sha256:'+'c'*64,'v1.2.3')
        with self.assertRaises(updater.ProtocolError) as error:self.submit()
        self.assertEqual(error.exception.code,'operation_in_progress');self.assertFalse(self.journal.active())


if __name__=='__main__':unittest.main()
