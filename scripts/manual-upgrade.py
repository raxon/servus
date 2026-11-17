#!/usr/bin/python3 -I
"""One-off Servus 0.1.4 to 0.1.5 upgrade.

This operator tool requires the 0.1.5 image digest to have been independently
verified against its GitHub attestation before execution. It does not back up
application volumes or Swarm state. Unexpected or interrupted state remains
for manual recovery; it is never treated as a completed upgrade.
The existing pinned ingress is trusted with Docker API access. A read-only bind
does not restrict requests made through a Unix socket. This assumes no parallel
administrative Docker changes and does not protect against ingress compromise.
"""
import argparse
import base64
import contextlib
import fcntl
import hashlib
import importlib.util
import json
import os
import pathlib
import re
import shutil
import socket
import sqlite3
import ssl
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request
import uuid

OLD = 'ghcr.io/raxon/servus@sha256:466654f228cf3adb4e13369ce85b047458fa7eb64e20c46c222df2326c293370'
NEW = 'ghcr.io/raxon/servus@sha256:32f7cccf97841716ffae6bbff4f4234d5c3575e3b3ad9daa61dcf5afba72a13c'
REVISION = '7c2013b081b4c26244a52c75b51e6ca2226c8a5a'
CONFIG_DIGEST = 'sha256:e000690194982b9a59ff56a9966794cac478903a63f2437e52381feb61cd53e8'
VERIFIER_FILES = {
    'verification-executor.py':'1b7cd6b9932008cf20ab57cee11a8b3bd8b79e58171308bcf8e180326415d71f',
    'verify-release.py':'84c3c5f1b643aafad0e79cefe2678c871322c0fbe5532c8fb5f0efa934cf0c02',
}
TRUSTED_INGRESS_IMAGE = 'sha256:24841fe2de7304c149343d877d2923b4c8800a38ba015dea9174c23b20e344a0'
ROLES = ('api', 'worker', 'agent')
HEX = re.compile(r'^[a-f0-9]{64}$')
TASK = re.compile(r'^[a-z0-9]{25}$')


class UpgradeError(Exception):
    pass


def secure_directory(path, owner=0, mode=None):
    path = pathlib.Path(path)
    if not path.is_absolute() or str(path) != os.path.normpath(str(path)):
        raise UpgradeError('Unsafe directory')
    current = pathlib.Path('/')
    root = current.lstat()
    if root.st_uid != 0 or not stat.S_ISDIR(root.st_mode) or root.st_mode & 0o022:
        raise UpgradeError('Unsafe root directory')
    for part in path.parts[1:]:
        current /= part
        info = current.lstat()
        last = current == path
        if (not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode) or
                info.st_uid != (owner if last else 0) or
                (stat.S_IMODE(info.st_mode) != mode if last and mode is not None else bool(info.st_mode & 0o022))):
            raise UpgradeError('Unsafe directory')
    return path


def read_private(path, limit=2**20):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1 or info.st_mode & 0o077 or info.st_size > limit:
            raise UpgradeError('Unsafe private file')
        chunks = []
        remaining = limit + 1
        while remaining:
            part = os.read(fd, min(65536, remaining))
            if not part: break
            chunks.append(part); remaining -= len(part)
        value = b''.join(chunks)
        final = os.fstat(fd); named = os.stat(path, follow_symlinks=False)
        if (len(value) != info.st_size or (info.st_dev,info.st_ino,info.st_size,info.st_mtime_ns,info.st_ctime_ns) !=
                (final.st_dev,final.st_ino,final.st_size,final.st_mtime_ns,final.st_ctime_ns) or
                (named.st_dev,named.st_ino) != (info.st_dev,info.st_ino)):
            raise UpgradeError('Private file changed')
        return value
    finally:
        os.close(fd)


def write_new(path, data, mode=0o600):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, mode)
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, 'wb', closefd=False) as out:
            out.write(data); out.flush(); os.fsync(fd)
    finally:
        os.close(fd)


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try: os.fsync(fd)
    finally: os.close(fd)


def atomic_private(path, data):
    temporary = pathlib.Path(str(path) + '.' + uuid.uuid4().hex)
    try:
        write_new(temporary, data)
        os.replace(temporary, path)
        sync_directory(path.parent)
    finally:
        with contextlib.suppress(FileNotFoundError): temporary.unlink()


class Docker:
    def __init__(self, config):
        self.environment = {'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','HOME':'/root',
                            'LANG':'C','LC_ALL':'C','DOCKER_HOST':'unix:///var/run/docker.sock',
                            'DOCKER_CONFIG':str(config)}

    def call(self, *args, timeout=60, limit=4*1024*1024):
        result = subprocess.run(['/usr/bin/docker', *args], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                stderr=subprocess.DEVNULL, env=self.environment, cwd='/', timeout=timeout)
        if result.returncode or len(result.stdout) > limit:
            raise UpgradeError('Docker operation failed or returned excessive data')
        return result.stdout

    def inspect(self, *ids):
        try: result = json.loads(self.call('inspect', *ids))
        except (ValueError, UnicodeError): raise UpgradeError('Docker inspection failed') from None
        if not isinstance(result, list) or len(result) != len(ids): raise UpgradeError('Docker inspection failed')
        return result


def set_marker(path, operation, phase, **details):
    value = {'version':1, 'operation':operation, 'phase':phase, **details}
    atomic_private(path, (json.dumps(value, sort_keys=True, separators=(',', ':'))+'\n').encode())


def container_ids(docker):
    output = docker.call('ps','-a','--no-trunc','--filter','label=com.docker.compose.project=servus','--format','{{.ID}}')
    ids = output.decode('ascii').splitlines()
    if len(ids) != 3 or len(set(ids)) != 3 or not all(HEX.fullmatch(x) for x in ids):
        raise UpgradeError('Expected exactly three Servus containers')
    result = {}
    for item in docker.inspect(*ids):
        label = item.get('Config',{}).get('Labels') or {}
        role = label.get('com.docker.compose.service')
        if role not in ROLES or role in result or label.get('com.docker.compose.project') != 'servus':
            raise UpgradeError('Unexpected Servus container')
        result[role] = item
    return result


def ensure_no_other_data_mounts(docker, expected, data_dir):
    raw = docker.call('ps','-aq','--no-trunc').decode('ascii').splitlines()
    if not raw: raise UpgradeError('Container inventory unavailable')
    data = os.path.realpath(data_dir)
    for item in docker.inspect(*raw):
        if item.get('Id') not in expected:
            host=item.get('HostConfig') or {};config=item.get('Config') or {};labels=config.get('Labels') or {}
            if (host.get('Privileged') is not False or host.get('PidMode')=='host' or
                    host.get('CapAdd') not in (None,[]) or host.get('Devices') not in (None,[]) or
                    host.get('DeviceRequests') not in (None,[])):
                raise UpgradeError('Unsupported external container privileges')
            for mount in item.get('Mounts') or []:
                source=mount.get('Source')
                if not isinstance(source,str) or not source: continue
                source=os.path.realpath(source);socket_path=os.path.realpath('/var/run/docker.sock')
                if socket_path==source or socket_path.startswith(source.rstrip('/')+'/'):
                    trusted=(source==socket_path and mount.get('RW') is False and
                             labels.get('com.docker.swarm.service.name')=='panel-ingress' and
                             config.get('Image')=='traefik:3.7.13' and item.get('Image')==TRUSTED_INGRESS_IMAGE)
                    if not trusted: raise UpgradeError('Unexpected container can access Docker API')
        for mount in item.get('Mounts') or []:
            source = mount.get('Source')
            if not isinstance(source,str) or not source: continue
            source = os.path.realpath(source)
            if source == data or source.startswith(data + '/') or data.startswith(source + '/'):
                if item.get('Id') not in expected or source != data or mount.get('RW') is not True:
                    raise UpgradeError('Unexpected container can access panel data')


def ensure_no_uid_writers(*, proc=pathlib.Path('/proc'), allowed_containers=frozenset()):
    """Reject processes with the panel owner's real, effective, saved or filesystem UID."""
    for item in proc.iterdir():
        if not item.name.isdecimal(): continue
        try: lines=(item/'status').read_text().splitlines()
        except FileNotFoundError: continue
        except OSError: raise UpgradeError('Process credentials could not be inspected') from None
        uid=[line for line in lines if line.startswith('Uid:')]
        if len(uid)!=1: raise UpgradeError('Process credentials are unavailable')
        try: values=[int(value) for value in uid[0].split()[1:]]
        except ValueError: raise UpgradeError('Process credentials are invalid') from None
        if len(values)!=4: raise UpgradeError('Process credentials are invalid')
        if 1000 in values:
            try: cgroup=(item/'cgroup').read_text()
            except FileNotFoundError: continue
            except OSError: raise UpgradeError('Process cgroup could not be inspected') from None
            matches=[cid for cid in allowed_containers if re.search(r'(?<![a-f0-9])'+re.escape(cid)+r'(?![a-f0-9])',cgroup)]
            if len(matches)!=1: raise UpgradeError('A panel-owner process can write panel data')


