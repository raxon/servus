import { afterEach, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

const mocks=vi.hoisted(()=>({allocate:vi.fn(),importCandidate:vi.fn(),commit:vi.fn(),cancel:vi.fn()}));
vi.mock('../../src/agent/restore-candidate.js',()=>({createRestoreCandidate:mocks.allocate}));
vi.mock('../../src/agent/database-import.js',async importOriginal=>({...await importOriginal<typeof import('../../src/agent/database-import.js')>(),importDatabaseCandidate:mocks.importCandidate}));
vi.mock('../../src/agent/restore-commit.js',()=>({commitPreparedRestore:mocks.commit,RestoreCommitUncertainError:class extends Error{}}));
vi.mock('../../src/agent/restore-candidate-cancel.js',()=>({cancelPreparedRestore:mocks.cancel}));
import { createAgent } from '../../src/agent/app.js';
import { createApp } from '../../src/server/app.js';
import { Store } from '../../src/server/store.js';
import { RestoreCommitUncertainError } from '../../src/agent/restore-commit.js';
import { DatabaseImportError } from '../../src/agent/database-import.js';

const cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const remove of cleanup.splice(0).reverse())await remove();vi.resetAllMocks();});
async function fixture(){
  const dataDir=mkdtempSync(join(tmpdir(),'restore-prepare-api-')),store=new Store(dataDir),socketPath=join(dataDir,'agent.sock'),token='fixture-token';
  const runtime={status:async()=>({online:true}),inspectService:async()=>({state:'unknown' as const}),apply:async()=>({state:'running' as const,deployedRevision:1,messages:[]}),consoleContainer:async()=>({id:'c'.repeat(64)})};
  const agent=await createAgent({dataDir,token,socketPath,dockerSocket:'/unused',ingressPort:18080,ingressImage:'unused'},runtime as never);
  const panel=await createApp({dataDir,store});cleanup.push(async()=>{await panel.close();await agent.close();store.close();rmSync(dataDir,{recursive:true,force:true});});
  const setup=await panel.inject({method:'POST',url:'/api/v1/setup',payload:{email:'admin@example.test',password:'testing-password'}});
  const headers={cookie:`panel_session=${setup.cookies[0]!.value}`,'x-csrf-token':setup.json().csrfToken,'idempotency-key':'create'};
  const project=store.createProject('fixture');
  const created=await panel.inject({method:'POST',url:`/api/v1/projects/${project.id}/services`,headers,payload:{name:'database',kind:'postgres',database:{database:'example',user:'fixture',password:'synthetic-password'}}});
  const service=created.json().service,job=store.claimNextJob('worker',60000)!;
  store.completeAction(job.actionId,'worker',{state:'running',deployedRevision:job.snapshot.revision});
  const operationId=randomBytes(16).toString('hex'),path=`/services/${service.id}/database-restore/${operationId}`,auth={authorization:`Bearer ${token}`};
  await agent.inject({method:'POST',url:`/services/${service.id}/database-restore/upload?operationId=${operationId}&kind=postgres`,headers:{...auth,'content-type':'application/octet-stream'},payload:Buffer.from('archive')});
  return {agent,store,service,operationId,path,auth};
}

it('prepares the staged archive against the confirmed source and service-owned credentials',async()=>{
  const f=await fixture();
  mocks.allocate.mockImplementation(async opts=>{expect(opts.journal.get(f.operationId).phase).toBe('importing');return {containerId:'d'.repeat(64),volumeName:`panel-restore-${f.operationId}`};});
  mocks.importCandidate.mockImplementation(async opts=>{const chunks:Buffer[]=[];for await(const chunk of opts.input() as Readable)chunks.push(Buffer.from(chunk));expect(Buffer.concat(chunks).toString()).toBe('archive');});
  const response=await f.agent.inject({method:'POST',url:`${f.path}/prepare`,headers:f.auth,payload:{}});
  expect(response.statusCode).toBe(200);expect(response.json()).toEqual({operationId:f.operationId,phase:'prepared'});
  expect(mocks.allocate).toHaveBeenCalledWith(expect.objectContaining({serviceId:f.service.id,sourceContainerId:'c'.repeat(64),database:'example',user:'fixture',password:'synthetic-password'}));
  expect((await f.agent.inject({method:'GET',url:f.path,headers:f.auth})).json().phase).toBe('prepared');
});

it('does not allocate without authentication or when the source is not running',async()=>{
  const f=await fixture();
  expect((await f.agent.inject({method:'POST',url:`${f.path}/prepare`,payload:{}})).statusCode).toBe(401);
  f.store.db.prepare("UPDATE services SET state='stopped' WHERE id=?").run(f.service.id);
  expect((await f.agent.inject({method:'POST',url:`${f.path}/prepare`,headers:f.auth,payload:{}})).statusCode).toBe(422);
  expect(mocks.allocate).not.toHaveBeenCalled();
  expect((await f.agent.inject({method:'GET',url:f.path,headers:f.auth})).json().phase).toBe('reserved');
});

