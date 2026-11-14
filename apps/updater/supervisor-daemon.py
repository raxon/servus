#!/usr/bin/python3
"""Serve authenticated component channels until a root operator requests a drain.

The policy must be provisioned independently from trusted installation inputs.
No production policy provisioner is implemented yet. This daemon never derives
expected policy from the running containers or applies updates.
"""
import argparse
import errno
import fcntl
import hashlib
import json
import os
import select
import signal
import socket
import sqlite3
import stat
import struct
import sys
import time
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
import supervisor

APPROVED_IMAGE = 'ghcr.io/raxon/servus'


def load_policy(path):
    parent, name = os.path.split(path)
    if not name or not os.path.isabs(path) or os.path.normpath(path) != path:
        raise supervisor.SupervisorError('Invalid policy path')
    directory = supervisor._trusted_directory(parent)
    try:
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        try:
            info = os.fstat(fd)
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1 or
                    stat.S_IMODE(info.st_mode) != 0o600 or info.st_size > 1048576):
                raise supervisor.SupervisorError('Unsafe policy file')
            with os.fdopen(fd, 'rb', closefd=False) as source:
                content = source.read(1048577)
            final = os.fstat(fd)
            named = os.stat(name, dir_fd=directory, follow_symlinks=False)
            if (len(content) != info.st_size or len(content) > 1048576 or
                    (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns) !=
                    (final.st_dev, final.st_ino, final.st_size, final.st_mtime_ns, final.st_ctime_ns) or
                    (named.st_dev, named.st_ino) != (info.st_dev, info.st_ino)):
                raise supervisor.SupervisorError('Policy changed while reading')
            document = json.loads(content, object_pairs_hook=supervisor._pairs)
        finally:
            os.close(fd)
    finally:
        os.close(directory)
    if (not isinstance(document, dict) or set(document) != {'version', 'policy'} or
            type(document['version']) is not int or document['version'] != 1 or not isinstance(document['policy'], dict) or
            set(document['policy']) != {'image_reference', 'image_id', 'install_dir', 'data_dir', 'gate_dir',
                                       'control_dir', 'secret_sources', 'config_hashes', 'environments',
                                       'host_configs', 'healthchecks'}):
        raise supervisor.SupervisorError('Invalid policy document')
    try:
        return supervisor.RuntimePolicy(**document['policy'])
    except (TypeError, ValueError) as error:
        raise supervisor.SupervisorError('Invalid policy document') from error


def _private_file(path, maximum):
    if not isinstance(path, str):
        raise supervisor.SupervisorError('Invalid protected path')
    parent, name = os.path.split(path)
    if not name or not os.path.isabs(path) or os.path.normpath(path) != path:
        raise supervisor.SupervisorError('Invalid protected path')
    directory = supervisor._trusted_directory(parent, 0o700)
    try:
        fd = supervisor._open_root_file(directory, name, 0o600)
        try:
            before = os.fstat(fd)
            if before.st_size > maximum:
                raise supervisor.SupervisorError('Protected file is too large')
            with os.fdopen(fd, 'rb', closefd=False) as source:
                value = source.read(maximum + 1)
            after = os.fstat(fd)
            named = os.stat(name, dir_fd=directory, follow_symlinks=False)
            if (len(value) != before.st_size or len(value) > maximum or
                (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) !=
                (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns) or
                (named.st_dev, named.st_ino) != (before.st_dev, before.st_ino)):
                raise supervisor.SupervisorError('Protected file changed while reading')
            return value
        finally:
            os.close(fd)
    finally:
        os.close(directory)


