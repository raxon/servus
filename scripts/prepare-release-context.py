#!/usr/bin/env python3
"""Build a release context exclusively from a committed Git tree."""

import argparse
import os
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import sys


def run():
    parser = argparse.ArgumentParser()
    parser.add_argument('--revision', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    commit = subprocess.check_output(['git', 'rev-parse', '--verify', args.revision + '^{commit}'], text=True).strip()
    if args.revision != commit:
        raise ValueError('A full commit ID is required')
    output = Path(args.output)
    output.mkdir(mode=0o700)
    archive = subprocess.Popen(['git', 'archive', '--format=tar', commit], stdout=subprocess.PIPE)
    assert archive.stdout is not None
    extract = subprocess.run(['tar', '-xf', '-', '-C', str(output)], stdin=archive.stdout, check=False)
    archive.stdout.close()
    archive_status = archive.wait()
    if extract.returncode or archive_status:
        raise ValueError('Cannot export release commit')
    assets = output / '.servus-install'
    assets.mkdir(mode=0o700)
    if (output / 'Dockerfile.release').exists():
        raise ValueError('Release Dockerfile path is reserved')
    manifest = output / 'scripts/release-install-files.txt'
    seen = set()
    for line in manifest.read_text(encoding='utf-8').splitlines():
        mode, path = line.split(' ', 1)
        p = PurePosixPath(path)
        if mode not in ('100644', '100755') or p.is_absolute() or str(p) != path or '..' in p.parts or path in seen:
            raise ValueError('Invalid install manifest')
        seen.add(path)
        entry = subprocess.check_output(['git', 'ls-tree', commit, '--', path], text=True).strip()
        if not entry.startswith(mode + ' blob ') or entry.split('\t', 1)[-1] != path:
            raise ValueError('Install file does not match commit: ' + path)
        source = output / path
        if source.is_symlink() or not source.is_file():
            raise ValueError('Install file is not regular: ' + path)
        dest = assets / path
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, dest)
        os.chmod(dest, int(mode[-3:], 8))
    if not seen:
        raise ValueError('Install manifest is empty')
    dockerfile = (output / 'Dockerfile').read_bytes()
    if not dockerfile.endswith(b'\n'):
        dockerfile += b'\n'
    (output / 'Dockerfile.release').write_bytes(dockerfile + b'COPY --chown=0:0 .servus-install/ /opt/servus/install/\n')


if __name__ == '__main__':
    try:
        run()
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        print('Release context preparation failed:', error, file=sys.stderr)
        raise SystemExit(1)
