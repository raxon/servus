import importlib.util
import json
import hashlib
from types import SimpleNamespace
from unittest import mock
import os
from pathlib import Path
import stat
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('provision_host', ROOT / 'apps/updater/provision-host.py')
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
sys.path.insert(0, str(ROOT / 'apps/updater'))
import supervisor


@unittest.skipUnless(sys.platform == 'linux' and os.geteuid() == 0, 'Requires isolated Linux root')
class HostProvisioningTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir='/root'); self.root = Path(self.temp.name)
        self.config = self.root/'config'; self.config.mkdir(mode=0o700)
        self.state = self.root/'state'

    def tearDown(self): self.temp.cleanup()

    def prepare(self): module.prepare(str(self.config),str(self.state))

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
        runtime=SimpleNamespace(_docker=mock.Mock(return_value=b''),_json=json.loads)
        return install,node,approved,daemon,backup,runtime

    def test_finalization_binds_supervisor_configuration_and_trusted_node(self):
        install,node,approved,daemon,backup,runtime=self.finalization_fixture()
        arguments=(str(self.config),str(self.state),str(install),str(node),supervisor,daemon,backup,runtime)
        module.finalize(*arguments)
        app=self.config/'update-apply.json';settings=json.loads(app.read_text())
        self.assertEqual(settings['nodeSha256'],hashlib.sha256(node.read_bytes()).hexdigest())
        self.assertEqual(settings['nodePath'],str(node));self.assertIsNone(settings['trustedIngress'])
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