def load_approved_policy(path, approval_journal, accepted_env, *, expected_operation_id=None):
    """Require a verified active approval and the unchanged accepted files."""
    config = _private_file(accepted_env, 65536)
    policy_data = _private_file(path, 1048576)
    _private_file(approval_journal, 64 * 1024 * 1024)
    try:
        uri = 'file:' + urllib.parse.quote(approval_journal, safe='/') + '?mode=ro'
        with sqlite3.connect(uri, uri=True, timeout=2) as db:
            row = db.execute("SELECT a.root_digest,a.env_digest,a.candidate_digest,a.operation_id,a.source_env_path FROM policy_approvals a JOIN operations o ON o.id=a.operation_id JOIN preparations p ON p.operation_id=a.operation_id WHERE a.policy_path=? AND a.accepted_env_path=? AND a.state='active' AND o.status='verified' AND o.attempt_id=a.attempt_id AND o.attempt_nonce=a.attempt_nonce AND o.digest=a.root_digest AND o.config_digest=a.image_config_digest AND p.status IN ('prepared','completed') AND p.attempt_id=a.attempt_id AND p.attempt_nonce=a.attempt_nonce AND p.preparation_id=a.preparation_id AND NOT EXISTS (SELECT 1 FROM policy_approvals WHERE state IN ('activating','recovery_required')) AND NOT EXISTS (SELECT 1 FROM extraction_probes WHERE status='intent') AND EXISTS (SELECT 1 FROM policy_probes WHERE operation_id=a.operation_id AND preparation_id=a.preparation_id AND config_digest=a.env_digest AND state='removed')", (path, accepted_env)).fetchall()
        if (len(row) != 1 or row[0][1] != 'sha256:' + hashlib.sha256(config).hexdigest() or
            row[0][2] != 'sha256:' + hashlib.sha256(policy_data).hexdigest() or
            (expected_operation_id is not None and row[0][3] != expected_operation_id)):
            raise supervisor.SupervisorError('Active policy approval is invalid')
        active_config = _private_file(row[0][4], 65536)
        if row[0][1] != 'sha256:' + hashlib.sha256(active_config).hexdigest():
            raise supervisor.SupervisorError('Active policy approval is invalid')
        policy = load_policy(path)
        if policy.image_reference != APPROVED_IMAGE + '@' + row[0][0]:
            raise supervisor.SupervisorError('Active policy approval is invalid')
        return policy
    except (sqlite3.Error, ValueError, OSError) as error:
        raise supervisor.SupervisorError('Active policy approval is unavailable') from error


def approved_policy_binding(hub, path, approval_journal, accepted_env):
    """Capture the approved policy for the authenticated hub under install.lock."""
    policy = load_approved_policy(path, approval_journal, accepted_env)
    if policy != hub.policy:
        raise supervisor.SupervisorError('Active policy changed')
    env_digest = 'sha256:' + hashlib.sha256(_private_file(accepted_env, 65536)).hexdigest()
    policy_digest = 'sha256:' + hashlib.sha256(_private_file(path, 1048576)).hexdigest()
    if load_approved_policy(path, approval_journal, accepted_env) != policy:
        raise supervisor.SupervisorError('Active policy changed')
    return path, env_digest, policy_digest, policy


def resolve_active_policy(approval_journal, active_env):
    """Resolve the approved generation while the caller holds install.lock."""
    _private_file(approval_journal, 64 * 1024 * 1024)
    try:
        uri = 'file:' + urllib.parse.quote(approval_journal, safe='/') + '?mode=ro'
        with sqlite3.connect(uri, uri=True, timeout=2) as db:
            rows = db.execute("SELECT policy_path,accepted_env_path,source_env_path FROM policy_approvals WHERE state='active'").fetchall()
        if len(rows) != 1 or rows[0][2] != active_env or not all(isinstance(item, str) and item for item in rows[0]):
            raise supervisor.SupervisorError('Active policy generation is unavailable')
        path, accepted_env, _ = rows[0]
        policy = load_approved_policy(path, approval_journal, accepted_env)
        with sqlite3.connect(uri, uri=True, timeout=2) as db:
            current = db.execute("SELECT policy_path,accepted_env_path,source_env_path FROM policy_approvals WHERE state='active'").fetchall()
        if current != rows:
            raise supervisor.SupervisorError('Active policy generation changed')
        return path, accepted_env, policy
    except (sqlite3.Error, ValueError, OSError) as error:
        raise supervisor.SupervisorError('Active policy generation is unavailable') from error


