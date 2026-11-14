"""Exercise the installed verifier on a disposable systemd VM as root."""

import json
import os
import pathlib
import runpy
import socket
import subprocess
import threading
import time
import uuid

EXECUTOR = '/usr/local/libexec/servus/verification-executor.py'
VERIFIER = pathlib.Path('/usr/local/libexec/servus/verify-release.py')
DIGEST = 'sha256:466654f228cf3adb4e13369ce85b047458fa7eb64e20c46c222df2326c293370'
COMMIT = 'dd585c65805ba432b880c661ea140ae69f7a9984'
TAG = 'v0.1.4'
ENV = {'PATH': '/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C'}


def run(*command, timeout=130):
    return subprocess.run(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, env=ENV, cwd='/', timeout=timeout, check=False)


def execute(commit=COMMIT):
    return run('/usr/bin/python3', '-I', EXECUTOR, '--digest', DIGEST,
               '--commit', commit, '--tag', TAG)


assert os.geteuid() == 0
process = subprocess.Popen(['/usr/bin/python3', '-I', EXECUTOR, '--digest', DIGEST,
                            '--commit', COMMIT, '--tag', TAG], stdin=subprocess.DEVNULL,
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=ENV, cwd='/')
observed = False
try:
    until = time.monotonic() + 100
    while process.poll() is None and time.monotonic() < until:
        units = run('/usr/bin/systemctl', 'list-units', '--all', '--plain', '--no-legend',
                    'servus-verify-*.service', timeout=5)
        names = [line.split()[0] for line in units.stdout.decode('ascii').splitlines() if line.strip()]
        for unit in names:
            props = run('/usr/bin/systemctl', 'show', unit, '--property=DynamicUser',
                        '--property=KillMode', '--property=Environment', '--property=MainPID', timeout=5)
            values = dict(line.split('=', 1) for line in props.stdout.decode('ascii').splitlines() if '=' in line)
            pid = int(values.get('MainPID', '0'))
            if values.get('DynamicUser') != 'yes' or values.get('KillMode') != 'control-group' or 'PATH=/usr/bin:/bin' not in values.get('Environment', '').split() or pid <= 0:
                continue
            try:
                status = pathlib.Path(f'/proc/{pid}/status').read_text()
            except FileNotFoundError:
                continue
            uid = next((line.split()[1] for line in status.splitlines() if line.startswith('Uid:')), '0')
            if int(uid) > 0:
                observed = True
                break
        if observed:
            break
        time.sleep(0.05)
    stdout, stderr = process.communicate(timeout=130)
finally:
    if process.poll() is None:
        process.kill()
        process.wait(timeout=10)
assert observed, 'The actual verifier unit properties were not observed'
result = subprocess.CompletedProcess(process.args, process.returncode, stdout, stderr)
assert result.returncode == 0, 'Signed release verification failed'
assert json.loads(result.stdout) == {'image': 'ghcr.io/raxon/servus', 'digest': DIGEST,
                                     'commit': COMMIT, 'tag': TAG, 'verified': True}
# Trace the actual executor's gh invocation without exposing its stderr. The
# root-owned fixture wrapper runs the real binary with the original arguments.
gh = pathlib.Path('/usr/bin/gh')
gh_real = pathlib.Path('/usr/bin/gh-real')
assert not gh_real.exists()
listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
listener.bind(('127.0.0.1', 0))
listener.listen(1)
listener.settimeout(100)
evidence = []
token = uuid.uuid4().hex
def observe_gh():
    try:
        connection, _ = listener.accept()
        with connection:
            evidence.append(connection.recv(1024))
    except OSError:
        pass
