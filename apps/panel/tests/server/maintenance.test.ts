import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { createApp } from '../../src/server/app.js';
import { MaintenanceGate } from '../../src/server/maintenance.js';
import { Store } from '../../src/server/store.js';
import type { agentRequest } from '../../src/agent/client.js';

const cleanup: (()=>Promise<void>)[]=[];
afterEach(async()=>{for(const fn of cleanup.splice(0).reverse())await fn();});
function deferred<T>() { let resolve!:(value:T)=>void; const promise=new Promise<T>(r=>{resolve=r;}); return {promise,resolve}; }
async function fixture(agent?:typeof agentRequest) {
  const dir=mkdtempSync(join(tmpdir(),'panel-maintenance-')), store=new Store(dir), gate=new MaintenanceGate();
  const app=await createApp({dataDir:dir,store,maintenance:gate,agentRequest:agent});
  cleanup.push(async()=>{await app.close();store.close();rmSync(dir,{recursive:true,force:true});});
  const response=await app.inject({method:'POST',url:'/api/v1/setup',payload:{email:'admin@example.test',password:'local-testing-password'}});
  const cookie=`panel_session=${response.cookies.find(item=>item.name==='panel_session')!.value}`;
  const headers={cookie,'x-csrf-token':response.json().csrfToken};
  return {app,gate,store,headers};
}

