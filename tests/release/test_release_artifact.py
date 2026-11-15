import importlib.util
import configparser
import shlex
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
PREPARE = ROOT / 'scripts/prepare-release-context.py'
VERIFY = ROOT / 'scripts/verify-release-install.py'
spec = importlib.util.spec_from_file_location('verify_release_install', VERIFY)
verify = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verify)
extract_spec = importlib.util.spec_from_file_location('release_extract', ROOT / 'apps/updater/extract-install.py')
extract = importlib.util.module_from_spec(extract_spec)
extract_spec.loader.exec_module(extract)


def archive(items):
    data = io.BytesIO()
    with tarfile.open(fileobj=data, mode='w') as out:
        for name, content, mode, kind in items:
            entry = tarfile.TarInfo(name)
            entry.uid = entry.gid = 0
            entry.mode = mode
            if kind == 'dir':
                entry.type = tarfile.DIRTYPE
                out.addfile(entry)
            elif kind == 'link':
                entry.type = tarfile.SYMTYPE
                entry.linkname = '/etc/passwd'
                out.addfile(entry)
            else:
                entry.size = len(content)
                out.addfile(entry, io.BytesIO(content))
    data.seek(0)
    return data


class ReleaseArtifactTest(unittest.TestCase):
    def test_bootstrap_unit_cannot_dispatch_updates(self):
        def read(name):
            parser = configparser.ConfigParser(interpolation=None, strict=True)
            parser.read(ROOT / 'deployment/systemd' / name)
            return parser
        bootstrap = read('servus-updater-bootstrap.service')
        normal = read('servus-updater.service')
        initial = shlex.split(bootstrap['Service']['ExecStart'])
        final = shlex.split(normal['Service']['ExecStart'])
        self.assertNotIn('--supervisor-socket', initial)
        self.assertIn('--supervisor-socket', final)
        self.assertIn('servus-updater.service', bootstrap['Unit']['Conflicts'].split())
        self.assertIn('servus-updater-socket.service', bootstrap['Unit']['Requires'].split())
        self.assertNotIn('servus-supervisor.service', bootstrap['Unit']['Requires'].split())
        self.assertEqual(bootstrap['Service']['NoNewPrivileges'], 'true')
        self.assertEqual(bootstrap['Service']['EnvironmentFile'], '/etc/servus/updater.env')
        supervisor = read('servus-supervisor.service')
        self.assertIn('/usr/local/libexec/servus/supervisor-daemon.py', shlex.split(supervisor['Service']['ExecStart']))

    def test_stream_rejects_extra_changed_duplicate_and_links(self):
        expected = {'apps/example': (0o755, b'committed')}
        good = [('.', b'', 0o755, 'dir'), ('apps', b'', 0o755, 'dir'), ('apps/example', b'committed', 0o755, 'file')]
        verify.verify_stream(archive(good), expected)
        for bad in [
            good + [('secret', b'x', 0o644, 'file')],
            good[:-1] + [('apps/example', b'modified!', 0o755, 'file')],
            good[:-1] + [('apps/example', b'committed', 0o644, 'file')],
            good + [good[-1]],
            good[:-1] + [('apps/example', b'', 0o755, 'link')],
            good + [('../other', b'x', 0o644, 'file')],
            good[:-1],
        ]:
            with self.subTest(entries=bad):
                with self.assertRaises(ValueError):
                    verify.verify_stream(archive(bad), expected)

    def test_context_comes_from_commit_not_worktree(self):
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory) / 'repo'
            repo.mkdir()
            subprocess.run(['git', 'init', '-q', str(repo)], check=True)
            (repo / 'scripts').mkdir()
            (repo / 'Dockerfile').write_text('FROM alpine:3.21\n')
            (repo / 'scripts/install.sh').write_text('committed\n')
            (repo / 'scripts/install.sh').chmod(0o755)
            (repo / 'scripts/release-install-files.txt').write_text('100644 Dockerfile\n100755 scripts/install.sh\n')
            subprocess.run(['git', 'add', '.'], cwd=repo, check=True)
            subprocess.run(['git', '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture'], cwd=repo, check=True)
            commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=repo, text=True).strip()
            (repo / 'scripts/install.sh').write_text('dirty\n')
            (repo / 'untracked-secret').write_text('secret\n')
            context = Path(directory) / 'context'
            subprocess.run(['python3', str(PREPARE), '--revision', commit, '--output', str(context)], cwd=repo, check=True)
            self.assertEqual((context / '.servus-install/scripts/install.sh').read_text(), 'committed\n')
            self.assertEqual((context / '.servus-install/scripts/install.sh').stat().st_mode & 0o777, 0o755)
            self.assertFalse((context / 'untracked-secret').exists())
            self.assertIn('COPY --chown=0:0 .servus-install/ /opt/servus/install/', (context / 'Dockerfile.release').read_text())
            self.assertNotEqual(subprocess.run(['python3', str(PREPARE), '--revision', 'HEAD', '--output', str(Path(directory) / 'bad')], cwd=repo, capture_output=True).returncode, 0)

            (repo / 'scripts/release-updater-abi.txt').write_text('2\n')
            subprocess.run(['git', 'add', 'scripts/release-updater-abi.txt'], cwd=repo, check=True)
            subprocess.run(['git', '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'require ABI 2'], cwd=repo, check=True)
            next_commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=repo, text=True).strip()
            (repo / 'scripts/release-updater-abi.txt').write_text('1\n')
            next_context = Path(directory) / 'context-abi2'
            subprocess.run(['python3', str(PREPARE), '--revision', next_commit, '--output', str(next_context)], cwd=repo, check=True)
            self.assertEqual(json.loads((next_context / '.servus-install/manifest.json').read_text())['minimumUpdaterAbi'], 2)
            previous = os.getcwd()
            try:
                os.chdir(repo)
                expected = verify.expected_files(next_commit)
                self.assertEqual(json.loads(expected['manifest.json'][1])['minimumUpdaterAbi'], 2)
                self.assertEqual(json.loads(verify.expected_files(commit)['manifest.json'][1])['minimumUpdaterAbi'], 1)
            finally:
                os.chdir(previous)

    @unittest.skipUnless(os.environ.get('SERVUS_RELEASE_DOCKER_TEST') == '1', 'Docker integration is opt-in')
    def test_actual_image_install_files(self):
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory) / 'repo'
            repo.mkdir()
            subprocess.run(['git', 'init', '-q', str(repo)], check=True)
            (repo / 'scripts').mkdir()
            (repo / 'Dockerfile').write_text('FROM scratch\n')
            (repo / 'scripts/install.sh').write_text('committed\n')
            (repo / 'scripts/install.sh').chmod(0o755)
            (repo / 'scripts/release-install-files.txt').write_text('100644 Dockerfile\n100755 scripts/install.sh\n')
            subprocess.run(['git', 'add', '.'], cwd=repo, check=True)
            subprocess.run(['git', '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture'], cwd=repo, check=True)
            commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=repo, text=True).strip()
            context = Path(directory) / 'context'
            subprocess.run(['python3', str(PREPARE), '--revision', commit, '--output', str(context)], cwd=repo, check=True)
            iidfile = Path(directory) / 'image-id'
            subprocess.run(['docker', 'build', '--quiet', '--iidfile', str(iidfile), '-f', str(context / 'Dockerfile.release'), str(context)], check=True, stdout=subprocess.DEVNULL)
            image = iidfile.read_text().strip()
            try:
                subprocess.run(['python3', str(VERIFY), '--revision', commit, '--image-id', image], cwd=repo, check=True)
            finally:
                subprocess.run(['docker', 'image', 'rm', image], check=True, stdout=subprocess.DEVNULL)

    @unittest.skipUnless(os.environ.get('SERVUS_RELEASE_DOCKER_TEST') == '1', 'Docker integration is opt-in')
    def test_same_updater_accepts_two_successive_images_with_new_allowed_file(self):
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory) / 'repo'; repo.mkdir()
            subprocess.run(['git', 'init', '-q', str(repo)], check=True)
            for name, mode in extract.FILES.items():
                target = repo / name; target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text('FROM scratch\n' if name == 'Dockerfile' else 'fixture:' + name)
                target.chmod(mode)
            manifest = repo / 'scripts/release-install-files.txt'
            manifest.write_text(''.join(f'{mode | 0o100000:06o} {name}\n' for name, mode in sorted(extract.FILES.items())))
            images = []
            try:
                for number in (1, 2):
                    if number == 2:
                        future = repo / 'apps/updater/future-helper.py'; future.write_text('fixture:future')
                        with manifest.open('a') as stream: stream.write('100644 apps/updater/future-helper.py\n')
                    subprocess.run(['git', 'add', '.'], cwd=repo, check=True)
                    subprocess.run(['git', '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', f'fixture-{number}'], cwd=repo, check=True)
                    commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=repo, text=True).strip()
                    context = Path(directory) / f'context-{number}'
                    subprocess.run(['python3', str(PREPARE), '--revision', commit, '--output', str(context)], cwd=repo, check=True)
                    iid = Path(directory) / f'image-{number}'
                    subprocess.run(['docker', 'build', '--quiet', '--iidfile', str(iid), '-f', str(context / 'Dockerfile.release'), str(context)], check=True, stdout=subprocess.DEVNULL)
                    image = iid.read_text().strip(); images.append(image)
                    cid = subprocess.check_output(['docker', 'create', '--pull=never', '--network=none', '--entrypoint', '/bin/false', image], text=True).strip()
                    try:
                        payload = subprocess.check_output(['docker', 'cp', cid + ':/opt/servus/install/.', '-'])
                        files = extract._read_archive(payload)
                        self.assertEqual('apps/updater/future-helper.py' in files, number == 2)
                        subprocess.run(['python3', str(VERIFY), '--revision', commit, '--image-id', image,
                                        '--updater', str(ROOT / 'apps/updater/extract-install.py')], cwd=repo, check=True)
                    finally:
                        subprocess.run(['docker', 'rm', '-v', cid], check=True, stdout=subprocess.DEVNULL)
            finally:
                for image in images:
                    subprocess.run(['docker', 'image', 'rm', image], check=True, stdout=subprocess.DEVNULL)


if __name__ == '__main__':
    unittest.main()
