import importlib.util
import json
import pathlib
import tempfile
import unittest
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('quiescence', ROOT / 'apps/updater/quiescence.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class MountTopologyTest(unittest.TestCase):
    def test_rejects_aliases_and_nested_mounts(self):
        base = '1 0 8:1 / / rw - ext4 /dev/root rw\n'
        module.check_mount_topology('/var/lib/servus', base + '2 1 8:1 /var/lib/else /mnt/else rw - ext4 /dev/root rw\n')
        for mount in ('2 1 8:1 /var/lib/servus /mnt/alias rw - ext4 /dev/root rw\n',
                      '2 1 0:50 / /var/lib/servus/secrets rw - tmpfs tmpfs rw\n',
                      '2 1 8:1 net:[1] /run/netns/test rw - nsfs nsfs rw\n'):
            with self.subTest(mount=mount), self.assertRaises(module.QuiescenceError):
                module.check_mount_topology('/var/lib/servus', base + mount)
        module.check_mount_topology('/var/lib/servus', base + '2 1 0:51 net:[1] /run/netns/test rw - nsfs nsfs rw\n')

    def test_rejects_invalid_topology_and_escaped_alias(self):
        for value in ('', 'bad line', '1 0 8:1 / / rw - ext4 /dev/root rw\n2 1 8:1 /var/lib/servus /mnt/alias\\777 rw - ext4 /dev/root rw\n'):
            with self.subTest(value=value), self.assertRaises(module.QuiescenceError):
                module.check_mount_topology('/var/lib/servus', value)
        with self.assertRaises(module.QuiescenceError):
            module.check_mount_topology('/', '1 0 8:1 / / rw - ext4 /dev/root rw\n')


class ProcessInventoryTest(unittest.TestCase):
    def test_detects_each_effective_uid_and_rejects_missing_status(self):
        with tempfile.TemporaryDirectory() as temp:
            proc = pathlib.Path(temp)
            process = proc / '123'; process.mkdir()
            status = process / 'status'
            status.write_text('Name:\ttest\nUid:\t2\t2\t2\t2\n')
            module.ensure_no_uid_writers(1000, proc=proc)
            for values in ('1000 2 2 2', '2 1000 2 2', '2 2 1000 2', '2 2 2 1000', '2 2'):
                status.write_text('Uid:\t' + values + '\n')
                with self.subTest(values=values), self.assertRaises(module.QuiescenceError):
                    module.ensure_no_uid_writers(1000, proc=proc)
            status.write_text('Name:\ttest\n')
            with self.assertRaises(module.QuiescenceError):
                module.ensure_no_uid_writers(1000, proc=proc)
            with self.assertRaises(module.QuiescenceError):
                module.ensure_no_uid_writers(0, proc=proc)

    def test_rejects_open_and_mapped_files_and_process_cwd(self):
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp).resolve(); data = root / 'data'; data.mkdir()
            proc = root / 'proc'; proc.mkdir(); process = proc / '123'; process.mkdir()
            fds = process / 'fd'; fds.mkdir()
            maps = process / 'maps'; maps.write_text('')
            module.ensure_no_open_data(data, proc=proc, own_pid=999)
            descriptor = fds / '3'; descriptor.symlink_to(data / 'panel.sqlite')
            with self.assertRaises(module.QuiescenceError):
                module.ensure_no_open_data(data, proc=proc, own_pid=999)
            descriptor.unlink()
            maps.write_text('1000-2000 r--p 00000000 00:00 0 ' + str(data / 'agent.sqlite') + '\n')
            with self.assertRaises(module.QuiescenceError):
                module.ensure_no_open_data(data, proc=proc, own_pid=999)
            maps.write_text('')
            (process / 'cwd').symlink_to(data)
            with self.assertRaises(module.QuiescenceError):
                module.ensure_no_open_data(data, proc=proc, own_pid=999)


class DockerInventoryTest(unittest.TestCase):
    def setUp(self):
        self.ids = {char * 64 for char in 'abc'}
        self.items = [{'Id': ident, 'State': {'Running': False, 'Paused': False, 'Restarting': False},
                       'Mounts': [{'Source': '/var/lib/servus', 'RW': True}]} for ident in self.ids]
        self.ingress = {'Id': 'd' * 64, 'Image': 'sha256:' + 'e' * 64,
                        'Config': {'Image': 'traefik:3.7.13', 'Labels': {'com.docker.swarm.service.name': 'panel-ingress'}},
                        'HostConfig': {'Privileged': False},
                        'Mounts': [{'Source': '/var/run/docker.sock', 'RW': False}]}
        self.items.append(self.ingress)
        self.docker = mock.Mock()
        self.docker.call.return_value = ('\n'.join(item['Id'] for item in self.items) + '\n').encode()
        self.docker.inspect.return_value = self.items
        self.trusted = ('panel-ingress', 'traefik:3.7.13', 'sha256:' + 'e' * 64)

    def check(self):
        module.ensure_no_other_data_mounts(self.docker, self.ids, '/var/lib/servus', trusted_ingress=self.trusted)

    def test_requires_exact_ingress_identity_and_no_extra_access(self):
        self.check()
        self.ingress['Image'] = 'sha256:' + 'f' * 64
        with self.assertRaises(module.QuiescenceError): self.check()
        self.ingress['Image'] = self.trusted[2]
        self.ingress['HostConfig']['PidMode'] = 'host'
        with self.assertRaises(module.QuiescenceError): self.check()
        self.ingress['HostConfig']['PidMode'] = ''
        self.ingress['Mounts'].append({'Source': '/var/lib/servus/secrets', 'RW': False})
        with self.assertRaises(module.QuiescenceError): self.check()

    def test_rejects_active_or_changed_role_and_incomplete_inventory(self):
        self.items[0]['State']['Running'] = True
        with self.assertRaises(module.QuiescenceError): self.check()
        self.items[0]['State']['Running'] = False
        self.items[0]['Mounts'] = []
        with self.assertRaises(module.QuiescenceError): self.check()
        self.items[0]['Mounts'] = [{'Source': '/var/lib/servus', 'RW': True}]
        self.docker.inspect.return_value = self.items[:-1]
        with self.assertRaises(module.QuiescenceError): self.check()

    def test_rejects_volume_aliases(self):
        self.docker.call.side_effect = [b'fixture\n', json.dumps([{'Driver': 'local', 'Options': {'type': 'none', 'device': '/var/lib/servus'}}]).encode()]
        with mock.patch.object(module, 'check_mount_topology'), mock.patch.object(module.os, 'stat') as stat, mock.patch.object(module.pathlib.Path, 'read_text', return_value=''):
            stat.return_value.st_ino = 1
            with self.assertRaises(module.QuiescenceError):
                module.ensure_no_mount_aliases(self.docker, '/var/lib/servus')


if __name__ == '__main__':
    unittest.main()