describe('maintenance barrier',()=>{
  it('rejects new reads and writes while preserving independent health endpoints',async()=>{
    const {app,gate,headers}=await fixture();
    expect(await gate.drain(1000)).toEqual({status:'drained'});
    expect((await app.inject({url:'/api/v1/auth/session',headers})).statusCode).toBe(503);
    expect((await app.inject({method:'POST',url:'/api/v1/auth/logout',headers})).statusCode).toBe(503);
    expect((await app.inject({url:'/api/v1/health'})).statusCode).toBe(200);
    expect((await app.inject({url:'/health'})).statusCode).toBe(200);
  });
  it('waits for an admitted async handler and times out without claiming a drain',async()=>{
    const pending=deferred<{online:boolean}>(); const entered=deferred<void>();
    const dir=mkdtempSync(join(tmpdir(),'panel-maintenance-')),store=new Store(dir),gate=new MaintenanceGate();
    const app=await createApp({dataDir:dir,store,maintenance:gate,runtimeStatus:()=>{entered.resolve();return pending.promise;}});
    cleanup.push(async()=>{await app.close();store.close();rmSync(dir,{recursive:true,force:true});});
    const setup=await app.inject({method:'POST',url:'/api/v1/setup',payload:{email:'admin@example.test',password:'local-testing-password'}});
    const cookie=`panel_session=${setup.cookies.find(item=>item.name==='panel_session')!.value}`;
    const request=app.inject({url:'/api/v1/runtime',headers:{cookie}}); await entered.promise;
    expect(await gate.drain(10)).toEqual({status:'timeout'});
    const later=gate.drain(1000);pending.resolve({online:true});expect((await request).statusCode).toBe(200);
    expect(await later).toEqual({status:'drained'});
  });
  it('waits for handler work after an early response is sent',async()=>{
    const pending=deferred<void>(),entered=deferred<void>();
    const dir=mkdtempSync(join(tmpdir(),'panel-maintenance-')),store=new Store(dir),gate=new MaintenanceGate();
    const app=await createApp({dataDir:dir,store,maintenance:gate});
    cleanup.push(async()=>{await app.close();store.close();rmSync(dir,{recursive:true,force:true});});
    app.get('/api/v1/early',async(_req,reply)=>{reply.send({ok:true});entered.resolve();await pending.promise;});
    const request=app.inject({url:'/api/v1/early'});await entered.promise;expect((await request).statusCode).toBe(200);
    expect(await gate.drain(10)).toEqual({status:'timeout'});
    const finish=gate.drain(1000);pending.resolve();expect(await finish).toEqual({status:'drained'});
  });
  it('keeps an aborted request uncertain after its handler eventually completes',async()=>{
    const pending=deferred<{online:boolean}>(),entered=deferred<void>();
    const dir=mkdtempSync(join(tmpdir(),'panel-maintenance-')),store=new Store(dir),gate=new MaintenanceGate();
    const app=await createApp({dataDir:dir,store,maintenance:gate,runtimeStatus:()=>{entered.resolve();return pending.promise;}});
    cleanup.push(async()=>{await app.close();store.close();rmSync(dir,{recursive:true,force:true});});
    const setup=await app.inject({method:'POST',url:'/api/v1/setup',payload:{email:'admin@example.test',password:'local-testing-password'}});
    const cookie=`panel_session=${setup.cookies.find(item=>item.name==='panel_session')!.value}`;
    const address=await app.listen({host:'127.0.0.1',port:0});const controller=new AbortController();
    const request=fetch(`${address}/api/v1/runtime`,{headers:{cookie},signal:controller.signal}).catch(()=>undefined);
    await entered.promise;controller.abort();await request;await new Promise(resolve=>setTimeout(resolve,30));
    expect(await gate.drain(10)).toEqual({status:'timeout'});
    const finish=gate.drain(1000);pending.resolve({online:true});expect(await finish).toEqual({status:'uncertain'});
  });
  it('does not poison a later drain when a static asset download is cancelled',async()=>{
    const dir=mkdtempSync(join(tmpdir(),'panel-maintenance-')), webDir=join(dir,'web'), gate=new MaintenanceGate();
    mkdirSync(join(webDir,'assets'),{recursive:true});writeFileSync(join(webDir,'assets','large.bin'),Buffer.alloc(32*1024*1024));
    const store=new Store(dir),app=await createApp({dataDir:dir,store,maintenance:gate,webDir});
    cleanup.push(async()=>{await app.close();store.close();rmSync(dir,{recursive:true,force:true});});
    let route='';app.addHook('onRequest',async req=>{route=req.routeOptions.url;});
    const address=await app.listen({host:'127.0.0.1',port:0});
    const response=await fetch(`${address}/assets/large.bin`);expect(response.status).toBe(200);
    expect(route).toBe('/*');
    await response.body!.cancel();await new Promise(resolve=>setTimeout(resolve,100));
    expect(await gate.drain(1000)).toEqual({status:'drained'});
  });
  it('still treats a disconnected dynamic asset route as uncertain',async()=>{
    const dir=mkdtempSync(join(tmpdir(),'panel-maintenance-')),store=new Store(dir),gate=new MaintenanceGate();
    const app=await createApp({dataDir:dir,store,maintenance:gate});
    cleanup.push(async()=>{await app.close();store.close();rmSync(dir,{recursive:true,force:true});});
    const entered=deferred<void>(),pending=deferred<void>();
    app.get('/assets/dynamic',async()=>{entered.resolve();await pending.promise;return {ok:true};});
    const address=await app.listen({host:'127.0.0.1',port:0});const controller=new AbortController();
    const request=fetch(`${address}/assets/dynamic`,{signal:controller.signal}).catch(()=>undefined);
    await entered.promise;controller.abort();await request;await new Promise(resolve=>setTimeout(resolve,30));
    pending.resolve();expect(await gate.drain(1000)).toEqual({status:'uncertain'});
  });
  it('closes SSE and waits for an in-flight log poll before claiming drain',async()=>{
    const poll=deferred<{lines:string[]}>(),entered=deferred<void>();
    const agent:typeof agentRequest=async<T>(path:string)=>{if(path.includes('/logs')){entered.resolve();return await poll.promise as T;}throw new Error('unexpected');};
    const {app,gate,store,headers}=await fixture(agent);const project=store.createProject('maintenance');
    const created=await app.inject({method:'POST',url:`/api/v1/projects/${project.id}/services`,headers:{...headers,'idempotency-key':'maint-test'},payload:{name:'web',image:'nginx:alpine',port:80,hostname:'maintenance.localhost'}});
    const service=created.json().service;const address=await app.listen({host:'127.0.0.1',port:0});
    const response=await fetch(`${address}/api/v1/services/${service.id}/logs/stream`,{headers:{cookie:headers.cookie}});
    expect(response.status).toBe(200);await entered.promise;
    expect(await gate.drain(20)).toEqual({status:'timeout'});
    const finish=gate.drain(1000);poll.resolve({lines:['log']});
    expect(await finish).toEqual({status:'drained'});
    await response.body?.cancel();
  });
  it('closes an authenticated websocket awaiting its grant when draining',async()=>{
    const {app,gate,store,headers}=await fixture();const project=store.createProject('maintenance');
    const created=await app.inject({method:'POST',url:`/api/v1/projects/${project.id}/services`,headers:{...headers,'idempotency-key':'maint-ws'},payload:{name:'web',image:'nginx:alpine',port:80,hostname:'maintenance.localhost'}});
    const service=created.json().service;const address=await app.listen({host:'127.0.0.1',port:0});
    const socket=new WebSocket(address.replace('http:','ws:')+`/api/v1/services/${service.id}/console`,{headers:{cookie:headers.cookie,origin:'http://localhost:4180'}});
    await new Promise<void>((resolve,reject)=>{socket.once('open',()=>resolve());socket.once('error',reject);});
    const closed=new Promise<void>(resolve=>socket.once('close',()=>resolve()));
    expect(await gate.drain(1000)).toEqual({status:'drained'});await closed;
  });
});
