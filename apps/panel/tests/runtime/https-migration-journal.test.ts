import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecretVault } from '../../src/shared/secrets.js';
import { HttpsMigrationJournal } from '../../src/agent/https-migration-journal.js';
import { applyHttpsMigration, recoverHttpsMigration, type IngressMigrationDriver } from '../../src/agent/https-migration.js';

const dirs:string[]=[];
afterEach(()=>{for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
function setup() {
  const dir=mkdtempSync(join(tmpdir(),'https-journal-'));dirs.push(dir);
  const vault=new SecretVault(dir), path=join(dir,'agent.sqlite');
  const connect=()=>new Database(path);
  const db=connect();
  db.exec("CREATE TABLE operations (id TEXT PRIMARY KEY,request_hash TEXT NOT NULL,state TEXT NOT NULL,response TEXT,updated_at TEXT NOT NULL,previous_spec TEXT,previous_recorded INTEGER NOT NULL DEFAULT 0,target_spec TEXT,operation_stage TEXT NOT NULL DEFAULT 'applying',previous_error TEXT,service_id TEXT)");
  const journal=(connection:Database.Database)=>new HttpsMigrationJournal(connection,value=>vault.seal(value),value=>vault.open(value));
  return {db,connect,journal};
}
const previous={Name:'panel-ingress',Labels:{owner:'private-value'}};
const target={Name:'panel-ingress',Labels:{owner:'private-value',https:'enabled'}};

describe('HTTPS ingress migration journal',()=>{
  it('persists encrypted intent across restarts and fences concurrent attempts',()=>{
    const {db,connect,journal}=setup();
    journal(db).begin(previous,target);
    const row=db.prepare('SELECT * FROM operations').get() as {state:string;previous_spec:string;target_spec:string};
    expect(row.state).toBe('running');
    expect(row.previous_spec).not.toContain('private-value');
    expect(row.target_spec).not.toContain('private-value');
    db.close();
    const reopened=connect(), other=connect();
    expect(journal(reopened).load()).toEqual({previous,target,stage:'applying'});
    expect(()=>journal(other).begin(previous,target)).toThrow();
    journal(reopened).rollback();
    expect(journal(other).load()?.stage).toBe('rolling_back');
    expect(()=>journal(other).finish('applied')).toThrow();
    journal(other).finish('restored');
    expect(journal(reopened).load()).toBeUndefined();
    reopened.close();other.close();
  });
  it('records a verified application and permits a subsequent migration',()=>{
    const {db,journal}=setup(), value=journal(db);
    value.begin(previous,target);value.finish('applied');
    expect(value.load()).toBeUndefined();
    value.begin(previous,target);
    expect(value.load()?.stage).toBe('applying');
    db.close();
  });
  it('rejects tampered snapshots and foreign reserved identities',()=>{
    const {db,journal}=setup(), value=journal(db);
    value.begin(previous,target);
    db.prepare("UPDATE operations SET previous_spec='enc:v1:broken'").run();
    expect(()=>value.load()).toThrow();
    db.prepare("UPDATE operations SET request_hash='other'").run();
    expect(()=>value.load()).toThrow(/identity conflict/);
    expect(()=>value.begin(previous,target)).toThrow();
    db.close();
  });
  it('restores the old ingress after an unhealthy update',async()=>{
    const {db,journal}=setup(), value=journal(db);
    let current=previous,version=1;
    const driver:IngressMigrationDriver={
      inspect:async()=>({spec:current,version}),
      update:async(spec,expected)=>{expect(expected).toBe(version);current=spec as typeof previous;version++;},
      waitHealthy:async spec=>{if(spec===target || spec.Labels?.https)throw new Error('not healthy');},
    };
    await expect(applyHttpsMigration(value,driver,previous,target,version)).rejects.toThrow('not healthy');
    expect(current).toEqual(previous);
    expect(value.load()).toBeUndefined();
    db.close();
  });
  it('leaves recovery fenced when an operator changed the ingress',async()=>{
    const {db,journal}=setup(), value=journal(db);
    value.begin(previous,target);
    const driver:IngressMigrationDriver={inspect:async()=>({spec:{Name:'changed'},version:2}),update:async()=>{throw new Error('must not update');},waitHealthy:async()=>{}};
    await expect(recoverHttpsMigration(value,driver)).rejects.toThrow('changed independently');
    expect(value.load()?.stage).toBe('rolling_back');
    db.close();
  });
});
