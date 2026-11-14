import importlib.util
import fcntl
import json
import hashlib
from types import SimpleNamespace
from unittest import mock
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('provision_host', ROOT / 'apps/updater/provision-host.py')
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
sys.path.insert(0, str(ROOT / 'apps/updater'))
import supervisor
policy_spec = importlib.util.spec_from_file_location('provision_runtime_policy', ROOT / 'apps/updater/runtime-policy.py')
runtime_policy = importlib.util.module_from_spec(policy_spec);policy_spec.loader.exec_module(runtime_policy)


@unittest.skipUnless(sys.platform == 'linux' and os.geteuid() == 0, 'Requires isolated Linux root')
class HostProvisioningTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir='/root'); self.root = Path(self.temp.name)
        self.config = self.root/'config'; self.config.mkdir(mode=0o700)
        self.state = self.root/'state'

    def tearDown(self): self.temp.cleanup()

    def prepare(self): module.prepare(str(self.config),str(self.state))

    def runtime_fixture(self):
        install=self.root/'install';install.mkdir(mode=0o700);(install/'install.lock').touch(mode=0o600)
        return install

    def test_runtime_preparation_is_idempotent_and_preserves_credentials(self):
        install=self.runtime_fixture()
        def run(): module.prepare_runtime(str(self.config),str(install),supervisor)
        run()
        tokens=supervisor.ComponentEndpoint().read_component_tokens(str(self.config/'supervisor-secrets'),1000)
        gate=self.config/'lifecycle'; lock=(gate/'lock').stat().st_ino
        control=(self.config/'supervisor-control').stat()
        self.assertEqual((control.st_uid,control.st_gid,stat.S_IMODE(control.st_mode)),(0,1000,0o750))
        run()
        self.assertEqual(tokens,supervisor.ComponentEndpoint().read_component_tokens(str(self.config/'supervisor-secrets'),1000))
        self.assertEqual(lock,(gate/'lock').stat().st_ino)

    def test_runtime_refuses_existing_installation_and_partial_state(self):
        install=self.runtime_fixture(); env=self.config/'servus.env';env.write_text('existing\n');env.chmod(0o600)
        with self.assertRaises(module.ProvisionError): module.prepare_runtime(str(install),str(install),supervisor)
        with self.assertRaises(module.ProvisionError): module.prepare_runtime(str(self.config),str(install),supervisor)
        self.assertEqual(env.read_text(),'existing\n');self.assertFalse((self.config/'lifecycle').exists())
        env.unlink();(self.config/'lifecycle').mkdir(mode=0o755)
        with self.assertRaises(module.ProvisionError): module.prepare_runtime(str(self.config),str(install),supervisor)
        self.assertTrue((self.config/'lifecycle').is_dir())

    def test_legacy_runtime_requires_matching_managed_running_containers(self):
        install=self.runtime_fixture();(install/'.servus-install').write_text('servus-installer-v1\n');(install/'.servus-install').chmod(0o600)
        data=self.root/'data';data.mkdir(mode=0o700);os.chown(data,1000,1000)
        image='ghcr.io/raxon/servus@sha256:'+'a'*64
        env=self.config/'servus.env';env.write_text('SERVUS_IMAGE='+image+'\nSERVUS_DATA_DIR='+str(data)+'\n');env.chmod(0o600)
        ids=[letter*64 for letter in 'abc'];records=[]
        for role,cid in zip(('api','agent','worker'),ids):
            records.append({'Id':cid,'Image':'sha256:'+'b'*64,
                'Config':{'Image':image,'User':'node','Cmd':['node','dist/'+('server' if role=='api' else role)+'/index.js'],
                          'Labels':{'com.docker.compose.project':'servus','com.docker.compose.service':role}},
                'State':{'Running':True,'Paused':False,'Restarting':False},
                'Mounts':[{'Type':'bind','Source':str(data),'Destination':str(data),'RW':True}]})
        runtime=SimpleNamespace(_read_private_file=runtime_policy._read_private_file,_env=runtime_policy._env,_json=runtime_policy._json,
            _docker=lambda _config,*args: ('\n'.join(ids)+'\n').encode() if args[0]=='ps' else json.dumps(records).encode())
        records[0]['Config']['Image']='unexpected'
        with self.assertRaises(module.ProvisionError):module.prepare_runtime(str(self.config),str(install),supervisor,legacy=True,runtime=runtime)
        self.assertFalse((self.config/'lifecycle').exists())
        records[0]['Config']['Image']=image
        module.prepare_runtime(str(self.config),str(install),supervisor,legacy=True,runtime=runtime)
        self.assertEqual(env.read_text(),'SERVUS_IMAGE='+image+'\nSERVUS_DATA_DIR='+str(data)+'\n')
        self.assertTrue((install/'.lifecycle-enabled-v1').is_file())

    def test_runtime_rejects_changed_state_credentials_and_install_lock(self):
        install=self.runtime_fixture()
        def run(): module.prepare_runtime(str(self.config),str(install),supervisor)
        fd=os.open(install/'install.lock',os.O_RDONLY)
        try:
            fcntl.flock(fd,fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError): run()
        finally: os.close(fd)
        run();state=self.config/'lifecycle/state';state.write_text('maintenance\n');state.chmod(0o644)
        with self.assertRaises(module.ProvisionError): run()
        state.write_text('servus-lifecycle-v1 normal\n');state.chmod(0o644)
        credential=self.config/'supervisor-secrets/api';credential.chmod(0o666)
        with self.assertRaises(supervisor.SupervisorError): run()

    def test_runtime_accepts_only_the_inherited_install_lock_and_keeps_it_held(self):
        install=self.runtime_fixture();lock=install/'install.lock'
        held=os.open(lock,os.O_RDONLY); other=os.open(self.config,os.O_RDONLY)
        try:
            fcntl.flock(held,fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(module.ProvisionError):
                module.prepare_runtime(str(self.config),str(install),supervisor,inherited_lock=other)
            self.assertFalse((self.config/'lifecycle').exists())
            module.prepare_runtime(str(self.config),str(install),supervisor,inherited_lock=held)
            contender=os.open(lock,os.O_RDONLY)
            try:
                with self.assertRaises(BlockingIOError): fcntl.flock(contender,fcntl.LOCK_EX | fcntl.LOCK_NB)
            finally: os.close(contender)
        finally: os.close(other);os.close(held)

    def test_runtime_command_accepts_lock_from_installer_process(self):
        install=self.runtime_fixture();modules=self.root/'modules';modules.mkdir(mode=0o700)
        for name in ('provision-host.py','supervisor.py','supervisor-daemon.py','backup.py','runtime-policy.py'):
            path=modules/name;shutil.copyfile(ROOT/'apps/updater'/name,path);path.chmod(0o644)
        held=os.open(install/'install.lock',os.O_RDONLY)
        try:
            fcntl.flock(held,fcntl.LOCK_EX | fcntl.LOCK_NB)
            args=[sys.executable,'-I',str(modules/'provision-host.py'),'--runtime','--config-dir',str(self.config),
                  '--install-dir',str(install),'--install-lock-fd',str(held)]
            result=subprocess.run(args,pass_fds=(held,),capture_output=True,text=True,timeout=10)
            self.assertEqual(result.returncode,0,result.stderr)
            result=subprocess.run(args,pass_fds=(held,),capture_output=True,text=True,timeout=10)
            self.assertEqual(result.returncode,0,result.stderr)
            contender=os.open(install/'install.lock',os.O_RDONLY)
            try:
                with self.assertRaises(BlockingIOError): fcntl.flock(contender,fcntl.LOCK_EX | fcntl.LOCK_NB)
            finally: os.close(contender)
        finally: os.close(held)

    def test_creates_private_configuration_and_is_idempotent(self):
        self.prepare()
        path=self.config/'updater.env'; contents=path.read_text(); inode=path.stat().st_ino
        self.assertEqual(stat.S_IMODE(path.stat().st_mode),0o600)
        self.assertIn('SERVUS_UPDATER_SOCKET_DIR=/run/servus-updater/control\n',contents)
        self.assertIn('SERVUS_COMPONENT_UID=1000\n',contents)
        for name in ('staging','maintenance','backups','policies','docker-config'):
            value=(self.state/name).stat()
            self.assertEqual((value.st_uid,value.st_gid,stat.S_IMODE(value.st_mode)),(0,0,0o700))
        self.prepare()
        self.assertEqual(path.stat().st_ino,inode);self.assertEqual(path.read_text(),contents)

    def test_existing_configuration_is_not_overwritten(self):
        self.prepare(); path=self.config/'updater.env'; path.write_text('unrelated\n');path.chmod(0o600)
        with self.assertRaises(module.ProvisionError): self.prepare()
        self.assertEqual(path.read_text(),'unrelated\n')

    def test_existing_symlink_and_unsafe_permissions_are_rejected(self):
        self.prepare(); path=self.state/'policies';path.rmdir();path.symlink_to(self.config)
        with self.assertRaises(OSError): self.prepare()
        path.unlink();path.mkdir(mode=0o777);path.chmod(0o777)
        with self.assertRaises(module.ProvisionError): self.prepare()
        self.assertEqual(stat.S_IMODE(path.stat().st_mode),0o777)

    def test_external_docker_configuration_is_never_adopted(self):
        self.prepare(); item=self.state/'docker-config/config.json';item.write_text('{}')
        with self.assertRaises(module.ProvisionError): self.prepare()
        self.assertTrue(item.exists())

    def finalization_fixture(self):
        self.prepare()
        install=self.root/'install';install.mkdir(mode=0o700);(install/'install.lock').touch(mode=0o600)
        gate=self.config/'lifecycle';gate.mkdir(mode=0o755)
        for name, value in (('lock',b''),('state',b'servus-lifecycle-v1 normal\n')):
            path=gate/name;path.write_bytes(value);path.chmod(0o644)
        control=self.config/'supervisor-control';control.mkdir(mode=0o750);os.chown(control,0,1000);control.chmod(0o750)
        secrets=self.config/'supervisor-secrets';secrets.mkdir(mode=0o700)
        for role, digit in zip(supervisor.ROLES,'123'):
            path=secrets/role;path.write_text(digit*64+'\n');os.chown(path,0,1000);path.chmod(0o640)
        node=self.root/'node';node.write_bytes(b'test executable');node.chmod(0o755)
        policies=self.state/'policies';policy=str(policies/'policy.json');snapshot=str(policies/'env.env')
        approved=SimpleNamespace(install_dir=str(install),gate_dir=str(gate),control_dir=str(control),
                                 secret_sources={role:str(secrets/role) for role in supervisor.ROLES},updater_dir='/run/servus-updater/control')
        daemon=SimpleNamespace(resolve_active_policy=mock.Mock(return_value=(policy,snapshot,approved)))
        backup=SimpleNamespace(_verify_node=mock.Mock())
        runtime=SimpleNamespace(_docker=mock.Mock(return_value=b''),_json=json.loads,
                                _installation_lock=runtime_policy._installation_lock)
        return install,node,approved,daemon,backup,runtime

    def test_finalization_binds_supervisor_configuration_and_trusted_node(self):
        install,node,approved,daemon,backup,runtime=self.finalization_fixture()
        arguments=(str(self.config),str(self.state),str(install),str(node),supervisor,daemon,backup,runtime)
        module.finalize(*arguments)
        app=self.config/'update-apply.json';settings=json.loads(app.read_text())
        self.assertEqual(settings['nodeSha256'],hashlib.sha256(node.read_bytes()).hexdigest())
        self.assertEqual(settings['nodePath'],str(node));self.assertIsNone(settings['trustedIngress'])
        daemon_spec=importlib.util.spec_from_file_location('actual_supervisor_daemon', ROOT / 'apps/updater/supervisor-daemon.py')
        daemon_module=importlib.util.module_from_spec(daemon_spec);daemon_spec.loader.exec_module(daemon_module)
        apply=daemon_module.HostApply(str(app),str(self.state/'journal.sqlite'),str(self.config/'servus.env'),object())
        fd=apply._node();os.close(fd)
        self.assertEqual(stat.S_IMODE(app.stat().st_mode),0o600)
        env=self.config/'supervisor.env';contents=env.read_text();self.assertIn('SERVUS_SUPERVISOR_UPDATE_ARGS=',contents)
        self.assertIn(str(self.config/'servus.env'),contents);self.assertIn(str(app),contents)
        inode=env.stat().st_ino;module.finalize(*arguments);self.assertEqual(env.stat().st_ino,inode)
        self.assertEqual(backup._verify_node.call_count,2)

    def test_invalid_policy_or_crypto_probe_does_not_publish_supervisor_config(self):
        install,node,approved,daemon,backup,runtime=self.finalization_fixture()
        arguments=(str(self.config),str(self.state),str(install),str(node),supervisor,daemon,backup,runtime)
        approved.updater_dir='/tmp/forged'
        with self.assertRaises(module.ProvisionError): module.finalize(*arguments)
        self.assertFalse((self.config/'supervisor.env').exists());self.assertFalse((self.config/'update-apply.json').exists())
        approved.updater_dir='/run/servus-updater/control';backup._verify_node.side_effect=RuntimeError('unusable node')
        with self.assertRaises(RuntimeError): module.finalize(*arguments)
        self.assertFalse((self.config/'supervisor.env').exists());self.assertFalse((self.config/'update-apply.json').exists())

    def test_finalization_accepts_installer_lock_and_rejects_another_file(self):
        install,node,approved,daemon,backup,runtime=self.finalization_fixture()
        arguments=(str(self.config),str(self.state),str(install),str(node),supervisor,daemon,backup,runtime)
        held=os.open(install/'install.lock',os.O_RDONLY);wrong=os.open(node,os.O_RDONLY)
        try:
            fcntl.flock(held,fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(runtime_policy.PolicyError): module.finalize(*arguments,inherited_lock=wrong)
            self.assertFalse((self.config/'supervisor.env').exists())
            module.finalize(*arguments,inherited_lock=held)
            contender=os.open(install/'install.lock',os.O_RDONLY)
            try:
                with self.assertRaises(BlockingIOError): fcntl.flock(contender,fcntl.LOCK_EX | fcntl.LOCK_NB)
            finally: os.close(contender)
        finally: os.close(wrong);os.close(held)

    def test_unsafe_control_or_node_and_changed_configuration_are_rejected(self):
        install,node,approved,daemon,backup,runtime=self.finalization_fixture()
        arguments=(str(self.config),str(self.state),str(install),str(node),supervisor,daemon,backup,runtime)
        control=self.config/'supervisor-control';os.chown(control,0,0)
        with self.assertRaises(module.ProvisionError): module.finalize(*arguments)
        os.chown(control,0,1000)
        node.unlink();node.symlink_to('/bin/true')
        with self.assertRaises(OSError): module.finalize(*arguments)
        node.unlink();node.write_bytes(b'test executable');node.chmod(0o755)
        module.finalize(*arguments)
        changed=self.config/'update-apply.json';changed.write_text('changed\n');changed.chmod(0o600)
        with self.assertRaises(module.ProvisionError): module.finalize(*arguments)
        self.assertEqual(changed.read_text(),'changed\n')

    def test_ingress_identity_requires_exact_image_and_readonly_socket(self):
        identifier='a'*64;image='sha256:'+'b'*64
        entry={'Id':identifier,'Image':image,'State':{'Running':True},
               'Config':{'Image':'traefik:3.7.13','Labels':{'com.docker.swarm.service.name':'panel-ingress'}},
               'HostConfig':{'Privileged':False,'PidMode':'','CapAdd':None,'Devices':None,'DeviceRequests':None},
               'Mounts':[{'Source':'/var/run/docker.sock','RW':False}]}
        runtime=SimpleNamespace(_docker=mock.Mock(side_effect=[(identifier+'\n').encode(),json.dumps([entry]).encode()]),_json=json.loads)
        self.assertEqual(module.trusted_ingress('/root/docker',runtime),[identifier,'panel-ingress','traefik:3.7.13',image])
        for change in ('writable','wrong_image','privileged'):
            bad=json.loads(json.dumps(entry))
            if change=='writable': bad['Mounts'][0]['RW']=True
            if change=='wrong_image': bad['Config']['Image']='other:latest'
            if change=='privileged': bad['HostConfig']['Privileged']=True
            runtime=SimpleNamespace(_docker=mock.Mock(side_effect=[(identifier+'\n').encode(),json.dumps([bad]).encode()]),_json=json.loads)
            with self.subTest(change=change), self.assertRaises(module.ProvisionError): module.trusted_ingress('/root/docker',runtime)

    def test_overlapping_or_invalid_paths_are_rejected(self):
        for config,state in ((str(self.config),str(self.config/'nested')),(str(self.config),'/root/../etc'),(str(self.config)+'\t','/root/state')):
            with self.subTest(state=state), self.assertRaises(module.ProvisionError): module.prepare(config,state)


if __name__ == '__main__': unittest.main()
