#!/usr/bin/python3 -I
"""Verify a published Servus image against its public GitHub attestation."""
import argparse
import hashlib
import json
import os
import pathlib
import re
import selectors
import signal
import ssl
import stat
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

IMAGE = 'ghcr.io/raxon/servus'
REPO = 'raxon/servus'
WORKFLOW = 'raxon/servus/.github/workflows/release-image.yml'
PREDICATE = 'https://slsa.dev/provenance/v1'
BUNDLE_MEDIA = 'application/vnd.dev.sigstore.bundle.v0.3+json'
OCI_INDEX = 'application/vnd.oci.image.index.v1+json'
OCI_MANIFEST = 'application/vnd.oci.image.manifest.v1+json'
DOCKER_MANIFEST = 'application/vnd.docker.distribution.manifest.v2+json'
DOCKER_INDEX = 'application/vnd.docker.distribution.manifest.list.v2+json'
ACCEPT = ', '.join([OCI_INDEX, OCI_MANIFEST, DOCKER_MANIFEST, DOCKER_INDEX])
DIGEST_PATTERN = re.compile(r'^sha256:[a-f0-9]{64}$')
COMMIT_PATTERN = re.compile(r'^[a-f0-9]{40}$')
TAG_PATTERN = re.compile(r'^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$')
MAX_INDEX = 1024 * 1024
MAX_MANIFEST = 2 * 1024 * 1024
MAX_BUNDLE = 4 * 1024 * 1024
MAX_GH_OUTPUT = 8 * 1024 * 1024
MAX_RESULT = 16384
TOTAL_SECONDS = 90
GH_CANDIDATES = ('/usr/bin/gh', '/usr/local/bin/gh', '/opt/homebrew/bin/gh')
CA_CANDIDATES = ('/etc/ssl/certs/ca-certificates.crt', '/etc/ssl/cert.pem')

class VerificationError(Exception):
    pass

def root_owned_file(path, *, executable=False, allow_symlink=False):
    """Walk each symlink target and directory without trusting writable paths."""
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
                if not remaining and not allow_symlink:
                    return False
                links += 1
                if links > 40:
                    return False
                target = os.readlink(current)
                base = '/' if os.path.isabs(target) else os.path.dirname(current)
                target_path = os.path.normpath(os.path.join(base, target, *remaining))
                remaining = list(pathlib.PurePosixPath(target_path).parts[1:])
                current = '/'
                continue
            if info.st_mode & 0o022:
                return False
            if remaining and not stat.S_ISDIR(info.st_mode):
                return False
            if not remaining and (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1):
                return False
        if current == '/':
            return False
        return not executable or bool(info.st_mode & 0o111)
    except (OSError, RuntimeError, ValueError):
        return False

def registry_tls_context():
    # Do not honor SSL_CERT_FILE, SSL_CERT_DIR or SSLKEYLOGFILE from the caller.
    for path in CA_CANDIDATES:
        if root_owned_file(path, allow_symlink=True):
            try:
                context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
                context.load_verify_locations(cafile=path)
                return context
            except (OSError, ssl.SSLError):
                continue
    raise VerificationError('No trusted certificate bundle is available')

def require_inputs(digest, commit, tag):
    if not DIGEST_PATTERN.fullmatch(digest) or not COMMIT_PATTERN.fullmatch(commit) or len(tag) > 64 or not TAG_PATTERN.fullmatch(tag):
        raise VerificationError('Invalid image digest, source commit or release tag')

def decode_json(data):
    try:
        return json.loads(data)
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError) as exc:
        raise VerificationError('Invalid JSON from registry or verifier') from exc

def verify_bytes(data, digest, size=None):
    if not isinstance(digest, str) or not DIGEST_PATTERN.fullmatch(digest):
        raise VerificationError('Invalid OCI descriptor digest')
    if size is not None and (type(size) is not int or size < 0 or len(data) != size):
        raise VerificationError('OCI descriptor size mismatch')
    if hashlib.sha256(data).hexdigest() != digest[7:]:
        raise VerificationError('OCI content digest mismatch')

def allowed_blob_redirect(location):
    if not isinstance(location, str) or len(location) > 8192:
        return False
    try:
        target = urllib.parse.urlsplit(location)
        return (target.scheme == 'https' and target.hostname == 'pkg-containers.githubusercontent.com'
                and target.port in (None, 443) and not target.username and not target.password
                and target.path.startswith('/') and not target.fragment)
    except ValueError:
        return False

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

