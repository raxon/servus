import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/server/app.js';
import { Store } from '../../src/server/store.js';
import { hashPassword } from '../../src/server/auth.js';
import { normalizeServiceInput } from '../../src/server/configuration.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.unstubAllEnvs(); });
async function fixture() {
  const dataDir=mkdtempSync(join(tmpdir(),'database-access-')),store=new Store(dataDir);
  let network: {aliases:string[];publishedPort:number|null;revision:number}={aliases:['database'],publishedPort:null,revision:1};
  const agentRequest=vi.fn(async(path:string)=>{if(path.endsWith('/database-network'))return network;throw new Error('Runtime unavailable');});
  const app=await createApp({dataDir,store,agentRequest:agentRequest as never});
  cleanup.push(async()=>{await app.close();store.close();rmSync(dataDir,{recursive:true,force:true});});
  const setup=await app.inject({method:'POST',url:'/api/v1/setup',payload:{email:'admin@example.test',password:'testing-password'}});
  const headers={cookie:`panel_session=${setup.cookies.find(cookie=>cookie.name==='panel_session')!.value}`,'x-csrf-token':setup.json().csrfToken};
  const admin=store.getSession(headers.cookie.slice('panel_session='.length))!.user,project=store.createProject('project');
  const created=store.createService(project.id,normalizeServiceInput({name:'database',kind:'postgres'}),admin.id);
  const complete=()=>{const job=store.claimNextJob('worker',60_000)!;expect(job).toBeTruthy();store.completeAction(job.actionId,'worker',{state:'running',deployedRevision:job.snapshot.revision});return job;};
  complete();
  return {app,store,headers,admin,project,service:created.service,complete,agentRequest,setNetwork:(value:typeof network)=>{network=value;}};
}

it('keeps databases private by default and returns only a verified short network alias',async()=>{
  const f=await fixture(),url=`/api/v1/services/${f.service.id}/connection`;
  let result=await f.app.inject({url,headers:f.headers});
  expect(result.statusCode).toBe(200);
  expect(result.json()).toMatchObject({host:'database',legacyHost:`panel-app-${f.service.id}`,runtimeVerified:true,externalAccess:{saved:{enabled:false},deployed:{enabled:false},pendingChanges:false,host:null}});
  f.setNetwork({aliases:['another-alias'],publishedPort:null,revision:1});
  result=await f.app.inject({url,headers:f.headers});expect(result.json().host).toBe(`panel-app-${f.service.id}`);
  f.agentRequest.mockRejectedValue(new Error('Runtime unavailable'));
  result=await f.app.inject({url,headers:f.headers});expect(result.json()).toMatchObject({host:`panel-app-${f.service.id}`,runtimeVerified:false});
});

it('requires administrator rights and CSRF for external access changes through create and patch',async()=>{
  const f=await fixture(),url=`/api/v1/services/${f.service.id}`;
  const member= f.store.createUser('member@example.test',await hashPassword('testing-password'));
  f.store.addMember(f.project.id,member.id,'editor');const session=f.store.createSession(member.id),headers={cookie:`panel_session=${session.token}`,'x-csrf-token':session.csrfToken};
  for(const databaseAccess of [{enabled:true,publishedPort:15432},{enabled:false}]) {
    expect((await f.app.inject({method:'PATCH',url,headers,payload:{expectedRevision:1,databaseAccess}})).statusCode).toBe(403);
    expect((await f.app.inject({method:'POST',url:`/api/v1/projects/${f.project.id}/services`,headers:{...headers,'idempotency-key':`member-${databaseAccess.enabled}`},payload:{name:'another',kind:'postgres',databaseAccess}})).statusCode).toBe(403);
  }
  expect((await f.app.inject({method:'PATCH',url,headers:{cookie:f.headers.cookie},payload:{expectedRevision:1,databaseAccess:{enabled:true,publishedPort:15432}}})).statusCode).toBe(403);
  expect((await f.app.inject({method:'PATCH',url,headers:f.headers,payload:{expectedRevision:1,databaseAccess:{enabled:true,publishedPort:15432}}})).statusCode).toBe(200);
  expect((await f.app.inject({method:'PATCH',url,headers:f.headers,payload:{expectedRevision:1,databaseAccess:{enabled:false}}})).statusCode).toBe(409);
});

