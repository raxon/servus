#!/usr/bin/python3 -I
"""Exercise policy generation on an isolated Docker host and private registry."""
import importlib.util
import json
import os
import pathlib
import re
import secrets
import shutil
import signal
import socket
import sqlite3
import subprocess
import tempfile
import time
import uuid
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


def systemd_compose_fixture(runtime, image_name, env_file, approved_env, active, journal_dir, install, gate, control, secrets_dir, compose_file, policy, supervisor):
    """Use a unique transient unit and only an otherwise absent servus project."""
    if docker('ps', '-a', '--filter', 'label=com.docker.compose.project=servus', '--format', '{{.ID}}'):
        raise RuntimeError('A servus project already exists on the fixture host')
    network = subprocess.run(['/usr/bin/docker', 'network', 'inspect', 'servus_default'], env=ENV, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if network.returncode == 0:
        raise RuntimeError('A servus network already exists on the fixture host')
    marker = secrets.token_hex(8)
    unit = 'servus-policy-fixture-' + marker + '.service'
    unit_path = pathlib.Path('/run/systemd/system') / unit
    maintenance = active.parent.parent / 'maintenance'; maintenance.mkdir(mode=0o700)
    daemon_file = runtime / 'supervisor-daemon.py'
    daemon_source = daemon_file.read_text().replace("APPROVED_IMAGE = 'ghcr.io/raxon/servus'", 'APPROVED_IMAGE = ' + repr(image_name))
    daemon_source = daemon_source.replace("except (supervisor.SupervisorError, OSError, ValueError):\n        try:\n            supervisor._send_message(connection, {'version': 1, 'status': 'failed'}", "except (supervisor.SupervisorError, OSError, ValueError) as error:\n        print('Fixture command failure:', error, flush=True)\n        try:\n            supervisor._send_message(connection, {'version': 1, 'status': 'failed'}")
    daemon_file.write_text(daemon_source)
    supervisor_file = runtime / 'supervisor.py'
    source = supervisor_file.read_text()
    start = source.index('IMAGE_REFERENCE = re.compile(')
    end = source.index('\n', start)
    source = source[:start] + 'IMAGE_REFERENCE = re.compile(' + repr(re.escape(image_name) + r'@sha256:[0-9a-f]{64}$') + ')' + source[end:]
    supervisor_file.write_text(source)
    command = ['/usr/bin/python3', '-I', str(daemon_file), '--policy', str(active), '--install-dir', str(install),
               '--gate-dir', str(gate), '--journal-dir', str(maintenance), '--secret-dir', str(secrets_dir),
               '--socket-dir', str(control), '--approval-journal', str(journal_dir / 'journal.sqlite'),
               '--accepted-env', str(approved_env), '--uid', '1000', '--gid', '1000']
    unit_path.write_text('[Unit]\nDescription=Servus isolated policy fixture\n[Service]\nType=simple\nExecStart=' + ' '.join(command) + '\nRestart=no\n')
    compose_args = ('compose', '--env-file', str(env_file), '-f', str(compose_file), '-p', 'servus')
    original_env = approved_env.read_bytes()
    try:
        subprocess.run(['systemctl', 'daemon-reload'], check=True)
        subprocess.run(['systemctl', 'start', unit], check=True)
        deadline = time.monotonic() + 20
        while not (control / 'command').is_socket() and time.monotonic() < deadline: time.sleep(0.1)
        assert (control / 'command').is_socket(), 'Supervisor did not open its command socket'
        subprocess.run(['systemctl', 'stop', unit], check=True)
        approved_env.write_bytes(original_env + b'\n')
        subprocess.run(['systemctl', 'start', unit], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.monotonic() + 10
        while subprocess.run(['systemctl', 'is-active', '--quiet', unit]).returncode == 0 and time.monotonic() < deadline: time.sleep(0.1)
        assert subprocess.run(['systemctl', 'is-active', '--quiet', unit]).returncode != 0
        assert not (control / 'command').exists()
        approved_env.write_bytes(original_env)
        subprocess.run(['systemctl', 'reset-failed', unit], check=True)
        subprocess.run(['systemctl', 'start', unit], check=True)
        deadline = time.monotonic() + 20
        while not (control / 'command').is_socket() and time.monotonic() < deadline: time.sleep(0.1)
        assert (control / 'command').is_socket()
        docker(*compose_args, 'up', '-d')
        def request_status():
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
                connection.settimeout(2)
                connection.connect(str(control / 'command'))
                connection.sendall(b'{"version":1,"type":"status"}\n')
                return json.loads(connection.recv(8192))
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            try:
                if request_status().get('status') == 'ready': break
            except (OSError, ValueError):
                pass
            time.sleep(0.2)
        else:
            raise AssertionError('The supervisor did not accept three control clients')
        def request_stop():
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
                connection.settimeout(40)
                connection.connect(str(control / 'command'))
                message = {'version': 1, 'type': 'stop', 'operationId': str(uuid.uuid4()), 'timeoutMs': 30000}
                connection.sendall(json.dumps(message).encode() + b'\n')
                return json.loads(connection.recv(8192))
        approved_env.write_bytes(original_env + b'\n')
        assert request_status()['status'] == 'waiting'
        assert request_stop()['status'] == 'failed'
        assert not (maintenance / 'maintenance.json').exists()
        approved_env.write_bytes(original_env)
        source_before = env_file.read_bytes()
        assert source_before == original_env
        env_file.write_bytes(source_before + b'\n')
        assert approved_env.read_bytes() == original_env
        assert request_status()['status'] == 'waiting'
        assert request_stop()['status'] == 'failed'
        assert not (maintenance / 'maintenance.json').exists()
        env_file.write_bytes(source_before)
        assert request_status()['status'] == 'ready'
        with sqlite3.connect(journal_dir / 'journal.sqlite') as db:
            db.execute("UPDATE preparations SET status='recovery_required'")
        assert request_status()['status'] == 'waiting'
        assert request_stop()['status'] == 'failed'
        assert not (maintenance / 'maintenance.json').exists()
        with sqlite3.connect(journal_dir / 'journal.sqlite') as db:
            db.execute("UPDATE preparations SET status='prepared'")
            approved_operation = db.execute("SELECT operation_id FROM policy_approvals WHERE state='active'").fetchone()[0]
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
            connection.settimeout(40)
            connection.connect(str(control / 'command'))
            connection.sendall(json.dumps({'version':1, 'type':'complete', 'operationId':approved_operation}).encode() + b'\n')
            complete_result = json.loads(connection.recv(8192))
            if complete_result.get('status') != 'completed':
                subprocess.run(['journalctl', '-u', unit, '--no-pager', '-n', '20'])
                raise AssertionError('Supervisor did not complete healthy preparation')
        with sqlite3.connect(journal_dir / 'journal.sqlite') as db:
            assert db.execute('SELECT status FROM preparations').fetchone()[0] == 'completed'
        deadline = time.monotonic() + 100
        response = None
        while time.monotonic() < deadline:
            try:
                response = request_stop()
                if response.get('status') == 'stopped_unverified': break
            except (OSError, ValueError):
                pass
            time.sleep(1)
        assert response and response.get('status') == 'stopped_unverified', 'Supervisor did not drain all three components'
        assert (maintenance / 'maintenance.json').exists()
        assert (gate / 'state').read_text() == 'servus-lifecycle-v1 maintenance\n'
        ids = docker('ps', '-a', '--filter', 'label=com.docker.compose.project=servus', '--format', '{{.ID}}').splitlines()
        assert len(ids) == 3
        assert all(docker('inspect', '--format', '{{.State.Running}}', cid) == 'false' for cid in ids)
        subprocess.run(['systemctl', 'stop', unit], check=True)
        subprocess.run(['systemctl', 'start', unit], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.monotonic() + 10
        while subprocess.run(['systemctl', 'is-active', '--quiet', unit]).returncode == 0 and time.monotonic() < deadline: time.sleep(0.1)
        assert subprocess.run(['systemctl', 'is-active', '--quiet', unit]).returncode != 0
        print('systemd supervisor rejected changed configuration, drained Compose roles, and blocked restart after maintenance')
    finally:
        approved_env.write_bytes(original_env)
        subprocess.run(['/usr/bin/docker', *compose_args, 'down', '--remove-orphans'], env=ENV, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60)
        subprocess.run(['systemctl', 'stop', unit], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        unit_path.unlink(missing_ok=True)
        subprocess.run(['systemctl', 'daemon-reload'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


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
        for name in ('supervisor.py', 'supervisor-daemon.py', 'extract-install.py', 'runtime-policy.py', 'validate-compose.py', 'servus-updater.py', 'verify-release.py'):
            shutil.copyfile(ROOT / 'apps/updater' / name, runtime / name)
        supervisor = load('supervisor', runtime / 'supervisor.py')
        extractor = load('extractor', runtime / 'extract-install.py')
        generator = load('generator', runtime / 'runtime-policy.py')
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
        app = source / 'app'; (app / 'dist/shared').mkdir(parents=True)
        shutil.copyfile(ROOT / 'deployment/lifecycle-gate.sh', app / 'lifecycle-gate.sh')
        for name in ('supervisor-control.js', 'supervisor-entrypoint.js'):
            shutil.copyfile(ROOT / 'apps/panel/dist/shared' / name, app / 'dist/shared' / name)
        shutil.copytree(ROOT / 'node_modules/zod', app / 'node_modules/zod')
        (app / 'package.json').write_text('{"type":"module"}\n')
        client = '''import {supervisorConfig,startSupervisorControl} from '../shared/supervisor-entrypoint.js';
import {createServer} from 'node:http';
const role=process.argv[1].includes('/server/')?'api':process.argv[1].includes('/worker/')?'worker':'agent';
startSupervisorControl(supervisorConfig(process.env),role,async()=>({status:'drained'}));
if(role==='api')createServer((_,res)=>{res.writeHead(200);res.end('ok')}).listen(4180,'0.0.0.0');
setInterval(()=>{},1000);process.on('SIGTERM',()=>process.exit(0));
'''
        for component in ('server', 'worker', 'agent'):
            directory = app / 'dist' / component; directory.mkdir()
            (directory / 'index.js').write_text(client)
        (app / 'dist/agent/client.js').write_text('export async function runtimeStatus(){return {online:true}}\n')
        (source / 'Dockerfile').write_text('FROM node:24-bookworm-slim\nWORKDIR /app\nENV NODE_ENV=production PANEL_DATA_DIR=/var/lib/panel PANEL_HOST=0.0.0.0 PANEL_PORT=4180\nCOPY inputs/ /opt/servus/install/\nCOPY app/ /app/\nUSER node\n')
        try:
            container_id = docker('run', '-d', '--name', registry_name, '-p', '127.0.0.1::5000', 'registry:2')
            port = docker('port', container_id, '5000/tcp').rsplit(':', 1)[1]
            image_name = '127.0.0.1:' + port + '/servus'
            generator.IMAGE = image_name
            preparer.IMAGE = image_name
            supervisor.IMAGE_REFERENCE = re.compile(re.escape(image_name) + r'@sha256:[a-f0-9]{64}$')
            daemon = load('fixture_daemon', runtime / 'supervisor-daemon.py')
            daemon.APPROVED_IMAGE = image_name
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
            etc.mkdir(mode=0o700); data.mkdir(mode=0o700); os.chown(data, 1000, 1000)
            gate = etc / 'gate'; control = etc / 'control'; secrets_dir = etc / 'secrets'; install = etc / 'install'
            for path in (gate, control, secrets_dir, install): path.mkdir(mode=0o700)
            gate.chmod(0o755); control.chmod(0o750); os.chown(control, 0, 1000)
            (gate / 'lock').touch(mode=0o644); (gate / 'state').write_text('servus-lifecycle-v1 normal\n')
            (gate / 'state').chmod(0o644)
            (install / 'install.lock').touch(mode=0o600)
            for role in generator.ROLES:
                (secrets_dir / role).write_text(secrets.token_hex(32))
                (secrets_dir / role).chmod(0o640); os.chown(secrets_dir / role, 0, 1000)
            staging = etc / 'staging'; staging.mkdir(mode=0o700)
            journal_dir = etc / 'journal'; journal_dir.mkdir(mode=0o700)
            output = etc / 'output'; output.mkdir(mode=0o700)
            env_file = etc / 'servus.env'
            docker_gid = os.stat('/var/run/docker.sock').st_gid
            env_file.write_text('\n'.join([
                'SERVUS_IMAGE=' + reference, 'SERVUS_DATA_DIR=' + str(data),
                'SERVUS_LIFECYCLE_DIR=' + str(gate), 'SERVUS_SUPERVISOR_CONTROL_DIR=' + str(control),
                'SERVUS_SUPERVISOR_SECRET_DIR=' + str(secrets_dir), 'SERVUS_DOCKER_GID=' + str(docker_gid),
                'SERVUS_BIND_ADDRESS=127.0.0.1', 'SERVUS_PORT=4180', 'SERVUS_ALLOWED_ORIGINS=http://localhost:4180',
                'SERVUS_TRUSTED_PROXY_SECRET=' + 'f'*64, '']))
            env_file.chmod(0o600)
            journal = updater.Journal(journal_dir)
            operation = '12345678-1234-4123-8123-123456789abc'
            try:
                journal.submit(operation, 'a'*40, digest, 'v1.2.3')
                attempt = journal.claim(); journal.finish(attempt, 'verified', config_digest)
                preparer.prepare_verified(journal, operation, str(staging), extractor, resolve_child=resolve_child)
                preparation_id = journal.db.execute('SELECT preparation_id FROM preparations').fetchone()[0]
                path = generator.produce(journal, operation, str(staging), str(env_file), str(install), str(output / ('candidate-' + preparation_id + '.json')), extractor, supervisor, resolve_child=resolve_child)
                document = json.loads(pathlib.Path(path).read_text())
                assert document['policy']['image_id'] in (image_id, selected['Id'])
                assert set(document['policy']['host_configs']) == set(generator.ROLES)
                assert journal.db.execute('SELECT status FROM preparations').fetchone()[0] == 'prepared'
                probe = journal.db.execute('SELECT project,config_digest,state FROM policy_probes').fetchone()
                assert re.fullmatch(r'servusprobe[a-f0-9]{32}', probe[0]) and probe[2] == 'removed'
                approved_env = pathlib.Path(journal.db.execute('SELECT accepted_env_path FROM policy_approvals WHERE operation_id=?', (operation,)).fetchone()[0])
                assert approved_env != env_file and approved_env.read_bytes() == env_file.read_bytes()
                active = output / 'policy.json'
                generator.activate(journal, operation, str(env_file), path, str(active), str(install), str(control), extractor, supervisor)
                loaded = daemon.load_approved_policy(str(active), str(journal_dir / 'journal.sqlite'), str(approved_env))
                assert loaded.image_id == document['policy']['image_id']
                original_env = approved_env.read_bytes()
                approved_env.write_bytes(original_env + b'\n')
                try:
                    try: daemon.load_approved_policy(str(active), str(journal_dir / 'journal.sqlite'), str(approved_env))
                    except supervisor.SupervisorError: pass
                    else: raise AssertionError('Changed accepted environment was allowed')
                finally:
                    approved_env.write_bytes(original_env)
                assert daemon.load_approved_policy(str(active), str(journal_dir / 'journal.sqlite'), str(approved_env))
                systemd_compose_fixture(runtime, image_name, env_file, approved_env, active, journal_dir, install, gate, control,
                                        secrets_dir, context / 'deployment/compose.yaml', loaded, supervisor)
                # A second image is actually built and pushed to the fixture
                # registry. Its root and config digests must both change.
                with (source / 'Dockerfile').open('a') as dockerfile:
                    dockerfile.write('LABEL io.servus.fixture.release=second\n')
                next_tag = image_name + ':next'
                docker('build', '--platform=linux/amd64', '--network=none', '--pull=false', '-t', next_tag, str(source))
                next_push = subprocess.check_output(['/usr/bin/docker', 'push', next_tag], env=ENV, stderr=subprocess.STDOUT, text=True, timeout=120)
                next_match = re.search(r'digest: (sha256:[a-f0-9]{64})', next_push)
                assert next_match
                next_digest = next_match.group(1)
                assert next_digest != digest
                next_reference = image_name + '@' + next_digest
                next_manifest = manifest(next_digest)
                if 'manifests' in next_manifest:
                    children = [item for item in next_manifest['manifests'] if item.get('platform', {}).get('os') == 'linux' and item.get('platform', {}).get('architecture') == 'amd64']
                    assert len(children) == 1
                    next_manifest = manifest(children[0]['digest'])
                next_config_digest = next_manifest['config']['digest']
                assert next_config_digest != config_digest
                next_env = etc / 'next.env'
                next_env.write_text(env_file.read_text().replace(reference, next_reference)); next_env.chmod(0o600)
                next_operation = str(uuid.uuid4())
                assert journal.submit(next_operation, 'b'*40, next_digest, 'v1.2.4')['status'] == 'accepted'
                next_attempt = journal.claim(); journal.finish(next_attempt, 'verified', next_config_digest)
                preparer.prepare_verified(journal, next_operation, str(staging), extractor, resolve_child=resolve_child)
                next_preparation = journal.db.execute('SELECT preparation_id FROM preparations WHERE operation_id=?', (next_operation,)).fetchone()[0]
                next_candidate = output / ('candidate-' + next_preparation + '.json')
                generator.produce(journal, next_operation, str(staging), str(next_env), str(install), str(next_candidate), extractor, supervisor, resolve_child=resolve_child)
                next_snapshot = pathlib.Path(journal.db.execute('SELECT accepted_env_path FROM policy_approvals WHERE operation_id=?', (next_operation,)).fetchone()[0])
                assert next_snapshot != approved_env and next_snapshot.read_bytes() == next_env.read_bytes()
                next_active = output / ('policy-' + next_preparation + '.json')
                try: generator.activate(journal, next_operation, str(next_env), str(next_candidate), str(next_active), str(install), str(control), extractor, supervisor)
                except generator.PolicyError: pass
                else: raise AssertionError('Replacement without drain, gate and backup evidence was allowed')
                states = dict(journal.db.execute('SELECT operation_id,state FROM policy_approvals'))
                assert states == {operation:'active', next_operation:'candidate'} and not next_active.exists()
                assert daemon.load_approved_policy(str(active), str(journal_dir / 'journal.sqlite'), str(approved_env))
                assert approved_env.read_bytes() == original_env
                print('A different release received a separate env snapshot; replacement remained blocked without drain, gate and backup')
                print('Verified policy from a real local registry, stopped probes and Compose')
                # A crash after Compose creates resources must leave a durable
                # project identity and require recovery; fixture cleanup below
                # is performed only after the child is confirmed dead.
                journal.db.execute('DELETE FROM policy_approvals')
                journal.db.execute('DELETE FROM policy_probes')
                journal.db.execute('DELETE FROM preparations')
                journal.db.execute('DELETE FROM operations')
                journal.submit(operation, 'a'*40, digest, 'v1.2.3')
                attempt = journal.claim(); journal.finish(attempt, 'verified', config_digest)
                preparer.prepare_verified(journal, operation, str(staging), extractor, resolve_child=resolve_child)
                preparation_id = journal.db.execute('SELECT preparation_id FROM preparations').fetchone()[0]
                journal.close()
                pid = os.fork()
                if pid == 0:
                    child_journal = updater.Journal(journal_dir)
                    original_docker = generator._docker
                    def interrupt(config, *args, **kwargs):
                        result = original_docker(config, *args, **kwargs)
                        if args and args[0] == 'compose' and 'create' in args:
                            os.kill(os.getpid(), signal.SIGKILL)
                        return result
                    generator._docker = interrupt
                    generator.produce(child_journal, operation, str(staging), str(env_file), str(install),
                                      str(output / ('candidate-' + preparation_id + '.json')), extractor, supervisor,
                                      resolve_child=resolve_child)
                    os._exit(1)
                _, status = os.waitpid(pid, 0)
                assert os.WIFSIGNALED(status) and os.WTERMSIG(status) == signal.SIGKILL
                journal = updater.Journal(journal_dir); journal.recover()
                probe = journal.db.execute('SELECT project,config_digest,state FROM policy_probes').fetchone()
                assert probe[2] == 'intent' and journal.db.execute('SELECT status FROM preparations').fetchone()[0] == 'recovery_required'
                probe_ids = docker('ps', '-a', '--no-trunc', '--filter', 'label=com.docker.compose.project=' + probe[0], '--format', '{{.ID}}').splitlines()
                assert len(probe_ids) == 3 and all(re.fullmatch(r'[a-f0-9]{64}', item) for item in probe_ids)
                docker('rm', *probe_ids)
                docker('network', 'rm', probe[0] + '_default')
                assert not docker('ps', '-a', '--filter', 'label=com.docker.compose.project=' + probe[0], '--format', '{{.ID}}')
                print('SIGKILL left durable probe identity and blocked recovery until manual cleanup')
                for purpose in ('prepare', 'policy'):
                    journal.db.execute('DELETE FROM policy_approvals')
                    journal.db.execute('DELETE FROM policy_probes')
                    journal.db.execute('DELETE FROM extraction_probes')
                    journal.db.execute('DELETE FROM preparations')
                    journal.db.execute('DELETE FROM operations')
                    journal.submit(operation, 'a'*40, digest, 'v1.2.3')
                    attempt = journal.claim(); journal.finish(attempt, 'verified', config_digest)
                    if purpose == 'policy':
                        preparer.prepare_verified(journal, operation, str(staging), extractor, resolve_child=resolve_child)
                    journal.close()
                    pid = os.fork()
                    if pid == 0:
                        child_journal = updater.Journal(journal_dir)
                        original_extract_docker = extractor._docker
                        def kill_extract(*args, **kwargs):
                            result = original_extract_docker(*args, **kwargs)
                            if args and args[0] == 'create': os.kill(os.getpid(), signal.SIGKILL)
                            return result
                        extractor._docker = kill_extract
                        if purpose == 'prepare':
                            preparer.prepare_verified(child_journal, operation, str(staging), extractor, resolve_child=resolve_child)
                        else:
                            preparation_id = child_journal.db.execute('SELECT preparation_id FROM preparations').fetchone()[0]
                            generator.produce(child_journal, operation, str(staging), str(env_file), str(install),
                                              str(output / ('candidate-' + preparation_id + '.json')), extractor, supervisor,
                                              resolve_child=resolve_child)
                        os._exit(1)
                    _, status = os.waitpid(pid, 0)
                    assert os.WIFSIGNALED(status) and os.WTERMSIG(status) == signal.SIGKILL
                    journal = updater.Journal(journal_dir); journal.recover()
                    extraction_probe = journal.db.execute('SELECT name,status FROM extraction_probes WHERE purpose=?', (purpose,)).fetchone()
                    assert extraction_probe[1] == 'intent' and journal.db.execute('SELECT status FROM preparations').fetchone()[0] == 'recovery_required'
                    info = json.loads(docker('inspect', '--format', '{{json .}}', extraction_probe[0]))
                    assert info['State']['Status'] == 'created' and info['Config']['Labels']['io.servus.updater.extraction'] == extraction_probe[0]
                    docker('rm', '-v', extraction_probe[0])
                    print('SIGKILL kept ' + purpose + ' extraction identity and required manual recovery')
                journal.db.execute('DELETE FROM policy_approvals')
                journal.db.execute('DELETE FROM policy_probes')
                journal.db.execute('DELETE FROM extraction_probes')
                journal.db.execute('DELETE FROM preparations')
                journal.db.execute('DELETE FROM operations')
                journal.submit(operation, 'a'*40, digest, 'v1.2.3')
                attempt = journal.claim(); journal.finish(attempt, 'verified', config_digest)
                preparer.prepare_verified(journal, operation, str(staging), extractor, resolve_child=resolve_child)
                preparation_id = journal.db.execute('SELECT preparation_id FROM preparations').fetchone()[0]
                candidate = output / ('candidate-' + preparation_id + '.json')
                original_remove = generator.shutil.rmtree
                def blocked_remove(path, *args, **kwargs):
                    if pathlib.Path(path).name.startswith('servus-policy-'):
                        raise OSError('synthetic cleanup failure')
                    return original_remove(path, *args, **kwargs)
                generator.shutil.rmtree = blocked_remove
                try:
                    try:
                        generator.produce(journal, operation, str(staging), str(env_file), str(install), str(candidate), extractor, supervisor, resolve_child=resolve_child)
                    except (generator.PolicyError, OSError):
                        pass
                    else:
                        raise AssertionError('Cleanup failure unexpectedly published a candidate')
                finally:
                    generator.shutil.rmtree = original_remove
                assert not candidate.exists() and journal.db.execute('SELECT status FROM preparations').fetchone()[0] == 'recovery_required'
                print('Temporary secret cleanup failure prevented candidate publication')
            finally:
                journal.close()
        finally:
            if container_id:
                subprocess.run(['/usr/bin/docker', 'rm', '-f', container_id], env=ENV, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            for image in (locals().get('next_reference'), locals().get('next_tag'), locals().get('reference'), locals().get('tag')):
                if image: subprocess.run(['/usr/bin/docker', 'image', 'rm', image], env=ENV, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            shutil.rmtree(data, ignore_errors=True)
            shutil.rmtree(etc, ignore_errors=True)


if __name__ == '__main__': main()