class Registry:
    def __init__(self, deadline):
        self.deadline = deadline
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect(), urllib.request.HTTPSHandler(context=registry_tls_context()))
        self.token = ''

    def _request(self, url, limit, token=False, redirect=False):
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise VerificationError('Verification timed out')
        headers = {'Accept': ACCEPT, 'User-Agent': 'servus-release-verifier'}
        if token:
            headers['Authorization'] = 'Bearer ' + self.token
        request = urllib.request.Request(url, headers=headers)
        try:
            response = self.opener.open(request, timeout=min(10, remaining))
        except urllib.error.HTTPError as exc:
            if not redirect or exc.code not in (301, 302, 303, 307, 308):
                raise VerificationError('Registry request failed') from None
            location = exc.headers.get('Location')
            if not allowed_blob_redirect(location):
                raise VerificationError('Registry redirect is not allowed') from None
            remaining = self.deadline - time.monotonic()
            if remaining <= 0:
                raise VerificationError('Verification timed out')
            try:
                response = self.opener.open(urllib.request.Request(location, headers={'User-Agent': 'servus-release-verifier'}), timeout=min(10, remaining))
            except (urllib.error.URLError, OSError):
                raise VerificationError('Registry blob request failed') from None
        except (urllib.error.URLError, OSError):
            raise VerificationError('Registry request failed') from None
        try:
            with response:
                length = response.headers.get('Content-Length')
                if length and (not length.isdigit() or int(length) > limit):
                    raise VerificationError('Registry response exceeds size limit')
                chunks, total = [], 0
                while True:
                    if self.deadline - time.monotonic() <= 0:
                        raise VerificationError('Verification timed out')
                    chunk = response.read1(min(65536, limit + 1 - total))
                    if not chunk:
                        return b''.join(chunks)
                    total += len(chunk)
                    if total > limit:
                        raise VerificationError('Registry response exceeds size limit')
                    chunks.append(chunk)
        except (urllib.error.URLError, OSError):
            raise VerificationError('Registry response failed') from None

    def authenticate(self):
        data = decode_json(self._request('https://ghcr.io/token?service=ghcr.io&scope=repository%3Araxon%2Fservus%3Apull', 16384))
        token = data.get('token') if isinstance(data, dict) else None
        if not isinstance(token, str) or not re.fullmatch(r'[A-Za-z0-9._~+/=-]{1,8192}', token):
            raise VerificationError('Invalid anonymous registry token')
        self.token = token

    def manifest(self, reference, limit=MAX_MANIFEST):
        if not (DIGEST_PATTERN.fullmatch(reference) or re.fullmatch(r'sha256-[a-f0-9]{64}', reference)):
            raise VerificationError('Invalid manifest reference')
        return self._request('https://ghcr.io/v2/raxon/servus/manifests/' + reference, limit, token=True)

    def blob(self, digest):
        if not DIGEST_PATTERN.fullmatch(digest):
            raise VerificationError('Invalid blob digest')
        return self._request('https://ghcr.io/v2/raxon/servus/blobs/' + digest, MAX_BUNDLE, token=True, redirect=True)

def cert_and_subject_match(result, digest, commit, tag):
    if not isinstance(result, list) or not result or len(result) > 16:
        return False
    ref = 'refs/tags/' + tag
    workflow_uri = 'https://github.com/' + WORKFLOW + '@' + ref
    for item in result:
        if not isinstance(item, dict):
            continue
        verified = item.get('verificationResult')
        if not isinstance(verified, dict):
            continue
        signature, statement = verified.get('signature'), verified.get('statement')
        cert = signature.get('certificate') if isinstance(signature, dict) else None
        if not isinstance(cert, dict) or not isinstance(statement, dict):
            continue
        expected = {
            'issuer': 'https://token.actions.githubusercontent.com',
            'subjectAlternativeName': workflow_uri,
            'buildSignerURI': workflow_uri,
            'sourceRepositoryURI': 'https://github.com/raxon/servus',
            'sourceRepositoryIdentifier': '1457036654',
            'sourceRepositoryOwnerURI': 'https://github.com/raxon',
            'sourceRepositoryOwnerIdentifier': '1338844',
            'sourceRepositoryDigest': commit,
            'sourceRepositoryRef': ref,
            'runnerEnvironment': 'github-hosted',
        }
        if any(cert.get(key) != value for key, value in expected.items()):
            continue
        subjects = statement.get('subject')
        if statement.get('predicateType') != PREDICATE or not isinstance(subjects, list) or len(subjects) > 32:
            continue
        if any(isinstance(subject, dict) and subject.get('name') == IMAGE and isinstance(subject.get('digest'), dict)
               and subject['digest'].get('sha256') == digest[7:] for subject in subjects):
            return True
    return False