def _overlap(left, right):
    def within(child,parent): return child == parent or child.startswith(parent.rstrip('/') + '/')
    return within(left,right) or within(right,left)


def check_mount_topology(data_dir, mountinfo):
    """Reject nested mounts and other mounts aliasing the data directory."""
    def unescape(value):
        def replace(match):
            escapes={'040':' ','011':'\t','012':'\n','134':'\\'}
            if match.group(1) not in escapes: raise UpgradeError('Invalid mount topology')
            return escapes[match.group(1)]
        return re.sub(r'\\([0-7]{3})',replace,value)
    data=os.path.normpath(str(data_dir)); entries=[]
    if not data.startswith('/') or data=='/': raise UpgradeError('Invalid data directory')
    for line in mountinfo.splitlines():
        before,separator,after=line.partition(' - ')
        fields=before.split()
        if not separator or len(fields)<6 or not re.fullmatch(r'[0-9]+:[0-9]+',fields[2]):
            raise UpgradeError('Invalid mount topology')
        root,point=unescape(fields[3]),unescape(fields[4])
        filesystem=after.split()[0] if after.split() else ''
        if not root.startswith('/') and filesystem=='nsfs': root=None
        if ((root is not None and (not root.startswith('/') or os.path.normpath(root)!=root)) or
                not point.startswith('/') or os.path.normpath(point)!=point):
            raise UpgradeError('Invalid mount topology')
        entries.append((fields[2],root,point))
    candidates=[entry for entry in entries if data==entry[2] or data.startswith(entry[2].rstrip('/')+'/')]
    if not candidates: raise UpgradeError('Data mount is unavailable')
    device,root,point=max(candidates,key=lambda entry:len(entry[2]))
    if root is None: raise UpgradeError('Unsupported data filesystem')
    relative=os.path.relpath(data,point)
    filesystem_data=os.path.normpath(os.path.join(root,relative))
    for other_device,other_root,other_point in entries:
        if other_point != data and other_point.startswith(data.rstrip('/')+'/'):
            raise UpgradeError('Nested data mount is unsupported')
        is_ancestor=data==other_point or data.startswith(other_point.rstrip('/')+'/')
        if not is_ancestor and other_device==device and (other_root is None or _overlap(other_root,filesystem_data)):
            raise UpgradeError('Data mount alias is unsupported')


def ensure_no_mount_aliases(docker, data_dir):
    if os.stat('/proc/1/ns/mnt').st_ino != os.stat('/proc/self/ns/mnt').st_ino:
        raise UpgradeError('Host mount namespace is required')
    check_mount_topology(data_dir,pathlib.Path('/proc/self/mountinfo').read_text())
    names=docker.call('volume','ls','-q').decode('utf-8').splitlines()
    if not names: return
    try: volumes=json.loads(docker.call('volume','inspect',*names))
    except (ValueError,UnicodeError): raise UpgradeError('Volume inventory is unavailable') from None
    if not isinstance(volumes,list) or len(volumes)!=len(names): raise UpgradeError('Volume inventory is unavailable')
    for volume in volumes:
        if not isinstance(volume,dict) or volume.get('Driver')!='local' or volume.get('Options') not in (None,{}):
            # Unknown drivers and device options may provide an unmounted alias.
            raise UpgradeError('Unsupported volume topology')


def ensure_host_namespaces():
    """Reject containers and namespace views that hide host resource limits."""
    try:
        if pathlib.Path('/proc/1/comm').read_text().strip()!='systemd':
            raise UpgradeError('A host systemd environment is required')
        for namespace in ('pid','mnt','cgroup'):
            if os.stat('/proc/1/ns/'+namespace).st_ino != os.stat('/proc/self/ns/'+namespace).st_ino:
                raise UpgradeError('Host namespaces are required')
    except OSError: raise UpgradeError('Host namespace verification failed') from None


def ensure_no_open_data(data_dir, *, proc=pathlib.Path('/proc'), own_pid=None):
    """Fail if another visible host process retains an open data handle."""
    data=os.path.realpath(data_dir); own_pid=os.getpid() if own_pid is None else own_pid
    try: processes=list(proc.iterdir())
    except OSError: raise UpgradeError('Process inventory is unavailable') from None
    for process in processes:
        if not process.name.isdecimal() or int(process.name)==own_pid: continue
        try:
            descriptors=list((process/'fd').iterdir())
            maps=(process/'maps').read_text()
        except FileNotFoundError:
            continue
        except (OSError,UnicodeError):
            raise UpgradeError('Process inventory is unavailable') from None
        for entry in ('cwd','root'):
            try: location=os.readlink(process/entry).removesuffix(' (deleted)')
            except FileNotFoundError: continue
            except OSError: raise UpgradeError('Process inventory is unavailable') from None
            if location==data or location.startswith(data+'/'):
                raise UpgradeError('A process is rooted in panel data')
        for descriptor in descriptors:
            try: target=os.readlink(descriptor)
            except FileNotFoundError: continue
            except OSError: raise UpgradeError('Process inventory is unavailable') from None
            target=target.removesuffix(' (deleted)')
            if target.startswith('/') and (target==data or target.startswith(data+'/')):
                raise UpgradeError('A process still holds panel data')
        for line in maps.splitlines():
            fields=line.split(maxsplit=5)
            if len(fields)==6:
                path=fields[5].removesuffix(' (deleted)')
                if path==data or path.startswith(data+'/'):
                    raise UpgradeError('A process still maps panel data')


def image_preflight(docker):
    raw = docker.call('image','inspect','--platform=linux/amd64','--format','{{json .}}',NEW)
    try: image = json.loads(raw)
    except (ValueError, UnicodeError): raise UpgradeError('Release image inspection failed') from None
    labels = image.get('Config',{}).get('Labels') or {}
    if (NEW not in (image.get('RepoDigests') or []) or image.get('Os') != 'linux' or image.get('Architecture') != 'amd64'
            or labels.get('org.opencontainers.image.revision') != REVISION or (image.get('Config',{}).get('Volumes') or {})):
        raise UpgradeError('Verified release image is unavailable')


def release_tools(docker, target, *, probe_name=None):
    # The image is pre-pulled by immutable digest and verified independently.
    args=['create','--pull=never','--platform=linux/amd64','--network=none','--read-only','--entrypoint=/bin/false']
    if probe_name is not None:
        if not re.fullmatch(r'servus-manual-tools-[a-f0-9]{32}',probe_name): raise UpgradeError('Invalid release probe name')
        args.extend(['--name',probe_name,'--label','servus.manual-upgrade=tools'])
    raw = docker.call(*args,NEW)
    cid = raw.decode('ascii').strip()
    if not HEX.fullmatch(cid): raise UpgradeError('Invalid release probe')
    try:
        for name, source, limit, mode in (
                ('backup.py','/opt/servus/install/apps/updater/backup.py',2**20,0o600),
                ('node','/usr/local/bin/node',256*2**20,0o755)):
            archive_path = target / (name + '.tar')
            with open(archive_path, 'xb') as out:
                result = subprocess.run(['/usr/bin/docker','cp',cid+':'+source,'-'],stdin=subprocess.DEVNULL,
                                        stdout=out,stderr=subprocess.DEVNULL,env=docker.environment,timeout=120)
            if result.returncode or archive_path.stat().st_size > limit + 65536:
                raise UpgradeError('Could not extract release tool')
            with tarfile.open(archive_path,mode='r:') as archive:
                members = archive.getmembers()
                if len(members) != 1 or not members[0].isfile() or members[0].name != name or members[0].size > limit:
                    raise UpgradeError('Unexpected release tool archive')
                stream = archive.extractfile(members[0])
                if stream is None: raise UpgradeError('Invalid release tool')
                write_new(target / name, stream.read(limit + 1), mode)
            archive_path.unlink()
        sync_directory(target)
    finally:
        docker.call('rm','-f',cid,timeout=30)


def load_backup(path):
    spec = importlib.util.spec_from_file_location('servus_oneoff_backup', path)
    if not spec or not spec.loader: raise UpgradeError('Backup module unavailable')
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


def check_stopped(docker, ids):
    for item in docker.inspect(*ids):
        state = item.get('State') or {}
        policy = (item.get('HostConfig') or {}).get('RestartPolicy') or {}
        if state.get('Running') is not False or state.get('ExitCode') != 0 or policy.get('Name') != 'no':
            raise UpgradeError('Servus did not stop cleanly or can restart')


def read_db(path):
    db = sqlite3.connect(f'file:{path}?mode=ro',uri=True,timeout=5)
    db.row_factory = sqlite3.Row
    if [row[0] for row in db.execute('PRAGMA integrity_check').fetchall()] != ['ok'] or db.execute('PRAGMA foreign_key_check').fetchone():
        db.close(); raise UpgradeError('SQLite integrity validation failed')
    return db


