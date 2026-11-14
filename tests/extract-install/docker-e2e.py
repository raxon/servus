#!/usr/bin/python3
"""Exercise extraction against a disposable local Docker image; requires Linux root."""
import importlib.util
import os
import pathlib
import secrets
import shutil
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('servus_extract_install', ROOT / 'apps/updater/extract-install.py')
extractor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(extractor)


def docker(*args):
    return subprocess.run(['/usr/bin/docker', *args], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          env={**extractor.ENV, 'DOCKER_BUILDKIT': '0'}, timeout=60).stdout.decode().strip()


def main():
    if os.geteuid() != 0:
        raise SystemExit('Linux root is required')
    temporary = tempfile.mkdtemp(prefix='servus-extract-fixture-', dir='/run')
    image = 'servus-extract-fixture:' + secrets.token_hex(12)
    observed = []
    original = extractor._docker
    try:
        context = pathlib.Path(temporary, 'context')
        root = context / 'inputs'
        root.mkdir(parents=True)
        for name, mode in extractor.FILES.items():
            target = root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(('fixture:' + name).encode())
            target.chmod(mode)
        (context / 'Dockerfile').write_text('FROM scratch\nCOPY inputs/ /opt/servus/install/\n')
        docker('build', '--platform=linux/amd64', '--network=none', '--pull=false', '--tag', image, str(context))
        image_id = docker('image', 'inspect', '--format', '{{.Id}}', image)
        staging = pathlib.Path(temporary, 'staging')
        staging.mkdir(mode=0o700)
        def tracked(*args, **kwargs):
            if args[0] == 'cp':
                cid = args[1].split(':', 1)[0]
                assert docker('inspect', '--format', '{{.Image}} {{.State.Status}}', cid) == image_id + ' created'
                observed.append(cid)
            return original(*args, **kwargs)
        extractor._docker = tracked
        result = pathlib.Path(extractor.extract(image_id, str(staging)))
        assert len(observed) == 1
        assert subprocess.run(['/usr/bin/docker', 'inspect', observed[0]], stdout=subprocess.DEVNULL,
                              stderr=subprocess.DEVNULL, env=extractor.ENV).returncode != 0
        actual = {str(path.relative_to(result)) for path in result.rglob('*') if path.is_file()}
        assert actual == set(extractor.FILES)
        for name, mode in extractor.FILES.items():
            file = result / name
            assert file.read_bytes() == ('fixture:' + name).encode()
            assert file.stat().st_mode & 0o7777 == mode
        print('Docker extraction verified: exact file set, modes, stopped probe and cleanup')
    finally:
        subprocess.run(['/usr/bin/docker', 'image', 'rm', image], stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL, env=extractor.ENV, timeout=30)
        shutil.rmtree(temporary)


if __name__ == '__main__':
    main()