def find_gh():
    for path in GH_CANDIDATES:
        candidate = pathlib.Path(path)
        if candidate.is_file() and os.access(path, os.X_OK):
            if os.geteuid() == 0 and not root_owned_file(path, executable=True):
                continue
            return path
    raise VerificationError('GitHub CLI is not installed in a trusted standard location')

def run_gh(manifest, bundle, commit, tag, tempdir, deadline):
    command = [find_gh(), 'attestation', 'verify', manifest, '--bundle', bundle,
               '--repo', REPO, '--signer-workflow', WORKFLOW, '--source-digest', commit,
               '--source-ref', 'refs/tags/' + tag, '--deny-self-hosted-runners', '--format', 'json']
    env = {'PATH': '/usr/bin:/bin', 'HOME': tempdir, 'GH_CONFIG_DIR': tempdir,
           'GH_PROMPT_DISABLED': '1', 'GH_NO_UPDATE_NOTIFIER': '1'}
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise VerificationError('Verification timed out')
    try:
        process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env, cwd=tempdir)
    except OSError:
        raise VerificationError('Could not start GitHub CLI') from None
    selector = selectors.DefaultSelector()
    output = bytearray()
    try:
        selector.register(process.stdout, selectors.EVENT_READ)
        while selector.get_map():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise VerificationError('Verification timed out')
            events = selector.select(remaining)
            if not events:
                raise VerificationError('Verification timed out')
            chunk = os.read(process.stdout.fileno(), 65536)
            if not chunk:
                selector.unregister(process.stdout)
                break
            output.extend(chunk)
            if len(output) > MAX_GH_OUTPUT:
                raise VerificationError('Verifier output exceeds size limit')
        remaining = deadline - time.monotonic()
        if remaining <= 0 or process.wait(timeout=remaining) != 0:
            raise VerificationError('Attestation signature verification failed')
    except subprocess.TimeoutExpired:
        raise VerificationError('Verification timed out') from None
    finally:
        selector.close()
        if process.poll() is None:
            process.kill()
            process.wait()
        if process.stdout:
            process.stdout.close()
    return decode_json(output)

def trusted_temp_root():
    for name in ('/tmp', '/private/tmp'):
        path = pathlib.Path(name)
        try:
            chain = (path,) + tuple(path.parents)
            safe = True
            for position, part in enumerate(chain):
                info = os.lstat(part)
                if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0:
                    safe = False
                    break
                if info.st_mode & (stat.S_IWGRP | stat.S_IWOTH):
                    if position != 0 or not (info.st_mode & stat.S_ISVTX):
                        safe = False
                        break
            if safe and os.access(path, os.W_OK | os.X_OK):
                return str(path)
        except OSError:
            continue
    raise VerificationError('No trusted temporary directory is available')

def validate_private_temp(path, root):
    try:
        info = os.lstat(path)
        if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid()
            or stat.S_IMODE(info.st_mode) != 0o700 or os.path.dirname(path) != root):
            raise VerificationError('Temporary directory is not private')
    except OSError:
        raise VerificationError('Temporary directory is unavailable') from None

def write_private(path, data):
    fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    with os.fdopen(fd, 'wb') as out:
        out.write(data)

