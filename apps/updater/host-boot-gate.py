#!/usr/bin/python3 -I
"""Fail closed when a host runtime exchange needs recovery at startup.

This check is not yet wired into systemd. It does not modify the journal or
perform recovery; a separate trusted recovery service must resolve the state.
"""
import os
import re
import sqlite3
import stat
import sys
import urllib.parse


class BootGateError(Exception):
    pass


def assert_safe(state_dir):
    """Allow startup only for a protected journal with no unfinished host work."""
    if (sys.platform!='linux' or os.geteuid()!=0 or not sys.flags.isolated or
        not isinstance(state_dir,str) or not os.path.isabs(state_dir) or os.path.normpath(state_dir)!=state_dir or state_dir=='/'):
        raise BootGateError('Invalid boot gate context')
    directory=os.open('/',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC)
    try:
        for name in state_dir.split('/')[1:]:
            child=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=directory)
            os.close(directory);directory=child
            info=os.fstat(directory)
            if info.st_uid!=0 or info.st_mode & 0o022:raise BootGateError('Unsafe state directory ancestry')
        info=os.fstat(directory)
        if info.st_gid!=0 or stat.S_IMODE(info.st_mode)!=0o700:raise BootGateError('Unsafe state directory')
        fd=os.open('journal.sqlite',os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC,dir_fd=directory)
        try:
            before=os.fstat(fd);named=os.stat('journal.sqlite',dir_fd=directory,follow_symlinks=False)
            if (not stat.S_ISREG(before.st_mode) or before.st_uid!=0 or before.st_gid!=0 or before.st_nlink!=1 or
                stat.S_IMODE(before.st_mode)!=0o600 or (before.st_dev,before.st_ino)!=(named.st_dev,named.st_ino)):
                raise BootGateError('Unsafe updater journal')
            uri='file:'+urllib.parse.quote(state_dir+'/journal.sqlite',safe='/')+'?mode=ro'
            try:
                db=sqlite3.connect(uri,uri=True,timeout=2)
                try:
                    if db.execute('PRAGMA user_version').fetchone()[0]!=8 or not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='operations'").fetchone():
                        raise BootGateError('Unsupported updater journal')
                    allowed=None
                    if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='host_stops'").fetchone():
                        starting=db.execute("SELECT operation_id,image_digest FROM host_stops WHERE status='starting'").fetchall()
                        if starting:
                            if len(starting)!=1:raise BootGateError('Ambiguous host activation')
                            try:
                                with open('/proc/sys/kernel/random/boot_id',encoding='ascii') as source:boot_id=source.read(64).strip()
                            except OSError as error:raise BootGateError('Boot identity is unavailable') from error
                            if not re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}',boot_id):
                                raise BootGateError('Boot identity is invalid')
                            match=db.execute("SELECT 1 FROM host_boot_authorizations a JOIN host_preparations p ON p.operation_id=a.operation_id AND p.image_digest=a.image_digest JOIN host_switches s ON s.operation_id=a.operation_id AND s.image_digest=a.image_digest JOIN host_unit_masks m ON m.operation_id=a.operation_id AND m.image_digest=a.image_digest WHERE a.operation_id=? AND a.image_digest=? AND a.boot_id=? AND p.status='prepared' AND s.phase='exchanged' AND m.phase='restored'",(*starting[0],boot_id)).fetchone()
                            if not match:raise BootGateError('Host activation requires recovery')
                            allowed=starting[0][0]
                    checks=(('host_stops',"status IS NULL OR status NOT IN ('completed','restarting')"),
                            ('host_preparations',"status IS NULL OR status NOT IN ('completed','abandoned')"),
                            ('host_switches',"phase IS NULL OR phase NOT IN ('completed','rolled_back')"),
                            ('host_unit_masks',"phase IS NULL OR phase != 'restored'"))
                    for table,condition in checks:
                        if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",(table,)).fetchone():
                            query='SELECT 1 FROM '+table+' WHERE ('+condition+')'
                            params=()
                            if allowed is not None:query+=' AND operation_id != ?';params=(allowed,)
                            if db.execute(query+' LIMIT 1',params).fetchone():raise BootGateError('Host update requires recovery')
                finally:db.close()
            except sqlite3.Error as error:raise BootGateError('Updater journal is unavailable') from error
            after=os.stat('journal.sqlite',dir_fd=directory,follow_symlinks=False)
            if (after.st_dev,after.st_ino)!=(before.st_dev,before.st_ino):raise BootGateError('Updater journal changed')
        finally:os.close(fd)
    finally:os.close(directory)


def main():
    try:assert_safe('/var/lib/servus-updater')
    except (BootGateError,OSError):
        print('Servus host update requires recovery before startup.',file=sys.stderr)
        return 1
    return 0


if __name__=='__main__':sys.exit(main())
