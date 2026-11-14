#!/usr/bin/python3 -I
"""Discover an unverified public Servus release candidate; never deploy an image."""

import argparse
from contextlib import contextmanager
import hashlib
import json
import os
import pathlib
import re
import signal
import ssl
import stat
import sys
import threading
import time
import urllib.error
import urllib.request

REPOSITORY = 'raxon/servus'
REPOSITORY_ID = 1457036654
OWNER_ID = 1338844
GITHUB = 'https://api.github.com'
REGISTRY = 'https://ghcr.io'
TAG = re.compile(r'^v(0|[1-9][0-9]{0,17})\.(0|[1-9][0-9]{0,17})\.(0|[1-9][0-9]{0,17})$')
COMMIT = re.compile(r'^[a-f0-9]{40}$')
TOKEN = re.compile(r'^[A-Za-z0-9._~+/=-]{1,8192}$')
MEDIA_TYPES = frozenset({
    'application/vnd.oci.image.index.v1+json',
    'application/vnd.oci.image.manifest.v1+json',
    'application/vnd.docker.distribution.manifest.v2+json',
    'application/vnd.docker.distribution.manifest.list.v2+json',
})
ACCEPT = ', '.join(sorted(MEDIA_TYPES))
MAX_JSON = 1024 * 1024
MAX_MANIFEST = 2 * 1024 * 1024
MAX_PAGES = 20
TIMEOUT = 45


class DiscoveryError(Exception):
    pass


class ManifestNotFound(DiscoveryError):
    pass


def parse_tag(value):
    if not isinstance(value, str) or len(value) > 64:
        return None
    match = TAG.fullmatch(value)
    return tuple(int(part) for part in match.groups()) if match else None


def _unique_pairs(pairs):
    out = {}
    for key, value in pairs:
        if key in out:
            raise ValueError('duplicate key')
        out[key] = value
    return out


def decode_json(data):
    try:
        return json.loads(data, object_pairs_hook=_unique_pairs)
    except (ValueError, UnicodeError, RecursionError):
        raise DiscoveryError('Invalid JSON response') from None


def _trusted_ca():
    for raw in ('/etc/ssl/certs/ca-certificates.crt', '/etc/ssl/cert.pem'):
        try:
            path = pathlib.Path(raw).resolve(strict=True)
            info = path.stat()
            if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022 or info.st_nlink != 1:
                continue
            if any(p.stat().st_uid != 0 or p.stat().st_mode & 0o022 for p in path.parents):
                continue
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
            context.load_verify_locations(cafile=str(path))
            return context
        except (OSError, RuntimeError, ssl.SSLError):
            continue
    raise DiscoveryError('Trusted certificate bundle unavailable')


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Transport:
    def __init__(self, deadline, opener=None):
        self.deadline = deadline
        self.opener = opener or urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect(), urllib.request.HTTPSHandler(context=_trusted_ca()))

    def get(self, url, *, limit, accept, bearer=None, allow_not_found=False):
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise DiscoveryError('Discovery timed out')
        headers = {'Accept': accept, 'User-Agent': 'servus-release-discovery', 'Accept-Encoding': 'identity'}
        if bearer is not None:
            headers['Authorization'] = 'Bearer ' + bearer
        try:
            with self.opener.open(urllib.request.Request(url, headers=headers), timeout=min(8, remaining)) as response:
                if response.status != 200:
                    raise DiscoveryError('Release service request failed')
                length = response.headers.get('Content-Length')
                if length is not None and (not length.isdigit() or int(length) > limit):
                    raise DiscoveryError('Release service response is too large')
                encoding = response.headers.get('Content-Encoding')
                if encoding and encoding.lower() != 'identity':
                    raise DiscoveryError('Unsupported response encoding')
                chunks, size = [], 0
                while True:
                    if self.deadline <= time.monotonic():
                        raise DiscoveryError('Discovery timed out')
                    part = response.read1(min(65536, limit + 1 - size))
                    if not part:
                        if length is not None and size != int(length):
                            raise DiscoveryError('Release service response is incomplete')
                        return b''.join(chunks), response.headers
                    size += len(part)
                    if size > limit:
                        raise DiscoveryError('Release service response is too large')
                    chunks.append(part)
        except urllib.error.HTTPError as error:
            if allow_not_found and error.code == 404:
                raise ManifestNotFound('Manifest is not available') from None
            raise DiscoveryError('Release service request failed') from None
        except (urllib.error.URLError, OSError, ValueError, TimeoutError):
            raise DiscoveryError('Release service request failed') from None


def _check_identity(transport):
    body, _ = transport.get(f'{GITHUB}/repos/{REPOSITORY}', limit=MAX_JSON, accept='application/vnd.github+json')
    obj = decode_json(body)
    if (not isinstance(obj, dict) or type(obj.get('id')) is not int or obj['id'] != REPOSITORY_ID
            or obj.get('full_name') != REPOSITORY or not isinstance(obj.get('owner'), dict)
            or type(obj['owner'].get('id')) is not int or obj['owner']['id'] != OWNER_ID
            or obj['owner'].get('login') != 'raxon'):
        raise DiscoveryError('Repository identity mismatch')


