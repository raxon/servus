#!/usr/bin/python3 -I
"""Internal capture primitive; it does not authorize or publish backups.

A future trusted coordinator MUST exclude all writers and mount changes for
this entire operation. Open descriptors and this module's checks do not prove
quiescence. A dedicated unprivileged child reads the application-owned source;
the privileged process never follows source file paths. The caller controls
staging, cleanup and publication, including partial staging after failures or
SIGKILL. Cgroup namespaces can hide tighter ancestor limits; the coordinator
must provision memory. Capture requires the initial cgroup namespace and a
cgroup v2 mount exposing its root; a private cgroup namespace or a subtree-only
mount is rejected because it can hide ancestor limits. Anonymous memory and memfd
can be swapped; the coordinator must
require encrypted swap or disable it if plaintext swap is unacceptable.
There is deliberately no CLI.
"""
import base64
import binascii
import ctypes
import hashlib
from contextlib import closing
import grp
import json
import os
import re
import signal
import socket
import sqlite3
import stat
import struct
import subprocess
import sys
import time

UUID = re.compile(r'^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$', re.I)
MAX_FILE = 1024 * 1024
MAX_DATABASE = 64 * 1024 ** 2
MEMORY_RESERVE = 512 * 1024 ** 2
MAX_SECRETS = 4096
MAX_TOTAL = 32 * 1024 * 1024
NODE_VERIFY = r'''const {createDecipheriv}=require('node:crypto');
let text='';process.stdin.setEncoding('utf8');process.stdin.on('data',v=>text+=v);process.stdin.on('end',()=>{try{const x=JSON.parse(text);const k=Buffer.from(x.key,'hex');for(const s of x.sealed){const b=Buffer.from(s.value,'base64');const d=createDecipheriv('aes-256-gcm',k,b.subarray(0,12));d.setAAD(Buffer.from('panel-secret-v1'));d.setAuthTag(b.subarray(12,28));const p=Buffer.concat([d.update(b.subarray(28)),d.final()]);if(s.json||s.git){const j=JSON.parse(p.toString('utf8'));if(!j||typeof j!=='object'||Array.isArray(j))throw Error();if(s.git){if(Object.keys(j).sort().join(',')!=='kind,repository,serviceId,token,username'||j.kind!=='git-credential-v1'||typeof j.token!=='string'||!j.token||j.token.length>4096||/[\x00-\x20\x7f]/.test(j.token)||!Array.isArray(s.git)||!s.git.length)throw Error();for(const e of s.git){const u=new URL(e.repository);if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash||u.href!==e.repository||j.serviceId!==e.serviceId||j.repository!==e.repository||j.username!==e.username)throw Error();}}}}process.stdout.write('ok');}catch{process.exitCode=1;}});'''

PANEL_SCHEMA = {
 'users': {'id','email','password_hash','role','created_at'},
 'sessions': {'token_hash','user_id','csrf_token','expires_at','absolute_expires_at'},
 'projects': {'id','name','description','created_at','deleted_at','display_name'},
 'memberships': {'project_id','user_id','role'},
 'services': {'id','project_id','name','image','port','hostname','replicas','revision','deployed_revision','state','last_error','created_at','updated_at','config','deleted_at','display_name','display_hostname','source_commit','image_digest'},
 'actions': {'id','project_id','service_id','actor_id','type','status','phase','error','created_at','updated_at','finished_at'},
 'jobs': {'id','action_id','service_id','snapshot','status','attempts','worker_id','lease_until','created_at'},
 'action_events': {'id','action_id','sequence','level','message','created_at'},
 'idempotency': {'actor_id','key','request_hash','action_id'},
 'service_secret_refs': {'reference','service_id'},
 'domain_reservations': {'hostname','service_id'},
 'audit_events': {'id','actor_id','operation','resource_id','created_at'},
 'local_credentials': {'user_id','password_hash'},
 'external_identities': {'issuer','subject','user_id'},
 'central_sessions': {'token_hash'},
 'central_config': {'id','issuer','client_id','client_secret','callback_url','revoke_token'},
 'central_pending_revocations': {'client_id','service_origin','revoke_token'},
 'central_pairings': {'id','service_url','callback_url','secret','actor_id','expires_at','redeemed_credentials'},
 'central_invitations': {'token_hash','email','actor_id','expires_at','used_at'},
 'central_transactions': {'state_hash','cookie_hash','verifier','nonce','invitation_hash','expires_at','link_user_id','link_session_hash'},
 'central_link_proofs': {'token_hash','user_id','session_hash','issuer','subject','expires_at'},
}
AGENT_SCHEMA = {'operations': {'id','request_hash','state','response','updated_at','previous_spec','previous_recorded','target_spec','operation_stage','previous_error','service_id'}}
AGENT_RESTORE_SCHEMA = {**AGENT_SCHEMA, 'restore_operations': {'id','service_id','kind','archive_sha256','phase','updated_at'}}
AGENT_SWITCH_OLD_SCHEMA = {**AGENT_RESTORE_SCHEMA, 'restore_switch_intents': {'id','service_id','service_version','sealed_plan','created_at'}}
AGENT_SWITCH_SCHEMA = {**AGENT_RESTORE_SCHEMA, 'restore_switch_intents': {'id','service_id','service_version','sealed_plan','created_at','stage'}}
AGENT_RETAINED_COLUMNS = {'operation_id','service_id','volume_name','reason','created_at'}
AGENT_BINDING_COLUMNS = {'service_id','operation_id','volume_name','kind','created_at'}

