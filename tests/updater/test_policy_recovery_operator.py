import importlib.util
import os
import pathlib
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('recovery_operator', ROOT / 'apps/updater/reconcile-policy-operator.py')
operator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(operator)


@unittest.skipUnless(os.geteuid() == 0 and pathlib.Path('/proc/self/fd').exists(), 'Requires Linux root')
class RecoveryOperatorTest(unittest.TestCase):
    def test_loads_only_regular_root_owned_module(self):
        with tempfile.TemporaryDirectory(dir='/run') as name:
            directory = pathlib.Path(name)
            path = directory / 'fixture.py'; path.write_text('value = 42\n'); path.chmod(0o644)
            fd = operator.trusted_directory(str(directory), 0o700)
            try:
                self.assertEqual(operator.load_module(fd, 'fixture.py').value, 42)
                path.chmod(0o666)
                with self.assertRaises(RuntimeError): operator.load_module(fd, 'fixture.py')
                path.unlink(); path.symlink_to('/etc/passwd')
                with self.assertRaises(OSError): operator.load_module(fd, 'fixture.py')
            finally:
                os.close(fd)

    def test_rejects_unsafe_directory_ancestry(self):
        with tempfile.TemporaryDirectory(dir='/run') as name:
            parent = pathlib.Path(name); child = parent / 'child'; child.mkdir(mode=0o700)
            parent.chmod(0o777)
            try:
                with self.assertRaises(RuntimeError): operator.trusted_directory(str(child), 0o700)
            finally:
                parent.chmod(0o700)


if __name__ == '__main__':
    unittest.main()
