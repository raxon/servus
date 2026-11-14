"""Exercise the updater helper and its verification fence on a disposable VM."""

import json
import grp
import os
import pathlib
import runpy
import selectors
import socket
import sqlite3
import subprocess
import threading
import time
import uuid

assert os.geteuid() == 0
BASE = pathlib.Path('/usr/local/libexec/servus')
DATA = pathlib.Path('/var/lib/servus-updater')
ROOT = pathlib.Path('/run/servus-updater')
CONTROL = ROOT / 'control'
FENCES = ROOT / 'fences'
SOCKET = CONTROL / 'updater.sock'
VERIFIER = BASE / 'verify-release.py'
DIGEST = 'sha256:466654f228cf3adb4e13369ce85b047458fa7eb64e20c46c222df2326c293370'
COMMIT = 'dd585c65805ba432b880c661ea140ae69f7a9984'
TAG = 'v0.1.4'
ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C', 'LC_ALL': 'C'}
UID = 65534
GID = 65534
helper = None
client = None
unit = None
HELPER = BASE / 'servus-updater.py'
LOG = pathlib.Path('/tmp/servus-updater-fixture-diagnostic.log')
original_helper = HELPER.read_bytes()


def command(*args, timeout=30):
    return subprocess.run(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, env=ENV, cwd='/', timeout=timeout, check=False)


def must(*args, timeout=30):
    result = command(*args, timeout=timeout)
    if result.returncode:
        raise RuntimeError(f'Fixture command failed: {args[0]}')
    return result


CLIENT = '''import json,socket,sys
for payload in sys.stdin.buffer:
 try:
  with socket.socket(socket.AF_UNIX) as s:
   s.settimeout(5);s.connect(sys.argv[1]);s.sendall(payload);parts=bytearray()
   while len(parts)<4096:
    chunk=s.recv(4096-len(parts))
    if not chunk: break
    parts.extend(chunk)
    if b'\\n' in chunk: break
  sys.stdout.buffer.write(parts);sys.stdout.buffer.flush()
 except OSError:
  sys.stdout.buffer.write(b'{"fixtureError":true}\\n');sys.stdout.buffer.flush()
'''


def request(action, operation, **extra):
    payload = {'version': 1, 'action': action, 'operationId': operation, **extra}
    if client is None or client.poll() is not None:
        raise RuntimeError('Fixture client is unavailable')
    client.stdin.write((json.dumps(payload) + '\n').encode())
    client.stdin.flush()
    ready = selectors.DefaultSelector()
    try:
        ready.register(client.stdout, selectors.EVENT_READ)
        if not ready.select(10): raise RuntimeError('Fixture socket request timed out')
        result = client.stdout.readline()
    finally:
        ready.close()
    if not result:
        raise RuntimeError('Fixture socket request failed')
    return json.loads(result)


def until(test, label, timeout=110):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        value = test()
        if value:
            return value
        time.sleep(0.1)
    raise RuntimeError(f'Timed out waiting for {label}')