class CaptureError(Exception): pass

def _dir(fd, owner, mode):
    info = os.fstat(fd)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != owner or stat.S_IMODE(info.st_mode) != mode:
        raise CaptureError('Unsafe capture directory')
    return info

def _file(directory, name, owner, dev, max_size=MAX_FILE, modes=(0o600,)):
    if '/' in name or name in ('', '.', '..'): raise CaptureError('Invalid inventory name')
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=directory)
    try:
        info = os.fstat(fd); current = os.stat(name, dir_fd=directory, follow_symlinks=False)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != owner or info.st_dev != dev or
            stat.S_IMODE(info.st_mode) not in modes or info.st_nlink != 1 or info.st_size > max_size or
            (info.st_dev, info.st_ino) != (current.st_dev, current.st_ino)):
            raise CaptureError('Unsafe inventory file')
        return fd, info
    except BaseException: os.close(fd); raise

def _read(fd, limit=MAX_FILE):
    data = bytearray()
    while len(data) <= limit:
        chunk = os.read(fd, min(65536, limit + 1 - len(data)))
        if not chunk: return bytes(data)
        data.extend(chunk)
    raise CaptureError('Inventory limit exceeded')

def _write(directory, name, data):
    fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=directory)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'wb', closefd=False) as stream:
            stream.write(data); stream.flush(); os.fsync(fd)
    finally: os.close(fd)

def _child_dir(parent, name, owner, dev):
    fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent)
    try:
        info = _dir(fd, owner, 0o700)
        if info.st_dev != dev: raise CaptureError('Inventory crosses a filesystem')
        return fd
    except BaseException: os.close(fd); raise

def _cgroup_v2_headroom(mountpoint, relative, *, actual_root=False):
    # Read all visible ancestors: each one's current value includes siblings.
    parts=relative.split('/') if relative else []
    if any(not part or part in ('.','..') for part in parts): raise CaptureError('Invalid cgroup path')
    remaining=None
    for depth in range(len(parts),-1,-1):
        directory=os.path.join(mountpoint,*parts[:depth])
        limit=usage=None
        try:
            with open(os.path.join(directory,'memory.max'),encoding='ascii') as f: limit=f.read().strip()
        except FileNotFoundError: pass
        try:
            with open(os.path.join(directory,'memory.current'),encoding='ascii') as f: usage=int(f.read().strip())
        except FileNotFoundError: pass
        if limit is None and usage is None and depth==0 and actual_root and os.path.isdir(directory): continue
        if limit is None or usage is None: raise CaptureError('Cannot check cgroup memory limits')
        if usage<0: raise CaptureError('Invalid cgroup memory usage')
        if limit!='max':
            value=int(limit)
            if value<0: raise CaptureError('Invalid cgroup memory limit')
            headroom=max(0,value-usage)
            remaining=headroom if remaining is None else min(remaining,headroom)
    return remaining

def _visible_cgroup_v2():
    with open('/proc/self/cgroup',encoding='utf-8') as f:
        paths=[line.strip().split(':',2)[2] for line in f if line.startswith('0::')]
    if len(paths)!=1 or not paths[0].startswith('/'): raise CaptureError('Cannot locate cgroup v2')
    path=paths[0]
    def unescape(value): return re.sub(r'\\([0-7]{3})',lambda match:chr(int(match.group(1),8)),value)
    candidates=[]
    with open('/proc/self/mountinfo',encoding='utf-8') as f:
        for line in f:
            fields=line.split()
            if '-' not in fields: continue
            separator=fields.index('-')
            if separator+1>=len(fields) or fields[separator+1]!='cgroup2' or len(fields)<6: continue
            root,mount=unescape(fields[3]),unescape(fields[4])
            if not root.startswith('/') or not mount.startswith('/'): continue
            if root=='/': relative=path.lstrip('/')
            elif path==root: relative=''
            elif path.startswith(root.rstrip('/')+'/'): relative=path[len(root.rstrip('/'))+1:]
            else: continue
            # Linux reserves this inode for the initial cgroup namespace.
            # A namespace-relative '/' can hide host ancestors, so it is not
            # sufficient evidence of the actual root cgroup by itself.
            initial_namespace=os.stat('/proc/self/ns/cgroup').st_ino==0xEFFFFFFB
            candidates.append((len(root),mount,relative,root=='/' and initial_namespace))
    if not candidates: raise CaptureError('Cannot locate cgroup v2 mount')
    # The broadest mount exposes the greatest number of ancestors.
    _,mount,relative,actual_root=min(candidates,key=lambda item:item[0])
    return mount,relative,actual_root

