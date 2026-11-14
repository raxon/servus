#!/usr/bin/python3 -I
"""Submit one release to the verification-only local updater and await preparation."""
import argparse
import json
import os
import re
import socket
import stat
import struct
import sys
import time
import uuid

SOCKET_PATH = '/run/servus-updater/control/updater.sock'
MAX_RESPONSE = 4096


class BootstrapError(Exception):
    pass


def pairs(values):
    result = {}
    for key, value in values:
        if key in result: raise BootstrapError('Duplicate updater response field')
        result[key] = value
    return result


def request(path, payload, timeout=8):
    if not isinstance(path, str) or not os.path.isabs(path) or os.path.normpath(path) != path:
        raise BootstrapError('Invalid updater socket path')
    before = os.lstat(path)
    if not stat.S_ISSOCK(before.st_mode) or before.st_uid != 0 or before.st_mode & 0o007:
        raise BootstrapError('Updater socket is unsafe')
    data = json.dumps({'version': 1, **payload}, separators=(',', ':')).encode() + b'\n'
    if len(data) > 1024: raise BootstrapError('Updater request is too large')
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(timeout)
        connection.connect(path)
        pid, uid, _gid = struct.unpack('3i', connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        after = os.lstat(path)
        if uid != 0 or pid <= 0 or (before.st_dev, before.st_ino) != (after.st_dev, after.st_ino):
            raise BootstrapError('Updater socket identity changed')
        connection.sendall(data)
        response = bytearray()
        while len(response) <= MAX_RESPONSE and not response.endswith(b'\n'):
            chunk = connection.recv(min(1024, MAX_RESPONSE + 1 - len(response)))
            if not chunk: break
            response.extend(chunk)
    if len(response) > MAX_RESPONSE or not response.endswith(b'\n') or response.count(b'\n') != 1:
        raise BootstrapError('Invalid updater response')
    try: result = json.loads(response, object_pairs_hook=pairs)
    except (UnicodeError, ValueError, RecursionError) as error: raise BootstrapError('Invalid updater response') from error
    if not isinstance(result, dict) or set(result) != {'ok', 'operation'} or result['ok'] is not True or not isinstance(result['operation'], dict):
        raise BootstrapError('Updater rejected the request')
    return result['operation']


def uuid4(value):
    try: return isinstance(value, str) and str(uuid.UUID(value, version=4)) == value
    except (ValueError, AttributeError): return False


def run(path, operation, commit, digest, tag, *, timeout=900, interval=2, call=request):
    if (not uuid4(operation) or not re.fullmatch(r'[0-9a-f]{40}', commit) or
        not re.fullmatch(r'sha256:[0-9a-f]{64}', digest) or len(tag) > 64 or
        not re.fullmatch(r'v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)', tag) or
        not 1 <= timeout <= 1800 or not 0 < interval <= 60):
        raise BootstrapError('Invalid release request')
    deadline = time.monotonic() + timeout
    submission = {'action': 'submit', 'operationId': operation, 'commit': commit, 'digest': digest, 'tag': tag}
    observed = call(path, submission)
    while True:
        if (set(observed) != {'operationId', 'commit', 'digest', 'tag', 'status', 'createdAt'} or
            (observed['operationId'], observed['commit'], observed['digest'], observed['tag']) != (operation, commit, digest, tag) or
            not isinstance(observed['createdAt'], str)):
            raise BootstrapError('Updater returned a different release')
        status = observed['status']
        if status == 'verified': break
        if status not in ('accepted', 'verifying'): raise BootstrapError('Release verification failed or needs recovery')
        if time.monotonic() >= deadline: raise BootstrapError('Release preparation timed out')
        time.sleep(min(interval, max(0, deadline - time.monotonic())))
        observed = call(path, {'action': 'status', 'operationId': operation})
    while True:
        observed = call(path, {'action': 'prepare', 'operationId': operation})
        if (set(observed) != {'operationId', 'preparationId', 'status'} or
            observed['operationId'] != operation or not uuid4(observed['preparationId'])):
            raise BootstrapError('Updater returned an invalid preparation')
        if observed['status'] == 'prepared': return
        if observed['status'] != 'preparing': raise BootstrapError('Release preparation needs recovery')
        if time.monotonic() >= deadline: raise BootstrapError('Release preparation timed out')
        time.sleep(min(interval, max(0, deadline - time.monotonic())))


def main():
    parser = argparse.ArgumentParser()
    for name in ('operation', 'commit', 'digest', 'tag'): parser.add_argument('--' + name, required=True)
    args = parser.parse_args()
    if sys.platform != 'linux' or os.geteuid() <= 0 or not sys.flags.isolated:
        print('Release preparation requires an unprivileged user and isolated Python.', file=sys.stderr); return 1
    try:
        run(SOCKET_PATH, args.operation, args.commit, args.digest, args.tag)
        print('Release verified and prepared.')
        return 0
    except (OSError, ValueError, TypeError, BootstrapError):
        print('Release preparation failed or needs recovery. Retain the operation ID when checking its status.', file=sys.stderr)
        return 1


if __name__ == '__main__': raise SystemExit(main())
