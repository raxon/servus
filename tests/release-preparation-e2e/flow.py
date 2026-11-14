#!/usr/bin/python3 -I
"""Test a real attested release over the updater socket in a disposable VM."""
import hashlib
import json
import os
import pathlib
import signal
import socket
import sqlite3
import stat
import subprocess
import sys
import time
import uuid

if os.geteuid() != 0 or not os.uname().nodename.startswith('colima-servus-release-e2e-'):
    raise SystemExit('A disposable release fixture VM is required')
if sys.argv[1:] not in (['tag'], ['head'], ['worktree']):
    raise SystemExit('Expected tag, head or worktree mode')
mode = sys.argv[1]
BASE = pathlib.Path('/usr/local/libexec/servus')
ROOT = pathlib.Path('/run/servus-updater')
CONTROL = ROOT / 'control'
SOCKET = CONTROL / 'updater.sock'
FIXTURE = pathlib.Path('/run/servus-release-fixture')
MANIFEST = json.loads((FIXTURE / 'manifest.json').read_text())
ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C', 'LC_ALL': 'C'}
DIGEST = 'sha256:32f7cccf97841716ffae6bbff4f4234d5c3575e3b3ad9daa61dcf5afba72a13c'
COMMIT = '7c2013b081b4c26244a52c75b51e6ca2226c8a5a'
TAG = 'v0.1.5'
UID = GID = 65534


def command(*args, timeout=30, check=True):
    result = subprocess.run(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, cwd='/', env=ENV, timeout=timeout)
    if check and result.returncode:
        raise RuntimeError('Fixture command failed: ' + args[0])
    return result


CLIENT = '''import socket,sys\ns=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);s.settimeout(5);s.connect(sys.argv[1]);s.sendall(sys.stdin.buffer.read());data=bytearray()\nwhile not data.endswith(b"\\n"):\n c=s.recv(4096)\n if not c:break\n data.extend(c)\nsys.stdout.buffer.write(data)\n'''


def request(action, operation, **extra):
    payload = json.dumps({'version': 1, 'action': action, 'operationId': operation, **extra}, separators=(',', ':')).encode() + b'\n'
    result = subprocess.run(['/usr/bin/setpriv', '--reuid=65534', '--regid=65534', '--clear-groups',
                             '/usr/bin/python3', '-I', '-c', CLIENT, str(SOCKET)], input=payload,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd='/', env=ENV, timeout=10)
    if result.returncode: raise RuntimeError('Fixture client failed')
    return json.loads(result.stdout)


def until(fn, label, timeout=180):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = fn()
        if value: return value
        time.sleep(.1)
    raise RuntimeError('Timed out waiting for ' + label)


def state(operation):
    value = request('status', operation)
    if not value.get('ok'): raise RuntimeError('Operation status unavailable')
    return value['operation']['status']


def prepare_state(operation):
    value = request('prepare', operation)
    if not value.get('ok'): raise RuntimeError('Preparation status unavailable: ' + value.get('error', 'unknown'))
    return value['operation']['status']


def start(name, *, existing=False):
    state_dir = FIXTURE / (mode + '-' + name)
    if not existing:
        state_dir.mkdir(mode=0o700)
        (state_dir / 'staging').mkdir(mode=0o700)
    log = os.open(str(state_dir / 'stderr.log'), os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW, 0o600)
    try:
        process = subprocess.Popen(['/usr/bin/python3', '-I', str(BASE / 'servus-updater.py'),
                                    '--state-dir', str(state_dir), '--socket-dir', str(CONTROL),
                                    '--peer-uid', str(UID), '--socket-gid', str(GID)],
                                   stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=log,
                                   cwd='/', env=ENV, close_fds=True)
    finally:
        os.close(log)
    def ready():
        if process.poll() is not None: raise RuntimeError('Updater exited during startup')
        if not SOCKET.is_socket(): return False
        try:
            return request('status', str(uuid.uuid4())) == {'ok': False, 'error': 'not_found'}
        except (OSError, RuntimeError, ValueError, subprocess.SubprocessError):
            return False
    until(ready, 'updater startup', 20)
    return process, state_dir


def stop(process, kill=False):
    if process.poll() is None:
        process.kill() if kill else process.terminate()
        process.wait(timeout=15)


def submit_verified():
    operation = str(uuid.uuid4())
    result = request('submit', operation, digest=DIGEST, commit=COMMIT, tag=TAG)
    assert result.get('ok') and result['operation']['status'] == 'accepted'
    terminal = until(lambda: (s if (s := state(operation)) in ('verified','verification_failed','recovery_required') else None), 'real attestation')
    if terminal != 'verified': raise AssertionError('Signed release verification ended as ' + terminal)
    return operation