def _memory_headroom(size):
    # Availability can change concurrently. The coordinator must provision
    # enough memory and prevent concurrent workloads from exhausting it.
    needed = MEMORY_RESERVE + 4 * size
    try:
        with open('/proc/meminfo', encoding='ascii') as info:
            available = next(int(line.split()[1]) * 1024 for line in info if line.startswith('MemAvailable:'))
        mount,relative,actual_root=_visible_cgroup_v2()
        if not actual_root: raise CaptureError('Cannot verify complete cgroup ancestry')
        cgroup_available=_cgroup_v2_headroom(mount,relative,actual_root=actual_root)
        if cgroup_available is not None: available=min(available,cgroup_available)
    except (OSError, ValueError, StopIteration, IndexError): raise CaptureError('Cannot check available memory') from None
    if available < needed: raise CaptureError('Insufficient memory for SQLite capture')

def _database_to_temp(source, name, owner, dev, temp, deadline):
    source_file, original = _file(source, name, owner, dev, MAX_DATABASE, (0o600, 0o644))
    sidecars = []
    try:
        for suffix in ('-wal', '-shm', '-journal'):
            try: item, _ = _file(source, name + suffix, owner, dev, MAX_DATABASE, (0o600, 0o644))
            except FileNotFoundError: continue
            sidecars.append(item)
        source_db = sqlite3.connect(f'file:/proc/self/fd/{source}/{name}?mode=ro', uri=True, timeout=2)
        try:
            pages = source_db.execute('PRAGMA page_count').fetchone()[0]
            page_size = source_db.execute('PRAGMA page_size').fetchone()[0]
            if pages * page_size > MAX_DATABASE: raise CaptureError('SQLite capture exceeds memory limit')
            _memory_headroom(pages * page_size)
            destination_db = sqlite3.connect(':memory:')
            try:
                def progress(_status, _remaining, _total):
                    if time.monotonic() > deadline: raise CaptureError('SQLite capture timed out')
                source_db.backup(destination_db, pages=128, progress=progress, sleep=0.01)
                if destination_db.execute('PRAGMA integrity_check').fetchall() != [('ok',)] or destination_db.execute('PRAGMA foreign_key_check').fetchone() is not None:
                    raise CaptureError('SQLite integrity check failed')
                data = destination_db.serialize()
                if len(data) > MAX_DATABASE: raise CaptureError('SQLite capture exceeds memory limit')
            finally: destination_db.close()
        finally: source_db.close()
        # memfd and the in-memory database disappear when the reader dies,
        # including on SIGKILL. They never create a named temporary file.
        dst_fd = os.memfd_create('servus-sqlite-capture', os.MFD_CLOEXEC)
        view = memoryview(data)
        while view:
            written = os.write(dst_fd, view)
            if written <= 0: raise CaptureError('Cannot write SQLite capture')
            view = view[written:]
        del view, data
        current = os.stat(name, dir_fd=source, follow_symlinks=False)
        if (original.st_dev, original.st_ino) != (current.st_dev, current.st_ino): raise CaptureError('SQLite inventory changed')
        os.lseek(dst_fd,0,os.SEEK_SET)
        result=dst_fd; dst_fd=None
        return result
    finally:
        if 'dst_fd' in locals() and dst_fd is not None: os.close(dst_fd)
        os.close(source_file)
        for fd in sidecars: os.close(fd)

def _send_file(sock, name, fd, size):
    meta = json.dumps({'name':name,'size':size}, separators=(',', ':')).encode()
    sock.sendall(struct.pack('!I', len(meta)) + meta)
    remaining=size
    while remaining:
        data=os.read(fd,min(65536,remaining))
        if not data: raise CaptureError('Inventory file changed')
        sock.sendall(data); remaining-=len(data)
    if os.read(fd,1): raise CaptureError('Inventory file changed')

def _parent_death_guard(parent_pid):
    libc=ctypes.CDLL(None,use_errno=True)
    if libc.prctl(1,signal.SIGKILL,0,0,0)!=0 or os.getppid()!=parent_pid:
        raise CaptureError('Reader parent is unavailable')

def _reader(sock, source_fd, source_uid, source_gid, deadline, parent_pid):
    # The child receives no destination or executable descriptors.
    for entry in os.listdir('/proc/self/fd'):
        if entry.isdecimal() and int(entry)>2 and int(entry) not in (source_fd,sock.fileno()):
            try: os.close(int(entry))
            except OSError: pass
    os.setgroups([]); os.setresgid(source_gid,source_gid,source_gid); os.setresuid(source_uid,source_uid,source_uid)
    if os.getresuid() != (source_uid,source_uid,source_uid) or os.getresgid() != (source_gid,source_gid,source_gid): raise CaptureError('Reader privilege drop failed')
    # Linux clears PR_SET_PDEATHSIG when credentials change.
    _parent_death_guard(parent_pid)
    os.umask(0o077); source=_dir(source_fd,source_uid,0o700)
    for name in ('panel.sqlite','agent.sqlite'):
        fd=_database_to_temp(source_fd,name,source_uid,source.st_dev,None,deadline)
        try: _send_file(sock,name,fd,os.fstat(fd).st_size)
        finally: os.close(fd)
    for name in ('secret-key','agent-token'):
        fd,info=_file(source_fd,name,source_uid,source.st_dev)
        try: _send_file(sock,name,fd,info.st_size)
        finally: os.close(fd)
    total=0
    for directory_name in ('secrets','database-roots'):
        try: directory=_child_dir(source_fd,directory_name,source_uid,source.st_dev)
        except FileNotFoundError:
            if directory_name=='database-roots': continue
            raise CaptureError('Secret directory is missing') from None
        try:
            names=os.listdir(directory)
            if len(names)>MAX_SECRETS: raise CaptureError('Inventory limit exceeded')
            for name in sorted(names):
                if not UUID.fullmatch(name): raise CaptureError('Unexpected inventory entry')
                fd,info=_file(directory,name,source_uid,source.st_dev)
                try:
                    total+=info.st_size
                    if total>MAX_TOTAL: raise CaptureError('Inventory limit exceeded')
                    _send_file(sock,f'{directory_name}/{name}',fd,info.st_size)
                finally: os.close(fd)
        finally: os.close(directory)

    sock.sendall(struct.pack('!I',0))

