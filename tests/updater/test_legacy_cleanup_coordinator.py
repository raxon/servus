import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
import uuid
from types import SimpleNamespace
from unittest import mock

ROOT=Path(__file__).resolve().parents[2]
def load(name,path):
    spec=importlib.util.spec_from_file_location(name,ROOT/path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
supervisor=load('legacy_cleanup_supervisor','apps/updater/supervisor.py')
coordinator=load('legacy_cleanup_coordinator','apps/updater/update-coordinator.py')


class LegacyCleanupCoordinatorTest(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix='servus-legacy-coordinator-')
        self.directory=os.open(self.tmp.name,os.O_RDONLY|os.O_DIRECTORY)
        self.op=str(uuid.uuid4());self.restore='a'*32;self.service=str(uuid.uuid4())
        self.lease=object.__new__(supervisor.DrainLease)
        self.lease._legacy_upload_id=self.restore
        self.lease._policy_binding=('/root/policy','sha256:'+'1'*64,'sha256:'+'2'*64)
        self.lease._owner=SimpleNamespace(journal=self.directory,_record=mock.Mock())
        self.lease._operation_id=self.op;self.lease._request_ids={role:str(uuid.uuid4()) for role in supervisor.ROLES}
        self.lease._timeout_ms=5000;self.lease._state='stopped_unverified';self.lease._settled=False
        hub=mock.create_autospec(supervisor.DrainHub,instance=True)
        hub.used=True;hub.expected_uid=1000
        hub.identities={role:{'id':char*64} for role,char in zip(supervisor.ROLES,'abc')}
        hub.policy=mock.create_autospec(supervisor.RuntimePolicy,instance=True)
        hub.policy.data_dir='/var/lib/servus';hub.policy.image_id='sha256:'+'e'*64
        self.lease._hub=hub
        self.checks=mock.Mock()
        self.result=json.dumps({'operationId':self.restore,'phase':'cancelled'}).encode()
        self.stack=mock.patch.object(self.lease,'assert_locked')
        self.stack.start();self.addCleanup(self.stack.stop)
        self.verify=mock.patch.object(supervisor,'_verify_data_directory');self.verify.start();self.addCleanup(self.verify.stop)
        self.docker=mock.patch.object(supervisor,'_docker',return_value=self.result);self.docker_mock=self.docker.start();self.addCleanup(self.docker.stop)

    def tearDown(self):
        os.close(self.directory);self.tmp.cleanup()

    def invoke(self,restore=None):
        return coordinator.cleanup_stopped_legacy_upload(self.op,restore or self.restore,self.service,self.lease,supervisor,self.checks)

    def marker(self): return json.loads((Path(self.tmp.name)/'legacy-upload-recovery.json').read_text())

    def test_runs_fixed_worker_only_after_checks_and_retains_a_cleaned_marker(self):
        self.assertEqual(self.invoke(),{'operationId':self.restore,'phase':'cancelled'})
        self.assertEqual(self.marker(),{'version':1,'operationId':self.op,'restoreId':self.restore,'serviceId':self.service,'state':'cleaned',
            'policyBinding':list(self.lease._policy_binding),'containerIds':{role:self.lease._hub.identities[role]['id'] for role in supervisor.ROLES}})
        self.assertEqual(self.checks.ensure_no_open_data.call_count,2)
        args,kwargs=self.docker_mock.call_args
        self.assertEqual(args[0],'run');self.assertIn('--read-only',args);self.assertIn('--cap-drop',args)
        self.assertIn(self.lease._hub.policy.image_id,args);self.assertEqual(args[-2:],(self.restore,self.service));self.assertEqual(kwargs,{'timeout':120})
        with self.assertRaises(coordinator.UpdateError):self.invoke()
        self.assertEqual(self.docker_mock.call_count,1)

    def test_wrong_scope_or_failed_quiescence_never_starts_worker(self):
        with self.assertRaises(coordinator.UpdateError):self.invoke('b'*32)
        self.checks.ensure_no_uid_writers.side_effect=RuntimeError('writer')
        with self.assertRaises(RuntimeError):self.invoke()
        self.docker_mock.assert_not_called();self.assertFalse((Path(self.tmp.name)/'legacy-upload-recovery.json').exists())

    def test_uncertain_worker_or_later_writer_preserves_intent(self):
        self.docker_mock.side_effect=RuntimeError('timeout')
        with self.assertRaises(RuntimeError):self.invoke()
        self.assertEqual(self.marker()['state'],'intent')

    def test_drift_after_worker_preserves_intent(self):
        self.checks.ensure_no_uid_writers.side_effect=[None,RuntimeError('writer appeared')]
        with self.assertRaises(RuntimeError):self.invoke()
        self.assertEqual(self.marker()['state'],'intent')

    def test_duplicate_or_wrong_worker_result_preserves_intent(self):
        self.docker_mock.return_value=b'{"operationId":"' + self.restore.encode() + b'","phase":"cancelled","phase":"cancelled"}'
        with self.assertRaises(coordinator.UpdateError):self.invoke()
        self.assertEqual(self.marker()['state'],'intent')
        self.assertEqual(self.checks.ensure_no_open_data.call_count,1)

    def test_scoped_lease_cannot_authorize_an_update_snapshot(self):
        with self.assertRaises(coordinator.UpdateError):
            coordinator.capture_stopped_snapshot(None,self.op,self.lease,'/tmp/unused',-1,supervisor,self.checks,None)
        with self.assertRaises(coordinator.UpdateError):
            coordinator.begin_snapshot(None,self.op,self.lease,supervisor)
        self.lease._settled=False;self.lease._state='stopped_unverified'
        with self.assertRaises(supervisor.SupervisorError):self.lease.record('snapshotting')
        self.docker_mock.assert_not_called()

    @unittest.skipUnless(os.geteuid()==0,'Requires root-owned marker')
    def test_start_requires_cleaned_marker_bound_to_scope_policy_and_containers(self):
        self.invoke();self.lease.record_legacy_start()
        self.assertEqual(self.marker()['state'],'starting');self.assertEqual(self.lease._state,'starting')
        self.lease._owner._record.assert_called_once_with(self.op,'starting',self.lease._request_ids,5000)

    @unittest.skipUnless(os.geteuid()==0,'Requires root-owned marker')
    def test_start_rejects_a_changed_marker_before_recording_start(self):
        self.invoke();marker=self.marker();marker['containerIds']['agent']='f'*64
        supervisor._atomic_file(self.directory,'legacy-upload-recovery.json',json.dumps(marker).encode()+b'\n',0o600)
        with self.assertRaises(supervisor.SupervisorError):self.lease.record_legacy_start()
        self.lease._owner._record.assert_not_called();self.assertEqual(self.lease._state,'stopped_unverified')

    @unittest.skipUnless(os.geteuid()==0,'Requires root-owned marker')
    def test_failed_durable_start_keeps_the_cleaned_marker(self):
        self.invoke();self.lease._owner._record.side_effect=OSError('fixture write failure')
        with self.assertRaises(OSError):self.lease.record_legacy_start()
        self.assertEqual(self.marker()['state'],'cleaned');self.assertEqual(self.lease._state,'stopped_unverified')


if __name__=='__main__': unittest.main()
