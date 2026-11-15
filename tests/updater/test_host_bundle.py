import hashlib
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('host_bundle', ROOT / 'apps/updater/host-bundle.py')
bundle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bundle)


@unittest.skipUnless(os.geteuid() == 0 and Path('/proc/self/fd').exists(), 'Requires Linux root')
class HostBundleTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir='/root')
        self.root = Path(self.tmp.name)
        self.root.chmod(0o700)
        self.modules = self.root / 'apps' / 'updater'
        self.modules.mkdir(parents=True, mode=0o755)
        (self.root / 'apps').chmod(0o755)
        self.fd = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY)
        self.manifest = {}
        self.add('core.py', b'core', 0o644)
        self.add('runner.py', b'runner', 0o755)

    def tearDown(self):
        os.close(self.fd)
        self.tmp.cleanup()

    def add(self, name, content, mode):
        path = self.modules / name
        path.write_bytes(content)
        path.chmod(mode)
        self.manifest['apps/updater/' + name] = (mode, len(content), hashlib.sha256(content).hexdigest())

    def collect(self):
        return bundle.collect(self.fd, self.manifest, ('core.py', 'runner.py'))

    def test_collects_exact_bytes_and_future_signed_modules(self):
        self.add('future.py', b'future', 0o644)
        self.assertEqual(self.collect(), {'core.py': (0o644, b'core'), 'future.py': (0o644, b'future'),
                                          'runner.py': (0o755, b'runner')})

    def test_rejects_content_mode_and_hardlink_changes(self):
        path = self.modules / 'core.py'
        path.write_bytes(b'CORE')
        with self.assertRaises(bundle.HostBundleError): self.collect()
        path.write_bytes(b'core'); path.chmod(0o600)
        with self.assertRaises(bundle.HostBundleError): self.collect()
        path.chmod(0o644); os.link(path, self.root / 'second-link')
        with self.assertRaises(bundle.HostBundleError): self.collect()

    def test_rejects_symlinks_and_untrusted_directories(self):
        path = self.modules / 'core.py'
        path.unlink(); path.symlink_to('runner.py')
        with self.assertRaises(OSError): self.collect()
        path.unlink(); self.add('core.py', b'core', 0o644)
        self.modules.chmod(0o777)
        with self.assertRaises(bundle.HostBundleError): self.collect()

    def test_requires_complete_and_well_formed_inventory(self):
        self.manifest.pop('apps/updater/core.py')
        with self.assertRaises(bundle.HostBundleError): self.collect()
        self.add('core.py', b'core', 0o644)
        self.manifest['apps/updater/../escape.py'] = (0o644, 0, '0' * 64)
        with self.assertRaises(bundle.HostBundleError): self.collect()
        del self.manifest['apps/updater/../escape.py']
        self.manifest['apps/updater/core.py'] = (0o644, True, '0' * 64)
        with self.assertRaises(bundle.HostBundleError): self.collect()

    def test_rejects_changed_file_during_read(self):
        original = os.read
        def changed(fd, amount):
            data = original(fd, amount)
            if data:
                path = self.modules / 'core.py'
                before = path.stat().st_mtime_ns
                path.write_bytes(b'CORE')
                os.utime(path, ns=(before + 1_000_000_000, before + 1_000_000_000))
            return data
        with mock.patch.object(bundle.os, 'read', side_effect=changed):
            with self.assertRaises(bundle.HostBundleError): self.collect()

    def test_rejects_oversized_bundle(self):
        with mock.patch.object(bundle, 'MAX_TOTAL', 3):
            with self.assertRaises(bundle.HostBundleError): self.collect()


if __name__ == '__main__': unittest.main()
