import fcntl
import hashlib
import importlib.util
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

import test_host_bundle as fixtures

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'apps/updater'))
import supervisor
spec=importlib.util.spec_from_file_location('host_coordinator',ROOT/'apps/updater/host-coordinator.py')
coordinator=importlib.util.module_from_spec(spec);spec.loader.exec_module(coordinator)
bundle=fixtures.bundle


@unittest.skipUnless(sys.platform=='linux' and os.geteuid()==0 and sys.flags.isolated,'Requires isolated Linux root')
class HostCoordinatorTest(unittest.TestCase):
    def setUp(self):
        self.fixture=fixtures.CompletedUpdateTest();self.fixture.setUp();self.fixture.db.commit()
        self.temp=tempfile.TemporaryDirectory(dir='/root');self.root=Path(self.temp.name)
        self.state,self.install,self.gate,self.candidates,self.host=(self.root/name for name in ('state','install','gate','candidates','host'))
        for path in (self.state,self.install,self.candidates):path.mkdir(mode=0o700)
        for path in (self.gate,self.host):path.mkdir(mode=0o755)
        (self.state/'maintenance').mkdir(mode=0o700);(self.state/'staging').mkdir(mode=0o700)
        self.stage=self.state/'staging'/('servus-install-'+'c'*32);self.stage.mkdir(mode=0o700)
        modules_dir=self.stage/'apps'/'updater';modules_dir.mkdir(parents=True,mode=0o755);(self.stage/'apps').chmod(0o755)
        self.cli=b'trusted cli';self.pin=('a'*64,hashlib.sha256(self.cli).hexdigest(),len(self.cli))
        source=('PINNED = '+repr({'amd64':self.pin,'arm64':self.pin})+'\ndef install(*, pinned=PINNED): pass\n').encode()
        contents={'install-gh.py':source,'core.py':b'core'};self.manifest={}
        for name,data in contents.items():
            path=modules_dir/name;path.write_bytes(data);path.chmod(0o644)
            self.manifest['apps/updater/'+name]=(0o644,len(data),hashlib.sha256(data).hexdigest())
        (self.stage/'manifest.json').write_bytes(b'fixture');(self.stage/'manifest.json').chmod(0o644)
        (self.host/'bin').mkdir(mode=0o755);(self.host/'bin'/'gh').write_bytes(self.cli);(self.host/'bin'/'gh').chmod(0o755)
        (self.gate/'state').write_bytes(b'servus-lifecycle-v1 normal\n');(self.gate/'state').chmod(0o644)
        for path in (self.state/'service.lock',self.state/'host.lock',self.install/'install.lock'):path.touch(mode=0o600)
        self.service_lock=os.open(self.state/'service.lock',os.O_RDONLY);self.host_lock=os.open(self.state/'host.lock',os.O_RDONLY);self.install_lock=os.open(self.install/'install.lock',os.O_RDONLY)
        for fd in (self.service_lock,self.host_lock,self.install_lock):fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        target=sqlite3.connect(self.state/'journal.sqlite');self.fixture.db.backup(target);target.close();(self.state/'journal.sqlite').chmod(0o600)
        self.db=sqlite3.connect(self.state/'journal.sqlite',isolation_level=None)
        self.db.execute('UPDATE preparations SET staging_path=?',(str(self.stage),))
        self.db.execute('CREATE TABLE extraction_probes(status TEXT)');self.db.execute('CREATE TABLE policy_probes(state TEXT)')
        self.policy=SimpleNamespace(image_reference=self.fixture.image)
        self.daemon=SimpleNamespace(resolve_active_policy=mock.Mock(return_value=('/root/policy','/root/accepted',self.policy)))
        self.extractor=SimpleNamespace(MANIFEST_LIMIT=262144,_manifest_files=mock.Mock(return_value=self.manifest))
        self.backup=SimpleNamespace(_read=lambda fd,limit:os.read(fd,limit+1))
        self.install_host=SimpleNamespace(MODULES=('install-gh.py','core.py'),UNITS=('servus-updater.service',))
        unit_dir=self.stage/'deployment'/'systemd';unit_dir.mkdir(parents=True,mode=0o755)
        (self.stage/'deployment').chmod(0o755)
        unit=b'[Service]\nType=simple\n';unit_path=unit_dir/'servus-updater.service'
        unit_path.write_bytes(unit);unit_path.chmod(0o644)
        self.manifest['deployment/systemd/servus-updater.service']=(0o644,len(unit),hashlib.sha256(unit).hexdigest())
        self.install_gh=SimpleNamespace(PINNED={'amd64':self.pin,'arm64':self.pin})

    def tearDown(self):
        self.db.close();os.close(self.service_lock);os.close(self.host_lock);os.close(self.install_lock);self.temp.cleanup();self.fixture.tearDown()

    def prepare(self, include_material=False):
        return coordinator.prepare_completed(self.db,self.fixture.op,state_dir=str(self.state),install_dir=str(self.install),
            gate_dir=str(self.gate),candidate_parent=str(self.candidates),host_dir=str(self.host),active_env='/root/env',
            service_lock=self.service_lock,install_lock=self.install_lock,supervisor=supervisor,daemon=self.daemon,
            extractor=self.extractor,backup=self.backup,bundle=bundle,install_host=self.install_host,install_gh=self.install_gh,include_material=include_material)

    def test_stop_updater_journals_before_systemctl_and_acquires_service_lock(self):
        names=('servus-updater.service','servus-supervisor.service','servus-updater-socket.service','servus-updater-bootstrap.service')
        before={name:('inactive' if name.endswith('bootstrap.service') else 'active') for name in names}
        after={**before,'servus-updater.service':'inactive'}
        unit_mask=SimpleNamespace(UNITS=names,capture_service_states=mock.Mock(side_effect=[before,after]))
        def stop(command,**kwargs):
            self.assertEqual(command,['/usr/bin/systemctl','stop','servus-updater.service'])
            self.assertEqual(self.db.execute('select status from host_stops').fetchone(),('stopping',))
        state_fd=os.open(self.state,os.O_RDONLY|os.O_DIRECTORY);install_fd=os.open(self.install,os.O_RDONLY|os.O_DIRECTORY)
        fcntl.flock(self.service_lock,fcntl.LOCK_UN)
        try:
            held,states=coordinator.stop_updater(self.db,self.fixture.op,self.fixture.digest,state_fd=state_fd,
                install_fd=install_fd,host_lock=self.host_lock,install_lock=self.install_lock,
                supervisor=supervisor,unit_mask=unit_mask,bundle=bundle,authorize=lambda:None,run=stop)
            try:self.assertEqual(states,before);self.assertEqual(self.db.execute('select status from host_stops').fetchone(),('stopped',))
            finally:os.close(held)
        finally:
            fcntl.flock(self.service_lock,fcntl.LOCK_EX|fcntl.LOCK_NB);os.close(state_fd);os.close(install_fd)

    def test_failed_stop_leaves_recovery_intent(self):
        names=('servus-updater.service','servus-supervisor.service','servus-updater-socket.service','servus-updater-bootstrap.service')
        states={name:('inactive' if name.endswith('bootstrap.service') else 'active') for name in names}
        unit_mask=SimpleNamespace(UNITS=names,capture_service_states=mock.Mock(return_value=states))
        state_fd=os.open(self.state,os.O_RDONLY|os.O_DIRECTORY);install_fd=os.open(self.install,os.O_RDONLY|os.O_DIRECTORY)
        try:
            with self.assertRaises(coordinator.HostPreparationError):
                coordinator.stop_updater(self.db,self.fixture.op,self.fixture.digest,state_fd=state_fd,install_fd=install_fd,
                    host_lock=self.host_lock,install_lock=self.install_lock,supervisor=supervisor,unit_mask=unit_mask,bundle=bundle,
                    authorize=lambda:None,run=mock.Mock(side_effect=subprocess.CalledProcessError(1,'systemctl')))
            self.assertEqual(self.db.execute('select status from host_stops').fetchone(),('stopping',))
        finally:os.close(state_fd);os.close(install_fd)

    def test_recover_stopped_updater_only_before_host_preparation(self):
        names=('servus-updater.service','servus-supervisor.service','servus-updater-socket.service','servus-updater-bootstrap.service')
        expected={name:('inactive' if name.endswith('bootstrap.service') else 'active') for name in names}
        stopped={**expected,'servus-updater.service':'inactive'}
        originals={name:b'unit' for name in names}
        unit_mask=SimpleNamespace(UNITS=names,_directory=mock.Mock(),_metadata=mock.Mock(),_read=mock.Mock(),
                                  capture_service_states=mock.Mock(side_effect=[stopped,expected]))
        self.db.execute('CREATE TABLE host_stops(operation_id TEXT PRIMARY KEY,image_digest TEXT,status TEXT)')
        self.db.execute("INSERT INTO host_stops VALUES(?,?,'stopping')",(self.fixture.op,self.fixture.digest))
        state_fd=os.open(self.state,os.O_RDONLY|os.O_DIRECTORY);install_fd=os.open(self.install,os.O_RDONLY|os.O_DIRECTORY)
        args=dict(state_fd=state_fd,install_fd=install_fd,units_fd=install_fd,host_lock=self.host_lock,
                  supervisor=supervisor,unit_mask=unit_mask,bundle=bundle,ready=lambda:None)
        try:
            with self.assertRaises(coordinator.HostPreparationError):
                coordinator.recover_stopped_updater(self.db,self.fixture.op,self.fixture.digest,originals,run=mock.Mock(),**args)
            fcntl.flock(self.install_lock,fcntl.LOCK_UN)
            self.db.execute('CREATE TABLE host_switches(operation_id TEXT,image_digest TEXT,phase TEXT)')
            self.db.execute("INSERT INTO host_switches VALUES(?,?,'intent')",(self.fixture.op,self.fixture.digest))
            with self.assertRaises(coordinator.HostPreparationError):
                coordinator.recover_stopped_updater(self.db,self.fixture.op,self.fixture.digest,originals,run=mock.Mock(),**args)
            self.db.execute('DELETE FROM host_switches')
            self.db.execute("INSERT INTO host_switches VALUES(?,?,'rolled_back')",(self.fixture.op,self.fixture.digest))
            inspector=SimpleNamespace(inspect_exchange=mock.Mock(return_value='exchanged'))
            args.update(host_switch=inspector,exchange=object(),active_parent=state_fd,candidate_parent=install_fd)
            with self.assertRaises(coordinator.HostPreparationError):
                coordinator.recover_stopped_updater(self.db,self.fixture.op,self.fixture.digest,originals,run=mock.Mock(),**args)
            inspector.inspect_exchange.return_value='original'
            self.db.execute('CREATE TABLE host_unit_masks(operation_id TEXT,image_digest TEXT,phase TEXT)')
            self.db.execute("INSERT INTO host_unit_masks VALUES(?,?,'masking')",(self.fixture.op,self.fixture.digest))
            with self.assertRaises(coordinator.HostPreparationError):
                coordinator.recover_stopped_updater(self.db,self.fixture.op,self.fixture.digest,originals,run=mock.Mock(),**args)
            self.db.execute("UPDATE host_unit_masks SET phase='restored'")
            self.db.execute('CREATE TABLE host_preparations(operation_id TEXT,image_digest TEXT,status TEXT)')
            self.db.execute("INSERT INTO host_preparations VALUES(?,?,'prepared')",(self.fixture.op,self.fixture.digest))
            run=mock.Mock()
            fcntl.flock(self.service_lock,fcntl.LOCK_UN)
            coordinator.recover_stopped_updater(self.db,self.fixture.op,self.fixture.digest,originals,run=run,**args)
            self.assertEqual([call.args[0] for call in run.call_args_list],[['/usr/bin/systemctl','daemon-reload'],['/usr/bin/systemctl','reset-failed','servus-updater-socket.service','servus-supervisor.service','servus-updater.service'],['/usr/bin/systemctl','start','servus-updater-socket.service'],['/usr/bin/systemctl','start','servus-supervisor.service'],['/usr/bin/systemctl','start','servus-updater.service']])
            self.assertEqual(self.db.execute('select status from host_stops').fetchone(),('completed',))
            self.assertEqual(self.db.execute('select status from host_preparations').fetchone(),('abandoned',))
        finally:
            fcntl.flock(self.service_lock,fcntl.LOCK_EX|fcntl.LOCK_NB);fcntl.flock(self.install_lock,fcntl.LOCK_EX|fcntl.LOCK_NB);os.close(state_fd);os.close(install_fd)

    def test_recovery_can_prepare_boot_without_starting_services(self):
        names=('servus-updater.service','servus-supervisor.service','servus-updater-socket.service','servus-updater-bootstrap.service')
        states={name:('inactive' if name.endswith('bootstrap.service') else 'active') for name in names}
        unit_mask=SimpleNamespace(UNITS=names,UnitMaskError=RuntimeError,_directory=mock.Mock(),_metadata=mock.Mock(),_read=mock.Mock(),capture_service_states=mock.Mock(return_value=states))
        self.db.execute('CREATE TABLE host_stops(operation_id TEXT PRIMARY KEY,image_digest TEXT,status TEXT)')
        self.db.execute("INSERT INTO host_stops VALUES(?,?,'stopped')",(self.fixture.op,self.fixture.digest))
        state_fd=os.open(self.state,os.O_RDONLY|os.O_DIRECTORY);install_fd=os.open(self.install,os.O_RDONLY|os.O_DIRECTORY)
        fcntl.flock(self.install_lock,fcntl.LOCK_UN);run=mock.Mock();ready=mock.Mock()
        try:
            coordinator.recover_stopped_updater(self.db,self.fixture.op,self.fixture.digest,{name:b'unit' for name in names},
                state_fd=state_fd,install_fd=install_fd,units_fd=install_fd,host_lock=self.host_lock,supervisor=supervisor,
                unit_mask=unit_mask,bundle=bundle,ready=ready,run=run,prepare_only=True)
            self.assertEqual(self.db.execute('select status from host_stops').fetchone(),('restarting',))
            self.assertEqual([call.args[0][1] for call in run.call_args_list],['daemon-reload','reset-failed'])
            ready.assert_not_called()
        finally:
            fcntl.flock(self.install_lock,fcntl.LOCK_EX|fcntl.LOCK_NB);os.close(state_fd);os.close(install_fd)

    def test_recovery_keeps_intent_if_control_plane_is_unavailable(self):
        names=('servus-updater.service','servus-supervisor.service','servus-updater-socket.service','servus-updater-bootstrap.service')
        states={name:('inactive' if name.endswith('bootstrap.service') else 'active') for name in names}
        unit_mask=SimpleNamespace(UNITS=names,UnitMaskError=RuntimeError,_directory=mock.Mock(),_metadata=mock.Mock(),_read=mock.Mock(),capture_service_states=mock.Mock(return_value=states))
        self.db.execute('CREATE TABLE host_stops(operation_id TEXT PRIMARY KEY,image_digest TEXT,status TEXT)')
        self.db.execute("INSERT INTO host_stops VALUES(?,?,'stopped')",(self.fixture.op,self.fixture.digest))
        state_fd=os.open(self.state,os.O_RDONLY|os.O_DIRECTORY);install_fd=os.open(self.install,os.O_RDONLY|os.O_DIRECTORY)
        fcntl.flock(self.install_lock,fcntl.LOCK_UN)
        try:
            with self.assertRaises(coordinator.HostPreparationError):
                coordinator.recover_stopped_updater(self.db,self.fixture.op,self.fixture.digest,{name:b'unit' for name in names},
                    state_fd=state_fd,install_fd=install_fd,units_fd=install_fd,host_lock=self.host_lock,supervisor=supervisor,
                    unit_mask=unit_mask,bundle=bundle,ready=mock.Mock(side_effect=RuntimeError('unavailable')),run=mock.Mock(),readiness_timeout=0)
            self.assertEqual(self.db.execute('select status from host_stops').fetchone(),('restarting',))
            ready=mock.Mock(side_effect=[RuntimeError('settling'),None])
            with mock.patch.object(coordinator.time,'sleep'):
                coordinator.recover_stopped_updater(self.db,self.fixture.op,self.fixture.digest,{name:b'unit' for name in names},
                    state_fd=state_fd,install_fd=install_fd,units_fd=install_fd,host_lock=self.host_lock,supervisor=supervisor,
                    unit_mask=unit_mask,bundle=bundle,ready=ready,run=mock.Mock())
            self.assertEqual(ready.call_count,2)
            self.assertEqual(self.db.execute('select status from host_stops').fetchone(),('completed',))
        finally:
            fcntl.flock(self.install_lock,fcntl.LOCK_EX|fcntl.LOCK_NB);os.close(state_fd);os.close(install_fd)

    def test_prepares_verified_generation_and_records_completion(self):
        with mock.patch.object(supervisor,'inspect_servus',return_value={'api':'same'}):name=self.prepare()
        self.assertEqual(name,'runtime-'+self.fixture.op)
        self.assertEqual(self.db.execute('select status from host_preparations').fetchone(),('prepared',))
        self.assertEqual((self.candidates/name/'bin'/'gh').read_bytes(),self.cli)

    def test_rejects_modified_systemd_unit_before_staging(self):
        (self.stage/'deployment'/'systemd'/'servus-updater.service').write_bytes(b'changed')
        with mock.patch.object(supervisor,'inspect_servus',return_value={'api':'same'}),self.assertRaises(bundle.HostBundleError):
            self.prepare()
        self.assertFalse(list(self.candidates.iterdir()))

    def test_preparation_can_return_authenticated_activation_material(self):
        with mock.patch.object(supervisor,'inspect_servus',return_value={'api':'same'}):
            generation,digest,modules,cli,pin=self.prepare(include_material=True)
        self.assertEqual(generation,'runtime-'+self.fixture.op);self.assertEqual(digest,self.fixture.digest)
        self.assertEqual(modules['core.py'],(0o644,b'core'));self.assertEqual(cli,self.cli);self.assertEqual(pin,self.pin)

    def test_rejects_pending_update_without_creating_candidate(self):
        self.db.execute("INSERT INTO apply_requests VALUES('pending','requested')")
        with mock.patch.object(supervisor,'inspect_servus',return_value={'api':'same'}),self.assertRaises(coordinator.HostPreparationError):self.prepare()
        self.assertFalse(list(self.candidates.iterdir()))

    def test_failed_stage_records_recovery_before_returning(self):
        with mock.patch.object(supervisor,'inspect_servus',return_value={'api':'same'}), \
             mock.patch.object(bundle,'stage_runtime_tree',side_effect=OSError('fixture')),self.assertRaises(OSError):self.prepare()
        self.assertEqual(self.db.execute('select status from host_preparations').fetchone(),('recovery_required',))

    def test_changed_generation_after_stage_requires_recovery(self):
        with mock.patch.object(supervisor,'inspect_servus',side_effect=[{'api':'old'},{'api':'old'},{'api':'new'}]), \
             self.assertRaises(coordinator.HostPreparationError):self.prepare()
        self.assertEqual(self.db.execute('select status from host_preparations').fetchone(),('recovery_required',))

    def test_rejects_wrong_held_lock_before_staging(self):
        other=self.root/'other.lock';other.touch(mode=0o600);fd=os.open(other,os.O_RDONLY);fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        try:
            with mock.patch.object(supervisor,'inspect_servus',return_value={'api':'same'}):
                original=self.service_lock;self.service_lock=fd
                try:
                    with self.assertRaises(coordinator.HostPreparationError):self.prepare()
                finally:self.service_lock=original
        finally:os.close(fd)
        self.assertFalse(list(self.candidates.iterdir()))


if __name__=='__main__':unittest.main()