def _matches(expected, observed):
    if isinstance(expected, dict):
        return isinstance(observed, dict) and set(expected) == set(observed) and all(_matches(value, observed[key]) for key, value in expected.items())
    if isinstance(expected, list):
        return isinstance(observed, list) and len(expected) == len(observed) and all(_matches(a,b) for a,b in zip(expected,observed))
    return expected == observed


def normalize_defaults(expected, observed):
    """Remove only known Docker defaults absent from the intended spec."""
    # Values are part of the compatibility contract; unknown fields fail.
    defaults={
        ('UpdateConfig','MaxFailureRatio'):0,
        ('RollbackConfig','MaxFailureRatio'):0,
        ('RollbackConfig','Monitor'):5_000_000_000,
        ('RollbackConfig','FailureAction'):'pause',
        ('TaskTemplate','ForceUpdate'):0,
        ('TaskTemplate','Placement'):{},
        ('TaskTemplate','Runtime'):'container',
        ('TaskTemplate','ContainerSpec','DNSConfig'):{},
        ('TaskTemplate','ContainerSpec','Isolation'):'default',
        ('TaskTemplate','ContainerSpec','StopGracePeriod'):10_000_000_000,
        ('TaskTemplate','RestartPolicy','Delay'):5_000_000_000,
    }
    observed=json.loads(json.dumps(observed))
    for parts,value in defaults.items():
        source=expected; target=observed
        for part in parts[:-1]:
            if not isinstance(source,dict) or not isinstance(target,dict): break
            source=source.get(part); target=target.get(part)
        else:
            if isinstance(target,dict) and isinstance(source,dict) and parts[-1] not in source and target.get(parts[-1],object())==value:
                del target[parts[-1]]
    # Docker omits empty lists in these documented container fields.
    left=expected.get('TaskTemplate',{}).get('ContainerSpec',{})
    right=observed.get('TaskTemplate',{}).get('ContainerSpec',{})
    if isinstance(left,dict) and isinstance(right,dict):
        for field in ('Env','Mounts','Secrets','Configs','Args','Command','Hosts'):
            if left.get(field) == [] and field not in right:
                right[field]=[]
    return observed


def reconciled_failure(destination, docker):
    """Check this installation's one historical failed image deployment.

    Only the returned ID can be excepted from the terminal-state check. This
    does not mutate either the captured databases or the Swarm.
    """
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    with contextlib.closing(read_db(destination / 'panel.sqlite')) as panel, contextlib.closing(read_db(destination / 'agent.sqlite')) as agent:
        failed = panel.execute("SELECT id,type,service_id,created_at,finished_at FROM actions WHERE status='failed'").fetchall()
        failed_jobs = panel.execute("SELECT action_id,service_id,snapshot FROM jobs WHERE status='failed'").fetchall()
        failed_agents = agent.execute("SELECT id,service_id,state,operation_stage,response,target_spec,previous_spec FROM operations WHERE state='failed'").fetchall()
        if len(failed) != 1 or len(failed_jobs) != 1 or len(failed_agents) != 1:
            raise UpgradeError('Unexpected failed operation inventory')
        old = failed[0]; job = failed_jobs[0]; previous = failed_agents[0]
        if (old['type'] != 'deploy' or old['id'] != job['action_id'] or old['id'] != previous['id'] or
                old['service_id'] != job['service_id'] or old['service_id'] != previous['service_id'] or not old['finished_at']):
            raise UpgradeError('Failed operation identity differs')
        try:
            snapshot = json.loads(job['snapshot'])
            response = json.loads(previous['response'])
            message = response['error']['message']
            source = snapshot.get('source') or {}
        except (ValueError, KeyError, TypeError, AttributeError): raise UpgradeError('Failed operation is invalid') from None
        if (source.get('type', 'image') != 'image' or previous['operation_stage'] != 'rolling_back' or
                not previous['target_spec'] or not previous['previous_spec'] or
                not isinstance(message,str) or 'restored the previous runtime configuration' not in message or
                any(value in message.lower() for value in ('timeout','timed out','deadline','recovery also failed'))):
            raise UpgradeError('Failed operation requires reconciliation')
        latest = panel.execute("SELECT a.id,a.type,a.created_at,a.status,j.status AS job_status,j.service_id AS job_service_id FROM actions a JOIN jobs j ON j.action_id=a.id WHERE a.service_id=? AND a.created_at>? ORDER BY a.created_at DESC LIMIT 1",(old['service_id'],old['finished_at'])).fetchone()
        if not latest or latest['type'] != 'deploy' or latest['status'] != 'succeeded' or latest['job_status'] != 'succeeded' or latest['job_service_id'] != old['service_id']:
            raise UpgradeError('No later successful deployment')
        later = panel.execute('SELECT 1 FROM actions WHERE service_id=? AND created_at>=? AND id<>? LIMIT 1',(old['service_id'],latest['created_at'],latest['id'])).fetchone()
        if later: raise UpgradeError('Service changed after reconciliation')
        operation = agent.execute("SELECT service_id,state,target_spec FROM operations WHERE id=?",(latest['id'],)).fetchone()
        service = panel.execute('SELECT deployed_revision,deleted_at FROM services WHERE id=?',(old['service_id'],)).fetchone()
        if not operation or operation['state'] != 'succeeded' or operation['service_id'] != old['service_id'] or not service or service['deleted_at'] is not None:
            raise UpgradeError('Later deployment cannot be verified')
        try:
            key = bytes.fromhex(read_private(destination / 'secret-key').decode('ascii'))
            sealed = operation['target_spec']
            if not isinstance(sealed,str) or not sealed.startswith('enc:v1:'): raise ValueError()
            raw = base64.b64decode(sealed[7:],validate=True)
            target = json.loads(AESGCM(key).decrypt(raw[:12],raw[28:]+raw[12:28],b'panel-secret-v1'))
        except Exception: raise UpgradeError('Deployment snapshot cannot be decrypted') from None
        ids = docker.call('service','ls','-q','--filter','label=panel.owner=self-hosted-panel').decode('ascii').splitlines()
        if not ids: raise UpgradeError('Swarm service is unavailable')
        items = json.loads(docker.call('service','inspect',*ids))
        matching = [item for item in items if (item.get('Spec',{}).get('Labels') or {}).get('panel.service') == old['service_id']]
        if len(matching) != 1: raise UpgradeError('Swarm service identity differs')
        item=matching[0]; actual=item['Spec']; index=item.get('Version',{}).get('Index')
        if type(index) is not int or (item.get('UpdateStatus') or {}).get('State') != 'completed':
            raise UpgradeError('Swarm update is not settled')
        for network in target.get('TaskTemplate',{}).get('Networks',[]):
            found=json.loads(docker.call('network','inspect',network['Target']))
            if not isinstance(found,list) or len(found)!=1: raise UpgradeError('Swarm network identity differs')
            network['Target']=found[0]['Id']
        actual=normalize_defaults(target,actual)
        if not _matches(target,actual): raise UpgradeError('Swarm specification differs')
        expected = target.get('TaskTemplate',{}).get('ContainerSpec',{})
        actual_container = actual.get('TaskTemplate',{}).get('ContainerSpec',{})
        for field in ('Image','Env','Command','Args','Dir','User','Mounts','Secrets','Configs','Privileges','Healthcheck','Hosts','DNSConfig','ReadOnly','Labels'):
            if not _matches(expected.get(field),actual_container.get(field)): raise UpgradeError('Swarm container specification differs')
        labels = actual_container.get('Labels') or {}
        if labels.get('panel.operation') != latest['id'] or labels.get('panel.revision') != str(service['deployed_revision']):
            raise UpgradeError('Swarm operation identity differs')
        desired = actual.get('Mode',{}).get('Replicated',{}).get('Replicas')
        if type(desired) is not int or desired < 1: raise UpgradeError('Unsupported service replica count')
        tids=docker.call('service','ps','-q','--no-trunc','--filter','desired-state=running',item['ID']).decode('ascii').splitlines()
        if len(tids)!=desired or not all(TASK.fullmatch(task) for task in tids): raise UpgradeError('Swarm task count differs')
        tasks=json.loads(docker.call('inspect','--type','task',*tids))
        for task in tasks:
            status=task.get('Status') or {}; cid=(status.get('ContainerStatus') or {}).get('ContainerID')
            if status.get('State')!='running' or not isinstance(cid,str) or not HEX.fullmatch(cid): raise UpgradeError('Swarm task is not running')
            container=docker.inspect(cid)[0]; state=container.get('State') or {}
            health=state.get('Health')
            if (state.get('Running') is not True or
                    (expected.get('Healthcheck') and (not isinstance(health,dict) or health.get('Status')!='healthy')) or
                    (health is not None and (not isinstance(health,dict) or health.get('Status')!='healthy'))):
                raise UpgradeError('Swarm task is not healthy')
        again=json.loads(docker.call('service','inspect',item['ID']))
        if len(again)!=1 or again[0].get('Version',{}).get('Index') != index: raise UpgradeError('Swarm changed during inspection')
        return old['id']