def complete_healthy_preparation(hub, approval_journal, operation_id, policy_path, accepted_env):
    """Record completion only while all authenticated roles are healthy."""
    if supervisor.inspect_servus(hub.policy) != hub.identities:
        raise supervisor.SupervisorError('Container identity changed')
    if select.select(list(hub.connections.values()), [], [], 0)[0]:
        raise supervisor.SupervisorError('A component channel changed')
    ids = [hub.identities[role]['id'] for role in supervisor.ROLES]
    try:
        records = json.loads(supervisor._docker('inspect', *ids), object_pairs_hook=supervisor._pairs)
        if not isinstance(records, list) or len(records) != len(ids):
            raise supervisor.SupervisorError('Container health is unavailable')
        by_id = {item.get('Id'): item for item in records if isinstance(item, dict)}
        if set(by_id) != set(ids):
            raise supervisor.SupervisorError('Container health is unavailable')
        for role in supervisor.ROLES:
            state = by_id[hub.identities[role]['id']].get('State')
            if (not isinstance(state, dict) or state.get('Running') is not True or
                (role in ('api', 'agent') and (not isinstance(state.get('Health'), dict) or state['Health'].get('Status') != 'healthy'))):
                raise supervisor.SupervisorError('Container health is unavailable')
        uri = 'file:' + urllib.parse.quote(approval_journal, safe='/') + '?mode=rw'
        with sqlite3.connect(uri, uri=True, timeout=2) as db:
            db.execute('BEGIN IMMEDIATE')
            cursor = db.execute("UPDATE preparations SET status='completed' WHERE operation_id=? AND status='prepared' AND NOT EXISTS (SELECT 1 FROM extraction_probes WHERE status='intent') AND EXISTS (SELECT 1 FROM policy_approvals a JOIN operations o ON o.id=a.operation_id WHERE a.operation_id=preparations.operation_id AND a.policy_path=? AND a.accepted_env_path=? AND a.state='active' AND a.attempt_id=preparations.attempt_id AND a.attempt_nonce=preparations.attempt_nonce AND a.preparation_id=preparations.preparation_id AND o.status='verified' AND o.attempt_id=a.attempt_id AND o.attempt_nonce=a.attempt_nonce AND o.digest=a.root_digest AND o.config_digest=a.image_config_digest)", (operation_id, policy_path, accepted_env))
            if cursor.rowcount != 1:
                raise supervisor.SupervisorError('Preparation cannot be completed')
            db.commit()
    except (sqlite3.Error, ValueError, OSError) as error:
        raise supervisor.SupervisorError('Preparation cannot be completed') from error


class DaemonOwnership:
    """Serialize daemon lifetimes and remove only proven abandoned sockets."""

    def __init__(self, socket_dir, journal_dir, gid):
        self.directory = self.lock = None
        try:
            self.directory = supervisor._trusted_directory(socket_dir, 0o750)
            if os.fstat(self.directory).st_gid != gid:
                raise supervisor.SupervisorError('Invalid control directory group')
            try:
                self.lock = os.open('daemon.lock', os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                                    0o600, dir_fd=self.directory)
                os.fchmod(self.lock, 0o600)
            except FileExistsError:
                self.lock = supervisor._open_root_file(self.directory, 'daemon.lock', 0o600)
            lock_info = os.fstat(self.lock)
            named = os.stat('daemon.lock', dir_fd=self.directory, follow_symlinks=False)
            if (not stat.S_ISREG(lock_info.st_mode) or lock_info.st_uid != 0 or lock_info.st_gid != 0 or
                    lock_info.st_nlink != 1 or stat.S_IMODE(lock_info.st_mode) != 0o600 or
                    (lock_info.st_dev, lock_info.st_ino) != (named.st_dev, named.st_ino)):
                raise supervisor.SupervisorError('Unsafe daemon lock')
            fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            journal = supervisor._trusted_directory(journal_dir, 0o700)
            try:
                try:
                    os.stat('maintenance.json', dir_fd=journal, follow_symlinks=False)
                except FileNotFoundError:
                    pass
                else:
                    raise supervisor.SupervisorError('Previous maintenance requires local reconciliation')
            finally:
                os.close(journal)
            self._remove_abandoned('socket', {(gid, 0o660), (0, 0o700), (gid, 0o700)})
            self._remove_abandoned('command', {(0, 0o600), (0, 0o700)})
        except BaseException:
            self.close()
            raise

    def _remove_abandoned(self, name, allowed_modes):
        try:
            info = os.stat(name, dir_fd=self.directory, follow_symlinks=False)
        except FileNotFoundError:
            return
        if (not stat.S_ISSOCK(info.st_mode) or info.st_uid != 0 or
                (info.st_gid, stat.S_IMODE(info.st_mode)) not in allowed_modes):
            raise supervisor.SupervisorError('Unsafe existing daemon socket')
        peer = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            peer.settimeout(1)
            result = peer.connect_ex(f'/proc/self/fd/{self.directory}/{name}')
        finally:
            peer.close()
        if result != errno.ECONNREFUSED:
            raise supervisor.SupervisorError('Existing daemon socket is not proven abandoned')
        current = os.stat(name, dir_fd=self.directory, follow_symlinks=False)
        if ((info.st_dev, info.st_ino, info.st_uid, info.st_gid, info.st_mode) !=
                (current.st_dev, current.st_ino, current.st_uid, current.st_gid, current.st_mode)):
            raise supervisor.SupervisorError('Existing daemon socket changed')
        os.unlink(name, dir_fd=self.directory)
        os.fsync(self.directory)

    def close(self):
        if self.lock is not None:
            os.close(self.lock)
            self.lock = None
        if self.directory is not None:
            os.close(self.directory)
            self.directory = None

    def assert_held(self, control_dir):
        """Revalidate the daemon singleton lock and its protected directory."""
        if self.directory is None or self.lock is None:
            raise supervisor.SupervisorError('Daemon ownership is unavailable')
        directory = supervisor._trusted_directory(control_dir, 0o750)
        try:
            expected, current = os.fstat(self.directory), os.fstat(directory)
            if (expected.st_dev, expected.st_ino) != (current.st_dev, current.st_ino):
                raise supervisor.SupervisorError('Daemon control directory changed')
            opened = os.fstat(self.lock)
            named = os.stat('daemon.lock', dir_fd=directory, follow_symlinks=False)
            if (not stat.S_ISREG(opened.st_mode) or opened.st_uid != 0 or opened.st_gid != 0 or
                opened.st_nlink != 1 or stat.S_IMODE(opened.st_mode) != 0o600 or
                (opened.st_dev, opened.st_ino) != (named.st_dev, named.st_ino)):
                raise supervisor.SupervisorError('Daemon lock changed')
            supervisor._assert_exclusive_flock(self.lock)
        except OSError as error:
            raise supervisor.SupervisorError('Daemon ownership is unavailable') from error
        finally:
            os.close(directory)