observer = threading.Thread(target=observe_gh, daemon=True)
observer.start()
expected = f'expected SourceRepositoryDigest to be {"0" * 40}, got {COMMIT}'
source = '''#!/usr/bin/python3 -I
import socket,subprocess,sys
result=subprocess.run(['/usr/bin/gh-real',*sys.argv[1:]],stdin=subprocess.DEVNULL,stdout=sys.stdout.buffer,stderr=subprocess.PIPE,timeout=60)
if result.returncode != 0 and %r.encode() in result.stderr:
    try:
        with socket.create_connection(('127.0.0.1',%d),timeout=2) as conn: conn.sendall(%r.encode())
    except OSError: pass
sys.stderr.buffer.write(result.stderr)
sys.exit(result.returncode)
''' % (expected, listener.getsockname()[1], token)
try:
    gh.rename(gh_real)
    gh.write_text(source, encoding='ascii')
    os.chmod(gh, 0o755)
    wrong = execute('0' * 40)
    observer.join(timeout=3)
    assert wrong.returncode != 0 and wrong.stderr == b'Release verification failed\n'
    assert evidence == [token.encode()], 'The actual gh digest mismatch was not observed'
finally:
    listener.close()
    observer.join(timeout=1)
    if gh_real.exists():
        gh.unlink(missing_ok=True)
        gh_real.rename(gh)
print('PASS real signature, actual DynamicUser/cgroup properties, PATH and wrong-commit rejection', flush=True)

try:
    assert run('/usr/bin/systemctl', 'set-environment', 'LD_AUDIT=/tmp/servus-fixture-missing.so').returncode == 0
    module = runpy.run_path(EXECUTOR)
    verify = module['verify']
    real_popen = subprocess.Popen
    attempted = []
    def observe_popen(command, *args, **kwargs):
        if command[0] == '/usr/bin/systemd-run':
            attempted.append(True)
            raise AssertionError('Verification unit was started under unsafe environment')
        return real_popen(command, *args, **kwargs)
    subprocess.Popen = observe_popen
    try:
        try:
            verify(DIGEST, COMMIT, TAG)
        except module['ExecutorError'] as error:
            assert str(error) == 'Systemd manager environment is not allowed'
        else:
            raise AssertionError('Unsafe systemd manager environment was accepted')
        assert not attempted
    finally:
        subprocess.Popen = real_popen
finally:
    assert run('/usr/bin/systemctl', 'unset-environment', 'LD_AUDIT').returncode == 0
print('PASS polluted manager environment is rejected', flush=True)

# A test-only hanging verifier starts a detached process in the same cgroup.
# The production verifier is restored even if this check fails.
original = VERIFIER.read_bytes()
marker = 'servus-e2e-child-' + uuid.uuid4().hex
listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
listener.bind(('127.0.0.1', 0))
listener.listen(1)
listener.settimeout(10)
started_child = threading.Event()
def observe_child():
    try:
        connection, _ = listener.accept()
        with connection:
            if connection.recv(16) == b'started':
                started_child.set()
    except OSError:
        pass
observer = threading.Thread(target=observe_child, daemon=True)
observer.start()
child_code = ('import socket,time;'
              f's=socket.create_connection(("127.0.0.1",{listener.getsockname()[1]}));'
              's.sendall(b"started");time.sleep(60)')
fake = ("import subprocess,time\n"
        "subprocess.Popen(['/usr/bin/python3','-c'," + repr(child_code) + ','
        + repr(marker) + "],start_new_session=True)\n"
        "time.sleep(60)\n").encode('ascii')
try:
    VERIFIER.write_bytes(fake)
    os.chmod(VERIFIER, 0o755)
    module = runpy.run_path(EXECUTOR)
    verify = module['verify']
    verify.__globals__['UNIT_TIMEOUT'] = 3
    verify.__globals__['PARENT_TIMEOUT'] = 12
    started = time.monotonic()
    try:
        verify(DIGEST, COMMIT, TAG)
    except module['ExecutorError']:
        pass
    else:
        raise AssertionError('A timed-out verifier was accepted')
    assert time.monotonic() - started < 20, 'Timeout did not terminate the unit'
    assert started_child.is_set(), 'The verifier descendant did not start'
    for _ in range(30):
        children = run('/usr/bin/pgrep', '-f', marker, timeout=5)
        if children.returncode == 1:
            break
        time.sleep(0.1)
    else:
        raise AssertionError('A verifier descendant survived cgroup shutdown')
finally:
    listener.close()
    observer.join(timeout=1)
    VERIFIER.write_bytes(original)
    os.chmod(VERIFIER, 0o755)
print('PASS timeout stops detached verifier descendants', flush=True)
