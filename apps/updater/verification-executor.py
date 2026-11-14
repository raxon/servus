#!/usr/bin/python3 -I
"""Run the fixed Servus release verifier in an isolated transient systemd unit.

This component only verifies an already selected release. It does not pull an
image, write an update journal, authorize an update, or apply a release.
Installation must put this file, the verifier, Python, systemd and gh under
root-owned, non-writable paths. The supervisor calling it must itself use a
clean environment and must treat a missing or malformed result as failure.
The systemd manager and root operators are trusted and must not change the
manager environment concurrently between inspection and unit startup.
"""

import argparse
import json
import os
import pathlib
import re
import selectors
import signal
import stat
import subprocess
import sys
import time
import uuid

PYTHON = '/usr/bin/python3'
SYSTEMD_RUN = '/usr/bin/systemd-run'
SYSTEMCTL = '/usr/bin/systemctl'
VERIFIER = '/usr/local/libexec/servus/verify-release.py'
GUARD = '/usr/local/libexec/servus/guarded-verifier.py'
GH_PATHS = ('/usr/bin/gh', '/usr/local/bin/gh')
MAX_OUTPUT = 16384
UNIT_TIMEOUT = 100
PARENT_TIMEOUT = 110
DIGEST = re.compile(r'^sha256:[0-9a-f]{64}$')
COMMIT = re.compile(r'^[0-9a-f]{40}$')
TAG = re.compile(r'^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$')
OPERATION_ID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
ENV = {'PATH': '/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C'}
MANAGER_ENV_LIMIT = 16384
MANAGER_ENV_TIMEOUT = 5
MANAGER_ENV_ALLOWLIST = {
    'LANG': {'C', 'C.UTF-8'},
    'LC_ALL': {'C', 'C.UTF-8'},
    'PATH': {'/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin',
             '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/snap/bin',
             '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
             '/usr/sbin:/usr/bin:/sbin:/bin'},
}


class ExecutorError(Exception):
    pass


def trusted_path(path, *, executable=False, final_symlink=False):
    """Resolve paths only through root-owned components that others cannot modify."""
    try:
        if not os.path.isabs(path):
            return False
        remaining = list(pathlib.PurePosixPath(os.path.normpath(path)).parts[1:])
        current = '/'
        root = os.lstat(current)
        if root.st_uid != 0 or not stat.S_ISDIR(root.st_mode) or root.st_mode & 0o022:
            return False
        links = 0
        while remaining:
            current = os.path.join(current, remaining.pop(0))
            info = os.lstat(current)
            if info.st_uid != 0:
                return False
            if stat.S_ISLNK(info.st_mode):
                if not remaining and not final_symlink:
                    return False
                links += 1
                if links > 40:
                    return False
                target = os.readlink(current)
                base = '/' if os.path.isabs(target) else os.path.dirname(current)
                remaining = list(pathlib.PurePosixPath(os.path.normpath(os.path.join(base, target, *remaining))).parts[1:])
                current = '/'
                continue
            if info.st_mode & 0o022:
                return False
            if remaining:
                if not stat.S_ISDIR(info.st_mode) or not info.st_mode & 0o001:
                    return False
            elif not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or not info.st_mode & 0o004:
                return False
        return current != '/' and (not executable or bool(info.st_mode & 0o001))
    except (OSError, ValueError):
        return False


def check_paths():
    for path in (PYTHON, SYSTEMD_RUN, SYSTEMCTL):
        if not trusted_path(path, executable=True, final_symlink=True):
            raise ExecutorError('A required system executable is not trusted')
    if not trusted_path(VERIFIER):
        raise ExecutorError('The installed verifier is not trusted')
    # The verifier selects the first executable candidate. Reject unsafe
    # candidates rather than allowing a different binary to be selected later.
    for path in GH_PATHS:
        if os.path.lexists(path):
            if not trusted_path(path, executable=True):
                raise ExecutorError('The GitHub CLI path is not trusted')
            return
    raise ExecutorError('A trusted GitHub CLI is not installed')


def validate_request(digest, commit, tag):
    if not isinstance(digest, str) or not DIGEST.fullmatch(digest):
        raise ExecutorError('Invalid digest')
    if not isinstance(commit, str) or not COMMIT.fullmatch(commit):
        raise ExecutorError('Invalid commit')
    if not isinstance(tag, str) or len(tag) > 64 or not TAG.fullmatch(tag):
        raise ExecutorError('Invalid release tag')


