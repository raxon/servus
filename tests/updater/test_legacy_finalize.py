import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock
import uuid

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'apps/updater'))
import supervisor
spec=importlib.util.spec_from_file_location('legacy_finalize_daemon',ROOT/'apps/updater/supervisor-daemon.py')
daemon=importlib.util.module_from_spec(spec);spec.loader.exec_module(daemon)


@unittest.skipUnless(os.geteuid()==0 and sys.platform=='linux','Requires isolated Linux root')
class LegacyFinalizeTest(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(dir='/root',prefix='servus-legacy-finalize-');root=Path(self.temp.name)
        (root/'journal').mkdir(mode=0o700);(root/'gate').mkdir(mode=0o755);self.journal_path=str(root/'journal')
        self.journal=os.open(root/'journal',os.O_RDONLY|os.O_DIRECTORY);self.gate=os.open(root/'gate',os.O_RDONLY|os.O_DIRECTORY)
        supervisor._atomic_file(self.gate,'state',b'servus-lifecycle-v1 normal\n',0o644)
        self.operation=SimpleNamespace(journal=self.journal,gate=self.gate);self.op=str(uuid.uuid4());self.restore='a'*32;self.service=str(uuid.uuid4())
        self.hub=mock.create_autospec(supervisor.DrainHub,instance=True);self.hub.used=False
        self.hub.connections={role:mock.Mock() for role in supervisor.ROLES}
        self.hub.identities={role:{'id':char*64,'pid':123,'cgroup':'/docker/'+char*64} for role,char in zip(supervisor.ROLES,'abc')}
        self.hub.policy=mock.Mock();self.binding=('/root/policy','sha256:'+'1'*64,'sha256:'+'2'*64,self.hub.policy)
        self.marker={'version':1,'operationId':self.op,'restoreId':self.restore,'serviceId':self.service,'state':'starting','policyBinding':list(self.binding[:3]),'containerIds':{role:self.hub.identities[role]['id'] for role in supervisor.ROLES}}
        self.maintenance={'version':1,'operationId':self.op,'state':'starting','requestIds':{role:str(uuid.uuid4()) for role in supervisor.ROLES},'timeoutMs':5000}
        self.write('legacy-upload-recovery.json',self.marker);self.write('maintenance.json',self.maintenance)
        records=[{'Id':self.hub.identities[role]['id'],'State':{'Running':True,'Health':{'Status':'healthy'}}} for role in supervisor.ROLES]
        self.patches=[mock.patch.object(daemon.select,'select',return_value=([],[],[])),mock.patch.object(supervisor,'inspect_servus',return_value=self.hub.identities),
                      mock.patch.object(daemon,'approved_policy_binding',return_value=self.binding),mock.patch.object(supervisor,'_docker',return_value=json.dumps(records).encode())]
        for patch in self.patches:patch.start();self.addCleanup(patch.stop)

    def tearDown(self):
        os.close(self.journal);os.close(self.gate);self.temp.cleanup()

    def write(self,name,value):supervisor._atomic_file(self.journal,name,json.dumps(value,separators=(',',':')).encode()+b'\n',0o600)
    def exists(self,name):
        try:os.stat(name,dir_fd=self.journal,follow_symlinks=False);return True
        except FileNotFoundError:return False
    def finalize(self):return daemon.finalize_legacy_recovery(self.hub,self.operation,'/root/policy','/root/journal','/root/env')

    def test_finishes_only_after_matching_healthy_authenticated_roles(self):
        self.assertTrue(self.finalize())
        self.assertFalse(self.exists('maintenance.json'));self.assertFalse(self.exists('legacy-upload-recovery.json'))
        fd=supervisor._open_root_file(self.journal,'legacy-upload-validated-'+self.op+'.json',0o600)
        try:self.assertEqual(json.loads(os.read(fd,4097))['state'],'validated')
        finally:os.close(fd)

    def test_retries_if_interrupted_after_removing_maintenance_marker(self):
        original=os.unlink
        def interrupted(path,*args,**kwargs):
            if path=='legacy-upload-recovery.json':raise OSError('fixture interruption')
            return original(path,*args,**kwargs)
        with mock.patch.object(daemon.os,'unlink',side_effect=interrupted):
            with self.assertRaises(OSError):self.finalize()
        self.assertFalse(self.exists('maintenance.json'));self.assertTrue(self.exists('legacy-upload-recovery.json'))
        self.assertTrue(self.finalize());self.assertFalse(self.exists('legacy-upload-recovery.json'))

    def test_changed_policy_or_container_never_removes_markers(self):
        self.marker['containerIds']['agent']='f'*64;self.write('legacy-upload-recovery.json',self.marker)
        with self.assertRaises(supervisor.SupervisorError):self.finalize()
        self.assertTrue(self.exists('maintenance.json'));self.assertTrue(self.exists('legacy-upload-recovery.json'))

    def test_missing_maintenance_without_matching_history_fails_closed(self):
        os.unlink('maintenance.json',dir_fd=self.journal)
        with self.assertRaises(supervisor.SupervisorError):self.finalize()
        self.assertTrue(self.exists('legacy-upload-recovery.json'))

    def test_uncertain_maintenance_is_not_finalized(self):
        self.maintenance['state']='recovery_required';self.write('maintenance.json',self.maintenance)
        with self.assertRaises(supervisor.SupervisorError):self.finalize()
        self.assertTrue(self.exists('maintenance.json'));self.assertTrue(self.exists('legacy-upload-recovery.json'))

    def test_incomplete_channels_wait_without_clearing_markers(self):
        del self.hub.connections['worker']
        self.assertFalse(self.finalize())
        self.assertTrue(self.exists('maintenance.json'));self.assertTrue(self.exists('legacy-upload-recovery.json'))

    def test_unhealthy_agent_or_changed_policy_stays_blocked(self):
        records=[{'Id':self.hub.identities[role]['id'],'State':{'Running':True,'Health':{'Status':'unhealthy' if role=='agent' else 'healthy'}}} for role in supervisor.ROLES]
        with mock.patch.object(supervisor,'_docker',return_value=json.dumps(records).encode()):
            with self.assertRaises(supervisor.SupervisorError):self.finalize()
        self.marker['policyBinding'][1]='sha256:'+'f'*64;self.write('legacy-upload-recovery.json',self.marker)
        with self.assertRaises(supervisor.SupervisorError):self.finalize()
        self.assertTrue(self.exists('maintenance.json'));self.assertTrue(self.exists('legacy-upload-recovery.json'))

    def test_health_drift_after_history_write_keeps_active_markers(self):
        def records(unhealthy):
            return json.dumps([{'Id':self.hub.identities[role]['id'],'State':{'Running':True,'Health':{'Status':'unhealthy' if unhealthy and role=='agent' else 'healthy'}}} for role in supervisor.ROLES]).encode()
        with mock.patch.object(supervisor,'_docker',side_effect=[records(False),records(True)]):
            with self.assertRaises(supervisor.SupervisorError):self.finalize()
        self.assertTrue(self.exists('maintenance.json'));self.assertTrue(self.exists('legacy-upload-recovery.json'))
        self.assertTrue(self.exists('legacy-upload-validated-'+self.op+'.json'))

    def test_status_requires_matching_history_and_no_active_recovery(self):
        status=lambda:daemon.legacy_recovery_status(self.journal_path,self.op,self.restore,self.service)
        self.assertEqual(status(),'in_progress')
        self.write('legacy-upload-validated-'+self.op+'.json',{**self.marker,'state':'validated'})
        self.assertEqual(status(),'in_progress')
        self.maintenance['state']='recovery_required';self.write('maintenance.json',self.maintenance)
        self.assertEqual(status(),'recovery_required')
        self.maintenance['state']='starting';self.write('maintenance.json',self.maintenance)
        self.assertTrue(self.finalize());self.assertEqual(status(),'completed')
        with self.assertRaises(supervisor.SupervisorError):daemon.legacy_recovery_status(self.journal_path,self.op,self.restore,str(uuid.uuid4()))

    def test_status_never_infers_success_from_missing_evidence(self):
        os.unlink('maintenance.json',dir_fd=self.journal);os.unlink('legacy-upload-recovery.json',dir_fd=self.journal)
        self.assertEqual(daemon.legacy_recovery_status(self.journal_path,self.op,self.restore,self.service),'unknown')


if __name__=='__main__':unittest.main()