def capture_snapshot(module, docker, source, destination, node):
    """Capture via the existing reader, allowing only a reconciled failure."""
    source_fd=os.open(source,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    destination_fd=os.open(destination,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    node_fd=os.open(node,os.O_RDONLY|os.O_NOFOLLOW)
    original_validate=module._validate_staging
    original_connect=module.sqlite3.connect
    original_headroom=module._cgroup_v2_headroom
    try:
        def validate(dest_fd, trusted_node):
            failure=reconciled_failure(destination,docker)
            class Connection:
                def __init__(self,raw): self.raw=raw
                def __enter__(self): self.raw.__enter__(); return self
                def __exit__(self,*args): return self.raw.__exit__(*args)
                def execute(self,sql,*args):
                    queries={
                        "SELECT 1 FROM jobs WHERE status != 'succeeded' OR status IS NULL LIMIT 1": "SELECT 1 FROM jobs WHERE (status != 'succeeded' OR status IS NULL) AND NOT (status IS 'failed' AND action_id=?) LIMIT 1",
                        "SELECT 1 FROM actions WHERE status != 'succeeded' OR status IS NULL LIMIT 1": "SELECT 1 FROM actions WHERE (status != 'succeeded' OR status IS NULL) AND NOT (status IS 'failed' AND id=?) LIMIT 1",
                        "SELECT 1 FROM operations WHERE state != 'succeeded' OR state IS NULL LIMIT 1": "SELECT 1 FROM operations WHERE (state != 'succeeded' OR state IS NULL) AND NOT (state IS 'failed' AND id=?) LIMIT 1",
                    }
                    return self.raw.execute(queries[sql],(failure,)) if sql in queries else self.raw.execute(sql,*args)
            module.sqlite3.connect=lambda *args,**kwargs: Connection(original_connect(*args,**kwargs))
            try: original_validate(dest_fd,trusted_node)
            finally: module.sqlite3.connect=original_connect
        module._validate_staging=validate
        module._cgroup_v2_headroom=visible_cgroup_headroom
        return module._capture_quiescent(source_fd,destination_fd,node_fd,source_uid=1000,reader_gid=65534)
    finally:
        module._validate_staging=original_validate
        module.sqlite3.connect=original_connect
        module._cgroup_v2_headroom=original_headroom
        for fd in (source_fd,destination_fd,node_fd): os.close(fd)


def visible_cgroup_headroom(mountpoint, relative):
    """Check every visible memory limit; cgroup v2's root has no limit files."""
    if not isinstance(mountpoint,str) or not mountpoint.startswith('/') or os.path.normpath(mountpoint)!=mountpoint:
        raise UpgradeError('Invalid cgroup path')
    parts=relative.split('/') if relative else []
    if any(not part or part in ('.','..') for part in parts): raise UpgradeError('Invalid cgroup path')
    remaining=None
    for depth in range(len(parts),-1,-1):
        directory=os.path.join(mountpoint,*parts[:depth]);values=[]
        directory_fd=os.open(directory,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC)
        try:
            for name in ('memory.max','memory.current'):
                try:
                    fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=directory_fd)
                    try: raw=os.read(fd,129)
                    finally: os.close(fd)
                    if len(raw)>128: raise UpgradeError('Invalid cgroup memory accounting')
                    values.append(raw.decode('ascii').strip())
                except FileNotFoundError: values.append(None)
        finally: os.close(directory_fd)
        limit,usage=values
        if limit is None and usage is None and depth==0: continue
        if limit is None or usage is None: raise UpgradeError('Incomplete cgroup memory accounting')
        if not usage.isdecimal() or (limit!='max' and not limit.isdecimal()): raise UpgradeError('Invalid cgroup memory accounting')
        if limit!='max':
            available=max(0,int(limit)-int(usage))
            remaining=available if remaining is None else min(remaining,available)
    return remaining


def checkpoint_role(docker, item):
    cid = item['Id']
    docker.call('stop','--time','180',cid,timeout=200)
    result = docker.inspect(cid)[0]
    if result.get('State',{}).get('Running') is not False or result['State'].get('ExitCode') != 0:
        raise UpgradeError('A Servus component failed to stop cleanly')


def replace_image(content):
    lines = content.splitlines(keepends=True)
    matches = [i for i,line in enumerate(lines) if line.startswith(b'SERVUS_IMAGE=')]
    if len(matches) != 1 or lines[matches[0]].rstrip(b'\r\n') != ('SERVUS_IMAGE='+OLD).encode():
        raise UpgradeError('Current image configuration differs')
    ending = b'\n' if lines[matches[0]].endswith(b'\n') else b''
    lines[matches[0]] = ('SERVUS_IMAGE='+NEW).encode()+ending
    return b''.join(lines)


def parse_environment(content, *, image=OLD, data_dir='/var/lib/servus', origin='https://159.65.115.230'):
    try:
        values={}
        for line in content.decode('ascii').splitlines():
            if not line or '=' not in line: raise ValueError()
            key,value=line.split('=',1)
            if not re.fullmatch(r'SERVUS_[A-Z0-9_]+',key) or key in values or not re.fullmatch(r'[A-Za-z0-9_./,:@%+\-]*',value): raise ValueError()
            values[key]=value
    except (UnicodeDecodeError,ValueError): raise UpgradeError('Invalid installation configuration') from None
    if (values.get('SERVUS_IMAGE') != image or values.get('SERVUS_DATA_DIR') != data_dir or
            values.get('SERVUS_BIND_ADDRESS') != '127.0.0.1' or values.get('SERVUS_PORT') != '4180' or
            values.get('SERVUS_PUBLIC_URL') != origin or values.get('SERVUS_SECURE_COOKIES') != 'true'):
        raise UpgradeError('Installation configuration is not supported')
    return values


def current_compose(install, *, expected_hash='4f93b54f1d1e68f4c105677f4e97baa4d0b57cbdcc6a117e44818b883b7a5867'):
    link=install/'current'; info=link.lstat()
    if not stat.S_ISLNK(info.st_mode) or info.st_uid != 0: raise UpgradeError('Current release link is unsafe')
    resolved=pathlib.Path(os.path.realpath(link)); releases=install/'releases'
    if resolved.parent != releases: raise UpgradeError('Current release is outside the installation')
    secure_directory(releases); secure_directory(resolved)
    deployment=resolved/'deployment'; secure_directory(deployment)
    compose=deployment/'compose.yaml'; fd=os.open(compose,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC)
    try:
        info=os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or info.st_nlink!=1 or info.st_mode&0o022 or info.st_size>2**20:
            raise UpgradeError('Compose file is unsafe')
        content=os.read(fd,2**20+1)
        if hashlib.sha256(content).hexdigest()!=expected_hash:
            raise UpgradeError('Compose file differs from the approved 0.1.4 release')
    finally: os.close(fd)
    return compose


def expected_runtime(docker, compose, config_path, image):
    """Derive component environment from the pinned image and approved Compose."""
    try:
        result=json.loads(docker.call('compose','--env-file',str(config_path),'-f',str(compose),'-p','servus','config','--format','json'))
        base=json.loads(docker.call('image','inspect','--platform=linux/amd64','--format','{{json .Config}}',image))
    except (ValueError,UnicodeError): raise UpgradeError('Runtime configuration is invalid') from None
    if not isinstance(result,dict) or not isinstance(base,dict) or set(result.get('services',{}))!=set(ROLES):
        raise UpgradeError('Runtime configuration is invalid')
    raw=base.get('Env')
    if not isinstance(raw,list) or not all(isinstance(item,str) and '=' in item for item in raw): raise UpgradeError('Image environment is invalid')
    entries=[item.split('=',1) for item in raw]
    if len({key for key,_ in entries})!=len(entries): raise UpgradeError('Image environment is invalid')
    common=dict(entries); output={}
    for role in ROLES:
        service=result['services'][role]
        environment=service.get('environment') if isinstance(service,dict) else None
        if not isinstance(service,dict) or service.get('image')!=image or not isinstance(environment,dict) or not all(isinstance(k,str) and isinstance(v,str) for k,v in environment.items()):
            raise UpgradeError('Runtime configuration is invalid')
        output[role]={**common,**environment}
    return output,base.get('Entrypoint'),base.get('WorkingDir')


def validate_running_components(docker, data_dir, *, image=OLD, restart='unless-stopped', runtime=None, allow_stopped=False):
    components=container_ids(docker); identities=set()
    for role,item in components.items():
        cid=item.get('Id'); config=item.get('Config') or {}; host=item.get('HostConfig') or {}; state=item.get('State') or {}
        running=(state.get('Running') is True and state.get('Status')=='running' and
                 state.get('Paused') is False and state.get('Restarting') is False)
        # Worker SIGTERM may exit 143; restart is gated on a clean API/agent,
        # all roles being stopped, and the journal and Swarm checks below.
        stopped=(allow_stopped and state.get('Running') is False and state.get('Status')=='exited' and
                 state.get('Paused') is False and state.get('Restarting') is False and
                 (state.get('ExitCode')==0 or (role=='worker' and state.get('ExitCode')==143)))
        if (not isinstance(cid,str) or not HEX.fullmatch(cid) or item.get('Image')!=image.split('@',1)[1] or
                config.get('Image')!=image or config.get('User')!='node' or
                config.get('Cmd')!=['node','dist/'+('server' if role=='api' else role)+'/index.js'] or
                not (running or stopped) or host.get('Privileged') is not False or
                host.get('PidMode')!='' or (host.get('RestartPolicy') or {}).get('Name') not in ((restart,) if isinstance(restart,str) else restart)):
            raise UpgradeError('Running Servus configuration differs')
        if (host.get('IpcMode')!='private' or host.get('UTSMode')!='' or host.get('UsernsMode')!='' or
                host.get('NetworkMode')!='servus_default' or host.get('CapAdd') not in (None,[]) or
                host.get('CapDrop') not in (None,[]) or host.get('Devices') not in (None,[]) or
                host.get('DeviceRequests') not in (None,[]) or host.get('SecurityOpt') not in (None,[]) or
                host.get('ReadonlyRootfs') is not False or host.get('PublishAllPorts') is not False or
                host.get('Init') is not True or host.get('Runtime')!='runc'):
            raise UpgradeError('Running Servus isolation differs')
        ports=host.get('PortBindings')
        if role=='api':
            if ports!={'4180/tcp':[{'HostIp':'127.0.0.1','HostPort':'4180'}]}:raise UpgradeError('Running Servus listener differs')
        elif ports not in (None,{}):raise UpgradeError('Unexpected Servus listener')
        if runtime is not None:
            environments,entrypoint,workdir=runtime
            raw=config.get('Env')
            if not isinstance(raw,list) or not all(isinstance(item,str) and '=' in item for item in raw):raise UpgradeError('Running Servus environment differs')
            pairs=[item.split('=',1) for item in raw]
            if (len({key for key,_ in pairs})!=len(pairs) or dict(pairs)!=environments[role] or
                    config.get('Entrypoint')!=entrypoint or config.get('WorkingDir')!=workdir):
                raise UpgradeError('Running Servus environment differs')
        if state.get('Running') is True and role in ('api','agent') and (state.get('Health') or {}).get('Status')!='healthy':
            raise UpgradeError('Running Servus component is unhealthy')
        mounts=item.get('Mounts') or []
        expected={(str(data_dir),str(data_dir),True)}
        if role=='agent': expected.add(('/var/run/docker.sock','/var/run/docker.sock',True))
        actual={(mount.get('Source'),mount.get('Destination'),mount.get('RW')) for mount in mounts}
        if len(mounts)!=len(expected) or actual!=expected or any(mount.get('Type')!='bind' for mount in mounts):
            raise UpgradeError('Running Servus mounts differ')
        identities.add(cid)
    ensure_no_other_data_mounts(docker,identities,data_dir)
    ensure_no_mount_aliases(docker,data_dir)
    return components


def verify_restored_image(docker, image, snapshot, scratch, *, probe_name=None):
    """Start an isolated copy and verify a synthetic local login."""
    clone=scratch/'restore'; shutil.copytree(snapshot,clone,symlinks=False)
    for root,dirs,files in os.walk(clone):
        os.chown(root,1000,1000); os.chmod(root,0o700)
        for name in files:
            path=pathlib.Path(root)/name
            if path.is_symlink() or not path.is_file(): raise UpgradeError('Restore inventory is unsafe')
            os.chown(path,1000,1000); os.chmod(path,0o600)
    cid=None
    try:
        args=['run','-d','--pull=never','--platform=linux/amd64','--network=none','--read-only']
        if probe_name is not None:
            if not re.fullmatch(r'servus-manual-restore-[a-f0-9]{32}',probe_name): raise UpgradeError('Invalid restore probe name')
            args.extend(['--name',probe_name,'--label','servus.manual-upgrade=restore'])
        raw=docker.call(*args,'--tmpfs','/tmp:rw,nosuid,nodev,size=32m',
                        '--mount',f'type=bind,source={clone},target=/var/lib/servus',
                        '--env','PANEL_DATA_DIR=/var/lib/servus','--env','PANEL_HOST=127.0.0.1',
                        '--env','PANEL_ALLOWED_ORIGINS=http://127.0.0.1:4180',image,timeout=60)
        cid=raw.decode('ascii').strip()
        if not HEX.fullmatch(cid): raise UpgradeError('Invalid restore test container')
        deadline=time.monotonic()+60
        while True:
            try:
                output=docker.call('exec',cid,'node','-e',"fetch('http://127.0.0.1:4180/api/v1/health').then(async r=>{const x=await r.json();process.exit(r.ok&&x.status==='ok'&&x.version==='0.1.5'&&x.revision==='"+REVISION+"'?0:1)}).catch(()=>process.exit(1))",timeout=5)
                break
            except (UpgradeError,subprocess.TimeoutExpired):
                if time.monotonic()>=deadline: raise UpgradeError('Restore test did not start') from None
                time.sleep(1)
        email='snapshot-'+uuid.uuid4().hex+'@example.test'
        javascript="""import {Store} from './dist/server/store.js';
import {hashPassword} from './dist/server/auth.js';
const email=process.argv[1],password='isolated-snapshot-test-password';
const s=new Store('/var/lib/servus');s.createUser(email,await hashPassword(password),'admin');s.close();
const r=await fetch('http://127.0.0.1:4180/api/v1/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email,password})});
const cookie=r.headers.get('set-cookie');if(!r.ok||!cookie)process.exit(1);
const q=await fetch('http://127.0.0.1:4180/api/v1/auth/session',{headers:{cookie:cookie.split(';')[0]}});const value=await q.json();if(!q.ok||value.user?.email!==email)process.exit(1);
"""
        docker.call('exec',cid,'node','--input-type=module','-e',javascript,email,timeout=30)
        # These processes use the restored copy and cannot access a Docker socket.
        roles_test="""import {spawn} from 'node:child_process';
const roles=[['dist/agent/index.js','Local agent listening'],['dist/worker/index.js','Deployment worker started.']];
const children=[];
try {
  for (const [path,ready] of roles) {
    const child=spawn(process.execPath,[path],{stdio:['ignore','pipe','ignore']});children.push(child);
    await new Promise((resolve,reject)=>{
      let output='';const timer=setTimeout(()=>reject(new Error('Role startup timed out')),20000);
      child.once('error',reject);child.once('exit',()=>reject(new Error('Role exited during startup')));
      child.stdout.on('data',part=>{output+=part.toString();if(output.includes(ready)){clearTimeout(timer);resolve();}});
    });
  }
  await new Promise(resolve=>setTimeout(resolve,1500));
  if(children.some(child=>child.exitCode!==null || child.signalCode!==null))throw new Error('Role exited early');
  for(const child of children)child.kill('SIGTERM');
  await Promise.all(children.map(child=>new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Role shutdown timed out')),20000);
    child.once('exit',(code,signal)=>{clearTimeout(timer);code===0&&!signal?resolve():reject(new Error('Role shutdown failed'));});
  })));
} finally { for(const child of children)if(child.exitCode===null && child.signalCode===null)child.kill('SIGKILL'); }
"""
        docker.call('exec',cid,'node','--input-type=module','-e',roles_test,timeout=60)
        docker.call('stop','--time','30',cid,timeout=40)
        if docker.inspect(cid)[0].get('State',{}).get('ExitCode')!=0:
            raise UpgradeError('Restore test did not stop cleanly')
    finally:
        if cid is not None: docker.call('rm','-f',cid,timeout=30)
        shutil.rmtree(clone)


def health_check(url, expected_version, expected_revision, *, timeout=90):
    bundle=pathlib.Path('/etc/ssl/certs/ca-certificates.crt')
    secure_directory(bundle.parent)
    fd=os.open(bundle,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC)
    try:
        info=os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or info.st_mode & 0o022 or
                info.st_nlink!=1 or not 0 < info.st_size <= 4*1024*1024):
            raise UpgradeError('System CA bundle is unsafe')
        with os.fdopen(fd,'rb',closefd=False) as source: data=source.read(4*1024*1024+1)
        final=os.fstat(fd); named=os.stat(bundle,follow_symlinks=False)
        if (len(data)!=info.st_size or (info.st_dev,info.st_ino,info.st_size,info.st_mtime_ns,info.st_ctime_ns)!=
                (final.st_dev,final.st_ino,final.st_size,final.st_mtime_ns,final.st_ctime_ns) or
                (named.st_dev,named.st_ino)!=(info.st_dev,info.st_ino)):
            raise UpgradeError('System CA bundle changed')
    finally: os.close(fd)
    try:
        context=ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        context.load_verify_locations(cadata=data.decode('ascii'))
    except (ValueError,UnicodeError,ssl.SSLError): raise UpgradeError('System CA bundle is invalid') from None
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),urllib.request.HTTPSHandler(context=context))
    deadline=time.monotonic()+timeout
    while True:
        try:
            with opener.open(url,timeout=3) as response:
                raw=response.read(16385)
                if response.status==200 and len(raw)<=16384:
                    value=json.loads(raw)
                    if value=={'status':'ok','version':expected_version,'revision':expected_revision}: return
        except (OSError,ValueError,UnicodeError): pass
        if time.monotonic()>=deadline: raise UpgradeError('Panel health verification failed')
        time.sleep(1)


