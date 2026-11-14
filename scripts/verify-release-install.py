#!/usr/bin/env python3
"""Compare a built image's install files with the exact release commit."""

import argparse
from pathlib import PurePosixPath
import re
import subprocess
import sys
import tarfile

MAX_FILE = 2 * 1024 * 1024
MAX_TOTAL = 16 * 1024 * 1024


def expected_files(commit):
    manifest = subprocess.check_output(['git', 'show', commit + ':scripts/release-install-files.txt'], text=True)
    expected = {}
    for line in manifest.splitlines():
        mode, name = line.split(' ', 1)
        path = PurePosixPath(name)
        if mode not in ('100644', '100755') or path.is_absolute() or str(path) != name or '..' in path.parts or name in expected:
            raise ValueError('Invalid install manifest')
        entry = subprocess.check_output(['git', 'ls-tree', commit, '--', name], text=True).strip()
        if not entry.startswith(mode + ' blob ') or entry.split('\t', 1)[-1] != name:
            raise ValueError('Install manifest differs from commit')
        content = subprocess.check_output(['git', 'show', commit + ':' + name])
        if len(content) > MAX_FILE:
            raise ValueError('Install file is too large')
        expected[name] = (int(mode[-3:], 8), content)
    if not expected or sum(len(value[1]) for value in expected.values()) > MAX_TOTAL:
        raise ValueError('Invalid install file total')
    return expected


def verify_stream(stream, expected):
    dirs = {'.'}
    for name in expected:
        parent = PurePosixPath(name).parent
        while str(parent) != '.':
            dirs.add(str(parent))
            parent = parent.parent
    seen = set()
    total = 0
    with tarfile.open(fileobj=stream, mode='r|') as archive:
        for entry in archive:
            raw = entry.name
            name = raw.removeprefix('./').rstrip('/') or '.'
            path = PurePosixPath(name)
            if (path.is_absolute() or str(path) != name or '..' in path.parts or name in seen or
                    entry.uid != 0 or entry.gid != 0):
                raise ValueError('Invalid image install entry')
            seen.add(name)
            if entry.isdir():
                if name not in dirs or entry.mode & 0o022:
                    raise ValueError('Unexpected install directory')
                continue
            if not entry.isfile() or name not in expected or entry.size > MAX_FILE:
                raise ValueError('Unexpected install file')
            mode, content = expected[name]
            total += entry.size
            if total > MAX_TOTAL or entry.mode != mode or entry.size != len(content):
                raise ValueError('Install file mode or size differs from commit')
            member = archive.extractfile(entry)
            if member is None or member.read(MAX_FILE + 1) != content:
                raise ValueError('Install file content differs from commit')
    if seen != set(expected) | dirs:
        raise ValueError('Install file set differs from commit')


def run():
    parser = argparse.ArgumentParser()
    parser.add_argument('--revision', required=True)
    parser.add_argument('--image-id', required=True)
    args = parser.parse_args()
    if not re.fullmatch(r'[0-9a-f]{40}', args.revision) or not re.fullmatch(r'sha256:[0-9a-f]{64}', args.image_id):
        raise ValueError('Full commit and image IDs are required')
    expected = expected_files(args.revision)
    cid = subprocess.check_output(['docker', 'create', '--pull=never', '--network=none', '--entrypoint', '/bin/false', args.image_id], text=True).strip()
    if not re.fullmatch(r'[0-9a-f]{64}', cid):
        raise ValueError('Invalid inspection container ID')
    process = None
    try:
        process = subprocess.Popen(['docker', 'cp', cid + ':/opt/servus/install/.', '-'], stdout=subprocess.PIPE)
        assert process.stdout is not None
        verify_stream(process.stdout, expected)
        process.stdout.close()
        if process.wait() != 0:
            raise ValueError('Cannot read image installation files')
    finally:
        if process is not None and process.poll() is None:
            process.kill()
            process.wait()
        subprocess.run(['docker', 'rm', '-f', cid], check=True, stdout=subprocess.DEVNULL)
    print('Image installation files match release commit')


if __name__ == '__main__':
    try:
        run()
    except (OSError, ValueError, tarfile.TarError, subprocess.SubprocessError) as error:
        print('Release install verification failed:', error, file=sys.stderr)
        raise SystemExit(1)