def validate_manager_environment(data):
    """Reject inherited manager variables before systemd starts any program."""
    if not isinstance(data, bytes) or len(data) > MANAGER_ENV_LIMIT:
        raise ExecutorError('Systemd manager environment is not allowed')
    try:
        text = data.decode('ascii')
    except UnicodeError:
        raise ExecutorError('Systemd manager environment is not allowed') from None
    seen = set()
    for line in text.splitlines():
        key, separator, value = line.partition('=')
        if not separator or key in seen or key not in MANAGER_ENV_ALLOWLIST or value not in MANAGER_ENV_ALLOWLIST[key]:
            raise ExecutorError('Systemd manager environment is not allowed')
        seen.add(key)
    if text and not text.endswith('\n'):
        raise ExecutorError('Systemd manager environment is not allowed')


def check_manager_environment():
    try:
        process = subprocess.Popen([SYSTEMCTL, 'show-environment'], stdin=subprocess.DEVNULL,
                                   stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                   env=ENV, cwd='/', close_fds=True)
    except OSError:
        raise ExecutorError('Cannot inspect systemd manager environment') from None
    selector = selectors.DefaultSelector()
    output = bytearray()
    deadline = time.monotonic() + MANAGER_ENV_TIMEOUT
    try:
        selector.register(process.stdout, selectors.EVENT_READ)
        while selector.get_map():
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not selector.select(remaining):
                raise ExecutorError('Cannot inspect systemd manager environment')
            chunk = os.read(process.stdout.fileno(), min(4096, MANAGER_ENV_LIMIT + 1 - len(output)))
            if not chunk:
                selector.unregister(process.stdout)
                break
            output.extend(chunk)
            if len(output) > MANAGER_ENV_LIMIT:
                raise ExecutorError('Cannot inspect systemd manager environment')
        remaining = deadline - time.monotonic()
        if remaining <= 0 or process.wait(timeout=remaining) != 0:
            raise ExecutorError('Cannot inspect systemd manager environment')
        validate_manager_environment(bytes(output))
    except (OSError, subprocess.TimeoutExpired):
        raise ExecutorError('Cannot inspect systemd manager environment') from None
    finally:
        selector.close()
        if process.poll() is None:
            process.kill()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                pass
        if process.stdout:
            process.stdout.close()


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('Duplicate JSON key')
        result[key] = value
    return result


def validate_result(data, digest, commit, tag):
    try:
        result = json.loads(data.decode('utf-8'), object_pairs_hook=unique_object)
    except (UnicodeError, ValueError, RecursionError):
        raise ExecutorError('The verifier returned an invalid result') from None
    if (not isinstance(result, dict) or type(result.get('verified')) is not bool or
        result != {'image': 'ghcr.io/raxon/servus', 'digest': digest, 'commit': commit, 'tag': tag, 'verified': True}):
        raise ExecutorError('The verifier result does not match the requested release')
    return result


def command_for(unit, digest, commit, tag, operation_id=None, attempt_id=None, nonce=None):
    # The cgroup remains responsible for descendants after this process exits.
    guarded = operation_id is not None and attempt_id is not None and nonce is not None
    prefix = [SYSTEMD_RUN, '--quiet', '--wait', '--pipe', '--collect', '--unit', unit,
            '--setenv=PATH=/usr/bin:/bin',
            '--property=DynamicUser=yes', '--property=KillMode=control-group',
            f'--property=RuntimeMaxSec={UNIT_TIMEOUT}', '--property=TimeoutStopSec=5',
            '--property=NoNewPrivileges=yes', '--property=PrivateTmp=yes',
            '--property=PrivateDevices=yes', '--property=ProtectSystem=strict',
            '--property=ProtectHome=yes', '--property=RestrictSUIDSGID=yes',
            '--property=CapabilityBoundingSet=', '--property=TasksMax=64',
            '--property=MemoryMax=512M',
            '--property=UnsetEnvironment=LD_PRELOAD LD_LIBRARY_PATH PYTHONPATH PYTHONHOME SSLKEYLOGFILE SSL_CERT_FILE SSL_CERT_DIR GH_TOKEN GITHUB_TOKEN GH_CONFIG_DIR']
    if guarded:
        prefix.append('--property=SupplementaryGroups=servus-verifier')
        return prefix + [PYTHON, '-I', GUARD, '--operation-id', operation_id, '--attempt-id', attempt_id, '--nonce', nonce, '--digest', digest, '--commit', commit, '--tag', tag]
    return prefix + [PYTHON, '-I', VERIFIER, '--digest', digest, '--commit', commit, '--tag', tag]