def _verify_release(digest, commit, tag, registry=None, verify=run_gh):
    require_inputs(digest, commit, tag)
    deadline = time.monotonic() + TOTAL_SECONDS
    registry = registry or Registry(deadline)
    registry.authenticate()
    manifest = registry.manifest(digest)
    verify_bytes(manifest, digest)
    image = decode_json(manifest)
    if not isinstance(image, dict) or image.get('schemaVersion') != 2 or image.get('mediaType') not in (OCI_INDEX, OCI_MANIFEST, DOCKER_MANIFEST, DOCKER_INDEX):
        raise VerificationError('Unsupported image manifest')
    index = decode_json(registry.manifest('sha256-' + digest[7:], MAX_INDEX))
    descriptors = index.get('manifests') if isinstance(index, dict) and index.get('mediaType') == OCI_INDEX and index.get('schemaVersion') == 2 else None
    if not isinstance(descriptors, list) or not descriptors or len(descriptors) > 16:
        raise VerificationError('Missing or invalid attestation index')
    candidates = [item for item in descriptors if isinstance(item, dict) and item.get('mediaType') == OCI_MANIFEST and item.get('artifactType') == BUNDLE_MEDIA]
    if not candidates or len(candidates) > 4:
        raise VerificationError('Missing or excessive attestation candidates')
    temp_root = trusted_temp_root()
    with tempfile.TemporaryDirectory(prefix='servus-verify-', dir=temp_root) as tmp:
        validate_private_temp(tmp, temp_root)
        manifest_path = os.path.join(tmp, 'manifest')
        write_private(manifest_path, manifest)
        for number, descriptor in enumerate(candidates):
            ref, size = descriptor.get('digest'), descriptor.get('size')
            if not isinstance(ref, str) or not DIGEST_PATTERN.fullmatch(ref) or type(size) is not int or size < 0 or size > MAX_MANIFEST:
                raise VerificationError('Invalid attestation descriptor')
            data = registry.manifest(ref)
            verify_bytes(data, ref, size)
            artifact = decode_json(data)
            subject = artifact.get('subject') if isinstance(artifact, dict) else None
            layers = artifact.get('layers') if isinstance(artifact, dict) else None
            if (not isinstance(artifact, dict) or artifact.get('schemaVersion') != 2 or artifact.get('mediaType') != OCI_MANIFEST
                or artifact.get('artifactType') != BUNDLE_MEDIA or not isinstance(subject, dict) or subject.get('digest') != digest
                or subject.get('size') != len(manifest) or subject.get('mediaType') != image.get('mediaType')
                or not isinstance(layers, list) or len(layers) != 1 or not isinstance(layers[0], dict) or layers[0].get('mediaType') != BUNDLE_MEDIA):
                raise VerificationError('Invalid attestation manifest')
            blob_digest, blob_size = layers[0].get('digest'), layers[0].get('size')
            if not isinstance(blob_digest, str) or not DIGEST_PATTERN.fullmatch(blob_digest) or type(blob_size) is not int or blob_size < 0 or blob_size > MAX_BUNDLE:
                raise VerificationError('Invalid attestation bundle descriptor')
            bundle = registry.blob(blob_digest)
            verify_bytes(bundle, blob_digest, blob_size)
            bundle_path = os.path.join(tmp, 'bundle-' + str(number) + '.json')
            write_private(bundle_path, bundle)
            try:
                result = verify(manifest_path, bundle_path, commit, tag, tmp, deadline)
            except VerificationError:
                continue
            if cert_and_subject_match(result, digest, commit, tag):
                return {'image': IMAGE, 'digest': digest, 'commit': commit, 'tag': tag, 'verified': True}
    raise VerificationError('No attestation matched the release identity')

def require_exclusive_child_wait():
    """Reject process state that could reap the verifier behind its supervisor."""
    if signal.getsignal(signal.SIGCHLD) != signal.SIG_DFL or threading.active_count() != 1:
        raise VerificationError('Verification requires an isolated single-threaded process with default SIGCHLD')
    if sys.platform.startswith('linux'):
        try:
            if len(os.listdir('/proc/self/task')) != 1:
                raise VerificationError('Verification requires an isolated single-threaded process')
        except OSError:
            raise VerificationError('Cannot establish exclusive child ownership') from None

