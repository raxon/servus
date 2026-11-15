import { afterEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { createAgent } from '../../src/agent/app.js';
import { AgentMaintenanceGate } from '../../src/agent/maintenance.js';
import { acquireRestoreUploadLock } from '../../src/agent/restore-upload-lock.js';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const remove of cleanup.splice(0).reverse()) await remove(); });
async function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), 'restore-upload-api-'));
  cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }));
  const config = { dataDir, token: 'fixture-token', socketPath: join(dataDir, 'sock'), dockerSocket: '/unused', ingressPort: 18080, ingressImage: 'unused' };
  const gate = new AgentMaintenanceGate();
  const runtime = { status: async () => ({ online: true }), inspectService: async () => ({ state: 'unknown' as const }), apply: async () => ({ state: 'running' as const, deployedRevision: 1, messages: [] }) };
  const app = await createAgent(config, runtime as never, gate); cleanup.push(() => app.close());
  const serviceId = randomUUID(), operationId = randomBytes(16).toString('hex');
  const url = `/services/${serviceId}/database-restore/upload?operationId=${operationId}&kind=postgres`;
  return { app, dataDir, gate, serviceId, operationId, url };
}

it('requires agent authentication and validates headers before reserving a restore', async () => {
  const { app, dataDir, url } = await fixture();
  const payload = Buffer.from('archive');
  expect((await app.inject({ method: 'POST', url, headers: { 'content-type':'application/octet-stream' }, payload })).statusCode).toBe(401);
  expect((await app.inject({ method: 'POST', url: url.replace('kind=postgres','kind=redis'), headers: { authorization:'Bearer fixture-token', 'content-type':'application/octet-stream' }, payload })).statusCode).toBe(400);
  const db = new Database(join(dataDir,'agent.sqlite'), { readonly:true });
  try { expect(db.prepare('SELECT count(*) AS count FROM restore_operations').get()).toEqual({ count:0 }); } finally { db.close(); }
});

it('streams a permitted upload to encrypted storage and records its digest', async () => {
  const { app, gate, url, operationId } = await fixture(), payload = Buffer.from('private database archive');
  const response = await app.inject({ method:'POST', url, headers: { authorization:'Bearer fixture-token', 'content-type':'application/octet-stream' }, payload });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ operationId, size:payload.length, sha256:createHash('sha256').update(payload).digest('hex'), phase:'reserved' });
  expect(await gate.drain(100)).toEqual({status:'uncertain'});
  expect((await app.inject({ method:'POST', url, headers: { authorization:'Bearer fixture-token', 'content-type':'application/octet-stream' }, payload })).statusCode).toBeGreaterThanOrEqual(400);
});

it('stops and cancels the upload after a real client disconnects', async () => {
  const { app, dataDir, url, operationId } = await fixture();
  const address = new URL(await app.listen({ host:'127.0.0.1', port:0 }));
  const db = new Database(join(dataDir,'agent.sqlite'), { readonly:true }); cleanup.push(() => db.close());
  const phase = () => (db.prepare('SELECT phase FROM restore_operations WHERE id=?').get(operationId) as { phase:string } | undefined)?.phase;
  const waitFor = async (expected:string) => { for (let i=0;i<100;i++) { if (phase() === expected) return; await delay(10); } throw new Error(`Upload did not reach ${expected}.`); };
  const outgoing = request({ hostname:'127.0.0.1', port:address.port, path:url, method:'POST', headers:{ authorization:'Bearer fixture-token', 'content-type':'application/octet-stream', 'content-length':'10000' } });
  outgoing.on('error', () => {}); outgoing.write('partial database copy');
  try {
    await waitFor('uploading'); outgoing.destroy(); await waitFor('cancelled');
  } finally { outgoing.destroy(); }
});

it('authorizes status and idempotent cancellation only for the matching service', async () => {
  const { app, url, serviceId, operationId } = await fixture(), payload = Buffer.from('private archive');
  const auth = {authorization:'Bearer fixture-token'};
  expect((await app.inject({method:'POST',url,headers:{...auth,'content-type':'application/octet-stream'},payload})).statusCode).toBe(200);
  const path = `/services/${serviceId}/database-restore/${operationId}`;
  expect((await app.inject({method:'GET',url:path})).statusCode).toBe(401);
  expect((await app.inject({method:'GET',url:path.replace(serviceId,randomUUID()),headers:auth})).statusCode).toBe(404);
  expect((await app.inject({method:'GET',url:path,headers:auth})).json()).toEqual({operationId,phase:'reserved',kind:'postgres'});
  for (let i=0;i<2;i++) {
    const response = await app.inject({method:'POST',url:`${path}/cancel`,headers:auth});
    expect(response.statusCode).toBe(200); expect(response.json()).toEqual({operationId,phase:'cancelled'});
  }
  expect((await app.inject({method:'GET',url:path,headers:auth})).json().phase).toBe('cancelled');
});

it('does not release an interrupted upload without a live writer to reconcile',async()=>{
  const {app,dataDir,serviceId,operationId}=await fixture();
  const db=new Database(join(dataDir,'agent.sqlite'));
  try{
    db.prepare('INSERT INTO restore_operations VALUES(?,?,?,?,?,?)').run(operationId,serviceId,'postgres','0'.repeat(64),'uploading',new Date().toISOString());
    const response=await app.inject({method:'POST',url:`/services/${serviceId}/database-restore/${operationId}/cancel`,headers:{authorization:'Bearer fixture-token'}});
    expect(response.statusCode).toBe(409);
    expect((db.prepare('SELECT phase FROM restore_operations WHERE id=?').get(operationId) as {phase:string}).phase).toBe('uploading');
  }finally{db.close();}
});

