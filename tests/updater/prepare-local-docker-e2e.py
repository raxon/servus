#!/usr/bin/python3 -I
"""Exercise staging against a local image; registry verification is simulated.

Only pull and the repository identity are simulated. Image inspection, probe
creation, extraction and cleanup use the real Docker daemon. This test is not
an attestation or real registry integration test.
"""
import importlib.util
import json
import os
import pathlib
import secrets
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]


def load(name, relative):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    if os.geteuid() != 0:
        raise SystemExit('Linux root is required')
    updater = load('updater', 'apps/updater/servus-updater.py')
    extractor = load('extractor', 'apps/updater/extract-install.py')
    prepare = load('prepare', 'apps/updater/prepare-verified.py')
    image_name = 'servus-prepare-local-fixture:' + secrets.token_hex(12)
    operation_id = '12345678-1234-4123-8123-123456789abc'
    original = extractor._docker
    with tempfile.TemporaryDirectory(prefix='servus-prepare-fixture-', dir='/run') as directory:
        context = pathlib.Path(directory) / 'context'
        inputs = context / 'inputs'
        inputs.mkdir(parents=True)
        for name, mode in extractor.FILES.items():
            path = inputs / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('fixture:' + name)
            path.chmod(mode)
        (context / 'Dockerfile').write_text('FROM scratch\nCOPY inputs/ /opt/servus/install/\n')
        docker_env = {**extractor.ENV, 'DOCKER_BUILDKIT': '0'}
        def docker(*args):
            return subprocess.check_output(['/usr/bin/docker', *args], env=docker_env, stderr=subprocess.DEVNULL, text=True).strip()
        try:
            docker('build', '--platform=linux/amd64', '--network=none', '--pull=false', '--tag', image_name, str(context))
            info = json.loads(docker('image', 'inspect', '--format', '{{json .}}', image_name))
            image_id = info['Id']
            if not image_id.startswith('sha256:') or len(image_id) != 71:
                raise AssertionError('Invalid local image identity')
            # Docker containerd uses a manifest/index digest; classic storage
            # uses the image config digest. The other value is synthetic here.
            descriptor = info.get('Descriptor') or {}
            containerd = descriptor.get('digest') == image_id
            root_digest = image_id if containerd else 'sha256:' + 'b' * 64
            config_digest = 'sha256:' + 'c' * 64 if containerd else image_id
            reference = prepare.IMAGE + '@' + root_digest
            staging = pathlib.Path(directory) / 'staging'
            staging.mkdir(mode=0o700)
            journal = updater.Journal(pathlib.Path(directory))
            try:
                journal.submit(operation_id, 'a' * 40, root_digest, 'v1.2.3')
                attempt = journal.claim()
                # This fixture does not verify a signature or contact a registry.
                journal.finish(attempt, 'verified', config_digest)
                calls = []
                def fake_registry(*args, **kwargs):
                    if args[0] == 'pull':
                        assert args[1:] == ('--platform=linux/amd64', reference)
                        calls.append('synthetic-pull')
                        return b''
                    if args[:2] == ('image', 'inspect') and args[-1] == reference:
                        actual = json.loads(original('image', 'inspect', '--platform=linux/amd64', '--format', '{{json .}}', image_id))
                        actual['RepoDigests'] = [reference]
                        calls.append('synthetic-registry-identity')
                        return json.dumps(actual).encode()
                    calls.append(args[0])
                    return original(*args, **kwargs)
                extractor._docker = fake_registry
                stage = pathlib.Path(prepare.prepare_verified(journal, operation_id, str(staging), extractor))
                assert journal.db.execute('SELECT status,staging_path FROM preparations').fetchone() == ('prepared', str(stage))
                assert set(str(p.relative_to(stage)) for p in stage.rglob('*') if p.is_file()) == set(extractor.FILES)
                for name in extractor.FILES:
                    assert (stage / name).read_text() == 'fixture:' + name
                assert calls.count('create') == calls.count('cp') == calls.count('rm') == 1
                print(('containerd' if containerd else 'classic') + ' Docker: local image prepared and extracted; registry identity simulated')
            finally:
                extractor._docker = original
                journal.close()
        finally:
            subprocess.run(['/usr/bin/docker', 'image', 'rm', image_name], env=docker_env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


if __name__ == '__main__':
    main()
