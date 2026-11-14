#!/usr/bin/python3 -I
"""Activate the initial policy for a verified and prepared release.

This does not stop containers, create a backup, install a release, or start a
service. The caller must arrange those steps and keep the updater stopped.
"""
import argparse
import fcntl
import importlib.util
import os
import pathlib
import re
import sqlite3
import stat
import sys
import time


class BootstrapError(Exception):
    pass


def bootstrap(journal, operation, accepted_env, install_dir, control_dir, policy_root,
              extractor, supervisor, policy, *, resolve_child=None, verify_active=None):
    if not supervisor._uuid4(operation): raise BootstrapError('Invalid operation identity')
    row = journal.db.execute("SELECT p.preparation_id,p.staging_path,o.digest FROM preparations p JOIN operations o ON o.id=p.operation_id WHERE p.operation_id=? AND p.status='prepared' AND o.status='verified' AND p.attempt_id=o.attempt_id AND p.attempt_nonce=o.attempt_nonce", (operation,)).fetchone()
    if (not row or not supervisor._uuid4(row[0]) or not isinstance(row[1], str) or
        not os.path.isabs(row[1]) or os.path.normpath(row[1]) != row[1] or
        not re.fullmatch(r'servus-install-[a-f0-9]{32}', os.path.basename(row[1])) or
        not isinstance(row[2], str) or not re.fullmatch(r'sha256:[a-f0-9]{64}', row[2])):
        raise BootstrapError('Verified preparation is unavailable')
    parent = supervisor._trusted_directory(policy_root, 0o700)
    os.close(parent)
    candidate = os.path.join(policy_root, 'candidate-' + row[0] + '.json')
    active = os.path.join(policy_root, 'policy-' + operation + '.json')
    table = journal.db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='policy_approvals'").fetchone()
    approvals = journal.db.execute('SELECT operation_id,state,candidate_path,source_env_path,policy_path,accepted_env_path FROM policy_approvals').fetchall() if table else []
    if approvals:
        if len(approvals) != 1:
            raise BootstrapError('An existing policy requires recovery')
        approval = approvals[0]
        if approval[:4] == (operation, 'active', candidate, accepted_env):
            snapshot = os.path.join(policy_root, 'env-' + row[0] + '.env')
            if approval[4:] != (active, snapshot) or verify_active is None:
                raise BootstrapError('An existing policy requires recovery')
            verified = verify_active(active, snapshot, operation)
            if verified.install_dir != install_dir or verified.control_dir != control_dir:
                raise BootstrapError('The active policy does not match this installation')
            return active
        if approval[:4] != (operation, 'candidate', candidate, accepted_env) or approval[4] is not None:
            raise BootstrapError('An existing policy requires recovery')
    else:
        policy.produce(journal, operation, os.path.dirname(row[1]), accepted_env, install_dir,
                       candidate, extractor, supervisor, resolve_child=resolve_child)
    return policy.activate(journal, operation, accepted_env, candidate, active, install_dir,
                           control_dir, extractor, supervisor)


def _trusted_modules():
    directory = pathlib.Path(os.path.realpath(__file__)).parent
    current = pathlib.Path('/')
    for part in directory.parts[1:]:
        current /= part
        info = current.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise BootstrapError('Untrusted updater directory')
    def load(name, filename, mode):
        path = directory / filename
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != mode:
                raise BootstrapError('Untrusted updater module')
        finally: os.close(fd)
        spec = importlib.util.spec_from_file_location(name, path)
        if not spec or not spec.loader: raise BootstrapError('Updater module unavailable')
        module = importlib.util.module_from_spec(spec); sys.modules[name] = module
        spec.loader.exec_module(module)
        return module
    supervisor = load('supervisor', 'supervisor.py', 0o644)
    return supervisor, load('servus_bootstrap_journal', 'servus-updater.py', 0o755), load('servus_bootstrap_policy', 'runtime-policy.py', 0o644), load('servus_bootstrap_extract', 'extract-install.py', 0o644), load('servus_bootstrap_verify', 'verify-release.py', 0o644), load('servus_bootstrap_daemon', 'supervisor-daemon.py', 0o644)


def main():
    parser = argparse.ArgumentParser()
    for name in ('operation', 'state-dir', 'accepted-env', 'install-dir', 'control-dir', 'policy-dir'):
        parser.add_argument('--' + name, required=True)
    args = parser.parse_args()
    if sys.platform != 'linux' or os.geteuid() != 0 or not sys.flags.isolated:
        print('Initial policy requires isolated Linux root.', file=sys.stderr); return 1
    os.umask(0o077)
    lock = None; journal = None
    try:
        supervisor, updater, policy, extractor, verifier, daemon = _trusted_modules()
        state = updater.trusted_directory(args.state_dir, 0o700)
        directory = supervisor._trusted_directory(str(state), 0o700)
        try:
            for name in ('service.lock', 'journal.sqlite'):
                fd = supervisor._open_root_file(directory, name, 0o600)
                if name == 'service.lock': lock = fd
                else: os.close(fd)
        finally: os.close(directory)
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        journal = updater.Journal(state)
        def resolve_child(root, config):
            registry = verifier.Registry(time.monotonic() + verifier.TOTAL_SECONDS)
            registry.authenticate()
            return verifier.revalidate_amd64_identity(registry, root, config)
        def verify_active(path, snapshot, operation):
            return daemon.load_approved_policy(path, str(state / 'journal.sqlite'), snapshot,
                                               expected_operation_id=operation)
        bootstrap(journal, args.operation, args.accepted_env, args.install_dir, args.control_dir,
                  args.policy_dir, extractor, supervisor, policy, resolve_child=resolve_child,
                  verify_active=verify_active)
        return 0
    except Exception:
        print('Initial policy could not be activated safely.', file=sys.stderr)
        return 1
    finally:
        if journal is not None: journal.close()
        if lock is not None: os.close(lock)


if __name__ == '__main__': raise SystemExit(main())
