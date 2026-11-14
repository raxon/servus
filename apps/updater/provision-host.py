#!/usr/bin/python3 -I
"""Prepare private host state for initial release verification.

Existing files and directories are verified, never silently replaced. Service
installation, policy activation, and live panel changes are separate steps.
"""
import argparse
import fcntl
import hashlib
import importlib.util
import json
import os
import re
import secrets
import stat
import sys


class ProvisionError(Exception):
    pass


def directory(path, mode=None):
    if not isinstance(path, str) or not path.startswith('/') or os.path.normpath(path) != path:
        raise ProvisionError('Invalid directory path')
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for name in path.split('/')[1:]:
            if not name: continue
            child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd); fd = child
            info = os.fstat(fd)
            if info.st_uid != 0 or info.st_mode & 0o022: raise ProvisionError('Untrusted directory ancestry')
        info = os.fstat(fd)
        if info.st_gid != 0 or (mode is not None and stat.S_IMODE(info.st_mode) != mode):
            raise ProvisionError('Unexpected directory ownership or mode')
        return fd
    except BaseException:
        os.close(fd); raise


def child_directory(parent, name):
    if not name or name in ('.', '..') or '/' in name: raise ProvisionError('Invalid directory name')
    try: os.mkdir(name, 0o700, dir_fd=parent)
    except FileExistsError: created = False
    else: created = True
    child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
    try:
        if created:
            os.fchown(child, 0, 0); os.fchmod(child, 0o700); os.fsync(child); os.fsync(parent)
        info = os.fstat(child); named = os.stat(name, dir_fd=parent, follow_symlinks=False)
        if (info.st_uid != 0 or info.st_gid != 0 or stat.S_IMODE(info.st_mode) != 0o700 or
            (info.st_dev, info.st_ino) != (named.st_dev, named.st_ino)):
            raise ProvisionError('Unsafe private directory')
        return child
    except BaseException:
        os.close(child); raise


def publish_once(parent, name, content):
    def verify_existing():
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        try:
            info = os.fstat(fd); named = os.stat(name, dir_fd=parent, follow_symlinks=False)
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_gid != 0 or info.st_nlink != 1 or
                stat.S_IMODE(info.st_mode) != 0o600 or info.st_size != len(content) or
                (info.st_dev, info.st_ino) != (named.st_dev, named.st_ino) or os.read(fd, len(content) + 1) != content):
                raise ProvisionError('Existing configuration differs')
        finally: os.close(fd)
    temporary = '.servus-config-' + secrets.token_hex(16)
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'wb', closefd=False) as stream:
            stream.write(content); stream.flush(); os.fsync(stream.fileno())
        try: os.link(temporary, name, src_dir_fd=parent, dst_dir_fd=parent, follow_symlinks=False)
        except FileExistsError: verify_existing()
        else: os.fsync(parent)
    finally:
        os.close(fd)
        os.unlink(temporary, dir_fd=parent)
        os.fsync(parent)


def prepare(config_dir, state_dir):
    if os.geteuid() != 0: raise ProvisionError('Root is required')
    if any(not isinstance(value, str) or not value.startswith('/') or value == '/' or
           os.path.normpath(value) != value or re.fullmatch(r'/[a-zA-Z0-9._/-]+', value) is None for value in (config_dir, state_dir)):
        raise ProvisionError('Invalid configuration path')
    if state_dir == config_dir or state_dir.startswith(config_dir + '/') or config_dir.startswith(state_dir + '/'):
        raise ProvisionError('State and configuration paths overlap')
    parent_path, state_name = os.path.split(state_dir)
    config = directory(config_dir, 0o700); parent = state = None
    try:
        parent = directory(parent_path)
        state = child_directory(parent, state_name)
        for name in ('staging', 'maintenance', 'backups', 'policies', 'docker-config'):
            fd = child_directory(state, name)
            try:
                if name == 'docker-config' and os.listdir(fd):
                    raise ProvisionError('Docker configuration must be empty')
            finally: os.close(fd)
        values = {'SERVUS_UPDATER_STATE_DIR': state_dir, 'SERVUS_UPDATER_SOCKET_DIR': '/run/servus-updater/control',
                  'SERVUS_COMPONENT_UID': '1000', 'SERVUS_UPDATER_SOCKET_GID': '1000',
                  'SERVUS_SUPERVISOR_COMMAND_SOCKET': config_dir + '/supervisor-control/command'}
        content = ''.join(key + '=' + value + '\n' for key, value in values.items()).encode('ascii')
        publish_once(config, 'updater.env', content)
    finally:
        if state is not None: os.close(state)
        if parent is not None: os.close(parent)
        os.close(config)


