import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest
import uuid
from unittest import mock

ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('legacy_run',ROOT/'apps/updater/legacy-run.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)


class MigrationRunTest(unittest.TestCase):
    def setUp(self):
        self.operation=str(uuid.uuid4());self.calls=[]
        self.supervisor=SimpleNamespace(_uuid4=lambda value:value==self.operation,SupervisorError=RuntimeError)
        self.approved=SimpleNamespace(control_dir='/control',updater_dir='/updater')
        self.daemon=SimpleNamespace(resolve_active_policy=mock.Mock(return_value=('/policy','/env',self.approved)))
        self.initial=SimpleNamespace(check_supervisor=mock.Mock(),check_updater=mock.Mock(),InitialGenerationError=RuntimeError)
    def execute(self,args,timeout):self.calls.append((args,timeout))
    def run_migration(self):
        return module.run(self.operation,'/old.env','/compose.yaml','/recovery','/snapshot',self.supervisor,self.daemon,self.initial,execute=self.execute)
    def test_runs_host_steps_in_order(self):
        self.run_migration()
        self.assertEqual([Path(args[2]).name if args[0].endswith('python3') else args[-1] for args,_ in self.calls],
                         ['legacy-prepare.py','provision-host.py','servus-updater-socket.service','servus-supervisor.service','servus-updater.service','legacy-migrate.py'])
        self.initial.check_supervisor.assert_called_once_with('/control',self.supervisor)
        self.initial.check_updater.assert_called_once_with('/updater',self.supervisor)
    def test_failure_does_not_run_later_steps(self):
        def fail(args,timeout):
            self.calls.append((args,timeout))
            if 'provision-host.py' in args[2]:raise module.MigrationRunError('fixture')
        self.execute=fail
        with self.assertRaises(module.MigrationRunError):self.run_migration()
        self.assertEqual(len(self.calls),2)
    def test_invalid_inputs_do_not_start_any_process(self):
        with self.assertRaises(module.MigrationRunError):
            module.run(self.operation,'relative','/compose.yaml','/recovery','/snapshot',self.supervisor,self.daemon,self.initial,execute=self.execute)
        self.assertEqual(self.calls,[])


if __name__=='__main__':unittest.main()