def _open_install_lock(path):
    fd=os.open(path,os.O_RDWR|os.O_NOFOLLOW|os.O_CLOEXEC)
    try:
        info=os.fstat(fd); named=os.stat(path,follow_symlinks=False)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or stat.S_IMODE(info.st_mode)!=0o600 or
                info.st_nlink!=1 or (info.st_dev,info.st_ino)!=(named.st_dev,named.st_ino)):
            raise UpgradeError('Installation lock is unsafe')
        try: fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError: raise UpgradeError('Another installation operation is active') from None
        return fd
    except BaseException:
        os.close(fd); raise


def _wait_component(docker, role, image, *, timeout=120):
    deadline=time.monotonic()+timeout
    while True:
        component=container_ids(docker)[role]
        state=component.get('State') or {}; config=component.get('Config') or {}
        ready=(state.get('Running') is True and config.get('Image')==image and
               (role=='worker' or (state.get('Health') or {}).get('Status')=='healthy'))
        if ready: return component
        if time.monotonic()>=deadline: raise UpgradeError('New component did not become healthy')
        time.sleep(1)


def run_upgrade(*, install=pathlib.Path('/opt/servus'),config_dir=pathlib.Path('/etc/servus'),
                data_dir=pathlib.Path('/var/lib/servus'),origin='https://159.65.115.230',
                compose_hash='4f93b54f1d1e68f4c105677f4e97baa4d0b57cbdcc6a117e44818b883b7a5867',
                health=health_check):
    """Perform the one-off upgrade after independent image attestation.

    Caller-provided paths are for isolated tests. The operator CLI uses only
    fixed production paths and remains gated until end-to-end review.
    """
    if sys.platform!='linux' or os.geteuid()!=0 or not sys.flags.isolated:
        raise UpgradeError('An isolated Linux root coordinator is required')
    ensure_host_namespaces()
    try:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        AESGCM(b'\0'*32)
    except (ImportError,ValueError): raise UpgradeError('Required cryptography is unavailable') from None
    install=secure_directory(install,mode=0o700)
    config_dir=secure_directory(config_dir,mode=0o700)
    data_dir=secure_directory(data_dir,owner=1000,mode=0o700)
    lock=_open_install_lock(install/'install.lock')
    try:
        marker=install/'manual-upgrade-state.json'
        if marker.exists() or marker.is_symlink(): raise UpgradeError('An earlier manual operation requires inspection')
        compose=current_compose(install,expected_hash=compose_hash)
        config_path=config_dir/'servus.env'; old_environment=read_private(config_path)
        parse_environment(old_environment,image=OLD,data_dir=str(data_dir),origin=origin)
        new_environment=replace_image(old_environment)
        parse_environment(new_environment,image=NEW,data_dir=str(data_dir),origin=origin)
        backups=install/'manual-backups'
        try: backups.mkdir(mode=0o700); sync_directory(install)
        except FileExistsError: pass
        secure_directory(backups,mode=0o700)
        operation=uuid.uuid4().hex; directory=backups/operation
        directory.mkdir(mode=0o700); sync_directory(backups)
        docker_config=directory/'docker-config';docker_config.mkdir(mode=0o700)
        tools=directory/'tools';tools.mkdir(mode=0o700)
        snapshot=directory/'snapshot';snapshot.mkdir(mode=0o700)
        scratch=directory/'scratch';scratch.mkdir(mode=0o700)
        sync_directory(directory)
        docker=Docker(docker_config)
        image_preflight(docker)
        old_runtime=expected_runtime(docker,compose,config_path,OLD)
        components=validate_running_components(docker,data_dir,image=OLD,runtime=old_runtime)
        ids={role:components[role]['Id'] for role in ROLES}
        ensure_no_uid_writers(allowed_containers=set(ids.values()))
        tool_name='servus-manual-tools-'+operation;restore_name='servus-manual-restore-'+operation
        state={'backup':str(directory),'oldContainers':ids,'toolsProbe':tool_name,'restoreProbe':restore_name}
        write_new(directory/'servus.env',old_environment);write_new(directory/'current-link',os.readlink(install/'current').encode()+b'\n')
        override=b'services:\n  api:\n    restart: "no"\n  worker:\n    restart: "no"\n  agent:\n    restart: "no"\n'
        write_new(directory/'restart-override.yaml',override);sync_directory(directory)
        write_new(marker,(json.dumps({'version':1,'operation':operation,'phase':'intent',**state},sort_keys=True,separators=(',',':'))+'\n').encode());sync_directory(install)
        release_tools(docker,tools,probe_name=tool_name)
        node=tools/'node'
        version=subprocess.run([str(node),'--version'],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,
                               cwd='/',env={'PATH':'/usr/bin:/bin','LANG':'C','LC_ALL':'C'},timeout=10)
        if version.returncode or not re.fullmatch(rb'v24\.[0-9]+\.[0-9]+\n',version.stdout):
            raise UpgradeError('Release Node binary is unavailable')
        module=load_backup(tools/'backup.py')
        original_headroom=module._cgroup_v2_headroom
        module._cgroup_v2_headroom=visible_cgroup_headroom
        try: module._memory_headroom(module.MAX_DATABASE)
        finally: module._cgroup_v2_headroom=original_headroom
        set_marker(marker,operation,'preventing_restart',**state)
        for role in ROLES: docker.call('update','--restart=no',ids[role],timeout=30)
        set_marker(marker,operation,'stopping',**state)
        for role in ('api','worker','agent'): checkpoint_role(docker,components[role])
        check_stopped(docker,list(ids.values()))
        ensure_no_other_data_mounts(docker,set(ids.values()),data_dir)
        ensure_no_mount_aliases(docker,data_dir)
        ensure_no_open_data(data_dir)
        ensure_no_uid_writers()
        set_marker(marker,operation,'capturing',**state)
        manifest=capture_snapshot(module,docker,data_dir,snapshot,node)
        if not isinstance(manifest,dict) or 'panel.sqlite' not in manifest.get('files',{}): raise UpgradeError('Snapshot was not verified')
        check_stopped(docker,list(ids.values()));ensure_no_mount_aliases(docker,data_dir);ensure_no_open_data(data_dir);ensure_no_uid_writers()
        set_marker(marker,operation,'testing_restore',**state)
        verify_restored_image(docker,NEW,snapshot,scratch,probe_name=restore_name)
        check_stopped(docker,list(ids.values()));ensure_no_mount_aliases(docker,data_dir);ensure_no_open_data(data_dir);ensure_no_uid_writers()
        # Detect root-operator changes made outside the shared installation lock.
        if read_private(config_path)!=old_environment or current_compose(install,expected_hash=compose_hash)!=compose:
            raise UpgradeError('Installation changed while preparing upgrade')
        set_marker(marker,operation,'ready_to_switch',**state)
        set_marker(marker,operation,'switching',**state)
        atomic_private(config_path,new_environment)
        for role in ('agent','api','worker'):
            docker.call('compose','--env-file',str(config_path),'-f',str(compose),'-f',str(directory/'restart-override.yaml'),
                        '-p','servus','up','-d','--no-deps','--pull','never','--force-recreate',role,timeout=180)
            _wait_component(docker,role,NEW)
        new_runtime=expected_runtime(docker,compose,config_path,NEW)
        current=validate_running_components(docker,data_dir,image=NEW,restart='no',runtime=new_runtime)
        set_marker(marker,operation,'verifying',**state)
        health('http://127.0.0.1:4180/api/v1/health','0.1.5',REVISION)
        health(origin+'/api/v1/health','0.1.5',REVISION)
        # Re-enable automatic restart only after the exact release is healthy.
        for role in ROLES: docker.call('update','--restart=unless-stopped',current[role]['Id'],timeout=30)
        validate_running_components(docker,data_dir,image=NEW,runtime=new_runtime)
        set_marker(marker,operation,'complete',**state)
        return directory
    finally:
        os.close(lock)