it('validates port range, reserved listeners and database-only configuration',async()=>{
  const f=await fixture(),url=`/api/v1/services/${f.service.id}`;
  for(const publishedPort of [0,22,443,1023,2375,2376,2377,4180,4181,4182,4789,7946,65536,15432.5]) expect((await f.app.inject({method:'PATCH',url,headers:f.headers,payload:{expectedRevision:1,databaseAccess:{enabled:true,publishedPort}}})).statusCode).toBe(400);
  expect((await f.app.inject({method:'PATCH',url,headers:f.headers,payload:{expectedRevision:1,databaseAccess:{enabled:true}}})).statusCode).toBe(400);
  vi.stubEnv('PANEL_PORT','15432');
  expect((await f.app.inject({method:'PATCH',url,headers:f.headers,payload:{expectedRevision:1,databaseAccess:{enabled:true,publishedPort:15432}}})).statusCode).toBe(400);
  expect(()=>normalizeServiceInput({name:'app',image:'nginx:alpine',domains:[],databaseAccess:{enabled:true,publishedPort:25432}})).toThrow('belongs to managed databases');
});

it('separates saved access from the deployed listener and preserves credentials',async()=>{
  const f=await fixture(),url=`/api/v1/services/${f.service.id}`,reference=f.service.database!.passwordSecretRef;
  const patch=await f.app.inject({method:'PATCH',url,headers:f.headers,payload:{expectedRevision:1,databaseAccess:{enabled:true,publishedPort:15432}}});
  expect(patch.statusCode).toBe(200);expect(patch.json().database.passwordSecretRef).toBe(reference);
  let response=await f.app.inject({url:`${url}/connection`,headers:f.headers});
  expect(response.json().externalAccess).toMatchObject({saved:{enabled:true,publishedPort:15432},deployed:{enabled:false},pendingChanges:true});
  expect(f.store.configurationChanges(f.service.id).sections).toContain('External database access');
  f.store.createAction(f.service.id,'deploy',f.admin.id,'publish');f.complete();
  f.setNetwork({aliases:['database'],publishedPort:15432,revision:2});
  response=await f.app.inject({url:`${url}/connection`,headers:f.headers});
  expect(response.json()).toMatchObject({host:'database',runtimeVerified:true,deployedRevision:2,externalAccess:{saved:{enabled:true,publishedPort:15432},deployed:{enabled:true,publishedPort:15432},pendingChanges:false}});
  f.setNetwork({aliases:['database'],publishedPort:null,revision:2});
  expect((await f.app.inject({url:`${url}/connection`,headers:f.headers})).json().runtimeVerified).toBe(false);
});

it('reserves saved, queued, deployed and uncertain failed ports until a successful private deployment',async()=>{
  const f=await fixture(),input=(name:string)=>normalizeServiceInput({name,kind:'postgres',databaseAccess:{enabled:true,publishedPort:15432}});
  const enabled=f.store.updateService(f.service.id,{expectedRevision:1,databaseAccess:{enabled:true,publishedPort:15432}});
  expect(()=>f.store.createService(f.project.id,input('conflict-saved'),f.admin.id)).toThrow('reserved');
  f.store.createAction(f.service.id,'deploy',f.admin.id,'publish');
  f.store.updateService(f.service.id,{expectedRevision:enabled.revision,databaseAccess:{enabled:false}});
  expect(()=>f.store.createService(f.project.id,input('conflict-queued'),f.admin.id)).toThrow('reserved');
  const job=f.store.claimNextJob('worker',60_000)!;f.store.failAction(job.actionId,'worker','fixture uncertain failure');
  expect(()=>f.store.createService(f.project.id,input('conflict-failed'),f.admin.id)).toThrow('reserved');
  f.store.createAction(f.service.id,'deploy',f.admin.id,'private');f.complete();
  const another=f.store.createService(f.project.id,input('available'),f.admin.id).service;
  f.complete();
  f.store.updateService(another.id,{expectedRevision:1,databaseAccess:{enabled:false}});
  expect(()=>f.store.createService(f.project.id,input('conflict-deployed'),f.admin.id)).toThrow('reserved');
  expect(f.store.listServices()).toHaveLength(2);
});

