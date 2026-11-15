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
        self.lease._legacy_service_id=self.service
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
        self.lease._legacy_service_id=str(uuid.uuid4())
        with self.assertRaises(coordinator.UpdateError):self.invoke()
        self.lease._legacy_service_id=self.service
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

    def test_scoped_start_keeps_new_work_blocked(self):
        self.lease._owner.gate=self.directory
        self.lease._owner.gate_lock=os.open(Path(self.tmp.name)/'lock',os.O_CREAT|os.O_RDWR,0o600)
        try:
            self.lease._state='starting'
            self.lease.release_for_start()
            self.assertEqual((Path(self.tmp.name)/'state').read_bytes(),b'servus-lifecycle-v1 recovering\n')
        finally:os.close(self.lease._owner.gate_lock)

    def start_fixture(self):
        hub=self.lease._hub;hub.policy.healthchecks={'api':{},'worker':None,'agent':{}}
        binding=(*self.lease._policy_binding,hub.policy)
        daemon=SimpleNamespace(resolve_active_policy=mock.Mock(return_value=(binding[0],'/root/accepted',hub.policy)),approved_policy_binding=mock.Mock(return_value=binding))
        ownership=SimpleNamespace(directory=123,assert_held=mock.Mock())
        states=[{'Id':hub.identities[role]['id'],'Image':hub.policy.image_id,'State':{'Running':True,'Health':{'Status':'healthy'}}} for role in supervisor.ROLES]
        self.docker_mock.side_effect=[b'',b'',b'',json.dumps(states).encode()]
        return hub,daemon,ownership

    def test_start_uses_only_original_containers_after_rechecking_policy_and_writers(self):
        hub,daemon,ownership=self.start_fixture()
        with mock.patch.object(coordinator.os,'readlink',return_value='/root/control'), \
             mock.patch.object(self.lease,'record_legacy_start') as record, mock.patch.object(self.lease,'release_for_start') as release, \
             mock.patch.object(supervisor,'inspect_servus',return_value=hub.identities):
            result=coordinator.start_cleaned_legacy_upload(self.op,self.lease,ownership,'/root/journal','/root/active',supervisor,daemon,self.checks)
        self.assertEqual(result,hub.identities);record.assert_called_once();release.assert_called_once()
        starts=[call.args for call in self.docker_mock.call_args_list if call.args[0]=='start']
        self.assertEqual(starts,[('start',hub.identities[role]['id']) for role in ('agent','api','worker')])
        self.checks.ensure_no_open_data.assert_called_once();self.checks.ensure_no_uid_writers.assert_called_once()

    def test_changed_policy_never_opens_gate_or_starts_containers(self):
        _hub,daemon,ownership=self.start_fixture();daemon.approved_policy_binding.return_value=('/wrong','sha256:'+'1'*64,'sha256:'+'2'*64,self.lease._hub.policy)
        with mock.patch.object(coordinator.os,'readlink',return_value='/root/control'), \
             mock.patch.object(self.lease,'record_legacy_start') as record, mock.patch.object(self.lease,'release_for_start') as release:
            with self.assertRaises(coordinator.UpdateError):
                coordinator.start_cleaned_legacy_upload(self.op,self.lease,ownership,'/root/journal','/root/active',supervisor,daemon,self.checks)
        record.assert_not_called();release.assert_not_called();self.docker_mock.assert_not_called()

    @unittest.skipUnless(os.geteuid()==0,'Requires root-owned marker')
    def test_interrupted_start_retains_starting_marker_without_retry(self):
        self.invoke();self.docker_mock.reset_mock()
        _hub,daemon,ownership=self.start_fixture();self.docker_mock.side_effect=[b'',RuntimeError('start outcome unknown')]
        with mock.patch.object(coordinator.os,'readlink',return_value='/root/control'), mock.patch.object(self.lease,'release_for_start') as release:
            with self.assertRaises(RuntimeError):
                coordinator.start_cleaned_legacy_upload(self.op,self.lease,ownership,'/root/journal','/root/active',supervisor,daemon,self.checks)
        release.assert_called_once();self.assertEqual(self.marker()['state'],'starting')
        self.assertEqual([call.args[0] for call in self.docker_mock.call_args_list],['start','start'])


if __name__=='__main__': unittest.main()