def assert_bundle(state_dir, operation):
    with sqlite3.connect(f'file:{state_dir / "journal.sqlite"}?mode=ro', uri=True) as db:
        row = db.execute('SELECT status,staging_path FROM preparations WHERE operation_id=?', (operation,)).fetchone()
    assert row and row[0] == 'prepared' and row[1]
    stage = pathlib.Path(row[1]); assert stage.parent == state_dir / 'staging'
    expected_dirs = set()
    for name in MANIFEST:
        parent = pathlib.PurePosixPath(name).parent
        while str(parent) != '.':
            expected_dirs.add(str(parent)); parent = parent.parent
    actual_files, actual_dirs = set(), set()
    info = stage.lstat()
    assert stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and info.st_gid == 0 and stat.S_IMODE(info.st_mode) == 0o700
    for root, dirs, files in os.walk(stage, followlinks=False):
        for name in dirs + files:
            path = pathlib.Path(root, name); info = path.lstat(); relative = path.relative_to(stage).as_posix()
            assert not path.is_symlink() and info.st_uid == 0 and info.st_gid == 0
            if stat.S_ISDIR(info.st_mode):
                assert stat.S_IMODE(info.st_mode) == 0o755
                actual_dirs.add(relative)
            else:
                assert stat.S_ISREG(info.st_mode) and info.st_nlink == 1
                actual_files.add(relative)
    assert actual_files == set(MANIFEST) and actual_dirs == expected_dirs, 'Installation inventory does not match signed commit'
    for name, expected in MANIFEST.items():
        p = stage / name
        info = p.lstat()
        assert stat.S_ISREG(info.st_mode) and not p.is_symlink() and info.st_uid == 0 and info.st_gid == 0
        assert stat.S_IMODE(info.st_mode) == expected['mode']
        assert hashlib.sha256(p.read_bytes()).hexdigest() == expected['sha256']


helper = None
if mode == 'tag':
    command('/usr/bin/install','-d','-m','755','/opt/servus',str(ROOT),str(ROOT / 'fences'))
    command('/usr/bin/install','-d','-m','710','-o','0','-g',str(GID),str(CONTROL))
    command('/usr/bin/install','-d','-m','700','/var/lib/servus-updater')
    command('/usr/bin/install','-m','600','/dev/null','/opt/servus/install.lock')
    command('/usr/bin/python3','-I',str(BASE / 'provision-verifier-group.py'),timeout=60)

try:
    helper, state_dir = start('valid')
    operation = submit_verified()
    result = request('prepare',operation)
    assert result.get('ok') and result['operation']['status'] in ('preparing','prepared')
    outcome = until(lambda: (s if (s := prepare_state(operation)) in ('prepared','recovery_required') else None), 'real release preparation', 300)
    assert outcome == 'prepared', 'Signed legacy release did not prepare'
    if mode != 'tag':
        denied = request('apply', operation)
        assert denied == {'ok': False, 'error': 'unavailable'}, 'Bootstrap updater must not apply a release'
    assert_bundle(state_dir,operation)
    print('PASS real v0.1.5 attestation, IPC, systemd, GHCR pull and exact install inventory (' + mode + ')',flush=True)
    stop(helper); helper = None

    if mode == 'tag':
        helper, state_dir = start('bad-digest')
        bad = str(uuid.uuid4())
        value = request('submit',bad,digest='sha256:'+'0'*64,commit=COMMIT,tag=TAG)
        assert value.get('ok')
        outcome = until(lambda: (s if (s := state(bad)) in ('verified','verification_failed','recovery_required') else None), 'bad digest rejection')
        assert outcome != 'verified'
        assert not request('prepare',bad).get('ok')
        print('PASS invalid registry digest did not reach preparation',flush=True)
        stop(helper); helper = None

        helper, state_dir = start('interrupted')
        interrupted = submit_verified()
        value = request('prepare', interrupted)
        assert value.get('ok') and value['operation']['status'] == 'preparing'
        prep_id = value['operation']['preparationId']
        unit = 'servus-prepare-' + prep_id.replace('-', '') + '.service'
        def freeze():
            result = command('/usr/bin/systemctl','freeze',unit,timeout=5,check=False)
            if result.returncode == 0: return True
            current = prepare_state(interrupted)
            if current != 'preparing':
                raise AssertionError('Preparation finished before interruption could be tested')
            return False
        until(freeze,'real preparation unit',30)
        try:
            assert command('/usr/bin/systemctl','is-active','--quiet',unit,check=False).returncode == 0
            stop(helper,kill=True); helper = None
            helper, _ = start('interrupted',existing=True)
            assert prepare_state(interrupted) == 'recovery_required'
            print('PASS interrupted real preparation requires recovery after restart',flush=True)
        finally:
            command('/usr/bin/systemctl','thaw',unit,check=False)
            command('/usr/bin/systemctl','stop',unit,check=False)
        stop(helper); helper = None
finally:
    if helper is not None: stop(helper,kill=True)
