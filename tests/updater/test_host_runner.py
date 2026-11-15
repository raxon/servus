import fcntl
import importlib.util
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'apps/updater'))
import supervisor

def load(name):
    spec=importlib.util.spec_from_file_location(name.replace('-','_'),ROOT/'apps/updater'/name)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
runner=load('host-runner.py');bundle=load('host-bundle.py')


@unittest.skipUnless(sys.platform=='linux' and os.geteuid()==0 and sys.flags.isolated,'Requires isolated Linux root')
class HostRunnerTest(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(dir='/root');root=Path(self.tmp.name)
        self.paths={key:str(root/key) for key in ('state','install','units','parent','candidates','gate','active','active_env','socket')}
        for key in ('state','install','candidates'):Path(self.paths[key]).mkdir(mode=0o700)
        for key in ('units','parent','gate','active'):Path(self.paths[key]).mkdir(mode=0o755)
        for path in (Path(self.paths['state'])/'host.lock',Path(self.paths['install'])/'install.lock',Path(self.paths['state'])/'service.lock'):path.touch(mode=0o600)
        db=sqlite3.connect(Path(self.paths['state'])/'journal.sqlite');db.close();os.chmod(Path(self.paths['state'])/'journal.sqlite',0o600)
        self.op='12345678-1234-4234-8234-123456789abc';self.digest='sha256:'+'a'*64;self.policy=SimpleNamespace(image_reference='image')
        self.daemon=SimpleNamespace(resolve_active_policy=mock.Mock(return_value=('/policy','/accepted',self.policy)))
        self.bundle=SimpleNamespace(OPERATION=bundle.OPERATION,completed_update=mock.Mock(return_value=(self.digest,'/stage')))
        self.coordinator=SimpleNamespace(stop_updater=mock.Mock(),prepare_completed=mock.Mock(),activate_prepared=mock.Mock())
        self.coordinator.stop_updater.side_effect=lambda *a,**k:(os.open(Path(self.paths['state'])/'service.lock',os.O_RDONLY),{'state':'fixture'})
        self.coordinator.prepare_completed.return_value=('runtime-'+self.op,self.digest,{'core.py':(0o644,b'core')},b'cli',('pin',))
        self.unit=SimpleNamespace(UNITS=('unit-a','unit-b'))
        self.modules=dict(supervisor=supervisor,daemon=self.daemon,bundle=self.bundle,coordinator=self.coordinator,
                          unit_mask=self.unit,switch=object(),install_host=SimpleNamespace(read_file=mock.Mock(return_value=b'unit')),
                          extractor=object(),backup=object(),install_gh=object(),fence=SimpleNamespace(assert_fenced=mock.Mock()),
                          quiescence=object(),exchange=object())

    def tearDown(self):self.tmp.cleanup()

    def test_binds_activation_to_completed_update_and_releases_locks(self):
        with mock.patch.object(supervisor,'inspect_servus',return_value={'api':'same'}):
            runner.activate(self.op,modules=self.modules,paths=self.paths)
        self.coordinator.stop_updater.assert_called_once();self.coordinator.prepare_completed.assert_called_once()
        self.coordinator.activate_prepared.assert_called_once()
        fd=os.open(Path(self.paths['state'])/'host.lock',os.O_RDONLY)
        try:fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        finally:os.close(fd)

    def test_rechecks_running_generation_before_stopping(self):
        def check(*args,**kwargs):kwargs['authorize']()
        self.coordinator.stop_updater.side_effect=check
        with mock.patch.object(supervisor,'inspect_servus',side_effect=[{'api':'old'},{'api':'changed'}]),self.assertRaises(runner.HostRunnerError):
            runner.activate(self.op,modules=self.modules,paths=self.paths)
        self.coordinator.prepare_completed.assert_not_called()

    def test_unverified_release_never_stops_updater(self):
        self.bundle.completed_update.side_effect=RuntimeError('unverified')
        with mock.patch.object(supervisor,'inspect_servus',return_value={'api':'same'}),self.assertRaises(RuntimeError):
            runner.activate(self.op,modules=self.modules,paths=self.paths)
        self.coordinator.stop_updater.assert_not_called()


if __name__=='__main__':unittest.main()
