import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import Database from 'better-sqlite3';
import WebSocket from 'ws';
import { createAgent } from '../../src/agent/app.js';
import { AgentMaintenanceGate } from '../../src/agent/maintenance.js';

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
