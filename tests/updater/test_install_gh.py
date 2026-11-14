import hashlib
import importlib.util
import io
import os
from pathlib import Path
import stat
import sys
import tarfile
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'apps/updater'))
import supervisor


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'apps/updater' / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


installer = load('install_gh', 'install-gh.py')
policy = load('gh_runtime_policy', 'runtime-policy.py')


def archive(contents=b'fixture', *, duplicate=False, symlink=False):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode='w:gz') as tar:
        item = tarfile.TarInfo(f'gh_{installer.VERSION}_linux_amd64/bin/gh')
        if symlink:
            item.type = tarfile.SYMTYPE
            item.linkname = '/bin/sh'
            tar.addfile(item)
        else:
            item.size = len(contents)
            tar.addfile(item, io.BytesIO(contents))
            if duplicate:
                tar.addfile(item, io.BytesIO(contents))
    return output.getvalue()


def metadata(blob, binary=b'fixture'):
    return {'amd64': (hashlib.sha256(blob).hexdigest(), hashlib.sha256(binary).hexdigest(), len(binary))}


@unittest.skipUnless(sys.platform == 'linux' and os.geteuid() == 0 and sys.flags.isolated, 'Requires isolated Linux root')
class InstallGHTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir='/root')
        self.root = Path(self.temp.name)
        self.install = self.root / 'install'
        self.host = self.root / 'host'
        self.install.mkdir(mode=0o700)
        self.host.mkdir(mode=0o755)
        (self.install / 'install.lock').touch(mode=0o600)
        self.blob = archive()
        self.fetch = mock.Mock(return_value=self.blob)

    def tearDown(self):
        self.temp.cleanup()

    def run_install(self, **kwargs):
        installer.install(str(self.install), str(self.host), supervisor, policy,
                          arch='amd64', pinned=metadata(self.blob), fetch=self.fetch, **kwargs)

    def test_installs_and_repeat_preserves_inode_without_network(self):
        self.run_install()
        binary = self.host / 'bin/gh'
        self.assertEqual(binary.read_bytes(), b'fixture')
        self.assertEqual(stat.S_IMODE(binary.stat().st_mode), 0o755)
        inode = binary.stat().st_ino
        self.run_install()
        self.assertEqual(binary.stat().st_ino, inode)
        self.fetch.assert_called_once_with('amd64')

    def test_rejects_checksum_and_archive_member_attacks(self):
        for value in (b'wrong archive', archive(duplicate=True), archive(symlink=True), archive(b'changed')):
            with self.subTest(value=value[:20]):
                # Keep the archive digest valid to exercise member and binary validation.
                pins = metadata(value)
                if value == b'wrong archive':
                    pins = metadata(self.blob)
                with self.assertRaises((installer.InstallError, tarfile.TarError)):
                    installer.install(str(self.install), str(self.host), supervisor, policy,
                                      arch='amd64', pinned=pins, fetch=lambda _: value)
                self.assertFalse((self.host / 'bin/gh').exists())

    def test_rejects_changed_existing_binary_without_replacement(self):
        self.run_install()
        binary = self.host / 'bin/gh'
        binary.write_bytes(b'changed')
        inode = binary.stat().st_ino
        with self.assertRaises(installer.InstallError):
            self.run_install()
        self.assertEqual((binary.stat().st_ino, binary.read_bytes()), (inode, b'changed'))
        self.fetch.assert_called_once()

    def test_rejects_symlink_directory_and_invalid_inherited_lock(self):
        target = self.root / 'target'
        target.mkdir(mode=0o700)
        (self.host / 'bin').symlink_to(target)
        with self.assertRaises(OSError):
            self.run_install()
        self.assertEqual(list(target.iterdir()), [])
        (self.host / 'bin').unlink()
        other = self.root / 'other.lock'
        other.touch(mode=0o600)
        fd = os.open(other, os.O_RDONLY)
        try:
            with self.assertRaises(Exception):
                self.run_install(inherited_lock=fd)
        finally:
            os.close(fd)
        self.fetch.assert_not_called()


if __name__ == '__main__':
    unittest.main()