it.each(['GET','POST'] as const)('rechecks revoked sessions after live inspection on %s connection requests',async method=>{
  const f=await fixture(),url=`/api/v1/services/${f.service.id}/connection${method==='POST'?'/reveal':''}`;
  const read=vi.spyOn(f.store.vault,'get');
  f.agentRequest.mockImplementation(async()=>{
    expect(read).not.toHaveBeenCalled();
    f.store.deleteSession(f.headers.cookie.slice('panel_session='.length));
    return {aliases:['database'],publishedPort:null,revision:1};
  });
  const response=await f.app.inject({method,url,headers:f.headers,...(method==='POST'?{payload:{}}:{})});
  expect(response.statusCode).toBe(401);expect(read).not.toHaveBeenCalled();
  expect((f.store.db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE operation='connection.reveal'").get() as {n:number}).n).toBe(0);
});

it('keeps deploy authorization on the normal durable action route',async()=>{
  const f=await fixture(),url=`/api/v1/services/${f.service.id}/deploy`;
  const viewer=f.store.createUser('viewer@example.test',await hashPassword('testing-password'));
  f.store.addMember(f.project.id,viewer.id,'viewer');const session=f.store.createSession(viewer.id);
  expect((await f.app.inject({method:'POST',url,headers:{cookie:`panel_session=${session.token}`,'x-csrf-token':session.csrfToken,'idempotency-key':'viewer'},payload:{}})).statusCode).toBe(404);
  expect((await f.app.inject({method:'POST',url,headers:{cookie:f.headers.cookie,'idempotency-key':'no-csrf'},payload:{}})).statusCode).toBe(403);
  expect((await f.app.inject({method:'POST',url,headers:{...f.headers,'idempotency-key':'authorized'},payload:{}})).statusCode).toBe(202);
});

it('suggests only server-selected unreserved ports without saving or deploying',async()=>{
  const f=await fixture(),url=`/api/v1/services/${f.service.id}/database-port-suggestion`;
  const reserved=f.store.updateService(f.service.id,{expectedRevision:1,databaseAccess:{enabled:true,publishedPort:15432}});
  const before=f.store.listActions(undefined,f.service.id).length;
  f.agentRequest.mockImplementation(async(path:string,...args:unknown[])=>{
    expect(path).toBe(`/services/${f.service.id}/database-port-suggestion`);
    const {candidates}=args[0] as {candidates:number[]};
    expect(candidates.length).toBe(64);expect(candidates).not.toContain(15432);
    return {port:candidates[0]} as never;
  });
  const result=await f.app.inject({url,headers:{cookie:f.headers.cookie}});
  expect(result.statusCode).toBe(200);expect(result.json().port).toBeGreaterThanOrEqual(10000);
  expect(f.store.getService(f.service.id)!.revision).toBe(reserved.revision);
  expect(f.store.listActions(undefined,f.service.id)).toHaveLength(before);
  expect((await f.app.inject({url:`${url}?port=15432`,headers:f.headers})).statusCode).toBe(400);
});

it('requires an administrator session and database service before port inspection',async()=>{
  const f=await fixture(),url=`/api/v1/services/${f.service.id}/database-port-suggestion`;
  expect((await f.app.inject({url})).statusCode).toBe(401);
  expect((await f.app.inject({url,headers:{authorization:'Bearer arbitrary',...f.headers}})).statusCode).toBe(403);
  const member=f.store.createUser('port-member@example.test',await hashPassword('testing-password'));
  f.store.addMember(f.project.id,member.id,'editor');const session=f.store.createSession(member.id);
  expect((await f.app.inject({url,headers:{cookie:`panel_session=${session.token}`}})).statusCode).toBe(403);
  const app=f.store.createService(f.project.id,normalizeServiceInput({name:'app',image:'nginx:alpine',domains:[]}),f.admin.id).service;
  expect((await f.app.inject({url:`/api/v1/services/${app.id}/database-port-suggestion`,headers:f.headers})).statusCode).toBe(400);
  expect(f.agentRequest).not.toHaveBeenCalled();
});

it('fails closed on unavailable, invalid, occupied and revoked-session port checks',async()=>{
  const f=await fixture(),url=`/api/v1/services/${f.service.id}/database-port-suggestion`;
  f.agentRequest.mockResolvedValue({port:null} as never);
  expect((await f.app.inject({url,headers:f.headers})).statusCode).toBe(409);
  f.agentRequest.mockResolvedValue({port:22} as never);
  expect((await f.app.inject({url,headers:f.headers})).statusCode).toBe(503);
  f.agentRequest.mockRejectedValue(new Error('offline'));
  expect((await f.app.inject({url,headers:f.headers})).statusCode).toBe(503);
  f.agentRequest.mockImplementation(async()=>{f.store.deleteSession(f.headers.cookie.slice('panel_session='.length));return {port:null} as never;});
  expect((await f.app.inject({url,headers:f.headers})).statusCode).toBe(401);
});
