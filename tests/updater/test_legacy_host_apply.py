from contextlib import nullcontext
import importlib.util
import os
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest import mock
import uuid

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'apps/updater'))
import supervisor
spec=importlib.util.spec_from_file_location('legacy_host_apply_daemon',ROOT/'apps/updater/supervisor-daemon.py')
daemon=importlib.util.module_from_spec(spec);spec.loader.exec_module(daemon)


class LegacyHostApplyTest(unittest.TestCase):
    def setUp(self):
        self.runner=object.__new__(daemon.HostApply)
        self.runner.ownership=SimpleNamespace(directory=123,assert_held=mock.Mock())
        self.runner.approval_journal='/root/journal';self.runner.active_env='/root/active'
        self.runner._current_ingress=mock.Mock(return_value=None)
        self.coordinator=mock.Mock();self.quiescence=mock.Mock()
        self.backup_journal=mock.MagicMock()
        self.backup_journal.__enter__.return_value=self.backup_journal
        self.backup_journal.active.return_value=None
        self.backups=SimpleNamespace(BackupJournal=mock.Mock(return_value=self.backup_journal),
                                     BackupError=type('FixtureBackupError',(Exception,),{}))
        modules={'update-coordinator':self.coordinator,'quiescence':self.quiescence,'provision-host':mock.Mock(),'runtime-policy':mock.Mock(),
                 'installation-backups':self.backups}
        def load(_name,filename,mode=0o644):
            self.assertEqual(mode,0o644)
            return modules[filename[:-3]]
        self.runner._load=mock.Mock(side_effect=load)
        self.hub=mock.create_autospec(supervisor.DrainHub,instance=True);self.hub.policy=SimpleNamespace(data_dir="/root/panel-data")
        self.maintenance=mock.create_autospec(supervisor.MaintenanceSupervisor,instance=True)
        self.lease=object();self.maintenance.drained_window.return_value=nullcontext(self.lease)
        self.op=str(uuid.uuid4());self.restore='a'*32;self.service=str(uuid.uuid4())
        self.binding=('/root/policy','sha256:'+'1'*64,'sha256:'+'2'*64,self.hub.policy)
        self.patches=[mock.patch.object(daemon.os,'readlink',return_value='/root/control'),
                      mock.patch.object(daemon,'resolve_active_policy',return_value=('/root/policy','/root/env',self.hub.policy)),
                      mock.patch.object(daemon,'approved_policy_binding',return_value=self.binding)]
        for patch in self.patches:patch.start();self.addCleanup(patch.stop)

    def invoke(self,restore=None):return self.runner.recover_legacy_upload(self.op,restore or self.restore,self.service,self.hub,self.maintenance)

    def test_preflights_then_drains_cleans_and_starts_under_same_scope(self):
        result=self.invoke()
        self.assertEqual(self.runner._current_ingress.call_args.args[2],"/root/panel-data")
        self.assertIs(result,self.coordinator.start_cleaned_legacy_upload.return_value)
        self.maintenance.drained_window.assert_called_once_with(self.hub,self.op,policy_binding=self.binding,legacy_upload_id=self.restore,legacy_service_id=self.service)
        self.assertEqual([call[0] for call in self.coordinator.method_calls],['preflight_external_containers','cleanup_stopped_legacy_upload','start_cleaned_legacy_upload'])
        self.assertEqual(self.coordinator.cleanup_stopped_legacy_upload.call_args.args[:4],(self.op,self.restore,self.service,self.lease))
        self.backups.BackupJournal.assert_called_once_with(self.maintenance,supervisor)
        self.backup_journal.active.assert_called_once_with()

    def test_invalid_identity_or_failed_preflight_never_stops_services(self):
        with self.assertRaises(supervisor.SupervisorError):self.invoke('../bad')
        self.coordinator.preflight_external_containers.side_effect=RuntimeError('fixture preflight failure')
        with self.assertRaises(RuntimeError):self.invoke()
        self.maintenance.drained_window.assert_not_called()
        self.coordinator.cleanup_stopped_legacy_upload.assert_not_called()

    def test_active_installation_backup_refuses_legacy_recovery_before_preflight_or_drain(self):
        for state in ('requested','capturing','verified','starting','completed','failed','recovery_required'):
            with self.subTest(state=state):
                self.backup_journal.active.return_value={'operationId':str(uuid.uuid4()),'state':state}
                with self.assertRaisesRegex(supervisor.SupervisorError,'installation backup'):
                    self.invoke()
        self.coordinator.preflight_external_containers.assert_not_called()
        self.maintenance.drained_window.assert_not_called()
        self.coordinator.cleanup_stopped_legacy_upload.assert_not_called()
        self.coordinator.start_cleaned_legacy_upload.assert_not_called()


if __name__=='__main__':unittest.main()