def _receive(sock, size, deadline):
    result=bytearray()
    while len(result)<size:
        remaining=deadline-time.monotonic()
        if remaining<=0: raise CaptureError('Capture timed out')
        sock.settimeout(remaining)
        try: chunk=sock.recv(min(65536,size-len(result)))
        except OSError: raise CaptureError('Capture stream failed') from None
        if not chunk: raise CaptureError('Capture stream ended unexpectedly')
        result.extend(chunk)
    return bytes(result)

def _collect(sock,dest_fd,deadline):
    children={}
    try:
        for name in ('secrets','database-roots'):
            os.mkdir(name,0o700,dir_fd=dest_fd)
            children[name]=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=dest_fd)
        seen=set(); total=0
        while True:
            length=struct.unpack('!I',_receive(sock,4,deadline))[0]
            if length==0: break
            if length>512: raise CaptureError('Capture metadata is invalid')
            try: meta=json.loads(_receive(sock,length,deadline))
            except (ValueError,UnicodeError): raise CaptureError('Capture metadata is invalid') from None
            if not isinstance(meta,dict) or set(meta)!={'name','size'} or not isinstance(meta['name'],str) or type(meta['size']) is not int or meta['name'] in seen:
                raise CaptureError('Capture metadata is invalid')
            name,size=meta['name'],meta['size']; seen.add(name)
            if name in ('panel.sqlite','agent.sqlite','secret-key','agent-token'):
                target, leaf=dest_fd,name; limit=MAX_DATABASE if name.endswith('.sqlite') else MAX_FILE
            else:
                parts=name.split('/')
                if len(parts)!=2 or parts[0] not in children or not UUID.fullmatch(parts[1]): raise CaptureError('Capture inventory is invalid')
                target,leaf=children[parts[0]],parts[1]; limit=MAX_FILE; total+=size
                if len(seen)>MAX_SECRETS*2+4 or total>MAX_TOTAL: raise CaptureError('Inventory limit exceeded')
            if size<0 or size>limit: raise CaptureError('Inventory limit exceeded')
            fd=os.open(leaf,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC,0o600,dir_fd=target)
            try:
                remaining=size
                while remaining:
                    data=_receive(sock,min(65536,remaining),deadline)
                    view=memoryview(data)
                    while view:
                        written=os.write(fd,view)
                        if written<=0: raise CaptureError('Capture write failed')
                        view=view[written:]
                    remaining-=len(data)
                os.fsync(fd)
            finally: os.close(fd)
        if not {'panel.sqlite','agent.sqlite','secret-key','agent-token'}.issubset(seen): raise CaptureError('Capture inventory is incomplete')
        for fd in children.values(): os.fsync(fd)
    finally:
        for fd in children.values(): os.close(fd)

def _sealed(value, json_value=False):
    if not isinstance(value,str) or not value.startswith('enc:v1:'): raise CaptureError('Encrypted inventory is invalid')
    encoded=value[7:]
    try: decoded=base64.b64decode(encoded,validate=True)
    except (ValueError,binascii.Error): raise CaptureError('Encrypted inventory is invalid') from None
    if len(decoded)<28 or len(decoded)>MAX_FILE: raise CaptureError('Encrypted inventory is invalid')
    return {'value':encoded,'json':json_value}

def _verify_node(node_fd,key,values):
    info=os.fstat(node_fd)
    if not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or info.st_nlink!=1 or info.st_mode&0o022 or not info.st_mode&0o111:
        raise CaptureError('Node executable is not trusted')
    payload=json.dumps({'key':key,'sealed':values},separators=(',', ':')).encode()
    if len(payload)>MAX_TOTAL: raise CaptureError('Encrypted inventory limit exceeded')
    try:
        proc=subprocess.run([f'/proc/self/fd/{node_fd}','-e',NODE_VERIFY],input=payload,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=20,check=False,pass_fds=(node_fd,),env={'PATH':'/usr/bin:/bin','LANG':'C'},cwd='/')
    except (OSError,subprocess.TimeoutExpired): raise CaptureError('Encryption verification failed') from None
    if proc.returncode!=0 or proc.stdout!=b'ok': raise CaptureError('Encryption verification failed')