def prepare_runtime(config_dir, install_dir, supervisor, *, inherited_lock=None):
    """Create the first lifecycle gate and component credentials under the install lock."""
    if os.geteuid() != 0: raise ProvisionError('Root is required')
    if (not all(isinstance(path, str) and path.startswith('/') and path != '/' and os.path.normpath(path) == path
                for path in (config_dir, install_dir)) or config_dir == install_dir or
        config_dir.startswith(install_dir + '/') or install_dir.startswith(config_dir + '/')):
        raise ProvisionError('Runtime paths overlap or are invalid')
    config = directory(config_dir, 0o700); install = lock = None
    names = ('lifecycle', 'supervisor-secrets', 'supervisor-control', '.supervisor-enabled-v1')
    def exists(parent, name):
        try: os.stat(name, dir_fd=parent, follow_symlinks=False); return True
        except FileNotFoundError: return False
    def create_file(parent, name, value, mode, gid):
        fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode, dir_fd=parent)
        try:
            os.fchown(fd, 0, gid); os.fchmod(fd, mode)
            with os.fdopen(fd, 'wb', closefd=False) as stream:
                stream.write(value); stream.flush(); os.fsync(fd)
        finally: os.close(fd)
    try:
        install = directory(install_dir, 0o700)
        lock = supervisor._open_root_file(install, 'install.lock', 0o600)
        if inherited_lock is not None:
            if type(inherited_lock) is not int or inherited_lock < 3:
                raise ProvisionError('Invalid inherited installation lock')
            inherited = os.fstat(inherited_lock); expected = os.fstat(lock)
            if (inherited.st_dev, inherited.st_ino) != (expected.st_dev, expected.st_ino):
                raise ProvisionError('Inherited installation lock does not match')
            duplicate = os.dup(inherited_lock)
            os.close(lock); lock = duplicate
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        present = [exists(config, name) for name in names]
        marker = exists(install, '.lifecycle-enabled-v1')
        if any(present) or marker:
            if not all(present) or not marker: raise ProvisionError('Incomplete runtime preparation requires recovery')
        else:
            if exists(config, 'servus.env'):
                raise ProvisionError('Existing installations require a verified migration')
            os.mkdir('lifecycle', 0o755, dir_fd=config)
            gate = os.open('lifecycle', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=config)
            try:
                os.fchmod(gate, 0o755)
                create_file(gate, 'lock', b'', 0o644, 0)
                create_file(gate, 'state', b'servus-lifecycle-v1 normal\n', 0o644, 0)
                os.fsync(gate)
            finally: os.close(gate)
            os.mkdir('supervisor-secrets', 0o700, dir_fd=config)
            secret_dir = os.open('supervisor-secrets', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=config)
            try:
                os.fchmod(secret_dir, 0o700)
                tokens = set()
                for role in supervisor.ROLES:
                    token = secrets.token_hex(32)
                    if token in tokens: raise ProvisionError('Duplicate component credential')
                    tokens.add(token)
                    create_file(secret_dir, role, (token + '\n').encode('ascii'), 0o640, 1000)
                os.fsync(secret_dir)
            finally: os.close(secret_dir)
            os.mkdir('supervisor-control', 0o750, dir_fd=config)
            control = os.open('supervisor-control', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=config)
            try: os.fchown(control, 0, 1000); os.fchmod(control, 0o750); os.fsync(control)
            finally: os.close(control)
            os.fsync(config)
            create_file(install, '.lifecycle-enabled-v1', b'servus-lifecycle-v1\n', 0o600, 0)
            os.fsync(install)
            create_file(config, '.supervisor-enabled-v1', b'servus-supervisor-v1\n', 0o600, 0)
            os.fsync(config)
        for parent, name, content in ((install, '.lifecycle-enabled-v1', b'servus-lifecycle-v1\n'),
                                      (config, '.supervisor-enabled-v1', b'servus-supervisor-v1\n')):
            fd = supervisor._open_root_file(parent, name, 0o600)
            try:
                if os.read(fd, len(content) + 1) != content: raise ProvisionError('Invalid runtime marker')
            finally: os.close(fd)
        control = os.open('supervisor-control', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=config)
        try:
            info = os.fstat(control)
            if (info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)) != (0, 1000, 0o750):
                raise ProvisionError('Unsafe supervisor control directory')
        finally: os.close(control)
        supervisor.ComponentEndpoint().read_component_tokens(config_dir + '/supervisor-secrets', 1000)
        gate = supervisor._trusted_directory(config_dir + '/lifecycle', 0o755)
        try:
            gate_lock = supervisor._open_root_file(gate, 'lock', 0o644)
            try:
                fcntl.flock(gate_lock, fcntl.LOCK_SH | fcntl.LOCK_NB)
                named = os.stat('lock', dir_fd=gate, follow_symlinks=False); opened = os.fstat(gate_lock)
                if (named.st_dev, named.st_ino) != (opened.st_dev, opened.st_ino):
                    raise ProvisionError('Lifecycle lock changed')
                state = supervisor._open_root_file(gate, 'state', 0o644)
                try:
                    if os.read(state, 64) != b'servus-lifecycle-v1 normal\n':
                        raise ProvisionError('Lifecycle gate is not in normal state')
                finally: os.close(state)
            finally: os.close(gate_lock)
        finally: os.close(gate)
    finally:
        if lock is not None: os.close(lock)
        if install is not None: os.close(install)
        os.close(config)