def recovery_status(install):
    """Report durable state without attempting recovery or starting services."""
    install=secure_directory(install,mode=0o700);marker=install/'manual-upgrade-state.json'
    try: content=read_private(marker,limit=16384)
    except FileNotFoundError: return {'phase':'none','action':'none'}
    try: data=json.loads(content)
    except (ValueError,UnicodeError,RecursionError):raise UpgradeError('Recovery state is invalid') from None
    phases=('intent','preventing_restart','stopping','capturing','testing_restore','ready_to_switch','switching','verifying','complete',
            'recovery_starting','recovery_verifying','recovered')
    if (not isinstance(data,dict) or set(data)!={'version','operation','phase','backup','oldContainers','toolsProbe','restoreProbe'} or
            type(data['version']) is not int or data['version']!=1 or not isinstance(data['operation'],str) or
            not re.fullmatch(r'[a-f0-9]{32}',data['operation']) or data['phase'] not in phases or
            data['backup'] != str(install/'manual-backups'/data['operation']) or
            not isinstance(data['oldContainers'],dict) or set(data['oldContainers'])!=set(ROLES) or
            not all(isinstance(cid,str) and HEX.fullmatch(cid) for cid in data['oldContainers'].values()) or
            len(set(data['oldContainers'].values()))!=len(ROLES) or
            data['toolsProbe']!='servus-manual-tools-'+data['operation'] or
            data['restoreProbe']!='servus-manual-restore-'+data['operation']):
        raise UpgradeError('Recovery state is invalid')
    return {'phase':data['phase'],'action':'none' if data['phase'] in ('complete','recovered') else 'inspection_required','backup':data['backup']}


