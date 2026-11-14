import grp
import importlib.util
import os
from pathlib import Path
import socket
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
HELPER = ROOT / 'apps/updater/servus-updater.py'
FENCE = ROOT / 'apps/updater/verification-fence.py'
spec = importlib.util.spec_from_file_location('servus_nss', HELPER)
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


class NSSConfigTest(unittest.TestCase):
    def test_only_enumerable_files_and_dynamic_systemd_sources_are_supported(self):
        self.assertFalse(helper.nss_sources('passwd: files\ngroup: files\n'))
        self.assertTrue(helper.nss_sources('passwd: files systemd\ngroup: files systemd\n'))
        for text in ('passwd: files sss\ngroup: files systemd\n',
                     'passwd: files systemd\ngroup: files systemd\ninitgroups: sss\n',
                     'passwd: files [NOTFOUND=return] systemd\ngroup: files\n',
                     'passwd: files\npasswd: files systemd\ngroup: files\n',
                     'passwd: files\n'):
            with self.subTest(text=text), self.assertRaises(RuntimeError): helper.nss_sources(text)

    def test_duplicate_gid_or_primary_gid_are_refused(self):
        groups='servus-verifier:x:55533:\n'
        helper.validate_local_group(55533, 'root:x:0:0:root:/root:/bin/sh\n', groups)
        for passwd, group in [('root:x:0:0:root:/root:/bin/sh\n', groups+'foreign:x:55533:user\n'),
                              ('user:x:1000:55533::/home/user:/bin/sh\n', groups),
                              ('root:x:0:0:root:/root:/bin/sh\n', groups+'servus-verifier:x:8:\n')]:
            with self.subTest(group=group), self.assertRaises(RuntimeError): helper.validate_local_group(55533,passwd,group)


@unittest.skipUnless(sys.platform == 'linux' and os.geteuid() == 0 and Path('/.dockerenv').exists(), 'Requires disposable Linux root container')
class NSSIsolationTest(unittest.TestCase):
    def test_real_aliased_gid_with_foreign_member_is_refused(self):
        group_path = Path('/etc/group')
        original = group_path.read_text()
        with tempfile.TemporaryDirectory(prefix='servus-nss-', dir='/run') as tmp:
            root = Path(tmp); root.chmod(0o755)
            try:
                with group_path.open('a') as stream:
                    stream.write('\nservus-verifier:x:55533:\nforeign-fixture:x:55533:foreign\n')
                target = grp.getgrnam('servus-verifier')
                aliases = [item for item in grp.getgrall() if item.gr_gid == target.gr_gid]
                self.assertEqual(len(aliases),2)
                with mock.patch.object(helper,'assert_host_systemd'), mock.patch.object(helper,'FENCE_MODULE',FENCE), mock.patch.object(helper,'FENCE_ROOT',root), \
                     mock.patch.object(helper,'assert_supported_nss',return_value=(Path('/etc/passwd').read_text(),group_path.read_text())):
                    with self.assertRaises(RuntimeError): helper.fence_context()
            finally:
                group_path.write_text(original)

    def test_systemd_userdb_must_have_only_expected_socket_and_empty_dropins(self):
        with tempfile.TemporaryDirectory(prefix='servus-userdb-', dir='/run') as tmp:
            root=Path(tmp);root.chmod(0o755)
            db=root/'systemd';db.mkdir(mode=0o755)
            drop=root/'drop';drop.mkdir(mode=0o755)
            sock=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
            sock.bind(str(db/'io.systemd.DynamicUser'))
            try:
                with mock.patch.object(helper,'SYSTEMD_USERDB',db), mock.patch.object(helper,'USERDB_DIRS',(drop,)):
                    helper.assert_systemd_userdb_is_dynamic_only()
                    (drop/'foreign.group').write_text('{}')
                    with self.assertRaises(RuntimeError): helper.assert_systemd_userdb_is_dynamic_only()
                    (drop/'foreign.group').unlink()
                    (db/'io.foreign').touch()
                    with self.assertRaises(RuntimeError): helper.assert_systemd_userdb_is_dynamic_only()
            finally: sock.close()


if __name__ == '__main__': unittest.main()
