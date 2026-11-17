import { afterEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import type Docker from 'dockerode';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
const mocked=vi.hoisted(()=>({importRedis:vi.fn()}));
vi.mock('../../src/agent/redis-restore-import.js',()=>({importRedisRestore:mocked.importRedis}));
import { Store } from '../../src/server/store.js';
import { normalizeServiceInput } from '../../src/server/configuration.js';
import { RestoreJournal } from '../../src/agent/restore-journal.js';
import { uploadRestoreArchive } from '../../src/agent/restore-upload.js';
import { RedisRestore } from '../../src/agent/redis-restore.js';
import { DatabaseImportError } from '../../src/agent/database-import.js';

const cleanup:(()=>void)[]=[];
afterEach(()=>{for(const close of cleanup.splice(0).reverse())close();vi.resetAllMocks();});
async function fixture() {
  const dataDir=mkdtempSync(join(tmpdir(),'redis-restore-unit-')),store=new Store(dataDir),actor=store.setup('fixture@example.test','unused-fixture-hash'),project=store.createProject('redis'),{service}=store.createService(project.id,normalizeServiceInput({name:'redis',kind:'redis',database:{database:'app',user:'app',password:'fixture-only-password'}}),actor.id),job=store.claimNextJob('fixture',60_000)!;store.completeAction(job.actionId,'fixture',{state:'running',deployedRevision:1});
  const db=new Database(join(dataDir,'agent.sqlite'));db.exec('CREATE TABLE operations(id TEXT PRIMARY KEY,service_id TEXT,state TEXT)');const journal=new RestoreJournal(db,()=>false),id=randomBytes(16).toString('hex'),archive=Buffer.from('REDIS0011-synthetic-untrusted-rdb');
  const missing=async()=>{throw Object.assign(new Error('Missing fixture resource.'),{statusCode:404});},volume={inspect:vi.fn(missing),remove:vi.fn()},candidate={inspect:vi.fn(missing),remove:vi.fn()},docker={getVolume:vi.fn(()=>volume),getContainer:vi.fn(()=>candidate),listContainers:vi.fn(async()=>[])} as unknown as Docker;
  const options={db,journal,docker,dockerSocket:'/unused',dataDir,vault:store.vault},restore=new RedisRestore(options);
  await uploadRestoreArchive({journal,operationId:id,serviceId:service.id,kind:'redis',dataDir,key:store.vault.restoreArchiveKey(id),input:()=>Readable.from([archive]),expectedSize:archive.length});
  mocked.importRedis.mockImplementation(async input=>{const chunks:Buffer[]=[];for await(const chunk of input.input())chunks.push(Buffer.from(chunk));expect(Buffer.concat(chunks)).toEqual(archive);});
  cleanup.push(()=>{db.close();store.close();rmSync(dataDir,{recursive:true,force:true});});
  return{dataDir,store,service,db,journal,id,restore,options,volume,candidate};
}

it('binds Redis preparation to its confirmed deployment and unchanged service-owned password',async()=>{
  const f=await fixture();expect(await f.restore.prepare(f.service.id,f.id,'c'.repeat(64))).toEqual({operationId:f.id,phase:'prepared'});
  expect(mocked.importRedis).toHaveBeenCalledWith(expect.objectContaining({serviceId:f.service.id,password:'fixture-only-password',sourceContainerId:'c'.repeat(64)}));
  expect(await f.restore.prepare(f.service.id,f.id,'c'.repeat(64))).toEqual({operationId:f.id,phase:'prepared'});expect(mocked.importRedis).toHaveBeenCalledTimes(1);expect(f.journal.hasUnresolved(f.service.id)).toBe(true);
});

it('holds a process-owned preparation lock so recovery cannot cancel an active writer',async()=>{
  const f=await fixture();let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});mocked.importRedis.mockImplementationOnce(()=>gate);
  const preparing=f.restore.prepare(f.service.id,f.id,'c'.repeat(64));await vi.waitFor(()=>expect(mocked.importRedis).toHaveBeenCalled());
  const second=new RedisRestore(f.options);await expect(second.recover(f.service.id,f.id)).rejects.toMatchObject({code:'REDIS_RESTORE_BUSY'});expect(f.journal.get(f.id)?.phase).toBe('importing');release();await preparing;
});

it('shares the process mutex across different restore identities for the same Redis service',async()=>{
  const f=await fixture(),older=randomBytes(16).toString('hex');f.db.prepare("INSERT INTO restore_operations VALUES(?,?,? ,?,'completed',?)").run(older,f.service.id,'redis','a'.repeat(64),new Date().toISOString());
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});mocked.importRedis.mockImplementationOnce(()=>gate);const preparing=f.restore.prepare(f.service.id,f.id,'c'.repeat(64));await vi.waitFor(()=>expect(mocked.importRedis).toHaveBeenCalled());
  try{await expect(new RedisRestore(f.options).recover(f.service.id,older)).rejects.toThrow('Another process is changing this Redis service.');}finally{release();await preparing;}
});