def _find_latest(transport):
    _check_identity(transport)
    seen, latest = set(), None
    for page in range(1, MAX_PAGES + 1):
        data, _ = transport.get(f'{GITHUB}/repos/{REPOSITORY}/tags?per_page=100&page={page}', limit=MAX_JSON, accept='application/vnd.github+json')
        items = decode_json(data)
        if not isinstance(items, list) or len(items) > 100:
            raise DiscoveryError('Invalid tag listing')
        for item in items:
            if not isinstance(item, dict) or not isinstance(item.get('name'), str) or len(item['name']) > 255:
                raise DiscoveryError('Invalid tag listing')
            name = item['name']
            if name in seen:
                raise DiscoveryError('Ambiguous duplicate tag')
            seen.add(name)
            version = parse_tag(name)
            if version is None:
                continue
            commit = item.get('commit')
            sha = commit.get('sha') if isinstance(commit, dict) else None
            if not isinstance(sha, str) or not COMMIT.fullmatch(sha):
                raise DiscoveryError('Invalid release commit')
            if latest is None or version > latest[0]:
                latest = version, name, sha
        if len(items) < 100:
            break
    else:
        raise DiscoveryError('Tag listing exceeds page limit')
    _check_identity(transport)
    if latest is None:
        raise DiscoveryError('No stable release was found')
    return latest


def _discover(transport, current):
    current_version = parse_tag(current)
    if current_version is None:
        raise DiscoveryError('Current version must be a stable vMAJOR.MINOR.PATCH tag')
    version, tag, commit = _find_latest(transport)
    if version <= current_version:
        status = 'no_newer_version' if version == current_version else 'ahead'
        return {'status': status, 'current': current, 'latest': tag}
    body, _ = transport.get(f'{REGISTRY}/token?service=ghcr.io&scope=repository%3Araxon%2Fservus%3Apull', limit=16384, accept='application/json')
    obj = decode_json(body)
    token = obj.get('token') if isinstance(obj, dict) else None
    if not isinstance(token, str) or not TOKEN.fullmatch(token):
        raise DiscoveryError('Invalid anonymous registry token')
    try:
        body, headers = transport.get(f'{REGISTRY}/v2/{REPOSITORY}/manifests/{tag}', limit=MAX_MANIFEST, accept=ACCEPT, bearer=token, allow_not_found=True)
    except ManifestNotFound:
        # A 404 may also reflect registry availability or permissions. Do not assert why it is absent.
        return {'status': 'release_pending', 'verified': False, 'tag': tag, 'commit': commit, 'reason': 'manifest_not_available'}
    media = headers.get('Content-Type', '').split(';', 1)[0].strip().lower()
    if media not in MEDIA_TYPES:
        raise DiscoveryError('Unsupported manifest type')
    manifest = decode_json(body)
    if not isinstance(manifest, dict) or type(manifest.get('schemaVersion')) is not int or manifest['schemaVersion'] != 2:
        raise DiscoveryError('Invalid OCI manifest')
    digest = 'sha256:' + hashlib.sha256(body).hexdigest()
    supplied = headers.get('Docker-Content-Digest')
    if supplied is not None and supplied != digest:
        raise DiscoveryError('Registry manifest digest mismatch')
    return {'status': 'candidate', 'verified': False, 'tag': tag, 'commit': commit, 'digest': digest}


@contextmanager
def total_deadline(seconds):
    if threading.current_thread() is not threading.main_thread() or not hasattr(signal, 'setitimer'):
        raise DiscoveryError('A process-wide deadline is required')
    previous = signal.getsignal(signal.SIGALRM)
    if any(signal.getitimer(signal.ITIMER_REAL)):
        raise DiscoveryError('An existing deadline prevents discovery')
    def expired(_signum, _frame):
        raise DiscoveryError('Discovery timed out')
    signal.signal(signal.SIGALRM, expired)
    try:
        signal.setitimer(signal.ITIMER_REAL, seconds)
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)


def discover(transport, current, *, timeout_seconds=TIMEOUT):
    if not isinstance(timeout_seconds, (int, float)) or isinstance(timeout_seconds, bool) or not 0 < timeout_seconds <= TIMEOUT:
        raise DiscoveryError('Invalid discovery deadline')
    # The public entry point always owns the process deadline, including for library callers.
    with total_deadline(timeout_seconds):
        return _discover(transport, current)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--current', required=True, help='Currently installed stable version, such as v0.1.3')
    args = parser.parse_args()
    try:
        result = discover(Transport(time.monotonic() + TIMEOUT), args.current)
    except (DiscoveryError, OSError):
        print('Release discovery failed.', file=sys.stderr)
        return 1
    print(json.dumps(result, separators=(',', ':')))
    return 0


if __name__ == '__main__':
    sys.exit(main())
