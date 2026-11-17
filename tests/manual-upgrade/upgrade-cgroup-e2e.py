#!/usr/bin/python3 -I
"""Exercise the signed v0.1.5 backup reader on a disposable development VM."""
import importlib.util
import os
import pathlib
import shutil
import sqlite3
import tempfile
import uuid

ROOT=pathlib.Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('manual_upgrade',ROOT/'scripts/manual-upgrade.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)


def main():
    if os.geteuid()!=0 or os.uname().nodename!='colima-panel-dev':
        raise SystemExit('Run as root only on the isolated colima-panel-dev VM')
    data=pathlib.Path('/var/lib/servus-cgroup-fixture-'+uuid.uuid4().hex)
    data.mkdir(mode=0o700);os.chown(data,1000,65534)
    with tempfile.TemporaryDirectory(prefix='servus-cgroup-fixture-',dir='/run') as temporary:
        root=pathlib.Path(temporary);tools=root/'tools';tools.mkdir(mode=0o700)
        dest=root/'snapshot';dest.mkdir(mode=0o700)
        config=root/'docker-config';config.mkdir(mode=0o700)
        try:
            for name in ('panel.sqlite','agent.sqlite'):
                with sqlite3.connect(data/name) as db:db.execute('CREATE TABLE fixture(id INTEGER)')
                os.chmod(data/name,0o600);os.chown(data/name,1000,65534)
            for name in ('secret-key','agent-token'):
                (data/name).write_text('a'*64);os.chmod(data/name,0o600);os.chown(data/name,1000,65534)
            (data/'secrets').mkdir(mode=0o700);os.chown(data/'secrets',1000,65534)
            docker=module.Docker(config);module.image_preflight(docker);module.release_tools(docker,tools)
            backup=module.load_backup(tools/'backup.py');backup._cgroup_v2_headroom=module.visible_cgroup_headroom
            backup._validate_staging=lambda *_args:None
            source_fd=os.open(data,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
            target_fd=os.open(dest,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
            node_fd=os.open('/usr/bin/true',os.O_RDONLY|os.O_NOFOLLOW)
            try:manifest=backup._capture_quiescent(source_fd,target_fd,node_fd,source_uid=1000,reader_gid=65534)
            finally:
                for fd in (source_fd,target_fd,node_fd):os.close(fd)
            if not {'panel.sqlite','agent.sqlite','secret-key','agent-token'}.issubset(manifest['files']):
                raise AssertionError('Capture inventory is incomplete')
            print('PASS signed v0.1.5 reader, real host cgroup and synthetic SQLite snapshot')
        finally:shutil.rmtree(data)


if __name__=='__main__':main()
