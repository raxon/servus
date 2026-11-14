import importlib.util
import os
from pathlib import Path
import stat
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('provision_socket', ROOT / 'apps/updater/provision-socket.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


@unittest.skipUnless(sys.platform == 'linux' and os.geteuid() == 0, 'Requires isolated Linux root')
class SocketProvisioningTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir='/root')
        self.root = Path(self.temp.name)

    def tearDown(self): self.temp.cleanup()

    def test_create_and_repeat_keep_the_same_directory_inodes(self):
        module.prepare(str(self.root), 1000)
        parent, control, fences = self.root / 'servus-updater', self.root / 'servus-updater/control', self.root / 'servus-updater/fences'
        before = (parent.stat().st_ino, control.stat().st_ino, fences.stat().st_ino)
        self.assertEqual((parent.stat().st_uid, parent.stat().st_gid, stat.S_IMODE(parent.stat().st_mode)), (0, 0, 0o755))
        self.assertEqual((control.stat().st_uid, control.stat().st_gid, stat.S_IMODE(control.stat().st_mode)), (0, 1000, 0o710))
        self.assertEqual((fences.stat().st_uid, fences.stat().st_gid, stat.S_IMODE(fences.stat().st_mode)), (0, 0, 0o755))
        module.prepare(str(self.root), 1000)
        self.assertEqual((parent.stat().st_ino, control.stat().st_ino, fences.stat().st_ino), before)

    def test_unsafe_fence_directory_is_rejected_without_replacement(self):
        module.prepare(str(self.root),1000)
        fences=self.root/'servus-updater/fences';inode=fences.stat().st_ino
        fences.chmod(0o777)
        with self.assertRaises(module.ProvisionError):module.prepare(str(self.root),1000)
        self.assertEqual((fences.stat().st_ino,stat.S_IMODE(fences.stat().st_mode)),(inode,0o777))
        fences.rmdir();target=self.root/'target';target.mkdir(mode=0o700);fences.symlink_to(target)
        with self.assertRaises(OSError):module.prepare(str(self.root),1000)
        self.assertEqual(list(target.iterdir()),[])

    def test_unsafe_existing_directory_is_not_changed(self):
        module.prepare(str(self.root), 1000)
        path = self.root / 'servus-updater/control'; path.chmod(0o777)
        inode = path.stat().st_ino
        with self.assertRaises(module.ProvisionError): module.prepare(str(self.root), 1000)
        self.assertEqual((path.stat().st_ino, stat.S_IMODE(path.stat().st_mode)), (inode, 0o777))
        path.chmod(0o710)
        with self.assertRaises(module.ProvisionError): module.prepare(str(self.root), 1001)
        self.assertEqual(path.stat().st_gid, 1000)

    def test_symlink_and_unsafe_ancestor_are_rejected(self):
        target = self.root / 'target'; target.mkdir(mode=0o700)
        (self.root / 'servus-updater').symlink_to(target)
        with self.assertRaises(OSError): module.prepare(str(self.root), 1000)
        self.assertEqual(list(target.iterdir()), [])
        (self.root / 'servus-updater').unlink()
        self.root.chmod(0o777)
        with self.assertRaises(module.ProvisionError): module.prepare(str(self.root), 1000)
        self.root.chmod(0o700)

    def test_bad_group_or_path_is_rejected(self):
        for group in (0, -1, 0xffffffff, True, '1000'):
            with self.subTest(group=group), self.assertRaises(module.ProvisionError): module.prepare(str(self.root), group)
        for path in ('relative', '/run/../etc'):
            with self.subTest(path=path), self.assertRaises(module.ProvisionError): module.prepare(path, 1000)


if __name__ == '__main__': unittest.main()