def _schema(db,expected,version):
    if db.execute('PRAGMA user_version').fetchone()[0]!=version: raise CaptureError('Unsupported database schema')
    tables={r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")}
    if tables!=set(expected): raise CaptureError('Unsupported database schema')
    for table,cols in expected.items():
        if {r[1] for r in db.execute(f'PRAGMA table_info({table})')}!=cols: raise CaptureError('Unsupported database schema')

def _agent_schema(db):
    has_restore = bool(db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='restore_operations'").fetchone())
    has_switch = bool(db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='restore_switch_intents'").fetchone())
    has_retained = bool(db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='restore_retained_volumes'").fetchone())
    has_bindings = bool(db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='restore_volume_bindings'").fetchone())
    has_upload_locks = bool(db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='restore_upload_locks'").fetchone())
    has_review_phases = bool(db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='restore_review_phases'").fetchone())
    if (has_switch or has_retained or has_bindings or has_upload_locks or has_review_phases) and not has_restore: raise CaptureError('Unsupported database schema')
    switch_columns={r[1] for r in db.execute('PRAGMA table_info(restore_switch_intents)')} if has_switch else set()
    schema=(AGENT_SWITCH_SCHEMA if 'stage' in switch_columns else AGENT_SWITCH_OLD_SCHEMA) if has_switch else AGENT_RESTORE_SCHEMA if has_restore else AGENT_SCHEMA
    if has_retained: schema={**schema,'restore_retained_volumes':AGENT_RETAINED_COLUMNS}
    if has_bindings: schema={**schema,'restore_volume_bindings':AGENT_BINDING_COLUMNS}
    if has_upload_locks: schema={**schema,'restore_upload_locks':{'operation_id','lock_id'}}
    if has_review_phases: schema={**schema,'restore_review_phases':{'operation_id','phase'}}
    _schema(db, schema, 0)
    if not has_restore: return
    for ident, service, kind, digest, phase, updated in db.execute('SELECT id,service_id,kind,archive_sha256,phase,updated_at FROM restore_operations'):
        if phase not in ('completed', 'cancelled'):
            raise CaptureError('Unresolved database restore requires recovery')
        if (not isinstance(ident,str) or not re.fullmatch(r'[a-f0-9]{32}',ident) or
            not isinstance(service,str) or not re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}',service) or
            kind not in ('postgres','mariadb','redis') or not isinstance(digest,str) or not re.fullmatch(r'[a-f0-9]{64}',digest) or
            not isinstance(updated,str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z',updated)):
            raise CaptureError('Database restore journal is invalid')
    if has_upload_locks:
        seen_operations=set();seen_locks=set()
        for ident,lock_id in db.execute('SELECT operation_id,lock_id FROM restore_upload_locks'):
            if (not isinstance(ident,str) or not re.fullmatch(r'[a-f0-9]{32}',ident) or ident in seen_operations or
                not isinstance(lock_id,str) or not re.fullmatch(r'[a-f0-9]{32}',lock_id) or lock_id in seen_locks or
                not db.execute("SELECT 1 FROM restore_operations WHERE id=? AND kind IN ('postgres','mariadb') AND phase IN ('completed','cancelled')",(ident,)).fetchone()):
                raise CaptureError('Upload lock journal is invalid')
            seen_operations.add(ident);seen_locks.add(lock_id)
    if has_review_phases and db.execute('SELECT 1 FROM restore_review_phases LIMIT 1').fetchone():
        raise CaptureError('Restore review journal is invalid')
    if has_switch and db.execute('SELECT 1 FROM restore_switch_intents LIMIT 1').fetchone(): raise CaptureError('Unresolved database restore requires recovery')
    if has_retained:
        seen=set();retained_volumes=set()
        for ident,service,volume,reason,created in db.execute('SELECT operation_id,service_id,volume_name,reason,created_at FROM restore_retained_volumes'):
            if (not isinstance(ident,str) or not re.fullmatch(r'[a-f0-9]{32}',ident) or ident in seen or
                not isinstance(service,str) or not re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}',service) or
                not isinstance(volume,str) or volume in retained_volumes or reason not in ('rollback_candidate','pre_restore_source') or not isinstance(created,str) or
                not re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z',created) or
                not db.execute('SELECT 1 FROM restore_operations WHERE id=? AND service_id=? AND phase=?',(ident,service,'cancelled' if reason=='rollback_candidate' else 'completed')).fetchone()):
                raise CaptureError('Retained database restore volume is invalid')
            if reason=='rollback_candidate' and volume!='panel-restore-'+ident: raise CaptureError('Retained database restore volume is invalid')
            if reason=='pre_restore_source' and volume!='panel-data-'+service+'-database':
                match=re.fullmatch(r'panel-restore-([a-f0-9]{32})',volume)
                if not match or match.group(1)==ident or not db.execute("SELECT 1 FROM restore_operations WHERE id=? AND service_id=? AND phase='completed'",(match.group(1),service)).fetchone(): raise CaptureError('Retained database restore volume is invalid')
            seen.add(ident)
            retained_volumes.add(volume)
    if has_bindings:
        seen_services=set();seen_operations=set();seen_volumes=set()
        for service,ident,volume,kind,created in db.execute('SELECT service_id,operation_id,volume_name,kind,created_at FROM restore_volume_bindings'):
            if (not isinstance(service,str) or not re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}',service) or service in seen_services or
                not isinstance(ident,str) or not re.fullmatch(r'[a-f0-9]{32}',ident) or ident in seen_operations or
                volume!='panel-restore-'+ident or volume in seen_volumes or kind not in ('postgres','mariadb') or
                not isinstance(created,str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z',created) or
                not db.execute("SELECT 1 FROM restore_operations WHERE id=? AND service_id=? AND kind=? AND phase='completed'",(ident,service,kind)).fetchone() or
                not has_retained or volume in retained_volumes or not db.execute("SELECT 1 FROM restore_retained_volumes WHERE operation_id=? AND service_id=? AND reason='pre_restore_source'",(ident,service)).fetchone()):
                raise CaptureError('Database restore volume binding is invalid')
            seen_services.add(service);seen_operations.add(ident);seen_volumes.add(volume)

def _config_references(config, refs, service_id, owners, purposes=None, git_requirements=None):
    if not isinstance(config,dict): raise CaptureError('Service configuration is invalid')
    environment=config.get('environment',[])
    if not isinstance(environment,list): raise CaptureError('Service configuration is invalid')
    for item in environment:
        if not isinstance(item,dict): raise CaptureError('Service configuration is invalid')
        if 'secretRef' in item:
            if not item.get('secret') or not isinstance(item['secretRef'],str): raise CaptureError('Secret reference is invalid')
            reference=item['secretRef']
            if owners.get(reference)!=service_id: raise CaptureError('Secret reference belongs to another service')
            if purposes is not None and purposes.get(reference) not in ('environment','legacy_shared'): raise CaptureError('Secret reference has an invalid purpose')
            refs.add(reference)
    database=config.get('database')
    if database is not None:
        if not isinstance(database,dict): raise CaptureError('Service configuration is invalid')
        if 'passwordSecretRef' in database:
            if not isinstance(database['passwordSecretRef'],str): raise CaptureError('Secret reference is invalid')
            reference=database['passwordSecretRef']
            if owners.get(reference)!=service_id: raise CaptureError('Secret reference belongs to another service')
            if purposes is not None and purposes.get(reference) not in ('database','legacy_shared'): raise CaptureError('Secret reference has an invalid purpose')
            refs.add(reference)
    source=config.get('source')
    if source is not None:
        if not isinstance(source,dict): raise CaptureError('Service configuration is invalid')
        credential=source.get('credential')
        if credential is not None:
            if source.get('type')!='git' or not isinstance(credential,dict) or set(credential)!={'username','secretRef'} or not isinstance(credential['username'],str) or not isinstance(credential['secretRef'],str): raise CaptureError('Git credential reference is invalid')
            reference=credential['secretRef']
            if owners.get(reference)!=service_id or purposes is None or purposes.get(reference)!='git': raise CaptureError('Git credential reference has an invalid purpose')
            repository=source.get('repository')
            if not isinstance(repository,str) or not repository or len(repository)>1000 or not credential['username'] or len(credential['username'])>256 or re.search(r'[\x00-\x20\x7f:=]',credential['username']): raise CaptureError('Git credential reference is invalid')
            if git_requirements is None: raise CaptureError('Git credential validation is unavailable')
            git_requirements.setdefault(reference,set()).add((service_id,repository,credential['username']))
            refs.add(reference)

def _validate_operation_history(panel, agent):
    # A failed operation remains historical evidence. A later full deployment
    # can supersede it only when both durable journals agree on the outcome.
    if panel.execute("SELECT 1 FROM jobs WHERE status NOT IN ('succeeded','failed') OR status IS NULL LIMIT 1").fetchone():
        raise CaptureError('Unresolved panel jobs require recovery')
    if panel.execute("SELECT 1 FROM actions WHERE status NOT IN ('succeeded','failed') OR status IS NULL LIMIT 1").fetchone():
        raise CaptureError('Unresolved panel actions require recovery')
    if agent.execute("SELECT 1 FROM operations WHERE state NOT IN ('succeeded','failed') OR state IS NULL LIMIT 1").fetchone():
        raise CaptureError('Unresolved agent operations require recovery')

    failures = panel.execute("SELECT id,service_id,type,phase,finished_at FROM actions WHERE status='failed'").fetchall()
    failed_jobs = panel.execute("SELECT action_id,service_id,lease_until,snapshot FROM jobs WHERE status='failed'").fetchall()
    failed_agent = agent.execute("SELECT id,service_id FROM operations WHERE state='failed'").fetchall()
    # Unmatched or inconsistent terminal records do not establish a safe state.
    if len(failures) != len(failed_jobs) or len(failures) != len(failed_agent):
        raise CaptureError('Unresolved failed operations require recovery')
    jobs = {action: (service, lease, snapshot) for action, service, lease, snapshot in failed_jobs}
    agents = {action: service for action, service in failed_agent}
    if len(jobs) != len(failures) or len(agents) != len(failures):
        raise CaptureError('Unresolved failed operations require recovery')
    def stateless_snapshot(raw, service):
        try: value = json.loads(raw)
        except (TypeError, ValueError): return False
        return (isinstance(value, dict) and value.get('id') == service and value.get('kind', 'app') == 'app'
                and value.get('mounts', []) == [] and value.get('database') is None)

    for action, service, kind, phase, finished in failures:
        job = jobs.get(action)
        if (not service or kind != 'deploy' or phase != 'failed' or not finished or not job or
                job[:2] != (service, None) or not stateless_snapshot(job[2], service) or agents.get(action) != service):
            raise CaptureError('Unresolved failed operations require recovery')
        candidates = panel.execute("""SELECT a.id,j.snapshot FROM actions a JOIN jobs j ON j.action_id=a.id
            WHERE a.service_id=? AND j.service_id=a.service_id AND a.type='deploy'
              AND a.status='succeeded' AND a.phase='complete' AND j.status='succeeded'
              AND j.lease_until IS NULL AND a.created_at>? AND a.finished_at IS NOT NULL
              AND a.finished_at>=a.created_at""", (service, finished)).fetchall()
        recovered = False
        for candidate, snapshot in candidates:
            if not stateless_snapshot(snapshot, service): continue
            row = agent.execute("SELECT state,service_id,response FROM operations WHERE id=?", (candidate,)).fetchone()
            if not row or row[0] != 'succeeded' or row[1] != service: continue
            try: response = json.loads(row[2])
            except (TypeError, ValueError): continue
            if isinstance(response, dict) and response.get('state') == 'running':
                recovered = True
                break
        if not recovered: raise CaptureError('Unresolved failed operations require recovery')

def _validate_staging(dest_fd,node_fd):
    # Captures are serialized standalone databases, never live WAL databases.
    # A sidecar must not be silently ignored by immutable SQLite reads.
    for name in ('panel.sqlite', 'agent.sqlite'):
        for suffix in ('-wal', '-shm', '-journal'):
            try: os.stat(name+suffix,dir_fd=dest_fd,follow_symlinks=False)
            except FileNotFoundError: continue
            raise CaptureError('Unexpected snapshot database sidecar')
    data={}
    for name in ('secret-key','agent-token'):
        fd,_=_file(dest_fd,name,0,os.fstat(dest_fd).st_dev)
        try: data[name]=_read(fd).decode('ascii')
        finally: os.close(fd)
        if not re.fullmatch(r'[a-f0-9]{64}',data[name]): raise CaptureError('Installation key or token is invalid')
    encrypted=[]; refs=set(); mariadb=set(); git_requirements={}; dev=os.fstat(dest_fd).st_dev
    with closing(sqlite3.connect(f'file:/proc/self/fd/{dest_fd}/panel.sqlite?mode=ro&immutable=1',uri=True)) as db:
        version=db.execute('PRAGMA user_version').fetchone()[0]
        if version==4: _schema(db,PANEL_SCHEMA,4)
        elif version==5: _schema(db,{**PANEL_SCHEMA,'service_secret_refs':PANEL_SCHEMA['service_secret_refs']|{'purpose'}},5)
        else: raise CaptureError('Unsupported database schema')
        owners=dict(db.execute('SELECT reference,service_id FROM service_secret_refs'))
        purposes=dict(db.execute('SELECT reference,purpose FROM service_secret_refs')) if version==5 else None
        if purposes is not None and any(value not in ('unclassified','environment','database','git','legacy_shared') for value in purposes.values()): raise CaptureError('Secret purpose metadata is invalid')
        refs.update(owners)
        for ident,raw,deployed in db.execute('SELECT id,config,deployed_revision FROM services'):
            try: config=json.loads(raw)
            except (TypeError,ValueError): raise CaptureError('Service configuration is invalid') from None
            _config_references(config,refs,ident,owners,purposes,git_requirements)
            if config.get('kind')=='mariadb' and deployed is not None: mariadb.add(ident)
        for ident,raw in db.execute('SELECT service_id,snapshot FROM jobs'):
            try: snapshot=json.loads(raw)
            except (TypeError,ValueError): raise CaptureError('Job snapshot is invalid') from None
            _config_references(snapshot,refs,ident,owners,purposes,git_requirements)
        checks={'central_config':['client_secret','revoke_token'],'central_pending_revocations':['revoke_token'],'central_pairings':['secret','redeemed_credentials'],'central_transactions':['verifier']}
        for table,cols in checks.items():
            for col in cols:
                for (value,) in db.execute(f'SELECT {col} FROM {table} WHERE {col} IS NOT NULL'):
                    encrypted.append(_sealed(value,table=='central_pairings' and col=='redeemed_credentials'))
    with closing(sqlite3.connect(f'file:/proc/self/fd/{dest_fd}/agent.sqlite?mode=ro&immutable=1',uri=True)) as db:
        _agent_schema(db)
        with closing(sqlite3.connect(f'file:/proc/self/fd/{dest_fd}/panel.sqlite?mode=ro&immutable=1',uri=True)) as panel:
            _validate_operation_history(panel, db)
        for (response,) in db.execute('SELECT response FROM operations'):
            try: parsed=json.loads(response)
            except (TypeError,ValueError): raise CaptureError('Agent response is invalid') from None
            if not isinstance(parsed,dict): raise CaptureError('Agent response is invalid')
        for row in db.execute('SELECT previous_spec,target_spec FROM operations'):
            for value in row:
                if value is None or value=='': continue
                if not isinstance(value,str): raise CaptureError('Agent snapshot is invalid')
                if value.startswith('enc:v1:'): encrypted.append(_sealed(value,True))
                else:
                    try: parsed=json.loads(value)
                    except (ValueError,TypeError): raise CaptureError('Agent snapshot is invalid') from None
                    if not isinstance(parsed,dict): raise CaptureError('Agent snapshot is invalid')
    secret_dir=_child_dir(dest_fd,'secrets',0,dev); roots_dir=_child_dir(dest_fd,'database-roots',0,dev)
    try:
        secrets=set(os.listdir(secret_dir)); roots=set(os.listdir(roots_dir))
        if not mariadb.issubset(roots): raise CaptureError('A deployed MariaDB root reference is missing')
        for directory,names in ((secret_dir,secrets),(roots_dir,roots)):
            for name in names:
                fd,_=_file(directory,name,0,dev)
                try: text=_read(fd).decode('ascii')
                finally: os.close(fd)
                if directory==secret_dir:
                    entry=_sealed(text)
                    if name in git_requirements: entry['git']=[{'serviceId':service_id,'repository':repository,'username':username} for service_id,repository,username in sorted(git_requirements[name])]
                    encrypted.append(entry)
                else:
                    if not UUID.fullmatch(text): raise CaptureError('Secret reference is invalid')
                    refs.add(text)
    finally: os.close(secret_dir);os.close(roots_dir)
    if any(not isinstance(ref,str) or not UUID.fullmatch(ref) or ref not in secrets for ref in refs): raise CaptureError('A referenced secret is missing')
    _verify_node(node_fd,data['secret-key'],encrypted)

def _capture_quiescent(source_fd,destination_fd,node_fd,*,source_uid,reader_gid,deadline_seconds=60):
    """Capture to empty root staging after independently verified quiescence.

    The coordinator must choose a non-privileged reader group. Open descriptors
    do not prove absence of writers. This private primitive
    is unsafe without the future coordinator's mechanical exclusivity gate.
    """
    if sys.platform!='linux' or os.geteuid()!=0 or source_uid<=0 or reader_gid!=65534 or not 1<=deadline_seconds<=300: raise CaptureError('Capture environment is invalid')
    try: group_name=grp.getgrgid(reader_gid).gr_name
    except KeyError: raise CaptureError('Reader group is not trusted') from None
    if group_name not in ('nobody','nogroup'): raise CaptureError('Reader group is not trusted')
    source=_dir(source_fd,source_uid,0o700); dest=_dir(destination_fd,0,0o700)
    if (source.st_dev,source.st_ino)==(dest.st_dev,dest.st_ino) or os.listdir(destination_fd): raise CaptureError('Staging directory must be empty and separate')
    # Reject hidden cgroup ancestors before creating the reader or copying data.
    # The reader checks again with the actual database size before each copy.
    try: _memory_headroom(0)
    except MemoryError: raise CaptureError('Cannot check available memory') from None
    deadline=time.monotonic()+deadline_seconds; parent,child=socket.socketpair(); parent_pid=os.getpid(); pid=os.fork()
    if pid==0:
        parent.close()
        try:
            # If the root coordinator dies, do not leave a privileged or
            # unprivileged reader copying installation data in the background.
            _parent_death_guard(parent_pid)
            _reader(child,source_fd,source_uid,reader_gid,deadline,parent_pid); child.close(); os._exit(0)
        except BaseException: child.close(); os._exit(1)
    child.close()
    try:
        _collect(parent,destination_fd,deadline)
        remaining=deadline-time.monotonic()
        while True:
            result,status=os.waitpid(pid,os.WNOHANG)
            if result==pid:
                pid=None
                if not os.WIFEXITED(status) or os.WEXITSTATUS(status)!=0: raise CaptureError('Unprivileged capture failed')
                break
            if remaining<=0: raise CaptureError('Capture timed out')
            time.sleep(min(.02,remaining)); remaining=deadline-time.monotonic()
    finally:
        parent.close()
        if pid is not None:
            try: os.kill(pid,signal.SIGKILL)
            except ProcessLookupError: pass
            os.waitpid(pid,0)
    try: _validate_staging(destination_fd,node_fd)
    except (sqlite3.Error,UnicodeError,OSError): raise CaptureError('Capture validation failed') from None
    manifest={'format':1,'files':{}}
    for name in ('panel.sqlite','agent.sqlite','secret-key','agent-token'):
        fd,_=_file(destination_fd,name,0,dest.st_dev,MAX_DATABASE)
        try:
            digest=hashlib.sha256()
            while chunk:=os.read(fd,65536): digest.update(chunk)
            manifest['files'][name]=digest.hexdigest()
        finally: os.close(fd)
    for name in ('secrets','database-roots'):
        childfd=_child_dir(destination_fd,name,0,dest.st_dev)
        try:
            for item in sorted(os.listdir(childfd)):
                fd,_=_file(childfd,item,0,dest.st_dev)
                try: manifest['files'][f'{name}/{item}']=hashlib.sha256(_read(fd)).hexdigest()
                finally: os.close(fd)
        finally: os.close(childfd)
    _write(destination_fd,'manifest.json',json.dumps(manifest,sort_keys=True,separators=(',', ':')).encode()+b'\n'); os.fsync(destination_fd)
    return manifest