def trusted_ingress(docker_config, runtime):
    raw = runtime._docker(docker_config, 'ps', '--no-trunc', '--filter', 'label=com.docker.swarm.service.name=panel-ingress', '--format', '{{.ID}}', limit=8192)
    try: ids = raw.decode('ascii').splitlines()
    except UnicodeError as error: raise ProvisionError('Invalid ingress inventory') from error
    if not ids: return None
    if len(ids) != 1 or not re.fullmatch(r'[a-f0-9]{64}', ids[0]): raise ProvisionError('Invalid ingress inventory')
    item = runtime._json(runtime._docker(docker_config, 'inspect', ids[0], limit=1024 * 1024))
    if not isinstance(item, list) or len(item) != 1 or not isinstance(item[0], dict): raise ProvisionError('Invalid ingress identity')
    item = item[0]; config = item.get('Config') or {}; labels = config.get('Labels') or {}; host = item.get('HostConfig') or {}
    mounts = item.get('Mounts'); image = item.get('Image'); state = item.get('State') or {}
    if (item.get('Id') != ids[0] or labels.get('com.docker.swarm.service.name') != 'panel-ingress' or
        config.get('Image') != 'traefik:3.7.13' or not isinstance(image, str) or not re.fullmatch(r'sha256:[a-f0-9]{64}', image) or
        state.get('Running') is not True or host.get('Privileged') is not False or host.get('PidMode') == 'host' or
        host.get('CapAdd') not in (None, []) or host.get('Devices') not in (None, []) or host.get('DeviceRequests') not in (None, []) or
        not isinstance(mounts, list)):
        raise ProvisionError('Untrusted ingress identity')
    socket_path = os.path.realpath('/var/run/docker.sock')
    matching = [mount for mount in mounts if isinstance(mount, dict) and isinstance(mount.get('Source'), str) and os.path.realpath(mount['Source']) == socket_path]
    if len(matching) != 1 or matching[0].get('RW') is not False:
        raise ProvisionError('Untrusted ingress socket')
    return [ids[0], 'panel-ingress', config['Image'], image]