def bounded_verification(callback, timeout):
    """Enforce a wall-clock deadline even when DNS or a socket read blocks."""
    if not hasattr(os, 'fork') or not isinstance(timeout, (int, float)) or not 0 < timeout <= TOTAL_SECONDS:
        raise VerificationError('Cannot enforce the verification deadline')
    require_exclusive_child_wait()
    deadline = time.monotonic() + timeout
    read_fd, write_fd = os.pipe()
    try:
        parent_read_fd, parent_write_fd = os.pipe()
    except OSError:
        os.close(read_fd)
        os.close(write_fd)
        raise VerificationError('Cannot start bounded verification') from None
    try:
        pid = os.fork()
    except OSError:
        os.close(read_fd)
        os.close(write_fd)
        os.close(parent_read_fd)
        os.close(parent_write_fd)
        raise VerificationError('Cannot start bounded verification') from None
    if pid == 0:
        try:
            os.close(read_fd)
            os.close(parent_write_fd)
            os.setsid()
            def watch_parent():
                try:
                    # Only the supervisor holds the write end; EOF means it exited.
                    while os.read(parent_read_fd, 1):
                        pass
                finally:
                    os.killpg(os.getpgrp(), signal.SIGKILL)
            threading.Thread(target=watch_parent, daemon=True).start()
            try:
                result = json.dumps({'ok': True, 'result': callback()}, separators=(',', ':')).encode('utf-8')
            except BaseException:
                result = b'{"ok":false}'
            if len(result) > MAX_RESULT:
                result = b'{"ok":false}'
            offset = 0
            while offset < len(result):
                offset += os.write(write_fd, result[offset:])
            os.close(write_fd)
            write_fd = -1
            # Keep the process-group leader alive until its supervisor cleans
            # up the group; a zombie-only group cannot be signalled on macOS.
            while True:
                signal.pause()
        except BaseException:
            pass
        finally:
            try:
                if write_fd >= 0: os.close(write_fd)
            except OSError: pass
            os._exit(0)
    os.close(write_fd)
    os.close(parent_read_fd)
    selector = None
    result = bytearray()
    try:
        selector = selectors.DefaultSelector()
        selector.register(read_fd, selectors.EVENT_READ)
        while selector.get_map():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise VerificationError('Verification timed out')
            events = selector.select(remaining)
            if events:
                chunk = os.read(read_fd, MAX_RESULT + 1 - len(result))
                if not chunk:
                    selector.unregister(read_fd)
                else:
                    result.extend(chunk)
                    if len(result) > MAX_RESULT:
                        raise VerificationError('Verification result exceeds size limit')
        parsed = decode_json(result)
        if not isinstance(parsed, dict) or parsed.get('ok') is not True or not isinstance(parsed.get('result'), dict):
            raise VerificationError('Release verification failed')
        return parsed['result']
    finally:
        if selector is not None:
            selector.close()
        os.close(read_fd)
        # Kill the group before reaping its leader. Its PID remains reserved, so
        # this cannot accidentally target a new process group with a reused ID.
        cleanup_failed = False
        try: os.killpg(pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            cleanup_failed = True
            try: os.kill(pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError): pass
        os.close(parent_write_fd)
        # waitpid with WNOHANG avoids blocking indefinitely on an uninterruptible child.
        reaped = False
        for _ in range(20):
            try:
                done, _ = os.waitpid(pid, os.WNOHANG)
            except ChildProcessError:
                reaped = True
                break
            if done:
                reaped = True
                break
            time.sleep(0.01)
        if not reaped:
            # Reap later if the kernel temporarily keeps the killed child alive.
            def reap_later():
                try: os.waitpid(pid, 0)
                except ChildProcessError: pass
            threading.Thread(target=reap_later, daemon=True).start()
        if cleanup_failed:
            raise VerificationError('Verification process group could not be stopped')

def verify_release(digest, commit, tag, registry=None, verify=run_gh):
    if os.geteuid() == 0:
        raise VerificationError('Release verification requires a configured cgroup supervisor')
    if __name__ != '__main__' or not sys.flags.isolated:
        raise VerificationError('Release verification requires the isolated CLI')
    require_inputs(digest, commit, tag)
    if registry is not None:
        # Injected registries are limited to local unit tests.
        return _verify_release(digest, commit, tag, registry, verify)
    return bounded_verification(lambda: _verify_release(digest, commit, tag, None, verify), TOTAL_SECONDS)

def main():
    parser = argparse.ArgumentParser(description='Verify a public Servus GHCR image attestation')
    parser.add_argument('--digest', required=True)
    parser.add_argument('--commit', required=True)
    parser.add_argument('--tag', required=True)
    args, unknown = parser.parse_known_args()
    if unknown:
        print('Release verification failed', file=sys.stderr)
        return 1
    # Process groups and parent-death monitoring do not contain detached children.
    # A root-owned systemd cgroup supervisor must be integrated before root use.
    if os.geteuid() == 0:
        print('Release verification requires a configured cgroup supervisor', file=sys.stderr)
        return 1
    try:
        print(json.dumps(verify_release(args.digest, args.commit, args.tag), separators=(',', ':')))
    except (VerificationError, OSError, ValueError):
        print('Release verification failed', file=sys.stderr)
        return 1
    return 0

if __name__ == '__main__':
    if os.geteuid() == 0 and not sys.flags.isolated:
        print('Release verification requires isolated Python', file=sys.stderr)
        sys.exit(1)
    sys.exit(main())