it('does not mistake an unregistered new-format lock for proof that a legacy writer stopped',async()=>{
  const {app,dataDir,serviceId,operationId}=await fixture(),lockId=randomBytes(16).toString('hex');
  const unlock=acquireRestoreUploadLock(dataDir,operationId,true,lockId);unlock();
  const db=new Database(join(dataDir,'agent.sqlite'));
  try {
    db.prepare('INSERT INTO restore_operations VALUES(?,?,?,?,?,?)').run(operationId,serviceId,'postgres','0'.repeat(64),'uploading',new Date().toISOString());
    const response=await app.inject({method:'POST',url:`/services/${serviceId}/database-restore/${operationId}/cancel`,headers:{authorization:'Bearer fixture-token'}});
    expect(response.statusCode).toBe(409);
    expect((db.prepare('SELECT phase FROM restore_operations WHERE id=?').get(operationId) as {phase:string}).phase).toBe('uploading');
  } finally { db.close(); }
});

it('does not trust an unregistered legacy-format lock as proof that a legacy writer stopped',async()=>{
  const {app,dataDir,serviceId,operationId}=await fixture();
  const unlock=acquireRestoreUploadLock(dataDir,operationId,true);unlock();
  const db=new Database(join(dataDir,'agent.sqlite'));
  try {
    db.prepare('INSERT INTO restore_operations VALUES(?,?,?,?,?,?)').run(operationId,serviceId,'postgres','0'.repeat(64),'uploading',new Date().toISOString());
    const response=await app.inject({method:'POST',url:`/services/${serviceId}/database-restore/${operationId}/cancel`,headers:{authorization:'Bearer fixture-token'}});
    expect(response.statusCode).toBe(409);
    expect((db.prepare('SELECT phase FROM restore_operations WHERE id=?').get(operationId) as {phase:string}).phase).toBe('uploading');
  } finally { db.close(); }
});

it('keeps an interrupted upload fenced if its recorded lock identity is malformed',async()=>{
  const {app,dataDir,serviceId,operationId}=await fixture();
  const db=new Database(join(dataDir,'agent.sqlite'));
  try {
    db.prepare('INSERT INTO restore_operations VALUES(?,?,?,?,?,?)').run(operationId,serviceId,'postgres','a'.repeat(32)+'b'.repeat(32),'uploading',new Date().toISOString());
    const response=await app.inject({method:'POST',url:`/services/${serviceId}/database-restore/${operationId}/cancel`,headers:{authorization:'Bearer fixture-token'}});
    expect(response.statusCode).toBe(409);
    expect((db.prepare('SELECT phase FROM restore_operations WHERE id=?').get(operationId) as {phase:string}).phase).toBe('uploading');
  } finally { db.close(); }
});

it('recovers a killed writer but refuses while another process holds its upload lock',async()=>{
  const {app,dataDir,serviceId,operationId}=await fixture();
  const journalUrl=new URL('../../src/agent/restore-journal.ts',import.meta.url).href,uploadUrl=new URL('../../src/agent/restore-upload.ts',import.meta.url).href;
  const sqlitePath=createRequire(import.meta.url).resolve('better-sqlite3');
  const program=`const {default:Database}=await import(process.argv[1]);const {RestoreJournal}=await import(process.argv[2]);const {uploadRestoreArchive}=await import(process.argv[3]);const {PassThrough}=await import('node:stream');const db=new Database(process.argv[4]);const journal=new RestoreJournal(db,()=>false);const source=new PassThrough();void uploadRestoreArchive({journal,operationId:process.argv[5],serviceId:process.argv[6],kind:'postgres',dataDir:process.argv[7],key:Buffer.alloc(32),input:()=>source}).catch(()=>{});source.write('private fixture');process.stdout.write('ready\\n');setInterval(()=>{},1000);`;
  const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',program,sqlitePath,journalUrl,uploadUrl,join(dataDir,'agent.sqlite'),operationId,serviceId,dataDir],{stdio:['ignore','pipe','pipe']});
  const path=`/services/${serviceId}/database-restore/${operationId}`,auth={authorization:'Bearer fixture-token'};
  try{
    const ready=await Promise.race([once(child.stdout,'data'),once(child,'exit').then(()=>{throw new Error('Upload fixture exited early');}),delay(5000).then(()=>{throw new Error('Upload fixture timed out');})]);
    expect(ready[0].toString()).toBe('ready\n');
    expect((await app.inject({method:'POST',url:`${path}/cancel`,headers:auth})).statusCode).toBe(409);
    expect((await app.inject({url:path,headers:auth})).json().phase).toBe('uploading');
    const exited=once(child,'exit');child.kill('SIGKILL');await exited;
    const cancelled=await app.inject({method:'POST',url:`${path}/cancel`,headers:auth});
    expect(cancelled.statusCode).toBe(200);expect(cancelled.json()).toEqual({operationId,phase:'cancelled'});
    expect(readdirSync(join(dataDir,'restore-archives'))).toEqual([]);
    expect((await app.inject({url:path,headers:auth})).json().phase).toBe('cancelled');
  }finally{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}
},10000);