def verify(digest, commit, tag, operation_id=None, attempt_id=None, nonce=None):
    validate_request(digest, commit, tag)
    if operation_id is not None and (not isinstance(operation_id, str) or not OPERATION_ID.fullmatch(operation_id)):
        raise ExecutorError('Invalid operation identity')
    if attempt_id is not None and (operation_id is None or not isinstance(attempt_id, str) or not OPERATION_ID.fullmatch(attempt_id)):
        raise ExecutorError('Invalid attempt identity')
    if nonce is not None and (attempt_id is None or not isinstance(nonce, str) or not re.fullmatch(r'[a-f0-9]{64}', nonce)):
        raise ExecutorError('Invalid attempt nonce')
    if attempt_id is not None and nonce is None:
        raise ExecutorError('Attempt nonce is required')
    if sys.platform != 'linux' or os.geteuid() != 0 or not sys.flags.isolated:
        raise ExecutorError('The isolated root supervisor is required')
    check_paths()
    if nonce is not None and not trusted_path(GUARD):
        raise ExecutorError('The verifier guard is not trusted')
    check_manager_environment()
    # Journalled operation identities keep unit names stable across process loss.
    # Recovery remains fail-closed until delayed systemd requests are fenced.
    unit = 'servus-verify-' + (operation_id.replace('-', '') if operation_id else uuid.uuid4().hex) + ('-' + attempt_id.replace('-', '') if attempt_id else '') + '.service'
    deadline = time.monotonic() + PARENT_TIMEOUT
    try:
        process = subprocess.Popen(command_for(unit, digest, commit, tag, operation_id, attempt_id, nonce),
                                   stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                   stderr=subprocess.DEVNULL, env=ENV, cwd='/', close_fds=True)
    except OSError:
        raise ExecutorError('Unable to start verification unit') from None
    selector = selectors.DefaultSelector()
    output = bytearray()
    try:
        selector.register(process.stdout, selectors.EVENT_READ)
        while selector.get_map():
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not selector.select(remaining):
                raise ExecutorError('Verification timed out')
            chunk = os.read(process.stdout.fileno(), min(4096, MAX_OUTPUT + 1 - len(output)))
            if not chunk:
                selector.unregister(process.stdout)
                break
            output.extend(chunk)
            if len(output) > MAX_OUTPUT:
                raise ExecutorError('Verification result is too large')
        remaining = deadline - time.monotonic()
        if remaining <= 0 or process.wait(timeout=remaining) != 0:
            raise ExecutorError('Release verification failed')
        return validate_result(bytes(output), digest, commit, tag)
    except (OSError, subprocess.TimeoutExpired):
        raise ExecutorError('Release verification failed') from None
    finally:
        selector.close()
        if process.poll() is None:
            process.kill()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                pass
        if process.stdout:
            process.stdout.close()
        # systemd-run may have rejected a pre-existing name. Never stop a unit
        # unless a future ownership fence proves it belongs to this attempt.
        # RuntimeMaxSec bounds units created by this process.


def main():
    parser = argparse.ArgumentParser(description='Verify one Servus release in an isolated systemd unit')
    parser.add_argument('--digest', required=True)
    parser.add_argument('--commit', required=True)
    parser.add_argument('--tag', required=True)
    parser.add_argument('--operation-id')
    parser.add_argument('--attempt-id')
    parser.add_argument('--nonce')
    args = parser.parse_args()
    try:
        result = verify(args.digest, args.commit, args.tag, args.operation_id, args.attempt_id, args.nonce)
    except (ExecutorError, OSError):
        print('Release verification failed', file=sys.stderr)
        return 1
    print(json.dumps(result, separators=(',', ':')))
    return 0


if __name__ == '__main__':
    sys.exit(main())