def start_helper(state_dir=DATA):
    logfd = os.open(LOG, os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        process = subprocess.Popen(['/usr/bin/python3', '-I', str(HELPER),
                                    '--state-dir', str(state_dir), '--socket-dir', str(CONTROL),
                                    '--peer-uid', str(UID), '--socket-gid', str(GID)],
                                   stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=logfd,
                                   env=ENV, cwd='/', close_fds=True)
    finally:
        os.close(logfd)
    probe = str(uuid.uuid4())
    def ready():
        if process.poll() is not None:
            raise RuntimeError('Fixture helper failed to start')
        if not SOCKET.is_socket():
            return False
        try:
            return request('status', probe) == {'ok': False, 'error': 'not_found'}
        except (OSError, ValueError, RuntimeError):
            return False
    until(ready, 'helper startup', 20)
    if process.poll() is not None:
        raise RuntimeError('Fixture helper failed to start')
    return process


def stop_helper(process, kill=False):
    if process is not None and process.poll() is None:
        process.kill() if kill else process.terminate()
        process.wait(timeout=10)


def status(operation):
    result = request('status', operation)
    if not result.get('ok'):
        raise RuntimeError('Fixture status unavailable')
    return result['operation']['status']


def metadata(operation):
    with sqlite3.connect(f'file:{DATA / "journal.sqlite"}?mode=ro', uri=True) as db:
        row = db.execute('SELECT attempt_id,attempt_nonce FROM operations WHERE id=?', (operation,)).fetchone()
    if not row or not row[0] or not row[1]:
        return None
    return row


def unit_name(operation, attempt):
    return 'servus-verify-' + operation.replace('-', '') + '-' + attempt.replace('-', '') + '.service'


def stale_guard(operation, attempt, nonce):
    name = 'servus-e2e-stale-' + uuid.uuid4().hex + '.service'
    try:
        result = command('/usr/bin/systemd-run', '--quiet', '--wait', '--pipe', '--collect', '--unit', name,
                         '--property=DynamicUser=yes', '--property=KillMode=control-group',
                         '--property=SupplementaryGroups=servus-verifier',
                         '/usr/bin/python3', '-I', str(BASE / 'guarded-verifier.py'),
                         '--operation-id', operation, '--attempt-id', attempt, '--nonce', nonce,
                         '--digest', DIGEST, '--commit', COMMIT, '--tag', TAG, timeout=20)
        if result.returncode == 0 or b'Verification attempt was not authorized.' not in result.stderr:
            raise RuntimeError('A revoked or stale nonce was not rejected by the guard')
    finally:
        command('/usr/bin/systemctl', 'stop', name, timeout=10)


for path in (DATA, ROOT, pathlib.Path('/opt/servus')):
    if path.exists():
        raise RuntimeError('Fixture path already exists')
try:
    # Fixture-only diagnostics preserve helper behavior and log exception types
    # and errno values, never attempt identities or secret values.
    source = original_helper.decode('utf-8')
    before = "        except (OSError, RuntimeError):\n            status = 'recovery_required'\n        self.journal.finish"
    after = ("        except (OSError, RuntimeError) as error:\n"
             "            cause = error.__cause__\n"
             "            reason = str(error) if str(error) in ('Process table changed during scan', 'Process task table changed during scan', 'Process identities changed during scan', 'Verifier group is held by a live process') else 'other'\n"
             "            print('FIXTURE_REVOKE_EXCEPTION', type(error).__name__, getattr(error, 'errno', None), reason, "
             "type(cause).__name__, getattr(cause, 'errno', None), file=sys.stderr, flush=True)\n"
             "            status = 'recovery_required'\n        self.journal.finish")
    assert source.count(before) == 1
    source = source.replace(before, after)
    before = "            except (OSError, RuntimeError):\n                # A launcher exception after a process exists has an uncertain outcome."
    after = ("            except (OSError, RuntimeError) as error:\n"
             "                cause = error.__cause__\n"
             "                reason = str(error) if str(error) in ('Process table changed during scan', 'Process task table changed during scan', 'Process identities changed during scan', 'Verifier group is held by a live process') else 'other'\n"
             "                print('FIXTURE_PREPARE_EXCEPTION', type(error).__name__, getattr(error, 'errno', None), reason, "
             "type(cause).__name__, getattr(cause, 'errno', None), file=sys.stderr, flush=True)\n"
             "                # A launcher exception after a process exists has an uncertain outcome.")
    assert source.count(before) == 1
    HELPER.write_text(source.replace(before, after), encoding='utf-8')
    os.chmod(HELPER, 0o755)
    must('/usr/bin/install', '-d', '-m', '755', '/opt/servus', str(ROOT), str(FENCES))
    must('/usr/bin/install', '-d', '-m', '700', str(DATA))
    must('/usr/bin/install', '-d', '-m', '710', '-o', '0', '-g', str(GID), str(CONTROL))
    must('/usr/bin/install', '-m', '600', '/dev/null', '/opt/servus/install.lock')
    client = subprocess.Popen(['/usr/bin/setpriv', '--reuid=65534', '--regid=65534', '--clear-groups',
                               '/usr/bin/python3', '-I', '-u', '-c', CLIENT, str(SOCKET)],
                              stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                              env=ENV, cwd='/', close_fds=True)
    must('/usr/bin/python3', '-I', str(BASE / 'provision-verifier-group.py'), timeout=60)
    fixture_helper = runpy.run_path(str(BASE / 'servus-updater.py'))
    fixture_helper['fence_context']()
    verifier_gid = grp.getgrnam('servus-verifier').gr_gid
    churn_stop = threading.Event()
    def churn():
        while not churn_stop.is_set():
            command('/usr/bin/true', timeout=5)
    churn_thread = threading.Thread(target=churn, daemon=True)
    churn_thread.start()
    refusals = 0
    try:
        for _ in range(15):
            try:
                fixture_helper['assert_stable_processes_without_gid'](verifier_gid)
            except RuntimeError:
                refusals += 1
    finally:
        churn_stop.set()
        churn_thread.join(timeout=10)
    print(f'Fixture controlled process churn: {refusals}/15 scans refused', flush=True)
    churn_state = DATA / 'churn-state'
    churn_state.mkdir(mode=0o700)
    helper = start_helper(churn_state)
    churn_stop.clear()
    churn_thread = threading.Thread(target=churn, daemon=True)
    churn_thread.start()
    churn_operation = str(uuid.uuid4())
    try:
        result = request('submit', churn_operation, digest=DIGEST, commit=COMMIT, tag=TAG)
        assert result.get('ok')
        terminal = until(lambda: (value if (value := status(churn_operation)) in
                                  ('verified', 'verification_failed', 'recovery_required') else None),
                         'verification under process churn')
    finally:
        churn_stop.set()
        churn_thread.join(timeout=10)
    diagnostic_lines = [line for line in LOG.read_text().splitlines()
                        if line.startswith(('FIXTURE_PREPARE_EXCEPTION ', 'FIXTURE_REVOKE_EXCEPTION '))]
    for line in diagnostic_lines:
        print(line, flush=True)
    print('Fixture helper result under process churn:', terminal, flush=True)
    assert terminal in ('verified', 'recovery_required'), 'Unexpected helper result under process churn'
    stop_helper(helper)
    helper = start_helper()
    operation = str(uuid.uuid4())
    response = request('submit', operation, digest=DIGEST, commit=COMMIT, tag=TAG)
    assert response.get('ok') and response['operation']['status'] == 'accepted'
    until(lambda: status(operation) in ('verified', 'verification_failed', 'recovery_required'), 'verification result')
    final_status = status(operation)
    if final_status != 'verified':
        fence_state = FENCES / operation / 'state'
        print('Fixture fence exists:', fence_state.exists(), flush=True)
        if fence_state.exists():
            print('Fixture fence revoked:', fence_state.read_bytes() == b'revoked\n', flush=True)
        current_metadata = metadata(operation)
        if current_metadata:
            old_attempt, old_nonce = current_metadata
            print('Fixture verifier unit still active:', command('/usr/bin/systemctl', 'is-active', '--quiet', unit_name(operation, old_attempt)).returncode == 0, flush=True)
            if fence_state.exists() and fence_state.read_bytes() != b'revoked\n':
                try:
                    fixture_helper['revoke_fence']({'operationId':operation, 'attemptId':old_attempt, 'attemptNonce':old_nonce})
                    print('Fixture delayed revocation succeeded', flush=True)
                except Exception as error:
                    print('Fixture delayed revocation:', type(error).__name__, str(error), flush=True)
        try:
            fixture_helper['fence_context']()
        except Exception as error:
            print('Fixture fence context:', type(error).__name__, str(error), flush=True)
        print('Fixture verification status:', final_status, flush=True)
        if LOG.exists():
            for line in LOG.read_text().splitlines():
                if line.startswith(('FIXTURE_REVOKE_EXCEPTION ', 'FIXTURE_PREPARE_EXCEPTION ')): print(line, flush=True)
        raise AssertionError('Signed image was not verified by the real helper')
    attempt, nonce = metadata(operation)
    assert (FENCES / operation / 'state').read_bytes() == b'revoked\n'
    stale_guard(operation, attempt, nonce)
    print('PASS helper verifies the real attestation and revokes the used fence', flush=True)

    original = VERIFIER.read_bytes()
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.bind(('127.0.0.1', 0))
    listener.listen(1)
    listener.settimeout(60)
    observed = threading.Event()
    def observe():
        try:
            connection, _ = listener.accept()
            with connection:
                if connection.recv(16) == b'started': observed.set()
        except OSError:
            pass
    thread = threading.Thread(target=observe, daemon=True)
    thread.start()
    code = ('import socket,time\n'
            f's=socket.create_connection(("127.0.0.1",{listener.getsockname()[1]}))\n'
            's.sendall(b"started")\n'
            'time.sleep(60)\n')
    try:
        VERIFIER.write_text(code, encoding='ascii')
        os.chmod(VERIFIER, 0o755)
        interrupted = str(uuid.uuid4())
        response = request('submit', interrupted, digest=DIGEST, commit=COMMIT, tag=TAG)
        assert response.get('ok')
        assert observed.wait(80), 'Guarded verifier did not start'
        assert status(interrupted) == 'verifying'
        attempt, nonce = metadata(interrupted)
        unit = unit_name(interrupted, attempt)
        assert command('/usr/bin/systemctl', 'is-active', '--quiet', unit).returncode == 0
        stop_helper(helper, kill=True)
        helper = start_helper()
        assert status(interrupted) == 'recovery_required'
        retry = request('retry', interrupted)
        assert retry == {'ok': False, 'error': 'recovery_required'}
        must('/usr/bin/systemctl', 'stop', unit, timeout=15)
        unit = None
        stop_helper(helper)
        helper = start_helper()
        assert status(interrupted) == 'recovery_required'
        assert (FENCES / interrupted / 'state').read_bytes() == b'revoked\n'
        stale_guard(interrupted, attempt, nonce)
        print('PASS SIGKILL recovery stays blocked and revokes the interrupted attempt', flush=True)
    finally:
        listener.close()
        thread.join(timeout=1)
        VERIFIER.write_bytes(original)
        os.chmod(VERIFIER, 0o755)
finally:
    if unit:
        command('/usr/bin/systemctl', 'stop', unit, timeout=15)
    stop_helper(helper, kill=True)
    stop_helper(client, kill=True)
    HELPER.write_bytes(original_helper)
    os.chmod(HELPER, 0o755)
    LOG.unlink(missing_ok=True)