def verify_release_attestation(*, directory=pathlib.Path('/usr/local/libexec/servus')):
    """Require the pinned release's independently verified GitHub provenance."""
    directory=secure_directory(directory)
    for name,expected in VERIFIER_FILES.items():
        path=directory/name;fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC)
        try:
            info=os.fstat(fd)
            if (not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or info.st_nlink!=1 or info.st_mode&0o022 or
                    not 0<info.st_size<=1024*1024):raise UpgradeError('Release verifier is unsafe')
            digest=hashlib.sha256()
            while chunk:=os.read(fd,65536):digest.update(chunk)
            final=os.fstat(fd);named=os.stat(path,follow_symlinks=False)
            if ((info.st_dev,info.st_ino,info.st_size,info.st_mtime_ns,info.st_ctime_ns)!=
                    (final.st_dev,final.st_ino,final.st_size,final.st_mtime_ns,final.st_ctime_ns) or
                    (info.st_dev,info.st_ino)!=(named.st_dev,named.st_ino) or digest.hexdigest()!=expected):
                raise UpgradeError('Release verifier does not match the approved implementation')
        finally:os.close(fd)
    digest=NEW.split('@',1)[1]
    try:
        result=subprocess.run(['/usr/bin/python3','-I',str(directory/'verification-executor.py'),
                               '--digest',digest,'--commit',REVISION,'--tag','v0.1.5'],
                              stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,
                              cwd='/',env={'PATH':'/usr/bin:/bin','LANG':'C','LC_ALL':'C'},timeout=120)
        if result.returncode or len(result.stdout)>16384:raise UpgradeError('Release attestation verification failed')
        value=json.loads(result.stdout)
    except (OSError,subprocess.TimeoutExpired,ValueError,UnicodeError):
        raise UpgradeError('Release attestation verification failed') from None
    if value!={'image':'ghcr.io/raxon/servus','digest':digest,'commit':REVISION,'tag':'v0.1.5',
               'verified':True,'configDigest':CONFIG_DIGEST}:
        raise UpgradeError('Release attestation does not match the approved image')


def verify_snapshot_hashes(snapshot):
    """Verify the immutable captured files without exposing their contents."""
    manifest=json.loads(read_private(snapshot/'manifest.json',limit=4*1024*1024))
    if not isinstance(manifest,dict) or set(manifest)!={'format','files'} or manifest['format']!=1 or not isinstance(manifest['files'],dict):
        raise UpgradeError('Snapshot manifest is invalid')
    files=manifest['files']
    if not {'panel.sqlite','agent.sqlite','secret-key','agent-token'}.issubset(files):raise UpgradeError('Snapshot inventory is incomplete')
    observed=set()
    for root,dirs,names in os.walk(snapshot,followlinks=False):
        root=pathlib.Path(root);secure_directory(root,mode=0o700)
        for name in dirs:
            if (root/name).is_symlink():raise UpgradeError('Snapshot inventory is unsafe')
        for name in names:
            path=root/name;relative=path.relative_to(snapshot).as_posix()
            if relative=='manifest.json':continue
            if relative not in files:
                sidecars={base+suffix for base in ('panel.sqlite','agent.sqlite') for suffix in ('-wal','-shm')}
                if relative not in sidecars:raise UpgradeError('Snapshot inventory differs')
                fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC)
                try:
                    info=os.fstat(fd);named=os.stat(path,follow_symlinks=False)
                    if (not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or info.st_nlink!=1 or info.st_mode&0o077 or
                            info.st_size>32*1024*1024 or (relative.endswith('-wal') and info.st_size!=0) or
                            (info.st_dev,info.st_ino)!=(named.st_dev,named.st_ino)):
                        raise UpgradeError('Snapshot SQLite sidecar is unsafe')
                finally:os.close(fd)
                continue
            if not isinstance(files[relative],str) or not HEX.fullmatch(files[relative]):raise UpgradeError('Snapshot inventory differs')
            fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC)
            try:
                before=os.fstat(fd)
                if not stat.S_ISREG(before.st_mode) or before.st_uid!=0 or before.st_nlink!=1 or before.st_mode&0o077:
                    raise UpgradeError('Snapshot file is unsafe')
                digest=hashlib.sha256()
                while chunk:=os.read(fd,1024*1024):digest.update(chunk)
                after=os.fstat(fd);named=os.stat(path,follow_symlinks=False)
                if ((before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns,before.st_ctime_ns)!=
                    (after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns) or
                    (before.st_dev,before.st_ino)!=(named.st_dev,named.st_ino) or digest.hexdigest()!=files[relative]):
                    raise UpgradeError('Snapshot contents differ')
            finally:os.close(fd)
            observed.add(relative)
    if observed!=set(files):raise UpgradeError('Snapshot inventory differs')


def finish_verified(*, install=pathlib.Path('/opt/servus'),config_dir=pathlib.Path('/etc/servus'),
                    data_dir=pathlib.Path('/var/lib/servus'),origin='https://159.65.115.230',health=health_check):
    """Finish a verified switch without reverting or replacing live databases."""
    if sys.platform!='linux' or os.geteuid()!=0 or not sys.flags.isolated:raise UpgradeError('An isolated Linux root coordinator is required')
    ensure_host_namespaces()
    install=secure_directory(install,mode=0o700);config_dir=secure_directory(config_dir,mode=0o700)
    data_dir=secure_directory(data_dir,owner=1000,mode=0o700);lock=_open_install_lock(install/'install.lock')
    try:
        status=recovery_status(install)
        if status['phase']!='verifying':raise UpgradeError('This recovery phase requires manual investigation')
        marker=install/'manual-upgrade-state.json';state=json.loads(read_private(marker,limit=16384))
        operation=state.pop('operation');state.pop('version');state.pop('phase')
        directory=secure_directory(pathlib.Path(state['backup']),mode=0o700)
        snapshot=secure_directory(directory/'snapshot',mode=0o700);verify_snapshot_hashes(snapshot)
        config=config_dir/'servus.env';environment=read_private(config);old_environment=read_private(directory/'servus.env')
        if environment!=replace_image(old_environment) or (os.readlink(install/'current')+'\n').encode()!=read_private(directory/'current-link'):
            raise UpgradeError('Installation configuration differs')
        parse_environment(environment,image=NEW,data_dir=str(data_dir),origin=origin)
        compose=current_compose(install);secure_directory(directory/'docker-config',mode=0o700)
        docker=Docker(directory/'docker-config');image_preflight(docker)
        runtime=expected_runtime(docker,compose,config,NEW)
        current=validate_running_components(docker,data_dir,image=NEW,restart=('no','unless-stopped'),runtime=runtime,allow_stopped=True)
        running_count=sum(item['State']['Running'] is True for item in current.values())
        if running_count not in (0,len(ROLES)):raise UpgradeError('Partially stopped panel requires manual investigation')
        def drop_privileges():os.setgroups([]);os.setgid(1000);os.setuid(1000)
        statement=("import sqlite3,sys,pathlib;d=sqlite3.connect(pathlib.Path(sys.argv[1]).as_uri()+'?mode=ro',uri=True);"
                   "v=d.execute('PRAGMA user_version').fetchone();q=d.execute('PRAGMA quick_check').fetchall();d.close();"
                   "sys.exit(0 if v==(int(sys.argv[2]),) and q==[('ok',)] else 1)")
        for name,version in (('panel.sqlite',4),('agent.sqlite',0)):
            path=data_dir/name;info=path.lstat()
            if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode):raise UpgradeError('Live database is unsafe')
            result=subprocess.run(['/usr/bin/python3','-I','-c',statement,str(path),str(version)],
                                  stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,
                                  cwd='/',env={'PATH':'/usr/bin:/bin','LANG':'C','LC_ALL':'C'},preexec_fn=drop_privileges,timeout=60)
            if result.returncode:raise UpgradeError('Live database validation failed')
        if running_count==0:
            ids={item['Id'] for item in current.values()}
            ensure_no_other_data_mounts(docker,ids,data_dir);ensure_no_mount_aliases(docker,data_dir)
            ensure_no_open_data(data_dir);ensure_no_uid_writers()
            failure=reconciled_failure(snapshot,docker)
            journal_check=("import sqlite3,sys,pathlib; "
                "p=sqlite3.connect((pathlib.Path(sys.argv[1])/'panel.sqlite').as_uri()+'?mode=ro',uri=True); "
                "a=sqlite3.connect((pathlib.Path(sys.argv[1])/'agent.sqlite').as_uri()+'?mode=ro',uri=True); "
                "f=sys.argv[2]; "
                "bad=p.execute(\"SELECT 1 FROM jobs WHERE status IS NULL OR status NOT IN ('succeeded','failed') OR (status='failed' AND action_id IS NOT ?) LIMIT 1\",(f,)).fetchone() "
                "or p.execute(\"SELECT 1 FROM actions WHERE status IS NULL OR status NOT IN ('succeeded','failed') OR (status='failed' AND id IS NOT ?) LIMIT 1\",(f,)).fetchone() "
                "or a.execute(\"SELECT 1 FROM operations WHERE state IS NULL OR state NOT IN ('succeeded','failed') OR (state='failed' AND id IS NOT ?) LIMIT 1\",(f,)).fetchone(); "
                "p.close();a.close();sys.exit(1 if bad else 0)")
            result=subprocess.run(['/usr/bin/python3','-I','-c',journal_check,str(data_dir),failure],
                                  stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,
                                  cwd='/',env={'PATH':'/usr/bin:/bin','LANG':'C','LC_ALL':'C'},preexec_fn=drop_privileges,timeout=60)
            if result.returncode:raise UpgradeError('Live operation journal requires manual investigation')
        for role in ('agent','api','worker'):
            if current[role]['State']['Running'] is False:
                now=container_ids(docker)
                if any(now[r]['Id']!=current[r]['Id'] for r in ROLES):raise UpgradeError('New containers changed')
                docker.call('start',current[role]['Id'],timeout=60)
                _wait_component(docker,role,NEW)
        current=validate_running_components(docker,data_dir,image=NEW,restart=('no','unless-stopped'),runtime=runtime)
        health('http://127.0.0.1:4180/api/v1/health','0.1.5',REVISION)
        health(origin+'/api/v1/health','0.1.5',REVISION)
        for role in ROLES:docker.call('update','--restart=unless-stopped',current[role]['Id'],timeout=30)
        validate_running_components(docker,data_dir,image=NEW,runtime=runtime)
        set_marker(marker,operation,'complete',**state)
    finally:os.close(lock)


