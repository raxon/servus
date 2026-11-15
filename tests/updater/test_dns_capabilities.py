import hashlib
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('dns_capabilities_updater',ROOT/'apps/updater/servus-updater.py')
updater=importlib.util.module_from_spec(spec)
spec.loader.exec_module(updater)


class DnsCapabilitiesTest(unittest.TestCase):
    def test_pinned_backup_is_the_reviewed_source(self):
        self.assertEqual(hashlib.sha256((ROOT/'apps/updater/backup.py').read_bytes()).hexdigest(),updater.DNS_JOURNAL_BACKUP_SHA256)

    def test_protocol_is_exact_and_never_claims_support_when_apply_is_unavailable(self):
        with mock.patch.object(updater,'dns_journal_backup_supported',return_value=True) as supported:
            self.assertEqual(updater.process(None,{'version':1,'action':'backup_schema'}),{'backupFileDnsJournalVersion':0})
            supported.assert_not_called()
            self.assertEqual(updater.process(None,{'version':1,'action':'backup_schema'},allow_apply=True),{'backupFileDnsJournalVersion':1})
            with self.assertRaises(updater.ProtocolError):
                updater.process(None,{'version':1,'action':'backup_schema','extra':True},allow_apply=True)
        with mock.patch.object(updater,'dns_journal_backup_supported',return_value=False):
            self.assertEqual(updater.process(None,{'version':1,'action':'backup_schema'},allow_apply=True),{'backupFileDnsJournalVersion':0})

    @unittest.skipUnless(os.geteuid()==0 and os.path.isdir('/root'),'Requires root-owned trusted directory')
    def test_installed_backup_must_match_and_not_be_writable_or_a_symlink(self):
        with tempfile.TemporaryDirectory(prefix='servus-dns-cap-',dir='/root') as directory:
            path=Path(directory)/'backup.py'
            path.write_bytes((ROOT/'apps/updater/backup.py').read_bytes())
            path.chmod(0o644)
            with mock.patch.object(updater,'DNS_JOURNAL_BACKUP',path):
                self.assertTrue(updater.dns_journal_backup_supported())
                path.chmod(0o666)
                self.assertFalse(updater.dns_journal_backup_supported())
                path.chmod(0o644)
                path.write_bytes(b'not the reviewed reader')
                self.assertFalse(updater.dns_journal_backup_supported())
                path.unlink()
                path.symlink_to(ROOT/'apps/updater/backup.py')
                self.assertFalse(updater.dns_journal_backup_supported())


if __name__=='__main__': unittest.main()