it('fences failed candidate allocation for review',async()=>{
  const f=await fixture(); mocks.allocate.mockRejectedValue(new Error('synthetic failure'));
  expect((await f.agent.inject({method:'POST',url:`${f.path}/prepare`,headers:f.auth,payload:{}})).statusCode).toBe(422);
  expect((await f.agent.inject({method:'GET',url:f.path,headers:f.auth})).json().phase).toBe('needs_review');
});

it('cleans a definitively failed import and keeps the current database unchanged',async()=>{
  const f=await fixture();mocks.allocate.mockResolvedValue({containerId:'d'.repeat(64),volumeName:`panel-restore-${f.operationId}`});
  mocks.importCandidate.mockRejectedValue(new DatabaseImportError('private detail',true));
  mocks.cancel.mockImplementation(async opts=>{expect(opts.journal.get(f.operationId).phase).toBe('discarding_candidate');return opts.journal.advance(f.operationId,'discarding_candidate','cancelled');});
  const response=await f.agent.inject({method:'POST',url:`${f.path}/prepare`,headers:f.auth,payload:{}});
  expect(response.statusCode).toBe(422);expect(response.json().error.code).toBe('RESTORE_IMPORT_FAILED');expect(response.body).not.toContain('private detail');
  expect((await f.agent.inject({method:'GET',url:f.path,headers:f.auth})).json().phase).toBe('cancelled');
});

it('keeps the cleanup fenced when removal is uncertain',async()=>{
  const f=await fixture();mocks.allocate.mockResolvedValue({containerId:'d'.repeat(64),volumeName:`panel-restore-${f.operationId}`});
  mocks.importCandidate.mockRejectedValue(new DatabaseImportError('invalid archive',true));mocks.cancel.mockRejectedValue(new Error('private cleanup detail'));
  const response=await f.agent.inject({method:'POST',url:`${f.path}/prepare`,headers:f.auth,payload:{}});
  expect(response.statusCode).toBe(503);expect(response.json().error.code).toBe('RESTORE_UNCERTAIN');expect(response.body).not.toContain('private cleanup detail');
  expect((await f.agent.inject({method:'GET',url:f.path,headers:f.auth})).json().phase).toBe('discarding_candidate');
});

it('requires authentication and serializes commit and cancellation for the same operation',async()=>{
  const f=await fixture();mocks.allocate.mockResolvedValue({containerId:'d'.repeat(64),volumeName:`panel-restore-${f.operationId}`});mocks.importCandidate.mockResolvedValue(undefined);
  expect((await f.agent.inject({method:'POST',url:`${f.path}/prepare`,headers:f.auth,payload:{}})).statusCode).toBe(200);
  expect((await f.agent.inject({method:'POST',url:`${f.path}/commit`,payload:{}})).statusCode).toBe(401);
  let entered!:()=>void,finish!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;}),blocked=new Promise<void>(resolve=>{finish=resolve;});
  mocks.commit.mockImplementation(async()=>{entered();await blocked;return {operationId:f.operationId,phase:'completed',rolledBack:false};});
  const pending=f.agent.inject({method:'POST',url:`${f.path}/commit`,headers:f.auth,payload:{}});await started;
  expect((await f.agent.inject({method:'POST',url:`${f.path}/cancel`,headers:f.auth,payload:{}})).statusCode).toBe(409);
  expect((await f.agent.inject({method:'POST',url:`${f.path}/commit`,headers:f.auth,payload:{}})).statusCode).toBe(409);
  finish();expect((await pending).json()).toEqual({operationId:f.operationId,phase:'completed',rolledBack:false});
});

it('reports an uncertain commit without leaking underlying details',async()=>{
  const f=await fixture();mocks.allocate.mockResolvedValue({containerId:'d'.repeat(64),volumeName:`panel-restore-${f.operationId}`});mocks.importCandidate.mockResolvedValue(undefined);
  await f.agent.inject({method:'POST',url:`${f.path}/prepare`,headers:f.auth,payload:{}});
  mocks.commit.mockRejectedValue(new RestoreCommitUncertainError('private detail'));
  const response=await f.agent.inject({method:'POST',url:`${f.path}/commit`,headers:f.auth,payload:{}});
  expect(response.statusCode).toBe(503);expect(response.json().error.code).toBe('RESTORE_UNCERTAIN');expect(response.body).not.toContain('private detail');
});