def command_listener(directory):
    fd = supervisor._trusted_directory(directory, 0o750)
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    identity = None
    try:
        try:
            os.stat('command', dir_fd=fd, follow_symlinks=False)
        except FileNotFoundError:
            pass
        else:
            raise supervisor.SupervisorError('Existing command socket requires reconciliation')
        listener.bind(f'/proc/self/fd/{fd}/command')
        info = os.stat('command', dir_fd=fd, follow_symlinks=False)
        identity = (info.st_dev, info.st_ino)
        if not stat.S_ISSOCK(info.st_mode) or info.st_uid != 0:
            raise supervisor.SupervisorError('Unsafe command socket')
        os.chmod('command', 0o600, dir_fd=fd, follow_symlinks=False)
        listener.listen(2)
        return listener, fd, (info.st_dev, info.st_ino)
    except BaseException:
        listener.close()
        if identity is not None:
            try:
                current = os.stat('command', dir_fd=fd, follow_symlinks=False)
                if (current.st_dev, current.st_ino) == identity and stat.S_ISSOCK(current.st_mode) and current.st_uid == 0:
                    os.unlink('command', dir_fd=fd)
            except FileNotFoundError:
                pass
        os.close(fd)
        raise


def handle_command(listener, hub, install_dir, gate_dir, journal_dir, policy_path, approval_journal, accepted_env):
    connection, _ = listener.accept()
    try:
        _, uid, _ = struct.unpack('3i', connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize('3i')))
        if uid != 0:
            raise supervisor.SupervisorError('Command peer rejected')
        deadline = time.monotonic() + 5
        request = supervisor._read_message(connection, deadline)
        kind = request.get('type')
        if kind == 'status' and set(request) == {'version', 'type'} and type(request.get('version')) is int and request['version'] == 1:
            ready = (hub is not None and not hub.used and set(hub.connections) == set(supervisor.ROLES)
                     and not select.select(list(hub.connections.values()), [], [], 0)[0])
            if ready:
                try:
                    with supervisor.MaintenanceSupervisor(install_dir, gate_dir, journal_dir):
                        ready = load_approved_policy(policy_path, approval_journal, accepted_env) == hub.policy
                except (supervisor.SupervisorError, OSError, ValueError):
                    ready = False
            supervisor._send_message(connection, {'version': 1, 'status': 'ready' if ready else 'waiting'}, time.monotonic() + 1)
            return
        if (type(request.get('version')) is not int or request['version'] != 1 or
                not supervisor._uuid4(request.get('operationId')) or hub is None or hub.used or
                set(hub.connections) != set(supervisor.ROLES) or
                (kind == 'stop' and (set(request) != {'version', 'type', 'operationId', 'timeoutMs'} or
                 type(request['timeoutMs']) is not int or not 1 <= request['timeoutMs'] <= 60000)) or
                (kind == 'complete' and set(request) != {'version', 'type', 'operationId'}) or
                kind not in ('stop', 'complete')):
            raise supervisor.SupervisorError('Invalid or unavailable command')
        with supervisor.MaintenanceSupervisor(install_dir, gate_dir, journal_dir) as operation:
            # The installation lock remains held through validation and drain.
            # A changed approval, environment or candidate must never authorize
            # a stop using channels registered under an earlier policy.
            approved = load_approved_policy(policy_path, approval_journal, accepted_env,
                                            expected_operation_id=request['operationId'] if kind == 'complete' else None)
            if approved != hub.policy:
                raise supervisor.SupervisorError('Active policy changed')
            if kind == 'complete':
                complete_healthy_preparation(hub, approval_journal, request['operationId'], policy_path, accepted_env)
                result = 'completed'
            else:
                result = operation.stop_after_drain(hub, request['operationId'], request['timeoutMs'])
        supervisor._send_message(connection, {'version': 1, 'status': result}, time.monotonic() + 5)
    except (supervisor.SupervisorError, OSError, ValueError):
        try:
            supervisor._send_message(connection, {'version': 1, 'status': 'failed'}, time.monotonic() + 1)
        except (supervisor.SupervisorError, OSError):
            pass
    finally:
        connection.close()