it('discards a definitively rejected RDB and permits a fresh operation without touching the original',async()=>{
  const f=await fixture();mocked.importRedis.mockRejectedValueOnce(new DatabaseImportError('Invalid RDB.',true));
  await expect(f.restore.prepare(f.service.id,f.id,'c'.repeat(64))).rejects.toThrow('Invalid RDB');expect(f.journal.get(f.id)?.phase).toBe('cancelled');expect(f.journal.hasUnresolved(f.service.id)).toBe(false);expect(f.store.getService(f.service.id)?.state).toBe('running');expect(f.volume.remove).not.toHaveBeenCalled();
});

it('recovers an interrupted preparation only after obtaining its process lock and repeats safely',async()=>{
  const f=await fixture();f.journal.advance(f.id,'reserved','importing');expect(await f.restore.recover(f.service.id,f.id)).toMatchObject({phase:'cancelled',rolledBack:false});expect(await f.restore.recover(f.service.id,f.id)).toMatchObject({phase:'cancelled',rolledBack:false});expect(f.store.getService(f.service.id)?.state).toBe('running');
});

it('refuses recovery cleanup when the named candidate belongs to another service',async()=>{
  const f=await fixture();f.journal.advance(f.id,'reserved','importing');f.volume.inspect.mockResolvedValueOnce({Name:`panel-restore-${f.id}`,Labels:{'panel.restore.service':'another-service'}} as never);
  await expect(f.restore.recover(f.service.id,f.id)).rejects.toThrow('ownership');expect(f.volume.remove).not.toHaveBeenCalled();expect(f.candidate.remove).not.toHaveBeenCalled();expect(f.journal.hasUnresolved(f.service.id)).toBe(true);
});

it('keeps lifecycle and maintenance fenced when completion still has an unresolved Redis plan',async()=>{
  const f=await fixture();f.db.prepare("UPDATE restore_operations SET phase='completed' WHERE id=?").run(f.id);f.db.prepare("INSERT INTO redis_restore_plans VALUES(?,?,?,'committing',?)").run(f.id,f.service.id,f.store.vault.seal('{}'),new Date().toISOString());
  expect(f.journal.hasUnresolved()).toBe(true);expect(f.journal.hasUnresolved(f.service.id)).toBe(true);expect(f.restore.metadata(f.service.id,f.id)).toEqual({redisRecoveryRequired:true});
  expect(()=>f.journal.reserve({id:randomBytes(16).toString('hex'),serviceId:f.service.id,kind:'redis',archiveSha256:'a'.repeat(64)})).toThrow('unresolved');
});

it('refuses rollback of an older completed operation while a different restore is reserved',async()=>{
  const f=await fixture();f.db.prepare("UPDATE restore_operations SET phase='completed' WHERE id=?").run(f.id);f.db.prepare("INSERT INTO redis_restore_plans VALUES(?,?,?,'completed',?)").run(f.id,f.service.id,f.store.vault.seal('{}'),new Date().toISOString());
  const next=randomBytes(16).toString('hex');f.journal.reserve({id:next,serviceId:f.service.id,kind:'redis',archiveSha256:'a'.repeat(64)});
  await expect(f.restore.rollback(f.service.id,f.id)).rejects.toMatchObject({code:'REDIS_RESTORE_BUSY'});expect(f.journal.get(next)?.phase).toBe('reserved');expect(f.options.docker.getVolume).not.toHaveBeenCalled();
});

it('extends the binding CHECK transactionally while preserving older database selections',async()=>{
  const f=await fixture();f.db.exec('DROP TABLE restore_volume_bindings; CREATE TABLE restore_volume_bindings(service_id TEXT PRIMARY KEY,operation_id TEXT NOT NULL UNIQUE,volume_name TEXT NOT NULL UNIQUE,kind TEXT NOT NULL CHECK(kind IN (\'postgres\',\'mariadb\')),created_at TEXT NOT NULL)');
  const row=['older-service','a'.repeat(32),'panel-restore-'+ 'a'.repeat(32),'postgres',new Date().toISOString()];f.db.prepare('INSERT INTO restore_volume_bindings VALUES(?,?,?,?,?)').run(...row);new RestoreJournal(f.db,()=>false);
  expect(Object.values(f.db.prepare('SELECT * FROM restore_volume_bindings').get() as object)).toEqual(row);expect(()=>f.db.prepare('INSERT INTO restore_volume_bindings VALUES(?,?,?,?,?)').run(f.service.id,f.id,`panel-restore-${f.id}`,'redis',new Date().toISOString())).not.toThrow();
});
