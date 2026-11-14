import importlib.util
from pathlib import Path
import unittest
import uuid

ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('legacy_host_bootstrap',ROOT/'apps/updater/legacy-host-bootstrap.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)


class LegacyHostBootstrapTest(unittest.TestCase):
    def setUp(self):self.operation=str(uuid.uuid4());self.calls=[]
    def execute(self,args,timeout,*,pass_fds=()):self.calls.append((args,timeout,pass_fds))
    def run_steps(self,needs_node=True):
        module.steps('/trusted',self.operation,'a'*40,'sha256:'+'b'*64,'v0.1.7','/old/compose.yaml',9,
                     needs_node=needs_node,execute=self.execute)
    def test_installs_dependencies_and_prepares_existing_runtime_under_lock(self):
        self.run_steps()
        self.assertEqual([call[0][0] if call[0][0].endswith('apt-get') else Path(call[0][2]).name for call in self.calls],
                         ['/usr/bin/apt-get','/usr/bin/apt-get','install-host.py','install-gh.py','provision-host.py','provision-host.py','provision-verifier-group.py'])
        self.assertIn('--adopt-legacy-verifier',self.calls[2][0])
        self.assertIn('--legacy',self.calls[5][0])
        self.assertEqual(self.calls[2][2],(9,));self.assertEqual(self.calls[5][2],(9,))
    def test_skips_node_install_when_already_available(self):
        self.run_steps(False)
        self.assertEqual(Path(self.calls[0][0][2]).name,'install-host.py')
    def test_invalid_release_never_executes_commands(self):
        with self.assertRaises(module.HostBootstrapError):
            module.steps('/trusted',self.operation,'bad','sha256:'+'b'*64,'v0.1.7','/old/compose.yaml',9,needs_node=True,execute=self.execute)
        self.assertEqual(self.calls,[])
    def test_host_error_stops_following_steps(self):
        def fail(args,timeout,*,pass_fds=()):
            self.calls.append((args,timeout,pass_fds))
            if args[-1]=='nodejs':raise module.HostBootstrapError('fixture')
        with self.assertRaises(module.HostBootstrapError):
            module.steps('/trusted',self.operation,'a'*40,'sha256:'+'b'*64,'v0.1.7','/old/compose.yaml',9,needs_node=True,execute=fail)
        self.assertEqual(len(self.calls),2)


if __name__=='__main__':unittest.main()
