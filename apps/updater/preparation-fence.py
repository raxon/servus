#!/usr/bin/python3 -I
"""Execute one durable preparation inside a transient systemd cgroup.

A clean cgroup is not evidence that an interrupted Docker daemon request has
finished. The caller must retain recovery_required after any uncertain outcome.
"""
import argparse
import importlib.util
import os
import pathlib
import stat
import sys
import time

BASE = pathlib.Path('/usr/local/libexec/servus')
PYTHON = '/usr/bin/python3'
SYSTEMD_RUN = '/usr/bin/systemd-run'
RUNNER = BASE / 'preparation-fence.py'


def unit_name(preparation_id):
    import uuid
    try:
        value = uuid.UUID(preparation_id)
    except (ValueError, TypeError, AttributeError):
        raise ValueError('Invalid preparation identity') from None
    if value.version != 4 or str(value) != preparation_id:
        raise ValueError('Invalid preparation identity')
    return 'servus-prepare-' + value.hex + '.service'


def command(state_dir, operation_id, preparation_id):
    # RuntimeMaxSec and KillMode cover the worker, Docker CLI and any plugin.
    return [SYSTEMD_RUN, '--quiet', '--wait', '--pipe', '--collect', '--unit', unit_name(preparation_id),
            '--setenv=PATH=/usr/bin:/bin', '--property=Type=exec', '--property=KillMode=control-group',
            '--property=RuntimeMaxSec=1000', '--property=TimeoutStopSec=5',
            '--property=NoNewPrivileges=yes', '--property=PrivateTmp=yes',
            '--property=ProtectHome=yes', '--property=TasksMax=128', '--property=MemoryMax=1G',
            '--property=UnsetEnvironment=LD_PRELOAD LD_LIBRARY_PATH PYTHONPATH PYTHONHOME SSLKEYLOGFILE SSL_CERT_FILE SSL_CERT_DIR DOCKER_HOST DOCKER_CONTEXT DOCKER_CONFIG',
            PYTHON, '-I', str(RUNNER), '--run', '--state-dir', str(state_dir),
            '--operation-id', operation_id, '--preparation-id', preparation_id]


def load(name, path, updater=None):
    if updater:
        updater.trusted_root_file(path)
    spec = importlib.util.spec_from_file_location(name, path)
    if not spec or not spec.loader:
        raise RuntimeError('Required preparation module unavailable')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def trusted_module(path):
    current = pathlib.Path('/')
    root = current.lstat()
    if root.st_uid != 0 or root.st_mode & 0o022 or not stat.S_ISDIR(root.st_mode):
        raise RuntimeError('Preparation module is not trusted')
    for part in path.parts[1:]:
        current /= part
        info = current.lstat()
        if info.st_uid != 0 or info.st_mode & 0o022 or stat.S_ISLNK(info.st_mode):
            raise RuntimeError('Preparation module is not trusted')
        if current != path and not stat.S_ISDIR(info.st_mode):
            raise RuntimeError('Preparation module is not trusted')
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise RuntimeError('Preparation module is not trusted')


def run(state_dir, operation_id, preparation_id):
    if sys.platform != 'linux' or os.geteuid() != 0 or not sys.flags.isolated:
        raise RuntimeError('Isolated root execution is required')
    for name in ('servus-updater.py', 'prepare-verified.py', 'extract-install.py', 'verify-release.py', 'preparation-fence.py'):
        trusted_module(BASE / name)
    updater = load('servus_updater', BASE / 'servus-updater.py')
    state = updater.trusted_directory(state_dir, 0o700)
    stage = updater.trusted_directory(state / 'staging', 0o700)
    journal = updater.Journal(state)
    try:
        operation = journal.preparing(operation_id, preparation_id)
        if operation is None:
            raise RuntimeError('Preparation has been revoked')
        prepare = load('servus_prepare', BASE / 'prepare-verified.py', updater)
        extract = load('servus_extract', BASE / 'extract-install.py', updater)
        verify = load('servus_verify', BASE / 'verify-release.py', updater)
        def resolve(root, config):
            registry = verify.Registry(time.monotonic() + verify.TOTAL_SECONDS)
            registry.authenticate()
            return verify.revalidate_amd64_identity(registry, root, config)
        prepare.prepare_claimed(journal, operation, str(stage), extract, resolve_child=resolve, defer_commit=True)
    finally:
        journal.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--run', action='store_true', required=True)
    parser.add_argument('--state-dir', required=True)
    parser.add_argument('--operation-id', required=True)
    parser.add_argument('--preparation-id', required=True)
    args = parser.parse_args()
    try:
        unit_name(args.preparation_id)
        run(args.state_dir, args.operation_id, args.preparation_id)
    except (OSError, RuntimeError, ValueError):
        print('Preparation could not be completed safely', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
