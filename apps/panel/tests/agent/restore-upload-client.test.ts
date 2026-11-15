import { afterEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { PassThrough, Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { createAgent } from '../../src/agent/app.js';
import { agentDatabaseUpload } from '../../src/agent/client.js';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const remove of cleanup.splice(0).reverse()) await remove(); });
async function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(),'restore-upload-client-')); cleanup.push(() => rmSync(dataDir,{recursive:true,force:true}));
  const socketPath = join(dataDir,'agent.sock'), token = 'fixture-token';
  const config = {dataDir,token,socketPath,dockerSocket:'/unused',ingressPort:18080,ingressImage:'unused'};
  const runtime = {status:async()=>({online:true}),inspectService:async()=>({state:'unknown' as const}),apply:async()=>({state:'running' as const,deployedRevision:1,messages:[]})};
  const app = await createAgent(config,runtime as never); await app.listen({path:socketPath}); cleanup.push(() => app.close());
  return { dataDir, socketPath, token, serviceId:randomUUID(), operationId:randomBytes(16).toString('hex') };
}

it('sends data over the agent socket and validates the returned identity and digest', async () => {
  const base = await fixture(), payload = Buffer.from('private restore fixture');
  const result = await agentDatabaseUpload(base.serviceId,{ operationId:base.operationId,kind:'postgres',size:payload.length,stream:Readable.from([payload.subarray(0,4),payload.subarray(4)]) },base);
  expect(result).toEqual({operationId:base.operationId,size:payload.length,sha256:createHash('sha256').update(payload).digest('hex'),phase:'reserved'});
});

it('fails closed on agent authentication errors and short uploads', async () => {
  const base = await fixture();
  await expect(agentDatabaseUpload(base.serviceId,{operationId:base.operationId,kind:'postgres',size:4,stream:Readable.from(['data'])},{...base,token:'wrong'})).rejects.toMatchObject({certainty:'uncertain'});
  await expect(agentDatabaseUpload(base.serviceId,{operationId:base.operationId,kind:'postgres',size:20,stream:Readable.from(['short'])},base)).rejects.toMatchObject({certainty:'uncertain'});
});

it('propagates cancellation and the agent cancels the unfinished operation', async () => {
  const base = await fixture(), stream = new PassThrough(), controller = new AbortController();
  const db = new Database(join(base.dataDir,'agent.sqlite'),{readonly:true}); cleanup.push(() => db.close());
  const phase = () => (db.prepare('SELECT phase FROM restore_operations WHERE id=?').get(base.operationId) as {phase:string}|undefined)?.phase;
  const waitFor = async (expected:string) => { for (let i=0;i<100;i++) { if (phase() === expected) return; await delay(10); } throw new Error(`Upload did not reach ${expected}.`); };
  const pending = agentDatabaseUpload(base.serviceId,{operationId:base.operationId,kind:'postgres',size:5000,stream,signal:controller.signal},base);
  stream.write('partial'); await waitFor('uploading'); controller.abort();
  await expect(pending).rejects.toMatchObject({certainty:'uncertain'}); await waitFor('cancelled');
});

it('rejects an invalid or premature success response', async () => {
  const dir = mkdtempSync(join(tmpdir(),'restore-upload-response-')); cleanup.push(() => rmSync(dir,{recursive:true,force:true}));
  const socketPath = join(dir,'sock');
  const server = createServer((_req,res) => res.end(JSON.stringify({operationId:'wrong',size:4,sha256:'0'.repeat(64),phase:'reserved'})));
  await new Promise<void>(resolve => server.listen(socketPath,resolve)); cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  await expect(agentDatabaseUpload(randomUUID(),{operationId:randomBytes(16).toString('hex'),kind:'postgres',size:4,stream:Readable.from(['data'])},{socketPath,token:'fixture'})).rejects.toMatchObject({certainty:'uncertain'});
});

it('rejects a response whose digest does not match the uploaded data', async () => {
  const dir = mkdtempSync(join(tmpdir(),'restore-upload-digest-')); cleanup.push(() => rmSync(dir,{recursive:true,force:true}));
  const socketPath = join(dir,'sock'), operationId = randomBytes(16).toString('hex');
  const server = createServer((req,res) => { req.resume(); req.on('end',() => res.end(JSON.stringify({operationId,size:4,sha256:'0'.repeat(64),phase:'reserved'}))); });
  await new Promise<void>(resolve => server.listen(socketPath,resolve)); cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  await expect(agentDatabaseUpload(randomUUID(),{operationId,kind:'postgres',size:4,stream:Readable.from(['data'])},{socketPath,token:'fixture'})).rejects.toMatchObject({certainty:'uncertain'});
});