def recover_old(*, install=pathlib.Path('/opt/servus'),config_dir=pathlib.Path('/etc/servus'),
                data_dir=pathlib.Path('/var/lib/servus'),origin='https://159.65.115.230',health=health_check):
    """Resume the untouched old databases only from the post-capture checkpoint."""
    if sys.platform!='linux' or os.geteuid()!=0 or not sys.flags.isolated:
        raise UpgradeError('An isolated Linux root coordinator is required')
    ensure_host_namespaces()
    install=secure_directory(install,mode=0o700)
    config_dir=secure_directory(config_dir,mode=0o700)
    data_dir=secure_directory(data_dir,owner=1000,mode=0o700)
    lock=_open_install_lock(install/'install.lock')
    try:
        status=recovery_status(install)
        if status['phase']!='ready_to_switch':
            raise UpgradeError('This recovery phase requires manual investigation')
        marker=install/'manual-upgrade-state.json'
        state=json.loads(read_private(marker,limit=16384));operation=state.pop('operation');state.pop('version');state.pop('phase')
        directory=secure_directory(pathlib.Path(state['backup']),mode=0o700)
        snapshot=secure_directory(directory/'snapshot',mode=0o700)
        verify_snapshot_hashes(snapshot)
        config=config_dir/'servus.env';environment=read_private(config)
        if environment!=read_private(directory/'servus.env') or (os.readlink(install/'current')+'\n').encode()!=read_private(directory/'current-link'):
            raise UpgradeError('Original installation configuration differs')
        parse_environment(environment,image=OLD,data_dir=str(data_dir),origin=origin)
        compose=current_compose(install)
        secure_directory(directory/'docker-config',mode=0o700)
        docker=Docker(directory/'docker-config')
        components=container_ids(docker)
        if any(components[role].get('Id')!=state['oldContainers'][role] for role in ROLES):
            raise UpgradeError('Original containers changed')
        for role,item in components.items():
            if (item.get('Image')!=OLD.split('@',1)[1] or (item.get('Config') or {}).get('Image')!=OLD or
                    (item.get('State') or {}).get('Running') is not False or
                    ((item.get('HostConfig') or {}).get('RestartPolicy') or {}).get('Name')!='no'):
                raise UpgradeError('Original containers are not safely stopped')
        ids=set(state['oldContainers'].values())
        check_stopped(docker,list(ids));ensure_no_other_data_mounts(docker,ids,data_dir)
        ensure_no_mount_aliases(docker,data_dir);ensure_no_open_data(data_dir);ensure_no_uid_writers()
        for base in (data_dir,snapshot):
            for name,version in (('panel.sqlite',4),('agent.sqlite',0)):
                path=base/name
                info=path.lstat()
                if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode):raise UpgradeError('Recovery database is unsafe')
                if base==data_dir:
                    # SQLite may create a shared-memory file even for a read-only connection.
                    def drop_privileges():
                        os.setgroups([]);os.setgid(1000);os.setuid(1000)
                    statement=("import sqlite3,sys,pathlib; "
                               "d=sqlite3.connect(pathlib.Path(sys.argv[1]).as_uri()+'?mode=ro',uri=True); "
                               "v=d.execute('PRAGMA user_version').fetchone(); "
                               "q=d.execute('PRAGMA quick_check').fetchall();d.close(); "
                               "sys.exit(0 if v==(int(sys.argv[2]),) and q==[('ok',)] else 1)")
                    result=subprocess.run(['/usr/bin/python3','-I','-c',statement,str(path),str(version)],
                                          stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,
                                          cwd='/',env={'PATH':'/usr/bin:/bin','LANG':'C','LC_ALL':'C'},
                                          preexec_fn=drop_privileges,timeout=60)
                    if result.returncode:raise UpgradeError('Recovery database validation failed')
                else:
                    with contextlib.closing(sqlite3.connect(path.as_uri()+'?mode=ro',uri=True)) as db:
                        if db.execute('PRAGMA user_version').fetchone()!=(version,) or db.execute('PRAGMA quick_check').fetchall()!=[('ok',)]:
                            raise UpgradeError('Recovery database validation failed')
        image=docker.inspect(OLD)[0];revision=((image.get('Config') or {}).get('Labels') or {}).get('org.opencontainers.image.revision')
        if not isinstance(revision,str) or not re.fullmatch(r'[a-f0-9]{40}',revision):raise UpgradeError('Old image revision unavailable')
        runtime=expected_runtime(docker,compose,config,OLD)
        set_marker(marker,operation,'recovery_starting',**state)
        for role in ('agent','api','worker'):
            docker.call('start',state['oldContainers'][role],timeout=60)
            _wait_component(docker,role,OLD)
        validate_running_components(docker,data_dir,image=OLD,restart='no',runtime=runtime)
        set_marker(marker,operation,'recovery_verifying',**state)
        health('http://127.0.0.1:4180/api/v1/health','0.1.4',revision)
        health(origin+'/api/v1/health','0.1.4',revision)
        for role in ROLES:docker.call('update','--restart=unless-stopped',state['oldContainers'][role],timeout=30)
        validate_running_components(docker,data_dir,image=OLD,runtime=runtime)
        set_marker(marker,operation,'recovered',**state)
    finally:
        os.close(lock)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    actions=parser.add_mutually_exclusive_group(required=True)
    actions.add_argument('--execute', action='store_true')
    actions.add_argument('--status', action='store_true')
    actions.add_argument('--recover', action='store_true')
    args = parser.parse_args()
    if sys.platform != 'linux' or os.geteuid() != 0 or not sys.flags.isolated:
        raise UpgradeError('An isolated root invocation is required')
    if args.status:
        print(json.dumps(recovery_status(pathlib.Path('/opt/servus')),separators=(',',':')))
        return
    if args.recover:
        phase=recovery_status(pathlib.Path('/opt/servus'))['phase']
        if phase=='ready_to_switch':recover_old()
        elif phase=='verifying':
            verify_release_attestation();finish_verified()
        else:raise UpgradeError('This recovery phase requires manual investigation')
        return
    verify_release_attestation()
    run_upgrade()


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('Upgrade halted; inspect its root-owned recovery state before continuing.',file=sys.stderr)
        raise SystemExit(1)
