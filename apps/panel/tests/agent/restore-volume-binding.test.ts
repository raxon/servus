import { afterEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RestoreJournal } from '../../src/agent/restore-journal.js';
import { SecretVault } from '../../src/shared/secrets.js';

const cleanup:(()=>void)[]=[];
afterEach(()=>{for(const remove of cleanup.splice(0).reverse())remove();});
function fixture(){
  const directory=mkdtempSync(join(tmpdir(),'restore-binding-'));cleanup.push(()=>rmSync(directory,{recursive:true,force:true}));
  const path=join(directory,'agent.sqlite'),db=new Database(path);db.exec('CREATE TABLE operations(id TEXT PRIMARY KEY,service_id TEXT,state TEXT)');cleanup.push(()=>{if(db.open)db.close();});
  const journal=new RestoreJournal(db,()=>false),vault=new SecretVault(directory),serviceId=randomUUID();
  function prepare(){
    const id=randomBytes(16).toString('hex');journal.reserve({id,serviceId,kind:'postgres',archiveSha256:'a'.repeat(64)});journal.advance(id,'reserved','importing');journal.advance(id,'importing','prepared');
    journal.beginSwitch({id,serviceId,serviceVersion:1,sealedPlan:vault.seal('fixture plan')});
    journal.advanceSwitchStage(id,'pending','candidate_stop');journal.advanceSwitchStage(id,'candidate_stop','candidate_detached');journal.advanceSwitchStage(id,'candidate_detached','applying');journal.advanceSwitchStage(id,'applying','applied');return id;
  }
  return {db,path,journal,serviceId,prepare};
}

it('atomically binds the restored volume and retains the original',()=>{
  const f=fixture(),id=f.prepare(),source=`panel-data-${f.serviceId}-database`;
  expect(f.journal.completeSwitch(id,f.serviceId,source).phase).toBe('completed');
  expect(f.journal.volumeBinding(f.serviceId)).toMatchObject({operation_id:id,volume_name:`panel-restore-${id}`,kind:'postgres'});
  expect(f.journal.retainedVolume(id)).toMatchObject({service_id:f.serviceId,volume_name:source,reason:'pre_restore_source'});
  expect(f.journal.switchIntent(id)).toBeUndefined();expect(f.journal.hasUnresolved(f.serviceId)).toBe(false);
  expect(f.journal.completeSwitch(id,f.serviceId,source).phase).toBe('completed');
});

it('retains each previous bound volume across successive restores',()=>{
  const f=fixture(),first=f.prepare();f.journal.completeSwitch(first,f.serviceId,`panel-data-${f.serviceId}-database`);
  const second=f.prepare();f.journal.completeSwitch(second,f.serviceId,`panel-restore-${first}`);
  expect(f.journal.volumeBinding(f.serviceId)?.operation_id).toBe(second);
  expect(f.journal.retainedVolume(second)?.volume_name).toBe(`panel-restore-${first}`);
});

it('keeps the switch fenced if the source binding changes or retention fails',()=>{
  const f=fixture(),id=f.prepare();
  expect(()=>f.journal.completeSwitch(id,f.serviceId,'wrong')).toThrow('binding changed');
  f.db.exec("CREATE TRIGGER fail_binding BEFORE INSERT ON restore_volume_bindings BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END");
  expect(()=>f.journal.completeSwitch(id,f.serviceId,`panel-data-${f.serviceId}-database`)).toThrow('synthetic failure');
  expect(f.journal.get(id)?.phase).toBe('switching');expect(f.journal.switchIntent(id)?.stage).toBe('applied');
  expect(f.journal.retainedVolume(id)).toBeUndefined();expect(f.journal.volumeBinding(f.serviceId)).toBeUndefined();
});

it('recovers the binding after reopening the agent database',()=>{
  const f=fixture(),id=f.prepare();f.journal.completeSwitch(id,f.serviceId,`panel-data-${f.serviceId}-database`);f.db.close();
  const reopened=new Database(f.path);cleanup.push(()=>reopened.close());const journal=new RestoreJournal(reopened,()=>false);
  expect(journal.volumeBinding(f.serviceId)?.volume_name).toBe(`panel-restore-${id}`);expect(journal.retainedVolume(id)?.reason).toBe('pre_restore_source');
});

it('preserves retained rollback volumes when upgrading the journal schema',()=>{
  const f=fixture(),id=randomBytes(16).toString('hex'),now=new Date().toISOString();
  f.db.prepare("INSERT INTO restore_operations VALUES(?,?,? ,?,'cancelled',?)").run(id,f.serviceId,'postgres','a'.repeat(64),now);
  f.db.exec("DROP TABLE restore_retained_volumes; CREATE TABLE restore_retained_volumes(operation_id TEXT PRIMARY KEY,service_id TEXT NOT NULL,volume_name TEXT NOT NULL UNIQUE,reason TEXT NOT NULL CHECK(reason='rollback_candidate'),created_at TEXT NOT NULL)");
  f.db.prepare("INSERT INTO restore_retained_volumes VALUES(?,?,?,'rollback_candidate',?)").run(id,f.serviceId,`panel-restore-${id}`,now);
  const migrated=new RestoreJournal(f.db,()=>false);
  expect(migrated.retainedVolume(id)).toMatchObject({service_id:f.serviceId,volume_name:`panel-restore-${id}`,reason:'rollback_candidate'});
  const next=f.prepare();expect(migrated.completeSwitch(next,f.serviceId,`panel-data-${f.serviceId}-database`).phase).toBe('completed');
});