def run(args):
    if type(args.uid) is not int or args.uid <= 0 or type(args.gid) is not int or args.gid <= 0:
        raise supervisor.SupervisorError('Invalid component identity')
    endpoint = supervisor.ComponentEndpoint()
    control = control_fd = control_identity = hub = ownership = None
    stopping = False
    def stop(_signum, _frame):
        nonlocal stopping
        stopping = True
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        ownership = DaemonOwnership(args.socket_dir, args.journal_dir, args.gid)
        active_env = getattr(args, 'active_env', None)
        with supervisor.MaintenanceSupervisor(args.install_dir, args.gate_dir, args.journal_dir):
            if active_env:
                policy_path, accepted_env, policy = resolve_active_policy(args.approval_journal, active_env)
            else:
                policy_path, accepted_env = args.policy, args.accepted_env
                policy = load_approved_policy(policy_path, args.approval_journal, accepted_env)
        if policy.install_dir != args.install_dir or policy.gate_dir != args.gate_dir or policy.control_dir != args.socket_dir:
            raise supervisor.SupervisorError('Policy paths do not match daemon configuration')
        tokens = endpoint.read_component_tokens(args.secret_dir, args.gid)
        listener = endpoint.listen(args.socket_dir, args.gid)
        control, control_fd, control_identity = command_listener(args.socket_dir)
        while not stopping:
            if hub is None:
                try:
                    if active_env:
                        with supervisor.MaintenanceSupervisor(args.install_dir, args.gate_dir, args.journal_dir):
                            policy_path, accepted_env, policy = resolve_active_policy(args.approval_journal, active_env)
                            if policy.install_dir != args.install_dir or policy.gate_dir != args.gate_dir or policy.control_dir != args.socket_dir:
                                raise supervisor.SupervisorError('Policy paths do not match daemon configuration')
                    hub = supervisor.DrainHub(listener, tokens, args.uid, policy)
                except (supervisor.SupervisorError, OSError):
                    pass
            inputs = [control]
            if hub is not None and not hub.used:
                inputs.append(listener)
                inputs.extend(hub.connections.values())
            ready, _, _ = select.select(inputs, [], [], 1)
            if hub and any(item in ready for item in hub.connections.values()):
                hub.close()
                hub = None
                continue
            if control in ready:
                handle_command(control, hub, args.install_dir, args.gate_dir, args.journal_dir,
                               policy_path, args.approval_journal, accepted_env)
                if hub and hub.used:
                    hub.close()
                    hub = None
            if hub and listener in ready:
                try:
                    hub.accept(timeout=5)
                except (supervisor.SupervisorError, OSError):
                    try:
                        changed = supervisor.inspect_servus(policy) != hub.identities
                    except (supervisor.SupervisorError, OSError):
                        changed = False
                    if changed:
                        hub.close()
                        hub = None
    finally:
        if hub:
            hub.close()
        if control:
            control.close()
        if control_fd is not None:
            try:
                info = os.stat('command', dir_fd=control_fd, follow_symlinks=False)
                if (info.st_dev, info.st_ino) == control_identity and stat.S_ISSOCK(info.st_mode) and info.st_uid == 0:
                    os.unlink('command', dir_fd=control_fd)
            except FileNotFoundError:
                pass
            os.close(control_fd)
        endpoint.close()
        if ownership is not None:
            ownership.close()


def main():
    parser = argparse.ArgumentParser()
    for name in ('policy', 'install-dir', 'gate-dir', 'journal-dir', 'secret-dir', 'socket-dir', 'approval-journal', 'accepted-env'):
        parser.add_argument('--' + name, required=True)
    parser.add_argument('--active-env')
    parser.add_argument('--uid', type=int, required=True)
    parser.add_argument('--gid', type=int, required=True)
    try:
        run(parser.parse_args())
    except (supervisor.SupervisorError, OSError, ValueError, RecursionError):
        print('Supervisor could not start safely', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
