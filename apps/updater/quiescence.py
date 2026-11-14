"""Host visibility checks for a stopped Servus control plane.

These checks do not themselves prevent writers and must run inside a protected
maintenance window. The caller must also inspect Docker and durable operations.
"""

import os
import pathlib
import re
import json


class QuiescenceError(Exception):
    pass


def ensure_no_other_data_mounts(docker, expected, data_dir, *, trusted_ingress=None):
    """Inspect all containers; only a separately approved ingress may hold Docker's socket."""
    if not isinstance(expected, set) or len(expected) != 3 or not all(re.fullmatch(r'[a-f0-9]{64}', item) for item in expected):
        raise QuiescenceError('Invalid control-plane container inventory')
    if trusted_ingress is not None and (not isinstance(trusted_ingress, tuple) or len(trusted_ingress) != 4 or
        not all(isinstance(value, str) and value for value in trusted_ingress) or
        not re.fullmatch(r'[a-f0-9]{64}', trusted_ingress[0]) or
        not re.fullmatch(r'sha256:[a-f0-9]{64}', trusted_ingress[3])):
        raise QuiescenceError('Invalid trusted ingress identity')
    ids = docker.call('ps', '-aq', '--no-trunc').decode('ascii').splitlines()
    if (len(ids) != len(set(ids)) or not expected.issubset(ids) or
        not all(re.fullmatch(r'[a-f0-9]{64}', item) for item in ids)):
        raise QuiescenceError('Container inventory is unavailable')
    items = docker.inspect(*ids)
    if (not isinstance(items, list) or len(items) != len(ids) or
        {item.get('Id') for item in items if isinstance(item, dict)} != set(ids)):
        raise QuiescenceError('Container inspection is unavailable')
    data = os.path.realpath(data_dir)
    socket_path = os.path.realpath('/var/run/docker.sock')
    for item in items:
        mounts = item.get('Mounts')
        if not isinstance(mounts, list) or any(not isinstance(mount, dict) or not isinstance(mount.get('Source'), str) or not mount['Source'].startswith('/') for mount in mounts):
            raise QuiescenceError('Container mounts are unavailable')
        if item['Id'] in expected:
            state = item.get('State')
            if (not isinstance(state, dict) or state.get('Running') is not False or
                state.get('Paused') is not False or state.get('Restarting') is not False or
                sum(os.path.realpath(mount['Source']) == data and mount.get('RW') is True for mount in mounts) != 1):
                raise QuiescenceError('Control-plane container is not stopped or changed')
        if item['Id'] not in expected:
            host = item.get('HostConfig') or {}; config = item.get('Config') or {}; labels = config.get('Labels') or {}
            if (host.get('Privileged') is not False or host.get('PidMode') == 'host' or
                host.get('CapAdd') not in (None, []) or host.get('Devices') not in (None, []) or
                host.get('DeviceRequests') not in (None, [])):
                raise QuiescenceError('Unsupported external container privileges')
            for mount in mounts:
                source = mount.get('Source')
                if not isinstance(source, str) or not source:
                    continue
                source = os.path.realpath(source)
                if socket_path == source or socket_path.startswith(source.rstrip('/') + '/'):
                    identity = (item['Id'], labels.get('com.docker.swarm.service.name'), config.get('Image'), item.get('Image'))
                    if not (trusted_ingress is not None and identity == trusted_ingress and source == socket_path and mount.get('RW') is False):
                        raise QuiescenceError('Unexpected container can access Docker API')
        for mount in mounts:
            source = mount.get('Source')
            if not isinstance(source, str) or not source:
                continue
            source = os.path.realpath(source)
            if _overlap(source, data) and (item['Id'] not in expected or source != data or mount.get('RW') is not True):
                raise QuiescenceError('Unexpected container can access panel data')


def ensure_no_mount_aliases(docker, data_dir):
    if os.stat('/proc/1/ns/mnt').st_ino != os.stat('/proc/self/ns/mnt').st_ino:
        raise QuiescenceError('Host mount namespace is required')
    check_mount_topology(data_dir, pathlib.Path('/proc/self/mountinfo').read_text())
    names = docker.call('volume', 'ls', '-q').decode('utf-8').splitlines()
    if not names:
        return
    try:
        volumes = json.loads(docker.call('volume', 'inspect', *names))
    except (ValueError, UnicodeError):
        raise QuiescenceError('Volume inventory is unavailable') from None
    if not isinstance(volumes, list) or len(volumes) != len(names):
        raise QuiescenceError('Volume inventory is unavailable')
    for volume in volumes:
        if not isinstance(volume, dict) or volume.get('Driver') != 'local' or volume.get('Options') not in (None, {}):
            raise QuiescenceError('Unsupported volume topology')


