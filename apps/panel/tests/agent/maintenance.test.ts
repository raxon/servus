import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import Database from 'better-sqlite3';
import WebSocket from 'ws';
import { createAgent } from '../../src/agent/app.js';
import { AgentMaintenanceGate, consoleExecStopped } from '../../src/agent/maintenance.js';
import { HttpsMigrationJournal, HTTPS_MIGRATION_OPERATION_ID } from '../../src/agent/https-migration-journal.js';
import { SecretVault } from '../../src/shared/secrets.js';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function service() {
  return { id: randomUUID(), projectId: randomUUID(), name: 'web', image: 'nginx:alpine', hostname: 'web.localhost', port: 80,
    replicas: 1, revision: 1, deployedRevision: null, state: 'pending', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', lastError: null };
}
function fixture() {
  const dataDir=mkdtempSync(join(tmpdir(),'agent-drain-'));
  cleanup.push(()=>rmSync(dataDir,{recursive:true,force:true}));
  return {dataDir,token:'test-token',socketPath:join(dataDir,'agent.sock'),dockerSocket:'/unused',ingressPort:18080,ingressImage:'unused'};
}
const outcome = { state:'running' as const, deployedRevision:1, messages:[] };
const headers = { authorization:'Bearer test-token' };
function runtime(apply: (...args:any[])=>Promise<any>) {
  return {status:async()=>({online:true}),inspectService:async()=>({state:'unknown' as const}),apply};
}

describe('agent maintenance barrier', () => {
  it('fences service changes after restart when ingress recovery is unavailable',async()=>{
    const config=fixture(),initial=await createAgent(config,runtime(async()=>outcome));
    await initial.close();
    const db=new Database(join(config.dataDir,'agent.sqlite')),vault=new SecretVault(config.dataDir);
    new HttpsMigrationJournal(db,value=>vault.seal(value),value=>vault.open(value)).begin({Name:'old'},{Name:'new'});
    db.close();
    const engine=runtime(vi.fn(async()=>outcome)),gate=new AgentMaintenanceGate();
    const app=await createAgent(config,engine,gate);cleanup.push(()=>app.close());
    const result=await app.inject({method:'POST',url:'/services/apply',headers,payload:{operationId:randomUUID(),type:'deploy',service:service()}});
    expect(result.statusCode).toBe(503);
    expect(result.json().error.code).toBe('INGRESS_RECOVERY_REQUIRED');
    expect(engine.apply).not.toHaveBeenCalled();
    expect(await gate.drain(50)).toEqual({status:'uncertain'});
  });
  it('reserves the ingress migration operation identity',async()=>{
    const app=await createAgent(fixture(),runtime(async()=>outcome));cleanup.push(()=>app.close());
    const result=await app.inject({method:'POST',url:'/services/apply',headers,payload:{operationId:HTTPS_MIGRATION_OPERATION_ID,type:'deploy',service:service()}});
    expect(result.statusCode).toBe(400);
  });
  it('permits only the explicitly identified legacy upload during a recovery drain',async()=>{
    const config=fixture(),gate=new AgentMaintenanceGate(),id='a'.repeat(32),serviceId=randomUUID();
    const app=await createAgent(config,runtime(async()=>outcome),gate);cleanup.push(()=>app.close());
    const db=new Database(join(config.dataDir,'agent.sqlite'));
    db.prepare('INSERT INTO restore_operations VALUES(?,?,?,?,?,?)').run(id,serviceId,'postgres','0'.repeat(64),'uploading',new Date().toISOString());db.close();
    const release=gate.admit()!;
    const pending=gate.drainForLegacyUpload(1000,id,serviceId);
    expect(gate.admit()).toBeUndefined();
    release();expect(await pending).toEqual({status:'drained'});
    expect(await gate.drainForLegacyUpload(100,id,serviceId)).toEqual({status:'drained'});
    expect(await gate.drain(100)).toEqual({status:'uncertain'});
  });
  it('rejects missing, modern, or additional unresolved operations during a recovery drain',async()=>{
    for(const scenario of ['missing','modern','additional','running','invalid_service','unsupported_kind','reserved','wrong_service'] as const){
      const config=fixture(),gate=new AgentMaintenanceGate(),id='b'.repeat(32),serviceId=randomUUID();
      const app=await createAgent(config,runtime(async()=>outcome),gate);cleanup.push(()=>app.close());
      const db=new Database(join(config.dataDir,'agent.sqlite'));
      if(scenario!=='missing')db.prepare('INSERT INTO restore_operations VALUES(?,?,?,?,?,?)').run(id,scenario==='invalid_service'?'invalid':serviceId,scenario==='unsupported_kind'?'redis':'postgres',scenario==='modern'?'c'.repeat(64):'0'.repeat(64),scenario==='reserved'?'reserved':'uploading',new Date().toISOString());
      if(scenario==='additional')db.prepare('INSERT INTO restore_operations VALUES(?,?,?,?,?,?)').run('d'.repeat(32),randomUUID(),'mariadb','0'.repeat(64),'uploading',new Date().toISOString());
      if(scenario==='running')db.prepare("INSERT INTO operations(id,request_hash,state,updated_at) VALUES(?,?,'running',?)").run(randomUUID(),'hash',new Date().toISOString());
      db.close();
      expect(await gate.drainForLegacyUpload(100,id,scenario==='wrong_service'?randomUUID():serviceId),scenario).toEqual({status:'uncertain'});
    }
  });
  it('waits for an active apply, denies new work and stays in drain mode', async () => {
    const config=fixture(), gate=new AgentMaintenanceGate(), entered=deferred<void>(), complete=deferred<typeof outcome>();
    const engine=runtime(vi.fn(async()=>{entered.resolve(); return complete.promise;}));
    const app=await createAgent(config,engine,gate);cleanup.push(()=>app.close());
    const body={operationId:randomUUID(),type:'deploy',service:service()};
    const request=app.inject({method:'POST',url:'/services/apply',headers,payload:body});
    await entered.promise;
    const draining=gate.drain(1000);
    const denied=await app.inject({method:'POST',url:'/services/apply',headers,payload:{...body,operationId:randomUUID()}});
    expect(denied.statusCode).toBe(503);
    complete.resolve(outcome);
    expect((await request).statusCode).toBe(200);
    expect(await draining).toEqual({status:'drained'});
    expect(await gate.drain(100)).toEqual({status:'drained'});
    expect(engine.apply).toHaveBeenCalledTimes(1);
  });
  it('times out without cancelling an accepted operation', async () => {
    const config=fixture(),gate=new AgentMaintenanceGate(),entered=deferred<void>(),complete=deferred<typeof outcome>();
    const app=await createAgent(config,runtime(async()=>{entered.resolve();return complete.promise;}),gate);cleanup.push(()=>app.close());
    const request=app.inject({method:'POST',url:'/services/apply',headers,payload:{operationId:randomUUID(),type:'deploy',service:service()}});
    await entered.promise;
    expect(await gate.drain(5)).toEqual({status:'timeout'});
    complete.resolve(outcome);expect((await request).statusCode).toBe(200);
    expect(await gate.drain(100)).toEqual({status:'drained'});
  });
  it('refuses drained when the journal contains an unresolved operation', async () => {
    const config=fixture(),gate=new AgentMaintenanceGate();
    const engine=runtime(async()=>{throw Object.assign(new Error('lost Docker connection'),{code:'ECONNRESET'});});
    const app=await createAgent(config,engine,gate);cleanup.push(()=>app.close());
    const op=randomUUID();
    expect((await app.inject({method:'POST',url:'/services/apply',headers,payload:{operationId:op,type:'deploy',service:service()}})).statusCode).toBe(503);
    expect(await gate.drain(100)).toEqual({status:'uncertain'});
  });
  it('fails closed when an earlier process left a running journal row', async () => {
    const config=fixture(),gate=new AgentMaintenanceGate();
    const app=await createAgent(config,runtime(async()=>outcome),gate);cleanup.push(()=>app.close());
    const db=new Database(join(config.dataDir,'agent.sqlite'));
    db.prepare("INSERT INTO operations(id,request_hash,state,updated_at) VALUES(?,?,'running',?)").run(randomUUID(),'hash',new Date().toISOString());db.close();
    expect(await gate.drain(100)).toEqual({status:'uncertain'});
  });
  it('closes a console and reports uncertainty when Docker shell termination is not proven', async () => {
    const config=fixture(),gate=new AgentMaintenanceGate(),started=deferred<void>();
    const stream=new PassThrough();
    const consoleContainer=vi.fn(async()=>({exec:async()=>({start:async()=>{started.resolve();return stream;}})}));
    const engine={...runtime(async()=>outcome),consoleContainer};
    const app=await createAgent(config,engine as any,gate);cleanup.push(()=>app.close());
    const address=await app.listen({host:'127.0.0.1',port:0});
    const socket=new WebSocket(`${address.replace('http:','ws:')}/services/${randomUUID()}/console`,{headers});
    cleanup.push(()=>socket.terminate());
    await started.promise;
    expect(await gate.drain(1000)).toEqual({status:'uncertain'});
  });
  it('permits maintenance after Docker confirms the closed console process exited', async () => {
    const config=fixture(),gate=new AgentMaintenanceGate(),started=deferred<void>();
    const stream=new PassThrough(),id='a'.repeat(64),containerId='b'.repeat(64),inspect=vi.fn(async()=>({ID:id,ContainerID:containerId,Running:false,Pid:123,ExitCode:0}));
    const consoleContainer=vi.fn(async()=>({id:containerId,exec:async()=>({id,inspect,start:async()=>{started.resolve();return stream;}})}));
    const app=await createAgent(config,{...runtime(async()=>outcome),consoleContainer} as any,gate);cleanup.push(()=>app.close());
    const address=await app.listen({host:'127.0.0.1',port:0});
    const socket=new WebSocket(`${address.replace('http:','ws:')}/services/${randomUUID()}/console`,{headers});
    socket.on('error',()=>{});cleanup.push(()=>socket.terminate());
    await started.promise;const closed=new Promise<void>(resolve=>socket.once('close',()=>resolve()));socket.close();await closed;
    expect(await gate.drain(1000)).toEqual({status:'drained'});expect(inspect).toHaveBeenCalled();
  });
  it('keeps ambiguous Docker exec states uncertain',async()=>{
    const id='a'.repeat(64),containerId='b'.repeat(64),base={ID:id,ContainerID:containerId,Running:false,Pid:123,ExitCode:0};
    for(const state of [{...base,ID:'c'.repeat(64)},{...base,ContainerID:'c'.repeat(64)},{...base,Pid:0},{...base,ExitCode:null},{...base,Running:true}]) {
      const exec={id,inspect:vi.fn(async()=>state)};
      expect(await consoleExecStopped(exec as any,containerId,25)).toBe(false);
    }
    expect(await consoleExecStopped({id,inspect:async()=>{throw new Error('Docker unavailable');}} as any,containerId,25)).toBe(false);
    expect(await consoleExecStopped({id,inspect:()=>new Promise(()=>{})} as any,containerId,25)).toBe(false);
  });
  it('waits for the exact Docker exec to finish before allowing maintenance',async()=>{
    const id='a'.repeat(64),containerId='b'.repeat(64);let calls=0;
    const exec={id,inspect:vi.fn(async()=>({ID:id,ContainerID:containerId,Running:++calls===1,Pid:123,ExitCode:calls===1?null:0}))};
    expect(await consoleExecStopped(exec as any,containerId,1000)).toBe(true);
    expect(calls).toBe(2);
  });
  it('does not start an exec after its console has already closed',async()=>{
    const config=fixture(),gate=new AgentMaintenanceGate(),entered=deferred<void>(),created=deferred<any>();
    const start=vi.fn(),consoleContainer=vi.fn(async()=>({id:'b'.repeat(64),exec:async()=>{entered.resolve();return created.promise;}}));
    const app=await createAgent(config,{...runtime(async()=>outcome),consoleContainer} as any,gate);cleanup.push(()=>app.close());
    const address=await app.listen({host:'127.0.0.1',port:0});
    const socket=new WebSocket(`${address.replace('http:','ws:')}/services/${randomUUID()}/console`,{headers});
    socket.on('error',()=>{});cleanup.push(()=>socket.terminate());await entered.promise;
    const closed=new Promise<void>(resolve=>socket.once('close',()=>resolve()));socket.close();await closed;
    await new Promise(resolve=>setTimeout(resolve,30));
    created.resolve({id:'a'.repeat(64),start});
    expect(await gate.drain(1000)).toEqual({status:'drained'});expect(start).not.toHaveBeenCalled();
  });
  it('keeps an uncertain Docker start failure blocked',async()=>{
    const config=fixture(),gate=new AgentMaintenanceGate();
    const consoleContainer=vi.fn(async()=>({id:'b'.repeat(64),exec:async()=>({id:'a'.repeat(64),start:async()=>{throw new Error('Docker connection lost');}})}));
    const app=await createAgent(config,{...runtime(async()=>outcome),consoleContainer} as any,gate);cleanup.push(()=>app.close());
    const address=await app.listen({host:'127.0.0.1',port:0});
    const socket=new WebSocket(`${address.replace('http:','ws:')}/services/${randomUUID()}/console`,{headers});
    socket.on('error',()=>{});cleanup.push(()=>socket.terminate());
    await new Promise<void>(resolve=>socket.once('close',()=>resolve()));
    expect(await gate.drain(1000)).toEqual({status:'uncertain'});
  });
  it('rejects a console whose asynchronous validation races with drain', async () => {
    const config=fixture(),gate=new AgentMaintenanceGate(),entered=deferred<void>(),complete=deferred<any>();
    const consoleContainer=vi.fn(async()=>{entered.resolve();return complete.promise;});
    const app=await createAgent(config,{...runtime(async()=>outcome),consoleContainer} as any,gate);cleanup.push(()=>app.close());
    const address=await app.listen({host:'127.0.0.1',port:0});
    const socket=new WebSocket(`${address.replace('http:','ws:')}/services/${randomUUID()}/console`,{headers});
    socket.on('error',()=>{});cleanup.push(()=>socket.terminate());
    await entered.promise;
    const draining=gate.drain(1000);
    complete.resolve({exec:vi.fn()});
    expect(await draining).toEqual({status:'drained'});
    await new Promise<void>(resolve=>socket.once('close',()=>resolve()));
    expect(consoleContainer).toHaveBeenCalledTimes(1);
  });
});
