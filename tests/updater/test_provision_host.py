import importlib.util
import os
from pathlib import Path
import stat
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('provision_host', ROOT / 'apps/updater/provision-host.py')
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)


@unittest.skipUnless(sys.platform == 'linux' and os.geteuid() == 0, 'Requires isolated Linux root')
class HostProvisioningTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir='/root'); self.root = Path(self.temp.name)
        self.config = self.root/'config'; self.config.mkdir(mode=0o700)
        self.state = self.root/'state'

    def tearDown(self): self.temp.cleanup()

    def prepare(self): module.prepare(str(self.config),str(self.state))

    def test_creates_private_configuration_and_is_idempotent(self):
        self.prepare()
        path=self.config/'updater.env'; contents=path.read_text(); inode=path.stat().st_ino
        self.assertEqual(stat.S_IMODE(path.stat().st_mode),0o600)
        self.assertIn('SERVUS_UPDATER_SOCKET_DIR=/run/servus-updater/control\n',contents)
        self.assertIn('SERVUS_COMPONENT_UID=1000\n',contents)
        for name in ('staging','maintenance','backups','policies','docker-config'):
            value=(self.state/name).stat()
            self.assertEqual((value.st_uid,value.st_gid,stat.S_IMODE(value.st_mode)),(0,0,0o700))
        self.prepare()
        self.assertEqual(path.stat().st_ino,inode);self.assertEqual(path.read_text(),contents)

    def test_existing_configuration_is_not_overwritten(self):
        self.prepare(); path=self.config/'updater.env'; path.write_text('unrelated\n');path.chmod(0o600)
        with self.assertRaises(module.ProvisionError): self.prepare()
        self.assertEqual(path.read_text(),'unrelated\n')

    def test_existing_symlink_and_unsafe_permissions_are_rejected(self):
        self.prepare(); path=self.state/'policies';path.rmdir();path.symlink_to(self.config)
        with self.assertRaises(OSError): self.prepare()
        path.unlink();path.mkdir(mode=0o777);path.chmod(0o777)
        with self.assertRaises(module.ProvisionError): self.prepare()
        self.assertEqual(stat.S_IMODE(path.stat().st_mode),0o777)

    def test_external_docker_configuration_is_never_adopted(self):
        self.prepare(); item=self.state/'docker-config/config.json';item.write_text('{}')
        with self.assertRaises(module.ProvisionError): self.prepare()
        self.assertTrue(item.exists())

    def test_overlapping_or_invalid_paths_are_rejected(self):
        for config,state in ((str(self.config),str(self.config/'nested')),(str(self.config),'/root/../etc'),(str(self.config)+'\t','/root/state')):
            with self.subTest(state=state), self.assertRaises(module.ProvisionError): module.prepare(config,state)


if __name__ == '__main__': unittest.main()
