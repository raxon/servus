#!/usr/bin/python3 -I
"""Stage a verified snapshot for a migration without changing the source data.

The caller must hold the installation lock and exclude unauthorized writers
throughout capture, staging and the handoff to the new generation. This helper
neither authorizes an adoption nor starts containers. An interrupted staging
directory must be inspected by the caller.
"""
import hashlib
import json
import os
import stat
import sys


class RestoreError(Exception):
    pass


def stage(snapshot, digest, parent_path, operation, backup, node_fd, supervisor, coordinator):
    if sys.platform != 'linux' or os.geteuid() != 0 or not sys.flags.isolated:
        raise RestoreError('An isolated Linux root coordinator is required')
    if not supervisor._uuid4(operation):
        raise RestoreError('Invalid migration identity')
    coordinator.verify_snapshot(snapshot, digest, backup, node_fd, supervisor)
    source = supervisor._trusted_directory(snapshot, 0o700)
    parent = target = None
    try:
        src_info = os.fstat(source)
        manifest_fd, _ = backup._file(source, 'manifest.json', 0, src_info.st_dev)
        try:
            raw = backup._read(manifest_fd)
        finally:
            os.close(manifest_fd)
        if 'sha256:' + hashlib.sha256(raw).hexdigest() != digest:
            raise RestoreError('Snapshot manifest changed')
        try:
            manifest = json.loads(raw, object_pairs_hook=coordinator._pairs)
            files = manifest['files']
        except (ValueError, KeyError, TypeError) as error:
            raise RestoreError('Invalid snapshot manifest') from error
        parent = supervisor._trusted_directory(parent_path, 0o711)
        info = os.fstat(parent)
        if info.st_gid != 0:
            raise RestoreError('Unsafe migration parent')
        name = 'restore-' + operation
        os.mkdir(name, 0o700, dir_fd=parent)
        target = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
        os.fchown(target, 0, 0); os.fchmod(target, 0o700); os.fsync(parent)
        for folder in ('secrets', 'database-roots'):
            os.mkdir(folder, 0o700, dir_fd=target)
        def copy_file(source_dir, destination_dir, filename, expected, limit):
            incoming, _ = backup._file(source_dir, filename, 0, src_info.st_dev, limit)
            outgoing = None
            try:
                outgoing = os.open(filename, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=destination_dir)
                os.fchown(outgoing, 0, 0); os.fchmod(outgoing, 0o600)
                hasher = hashlib.sha256(); total = 0
                with os.fdopen(outgoing, 'wb', closefd=False) as stream:
                    while chunk := os.read(incoming, 65536):
                        total += len(chunk)
                        if total > limit: raise RestoreError('Snapshot file is too large')
                        hasher.update(chunk); stream.write(chunk)
                    stream.flush(); os.fsync(outgoing)
                if hasher.hexdigest() != expected:
                    raise RestoreError('Snapshot file changed')
            finally:
                if outgoing is not None: os.close(outgoing)
                os.close(incoming)
        for relative, checksum in files.items():
            parts = relative.split('/')
            src = dst = None
            try:
                if len(parts) == 2:
                    src = backup._child_dir(source, parts[0], 0, src_info.st_dev)
                    dst = os.open(parts[0], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=target)
                copy_file(src if src is not None else source, dst if dst is not None else target,
                          parts[-1], checksum, backup.MAX_DATABASE if relative.endswith('.sqlite') else backup.MAX_FILE)
            finally:
                if dst is not None: os.close(dst)
                if src is not None: os.close(src)
        copy_file(source, target, 'manifest.json', digest.removeprefix('sha256:'), backup.MAX_FILE)
        for folder in ('secrets', 'database-roots'):
            fd = os.open(folder, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=target)
            try: os.fsync(fd)
            finally: os.close(fd)
        os.fsync(target)
        destination = os.path.join(parent_path, name)
        coordinator.verify_snapshot(destination, digest, backup, node_fd, supervisor)
        # The caller must maintain writer exclusion while ownership transfers.
        # The root-owned parent permits traversal but not directory listing.
        for relative in files:
            parts = relative.split('/')
            child = None
            try:
                if len(parts) == 2: child = os.open(parts[0], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=target)
                fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=child if child is not None else target)
                try: os.fchown(fd, 1000, 1000); os.fsync(fd)
                finally: os.close(fd)
            finally:
                if child is not None: os.close(child)
        for folder in ('secrets', 'database-roots'):
            fd = os.open(folder, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=target)
            try: os.fchown(fd, 1000, 1000); os.fsync(fd)
            finally: os.close(fd)
        os.unlink('manifest.json', dir_fd=target)
        os.fchown(target, 1000, 1000); os.fsync(target); os.fsync(parent)
        return destination
    finally:
        for fd in (target, parent, source):
            if fd is not None: os.close(fd)