def ensure_no_uid_writers(source_uid, *, proc=pathlib.Path('/proc')):
    """Reject processes with the panel owner's real, effective, saved or filesystem UID."""
    if type(source_uid) is not int or source_uid <= 0:
        raise QuiescenceError('Invalid panel owner')
    try:
        processes = list(proc.iterdir())
    except OSError:
        raise QuiescenceError('Process inventory is unavailable') from None
    for item in processes:
        if not item.name.isdecimal(): continue
        try: lines=(item/'status').read_text().splitlines()
        except FileNotFoundError: continue
        except OSError: raise QuiescenceError('Process credentials could not be inspected') from None
        uid=[line for line in lines if line.startswith('Uid:')]
        if len(uid)!=1: raise QuiescenceError('Process credentials are unavailable')
        try: values=[int(value) for value in uid[0].split()[1:]]
        except ValueError: raise QuiescenceError('Process credentials are invalid') from None
        if len(values)!=4: raise QuiescenceError('Process credentials are invalid')
        if source_uid in values:
            raise QuiescenceError('A panel-owner process can write panel data')


def _overlap(left, right):
    def within(child,parent): return child == parent or child.startswith(parent.rstrip('/') + '/')
    return within(left,right) or within(right,left)


def check_mount_topology(data_dir, mountinfo):
    """Reject nested mounts and other mounts aliasing the data directory."""
    def unescape(value):
        def replace(match):
            escapes={'040':' ','011':'\t','012':'\n','134':'\\'}
            if match.group(1) not in escapes: raise QuiescenceError('Invalid mount topology')
            return escapes[match.group(1)]
        return re.sub(r'\\([0-7]{3})',replace,value)
    data=os.path.normpath(str(data_dir)); entries=[]
    if not data.startswith('/') or data=='/': raise QuiescenceError('Invalid data directory')
    for line in mountinfo.splitlines():
        before,separator,after=line.partition(' - ')
        fields=before.split()
        if not separator or len(fields)<6 or not re.fullmatch(r'[0-9]+:[0-9]+',fields[2]):
            raise QuiescenceError('Invalid mount topology')
        root,point=unescape(fields[3]),unescape(fields[4])
        filesystem=after.split()[0] if after.split() else ''
        if not root.startswith('/') and filesystem=='nsfs': root=None
        if ((root is not None and (not root.startswith('/') or os.path.normpath(root)!=root)) or
                not point.startswith('/') or os.path.normpath(point)!=point):
            raise QuiescenceError('Invalid mount topology')
        entries.append((fields[2],root,point))
    candidates=[entry for entry in entries if data==entry[2] or data.startswith(entry[2].rstrip('/')+'/')]
    if not candidates: raise QuiescenceError('Data mount is unavailable')
    device,root,point=max(candidates,key=lambda entry:len(entry[2]))
    if root is None: raise QuiescenceError('Unsupported data filesystem')
    relative=os.path.relpath(data,point)
    filesystem_data=os.path.normpath(os.path.join(root,relative))
    for other_device,other_root,other_point in entries:
        if other_point != data and other_point.startswith(data.rstrip('/')+'/'):
            raise QuiescenceError('Nested data mount is unsupported')
        is_ancestor=data==other_point or data.startswith(other_point.rstrip('/')+'/')
        if not is_ancestor and other_device==device and (other_root is None or _overlap(other_root,filesystem_data)):
            raise QuiescenceError('Data mount alias is unsupported')


def ensure_host_namespaces():
    """Reject containers and namespace views that hide host resource limits."""
    try:
        if pathlib.Path('/proc/1/comm').read_text().strip()!='systemd':
            raise QuiescenceError('A host systemd environment is required')
        for namespace in ('pid','mnt','cgroup'):
            if os.stat('/proc/1/ns/'+namespace).st_ino != os.stat('/proc/self/ns/'+namespace).st_ino:
                raise QuiescenceError('Host namespaces are required')
    except OSError: raise QuiescenceError('Host namespace verification failed') from None


def ensure_no_open_data(data_dir, *, proc=pathlib.Path('/proc'), own_pid=None):
    """Fail if another visible host process retains an open data handle."""
    data=os.path.realpath(data_dir); own_pid=os.getpid() if own_pid is None else own_pid
    try: processes=list(proc.iterdir())
    except OSError: raise QuiescenceError('Process inventory is unavailable') from None
    for process in processes:
        if not process.name.isdecimal() or int(process.name)==own_pid: continue
        try:
            descriptors=list((process/'fd').iterdir())
            maps=(process/'maps').read_text()
        except FileNotFoundError:
            continue
        except (OSError,UnicodeError):
            raise QuiescenceError('Process inventory is unavailable') from None
        for entry in ('cwd','root'):
            try: location=os.readlink(process/entry).removesuffix(' (deleted)')
            except FileNotFoundError: continue
            except OSError: raise QuiescenceError('Process inventory is unavailable') from None
            if location==data or location.startswith(data+'/'):
                raise QuiescenceError('A process is rooted in panel data')
        for descriptor in descriptors:
            try: target=os.readlink(descriptor)
            except FileNotFoundError: continue
            except OSError: raise QuiescenceError('Process inventory is unavailable') from None
            target=target.removesuffix(' (deleted)')
            if target.startswith('/') and (target==data or target.startswith(data+'/')):
                raise QuiescenceError('A process still holds panel data')
        for line in maps.splitlines():
            fields=line.split(maxsplit=5)
            if len(fields)==6:
                path=fields[5].removesuffix(' (deleted)')
                if path==data or path.startswith(data+'/'):
                    raise QuiescenceError('A process still maps panel data')
