import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import Database from 'better-sqlite3';
import { RestoreJournal } from '../../src/agent/restore-journal.js';
import { cancelLegacyUploadOffline } from '../../src/agent/restore-legacy-offline.js';

const cleanup:(()=>void)[]=[];
afterEach(()=>{for(const close of cleanup.splice(0).reverse())close();});
function fixture(){
  const dataDir=mkdtempSync(join(tmpdir(),'servus-legacy-offline-'));
  cleanup.push(()=>rmSync(dataDir,{recursive:true,force:true}));
  const db=new Database(join(dataDir,'agent.sqlite'));db.exec('CREATE TABLE operations(id TEXT PRIMARY KEY,service_id TEXT,state TEXT)');
  cleanup.push(()=>{if(db.open)db.close();});
  const journal=new RestoreJournal(db,()=>false),operationId='a'.repeat(32),serviceId=randomUUID();
  journal.beginUpload({id:operationId,serviceId,kind:'postgres'});
  const dir=join(dataDir,'restore-archives');mkdirSync(dir,{mode:0o700});
  return {dataDir,db,journal,operationId,serviceId,dir};
}

it('cleans a partially published legacy archive and preserves the source data',()=>{
  const f=fixture(),pending=join(f.dir,`.pending-${f.operationId}-${'b'.repeat(32)}`),published=join(f.dir,`${f.operationId}.enc`),source=join(f.dataDir,'source-database');
  writeFileSync(pending,'encrypted fixture',{mode:0o600});linkSync(pending,published);writeFileSync(source,'source data',{mode:0o600});
  expect(cancelLegacyUploadOffline(f).phase).toBe('cancelled');
  expect(readdirSync(f.dir)).toEqual([]);expect(readFileSync(source,'utf8')).toBe('source data');
  expect(cancelLegacyUploadOffline(f).phase).toBe('cancelled');
});

it('is repeatable after cleanup succeeds but the journal update fails',()=>{
  const f=fixture(),pending=join(f.dir,`.pending-${f.operationId}-${'b'.repeat(32)}`);
  writeFileSync(pending,'encrypted fixture',{mode:0o600});
  const advance=vi.spyOn(f.journal,'advance').mockImplementationOnce(()=>{throw new Error('synthetic journal failure');});
  expect(()=>cancelLegacyUploadOffline(f)).toThrow('synthetic journal failure');
  expect(f.journal.get(f.operationId)?.phase).toBe('uploading');expect(existsSync(pending)).toBe(false);
  advance.mockRestore();expect(cancelLegacyUploadOffline(f).phase).toBe('cancelled');
});

it('can resume after the cleanup process is killed before recording cancellation',async()=>{
  const f=fixture(),pending=join(f.dir,`.pending-${f.operationId}-${'b'.repeat(32)}`);
  writeFileSync(pending,'encrypted fixture',{mode:0o600});f.db.close();
  const sqlitePath=createRequire(import.meta.url).resolve('better-sqlite3');
  const journalUrl=new URL('../../src/agent/restore-journal.ts',import.meta.url).href;
  const workerUrl=new URL('../../src/agent/restore-legacy-offline.ts',import.meta.url).href;
  const program=`const {default:Database}=await import(process.argv[1]);const {RestoreJournal}=await import(process.argv[2]);const {cancelLegacyUploadOffline}=await import(process.argv[3]);const {writeSync}=await import('node:fs');const db=new Database(process.argv[4]);const journal=new RestoreJournal(db,()=>false);journal.advance=()=>{writeSync(1,'ready\\n');process.kill(process.pid,'SIGSTOP');};cancelLegacyUploadOffline({journal,dataDir:process.argv[5],operationId:process.argv[6],serviceId:process.argv[7]});`;
  const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',program,sqlitePath,journalUrl,workerUrl,join(f.dataDir,'agent.sqlite'),f.dataDir,f.operationId,f.serviceId],{stdio:['ignore','pipe','pipe']});
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{
    const ready=await Promise.race([once(child.stdout,'data'),once(child,'exit').then(()=>{throw new Error('Cleanup fixture exited early');}),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Cleanup fixture timed out')),5000);})]);
    expect(ready[0].toString()).toBe('ready\n');const stopped=once(child,'exit');child.kill('SIGKILL');await stopped;
  }finally{if(timer)clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}
  const db=new Database(join(f.dataDir,'agent.sqlite'));cleanup.push(()=>db.close());
  const journal=new RestoreJournal(db,()=>false);
  expect(journal.get(f.operationId)?.phase).toBe('uploading');expect(existsSync(pending)).toBe(false);
  expect(cancelLegacyUploadOffline({...f,journal}).phase).toBe('cancelled');
});

it('leaves the operation and files fenced when identity, ownership or exclusivity is unclear',()=>{
  const f=fixture(),pending=join(f.dir,`.pending-${f.operationId}-${'b'.repeat(32)}`);
  writeFileSync(pending,'encrypted fixture',{mode:0o600});
  expect(()=>cancelLegacyUploadOffline({...f,serviceId:randomUUID()})).toThrow();
  f.journal.beginUpload({id:'c'.repeat(32),serviceId:randomUUID(),kind:'mariadb'});
  expect(()=>cancelLegacyUploadOffline(f)).toThrow();
  expect(existsSync(pending)).toBe(true);expect(f.journal.get(f.operationId)?.phase).toBe('uploading');
});

it('does not follow an unexpected archive symlink',()=>{
  const f=fixture(),target=join(f.dataDir,'untouched'),published=join(f.dir,`${f.operationId}.enc`);
  writeFileSync(target,'source',{mode:0o600});symlinkSync(target,published);
  expect(()=>cancelLegacyUploadOffline(f)).toThrow();
  expect(existsSync(target)).toBe(true);expect(f.journal.get(f.operationId)?.phase).toBe('uploading');
});
