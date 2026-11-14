#!/usr/bin/python3 -I
"""Exercise OCI index preparation against a private registry without an attestation."""
import importlib.util
import hashlib
import json
import os
import pathlib
import re
import secrets
import shutil
import subprocess
import tempfile
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[2]
ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'HOME': '/root', 'DOCKER_HOST': 'unix:///var/run/docker.sock', 'DOCKER_CONFIG': '/dev/null', 'LANG': 'C'}


def docker(*args):
    return subprocess.check_output(['/usr/bin/docker', *args], env=ENV, text=True, timeout=120).strip()


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    if name == 'supervisor':
        import sys
        sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


def main():
    if os.geteuid() != 0:
        raise SystemExit('Linux root is required')
    marker = secrets.token_hex(8)
    registry_name = 'servus-policy-registry-' + marker
    container_id = ''
    data = pathlib.Path('/var/lib/servus-policy-data-' + marker)
    etc = pathlib.Path('/etc/servus-policy-fixture-' + marker)
    with tempfile.TemporaryDirectory(prefix='servus-policy-fixture-', dir='/run') as directory:
        base = pathlib.Path(directory)
        docker_config = base / 'docker-client'; docker_config.mkdir(mode=0o700)
        ENV['DOCKER_CONFIG'] = str(docker_config)
        runtime = base / 'runtime'; runtime.mkdir(mode=0o700)
        for name in ('extract-install.py', 'servus-updater.py', 'verify-release.py'):
            shutil.copyfile(ROOT / 'apps/updater' / name, runtime / name)
        extractor = load('extractor', runtime / 'extract-install.py')
        updater = load('updater', runtime / 'servus-updater.py')
        verifier = load('verifier', runtime / 'verify-release.py')
        shutil.copyfile(ROOT / 'apps/updater/prepare-verified.py', runtime / 'prepare-verified.py')
        preparer = load('preparer', runtime / 'prepare-verified.py')
        source = base / 'source'; source.mkdir(mode=0o700)
        context = source / 'inputs'; context.mkdir()
        for name, mode in extractor.FILES.items():
            destination = context / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / name, destination)
            destination.chmod(mode)
        records = []
        for name, mode in sorted(extractor.FILES.items()):
            contents = (context / name).read_bytes()
            records.append({'path': name, 'type': 'file', 'mode': mode, 'size': len(contents), 'sha256': hashlib.sha256(contents).hexdigest()})
        (context / 'manifest.json').write_text(json.dumps({'schema': 1, 'minimumUpdaterAbi': 1, 'files': records}, sort_keys=True, separators=(',', ':')) + '\n')
        (source / 'Dockerfile').write_text('FROM node:24-bookworm-slim\nWORKDIR /app\nENV NODE_ENV=production PANEL_DATA_DIR=/var/lib/panel PANEL_HOST=0.0.0.0 PANEL_PORT=4180\nCOPY inputs/ /opt/servus/install/\nUSER node\n')
        try:
            container_id = docker('run', '-d', '--name', registry_name, '-p', '127.0.0.1::5000', 'registry:2')
            port = docker('port', container_id, '5000/tcp').rsplit(':', 1)[1]
            image_name = '127.0.0.1:' + port + '/servus'
            preparer.IMAGE = image_name
            tag = image_name + ':fixture'
            docker('build', '--platform=linux/amd64', '--network=none', '--pull=false', '-t', tag, str(source))
            push = subprocess.check_output(['/usr/bin/docker', 'push', tag], env=ENV, stderr=subprocess.STDOUT, text=True, timeout=120)
            match = re.search(r'digest: (sha256:[a-f0-9]{64})', push)
            if not match: raise AssertionError('Registry did not return a digest')
            digest = match.group(1); reference = image_name + '@' + digest
            docker('pull', '--platform=linux/amd64', reference)
            info = json.loads(docker('image', 'inspect', '--format', '{{json .}}', reference))
            selected = json.loads(docker('image', 'inspect', '--platform=linux/amd64', '--format', '{{json .}}', reference))
            image_id = info['Id']
            manifest_url = 'http://127.0.0.1:' + port + '/v2/servus/manifests/'
            headers = {'Accept': 'application/vnd.oci.image.index.v1+json,application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.docker.distribution.manifest.v2+json'}
            def manifest(ref):
                with urllib.request.urlopen(urllib.request.Request(manifest_url + ref, headers=headers), timeout=5) as reply:
                    return json.load(reply)
            root_manifest = manifest(digest)
            if 'manifests' in root_manifest:
                children = [item for item in root_manifest['manifests'] if item.get('platform', {}).get('os') == 'linux' and item.get('platform', {}).get('architecture') == 'amd64']
                assert len(children) == 1
                root_manifest = manifest(children[0]['digest'])
            config_digest = root_manifest['config']['digest']
            class LocalRegistry:
                def manifest(self, ref):
                    request = urllib.request.Request(manifest_url + ref, headers=headers)
                    with urllib.request.urlopen(request, timeout=5) as reply: return reply.read()
                def blob(self, ref):
                    with urllib.request.urlopen('http://127.0.0.1:' + port + '/v2/servus/blobs/' + ref, timeout=5) as reply: return reply.read()
            resolve_child = lambda root, config: verifier.revalidate_amd64_identity(LocalRegistry(), root, config)
            etc.mkdir(mode=0o700)
            staging = etc / 'staging'; staging.mkdir(mode=0o700)
            journal_dir = etc / 'journal'; journal_dir.mkdir(mode=0o700)
            journal = updater.Journal(journal_dir)
            operation = '12345678-1234-4123-8123-123456789abc'
            try:
                journal.submit(operation, 'a'*40, digest, 'v1.2.3')
                attempt = journal.claim(); journal.finish(attempt, 'verified', config_digest)
                preparer.prepare_verified(journal, operation, str(staging), extractor, resolve_child=resolve_child)
                row = journal.db.execute('SELECT status,staging_path FROM preparations').fetchone()
                assert row[0] == 'prepared'
                extracted = pathlib.Path(row[1])
                assert set(str(path.relative_to(extracted)) for path in extracted.rglob('*') if path.is_file()) == set(extractor.FILES) | {'manifest.json'}
                print('Prepared an OCI index from a real local registry; attestation was simulated')
            finally:
                journal.close()
        finally:
            if container_id:
                subprocess.run(['/usr/bin/docker', 'rm', '-f', container_id], env=ENV, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            for image in (locals().get('reference'), locals().get('tag')):
                if image: subprocess.run(['/usr/bin/docker', 'image', 'rm', image], env=ENV, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            shutil.rmtree(data, ignore_errors=True)
            shutil.rmtree(etc, ignore_errors=True)


if __name__ == '__main__': main()
