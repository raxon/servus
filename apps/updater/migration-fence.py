#!/usr/bin/python3 -I
"""Verify a durable fence around the original data during migration startup.

The coordinator must first stop and remove the validated legacy containers and
protect the original data directory as root:root 0700. It must also preserve
the original ownership and recovery information before making those changes.
This module checks and records that state; it does not perform those steps.
"""
import json
import os
import re
import stat
import sys


class MigrationFenceError(Exception):
    pass


class MigrationFence:
    def __init__(self,journal,operation,active_env,source,old_ids,supervisor,daemon,adoption,quiescence,docker):
        self.journal,self.operation,self.active_env=journal,operation,active_env
        self.source,self.old_ids=source,old_ids
        self.supervisor,self.daemon,self.adoption=supervisor,daemon,adoption
        self.quiescence,self.docker=quiescence,docker

    def _check(self,operation,install_lock):
        if sys.platform!='linux' or os.geteuid()!=0 or not sys.flags.isolated:
            raise MigrationFenceError('Isolated Linux root is required')
        s=self.supervisor
        if operation!=self.operation or not s._uuid4(operation):raise MigrationFenceError('Invalid migration operation')
        if (not isinstance(self.source,str) or not self.source.startswith('/') or self.source=='/' or os.path.normpath(self.source)!=self.source or
            not isinstance(self.old_ids,dict) or set(self.old_ids)!={'api','agent','worker'} or
            any(not isinstance(value,str) or not re.fullmatch(r'[a-f0-9]{64}',value) for value in self.old_ids.values()) or
            len(set(self.old_ids.values()))!=3):raise MigrationFenceError('Invalid legacy identity')
        policy_path,accepted,approved,binding=self.adoption._binding(self.journal,operation,self.active_env,s,self.daemon)
        if self.source==approved.data_dir or self.source.startswith(approved.data_dir+'/') or approved.data_dir.startswith(self.source+'/'):
            raise MigrationFenceError('Migration data paths overlap')
        directory=s._trusted_directory(approved.install_dir,0o700)
        try:
            expected=s._open_root_file(directory,'install.lock',0o600)
            try:
                a,b=os.fstat(install_lock),os.fstat(expected)
                if (a.st_dev,a.st_ino)!=(b.st_dev,b.st_ino):raise MigrationFenceError('Installation lock does not match')
                s._assert_exclusive_flock(install_lock)
            finally:os.close(expected)
        finally:os.close(directory)
        self.quiescence.ensure_host_namespaces()
        source_fd=s._trusted_directory(self.source,0o700)
        try:
            info=os.fstat(source_fd)
            if (info.st_uid,info.st_gid,stat.S_IMODE(info.st_mode))!=(0,0,0o700):
                raise MigrationFenceError('Original data is not protected')
            identity=(info.st_dev,info.st_ino)
            self.quiescence.ensure_no_mount_aliases(self.docker,self.source)
            self.quiescence.ensure_no_open_data(self.source)
            try:ids=self.docker.call('ps','-aq','--no-trunc').decode('ascii').splitlines()
            except (UnicodeError,ValueError):raise MigrationFenceError('Container inventory is invalid') from None
            if len(ids)!=len(set(ids)) or not all(re.fullmatch(r'[a-f0-9]{64}',item) for item in ids):
                raise MigrationFenceError('Container inventory is invalid')
            if set(self.old_ids.values()).intersection(ids):raise MigrationFenceError('Legacy containers are still present')
            items=self.docker.inspect(*ids) if ids else []
            if (not isinstance(items,list) or len(items)!=len(ids) or any(not isinstance(item,dict) for item in items) or
                {item.get('Id') for item in items}!=set(ids)):raise MigrationFenceError('Container inspection is invalid')
            for item in items:
                mounts=item.get('Mounts')
                if not isinstance(mounts,list):raise MigrationFenceError('Container mounts are unavailable')
                for mount in mounts:
                    if not isinstance(mount,dict) or not isinstance(mount.get('Source'),str) or not mount['Source'].startswith('/'):
                        raise MigrationFenceError('Container mounts are unavailable')
                    path=os.path.realpath(mount['Source'])
                    if path==self.source or path.startswith(self.source+'/') or self.source.startswith(path.rstrip('/')+'/'):
                        raise MigrationFenceError('A container can access original data')
            after=os.fstat(source_fd)
            named=os.stat(self.source,follow_symlinks=False)
            if ((after.st_dev,after.st_ino)!=(named.st_dev,named.st_ino) or
                (after.st_dev,after.st_ino)!=identity or (after.st_uid,after.st_gid,stat.S_IMODE(after.st_mode))!=(0,0,0o700)):
                raise MigrationFenceError('Original data fence changed')
        finally:os.close(source_fd)
        if self.adoption._binding(self.journal,operation,self.active_env,s,self.daemon)!=(policy_path,accepted,approved,binding):
            raise MigrationFenceError('Approved release changed')
        return (*binding,policy_path,accepted,self.active_env,self.source,json.dumps(self.old_ids,sort_keys=True,separators=(',',':')),*identity)

    def record(self,operation,install_lock):
        """Record the fenced source identity; interrupted operations need recovery."""
        proof=self._check(operation,install_lock);db=self.journal.db
        db.execute('BEGIN IMMEDIATE')
        try:
            if self._check(operation,install_lock)!=proof:raise MigrationFenceError('Migration fence changed')
            db.execute("CREATE TABLE IF NOT EXISTS legacy_migration_fences (operation_id TEXT PRIMARY KEY, preparation_id TEXT NOT NULL, attempt_id TEXT NOT NULL, nonce TEXT NOT NULL, root_digest TEXT NOT NULL, config_digest TEXT NOT NULL, policy_path TEXT NOT NULL, accepted_env TEXT NOT NULL, active_env TEXT NOT NULL, source TEXT NOT NULL, old_ids TEXT NOT NULL, source_dev INTEGER NOT NULL, source_ino INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('fenced','recovery_required'))) ")
            if db.execute('SELECT 1 FROM legacy_migration_fences LIMIT 1').fetchone():raise MigrationFenceError('Existing migration requires recovery')
            db.execute("INSERT INTO legacy_migration_fences VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'fenced')",(operation,*proof))
            db.execute('COMMIT')
        except BaseException:
            if db.in_transaction:db.execute('ROLLBACK')
            raise

    def assert_locked(self,operation,install_lock):
        """Recheck the persisted fence while holding the installation lock."""
        proof=self._check(operation,install_lock)
        try:row=self.journal.db.execute('SELECT preparation_id,attempt_id,nonce,root_digest,config_digest,policy_path,accepted_env,active_env,source,old_ids,source_dev,source_ino,state FROM legacy_migration_fences WHERE operation_id=?',(operation,)).fetchone()
        except Exception as error:raise MigrationFenceError('Migration fence is unavailable') from error
        if row!=(*proof,'fenced'):raise MigrationFenceError('Migration fence does not match')