def finalize(config_dir, state_dir, install_dir, node_path, supervisor, daemon, backup, runtime):
    """Bind host service configuration to an already approved generation."""
    if os.geteuid() != 0: raise ProvisionError('Root is required')
    prepare(config_dir, state_dir)
    gate = config_dir + '/lifecycle'; control = config_dir + '/supervisor-control'; secret_dir = config_dir + '/supervisor-secrets'
    journal = state_dir + '/journal.sqlite'; active_env = config_dir + '/servus.env'; policy_root = state_dir + '/policies'
    backup_root = state_dir + '/backups'; docker_config = state_dir + '/docker-config'; maintenance = state_dir + '/maintenance'
    with supervisor.MaintenanceSupervisor(install_dir, gate, maintenance):
        policy_path, accepted_env, approved = daemon.resolve_active_policy(journal, active_env)
        expected_secrets = {role: secret_dir + '/' + role for role in supervisor.ROLES}
        if (approved.install_dir != install_dir or approved.gate_dir != gate or approved.control_dir != control or
            dict(approved.secret_sources) != expected_secrets or approved.updater_dir != '/run/servus-updater/control' or
            os.path.dirname(policy_path) != policy_root or os.path.dirname(accepted_env) != policy_root):
            raise ProvisionError('Approved policy does not match the host')
        supervisor.ComponentEndpoint().read_component_tokens(secret_dir, 1000)
        control_info = os.stat(control, follow_symlinks=False)
        if control_info.st_uid != 0 or control_info.st_gid != 1000 or stat.S_IMODE(control_info.st_mode) != 0o750:
            raise ProvisionError('Untrusted supervisor control directory')
        for path, mode in ((control, 0o750), (secret_dir, 0o700), (policy_root, 0o700), (backup_root, 0o700), (docker_config, 0o700)):
            fd = supervisor._trusted_directory(path, mode); os.close(fd)
        parent, name = os.path.split(node_path); node_parent = supervisor._trusted_directory(parent)
        try: node = supervisor._open_root_file(node_parent, name, 0o755)
        finally: os.close(node_parent)
        try:
            digest = hashlib.sha256()
            while chunk := os.read(node, 65536): digest.update(chunk)
            os.lseek(node, 0, os.SEEK_SET)
            backup._verify_node(node, '0' * 64, [{'value':'AAAAAAAAAAAAAAAAAPE7Iln+jhkZLh/RZ/oXyrXa','json':True}])
            ingress = trusted_ingress(docker_config, runtime)
            settings = {'backupRoot':backup_root,'policyRoot':policy_root,'dockerConfig':docker_config,
                        'nodePath':node_path,'nodeSha256':digest.hexdigest(),'trustedIngress':ingress}
            config = directory(config_dir, 0o700)
            try:
                publish_once(config, 'update-apply.json', (json.dumps(settings,sort_keys=True,separators=(',',':'))+'\n').encode())
                values = {'SERVUS_POLICY':policy_path,'SERVUS_INSTALL_DIR':install_dir,'SERVUS_GATE_DIR':gate,
                          'SERVUS_JOURNAL_DIR':maintenance,'SERVUS_SECRET_DIR':secret_dir,'SERVUS_SOCKET_DIR':control,
                          'SERVUS_APPROVAL_JOURNAL':journal,'SERVUS_ACCEPTED_ENV':accepted_env,
                          'SERVUS_COMPONENT_UID':'1000','SERVUS_COMPONENT_GID':'1000',
                          'SERVUS_SUPERVISOR_UPDATE_ARGS':'"--active-env '+active_env+' --apply-config '+config_dir+'/update-apply.json"'}
                content=''.join(key+'='+value+'\n' for key,value in values.items()).encode('ascii')
                publish_once(config, 'supervisor.env', content)
            finally: os.close(config)
        finally: os.close(node)


def trusted_modules():
    root = directory(os.path.dirname(os.path.realpath(__file__)))
    def load(name, filename):
        fd = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=root)
        try:
            info=os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_gid != 0 or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o644:
                raise ProvisionError('Untrusted updater module')
        finally: os.close(fd)
        spec=importlib.util.spec_from_file_location(name, os.path.join(os.path.dirname(os.path.realpath(__file__)), filename))
        if not spec or not spec.loader: raise ProvisionError('Updater module unavailable')
        module=importlib.util.module_from_spec(spec);sys.modules[name]=module;spec.loader.exec_module(module)
        return module
    try:
        supervisor=load('supervisor','supervisor.py')
        return supervisor,load('servus_config_daemon','supervisor-daemon.py'),load('servus_config_backup','backup.py'),load('servus_config_policy','runtime-policy.py')
    finally: os.close(root)

def main():
    if sys.platform != 'linux' or os.geteuid() != 0 or not sys.flags.isolated:
        print('Host preparation requires isolated Linux root.', file=sys.stderr); return 1
    parser = argparse.ArgumentParser()
    actions = parser.add_mutually_exclusive_group()
    actions.add_argument('--finalize', action='store_true')
    actions.add_argument('--runtime', action='store_true')
    parser.add_argument('--install-lock-fd', type=int)
    parser.add_argument('--config-dir')
    parser.add_argument('--install-dir')
    args = parser.parse_args()
    if (args.install_lock_fd is not None or args.config_dir is not None or args.install_dir is not None) and not args.runtime:
        parser.error('Runtime options require --runtime')
    os.umask(0o077)
    try:
        if args.runtime:
            supervisor, _, _, _ = trusted_modules()
            prepare_runtime(args.config_dir or '/etc/servus', args.install_dir or '/opt/servus', supervisor,
                            inherited_lock=args.install_lock_fd)
        elif args.finalize:
            supervisor, daemon, backup, runtime = trusted_modules()
            finalize('/etc/servus', '/var/lib/servus-updater', '/opt/servus', '/usr/bin/node', supervisor, daemon, backup, runtime)
        else:
            prepare('/etc/servus', '/var/lib/servus-updater')
        return 0
    except Exception:
        print('Updater host state could not be prepared safely.', file=sys.stderr); return 1


if __name__ == '__main__': raise SystemExit(main())
