#!/usr/bin/python3 -I
"""Exercise real isolated restore only on the disposable development VM."""
import hashlib
import importlib.util
import os
import pathlib
import sqlite3
import tempfile

ROOT=pathlib.Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('manual_upgrade',ROOT/'scripts/manual-upgrade.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)


def main():
    if os.geteuid()!=0 or os.uname().nodename!='colima-panel-dev':
        raise SystemExit('Run as root only on the isolated colima-panel-dev VM')
    with tempfile.TemporaryDirectory(prefix='servus-restore-e2e-',dir='/run') as tmp:
        base=pathlib.Path(tmp);config=base/'docker-config';config.mkdir(mode=0o700)
        snapshot=base/'snapshot';snapshot.mkdir(mode=0o700);os.chown(snapshot,1000,1000)
        scratch=base/'scratch';scratch.mkdir(mode=0o700)
        docker=module.Docker(config)
        script="""import {Store} from './dist/server/store.js';import {hashPassword} from './dist/server/auth.js';
        import {writeFileSync} from 'node:fs';const store=new Store('/var/lib/servus');
        store.createUser('fixture@example.test',await hashPassword('fixture-password'),'admin');store.close();
        writeFileSync('/var/lib/servus/agent-token','a'.repeat(64),{mode:0o600});"""
        docker.call('run','--rm','--pull=never','--platform=linux/amd64','--network=none',
                    '--mount',f'type=bind,source={snapshot},target=/var/lib/servus',
                    '--entrypoint','node',module.NEW,'--input-type=module','-e',script,timeout=120)
        with sqlite3.connect(snapshot/'agent.sqlite') as db:
            db.execute('CREATE TABLE operations(id TEXT PRIMARY KEY,request_hash TEXT,state TEXT,response TEXT,updated_at TEXT,previous_spec TEXT,previous_recorded INTEGER,target_spec TEXT,operation_stage TEXT,previous_error TEXT,service_id TEXT)')
        before={str(file.relative_to(snapshot)):hashlib.sha256(file.read_bytes()).hexdigest() for file in snapshot.rglob('*') if file.is_file()}
        module.verify_restored_image(docker,module.NEW,snapshot,scratch)
        after={str(file.relative_to(snapshot)):hashlib.sha256(file.read_bytes()).hexdigest() for file in snapshot.rglob('*') if file.is_file()}
        if before!=after:raise AssertionError('Source snapshot was modified')
        if list(scratch.iterdir()):raise AssertionError('Restore scratch was not removed')
        print('PASS isolated real image restore, synthetic login, untouched original snapshot')


if __name__=='__main__':main()
