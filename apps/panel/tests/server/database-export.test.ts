import { afterEach, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { createApp } from '../../src/server/app.js';
import { Store } from '../../src/server/store.js';
import { hashPassword } from '../../src/server/auth.js';
import { createAgent } from '../../src/agent/app.js';

const cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const fn of cleanup.splice(0).reverse())await fn();vi.unstubAllEnvs();});
async function fixture(){
  const dataDir=mkdtempSync(join(tmpdir(),'panel-export-')),store=new Store(dataDir);
  const exportRequest=vi.fn(async()=>Object.assign(Readable.from([Buffer.from('data')]),{headers:{'content-length':'4','x-export-extension':'dump'}}) as IncomingMessage);
  const app=await createApp({dataDir,store,databaseExport:exportRequest});
  cleanup.push(async()=>{await app.close();store.close();rmSync(dataDir,{recursive:true,force:true});});
  const setup=await app.inject({method:'POST',url:'/api/v1/setup',payload:{email:'admin@example.test',password:'testing-password'}});
  const headers={cookie:`panel_session=${setup.cookies.find(cookie=>cookie.name==='panel_session')!.value}`,'x-csrf-token':setup.json().csrfToken};
  const project=store.createProject('fixture');
  const created=await app.inject({method:'POST',url:`/api/v1/projects/${project.id}/services`,headers:{...headers,'idempotency-key':'create'},payload:{name:'database',kind:'postgres',database:{database:'app',user:'app'}}});
  expect(created.statusCode).toBe(202);
  const service=created.json().service,job=store.claimNextJob('worker',60000)!;
  store.completeAction(job.actionId,'worker',{state:'running',deployedRevision:job.snapshot.revision});
  return {app,store,headers,service,project,exportRequest};
}

it('requires a session, CSRF and project write access before an export',async()=>{
  const {app,store,headers,service,project,exportRequest}=await fixture(),url=`/api/v1/services/${service.id}/database-export`;
  expect((await app.inject({method:'POST',url,payload:{}})).statusCode).toBe(401);
  expect((await app.inject({method:'POST',url,headers:{cookie:headers.cookie},payload:{}})).statusCode).toBe(403);
  const viewer=store.createUser('viewer@example.test',await hashPassword('testing-password'));
  store.addMember(project.id,viewer.id,'viewer');const session=store.createSession(viewer.id);
  expect((await app.inject({method:'POST',url,headers:{cookie:`panel_session=${session.token}`,'x-csrf-token':session.csrfToken},payload:{}})).statusCode).toBe(404);
  expect(exportRequest).not.toHaveBeenCalled();
});

it('streams the confirmed database export and records an audit event',async()=>{
  const {app,store,headers,service,exportRequest}=await fixture();
  const prepared=await app.inject({method:'POST',url:`/api/v1/services/${service.id}/database-export`,headers,payload:{}});
  expect(prepared.statusCode).toBe(200);
  const ticket=prepared.cookies.find(cookie=>cookie.name==='panel_export')!;
  expect(ticket.httpOnly).toBe(true);
  const url=prepared.json().downloadUrl,cookie=`${headers.cookie}; panel_export=${ticket.value}`;
  const response=await app.inject({url,headers:{cookie}});
  expect(response.statusCode).toBe(200);expect(response.rawPayload.toString()).toBe('data');
  expect(response.headers['content-disposition']).toContain(`servus-${service.id}.dump`);
  expect(exportRequest).toHaveBeenCalledWith(service.id,{kind:'postgres',database:'app',user:'app'},undefined);
  expect((store.db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE operation='database.export.download'").get() as {n:number}).n).toBe(1);
  expect((await app.inject({url,headers:{cookie}})).statusCode).toBe(404);
});

it('binds each one-use download to the originating session',async()=>{
  const {app,store,headers,service}=await fixture();
  const prepared=await app.inject({method:'POST',url:`/api/v1/services/${service.id}/database-export`,headers,payload:{}});
  const ticket=prepared.cookies.find(cookie=>cookie.name==='panel_export')!;
  const user=store.getSession(headers.cookie.slice('panel_session='.length))!.user;
  const other=store.createSession(user.id);
  const cookie=`panel_session=${other.token}; panel_export=${ticket.value}`;
  expect((await app.inject({url:prepared.json().downloadUrl,headers:{cookie}})).statusCode).toBe(404);
});

it('streams a prepared export through the authenticated agent socket',async()=>{
  const dataDir=mkdtempSync(join(tmpdir(),'panel-export-socket-'));
  const executable=join(dataDir,'docker');writeFileSync(executable,'#!/bin/sh\nprintf export-data\n');chmodSync(executable,0o700);
  vi.stubEnv('PATH',dataDir+delimiter+(process.env.PATH||''));
  const store=new Store(dataDir),socketPath=join(dataDir,'agent.sock'),token='agent-test-token';
  const container={id:'a'.repeat(64),inspect:async()=>({Config:{Env:['POSTGRES_DB=app','POSTGRES_USER=app']}})};
  const runtime={status:async()=>({online:true}),inspectService:async()=>({state:'unknown' as const}),apply:async()=>({state:'running' as const,deployedRevision:1,messages:[]}),consoleContainer:async()=>container};
  const agent=await createAgent({dataDir,token,socketPath,dockerSocket:'/unused',ingressPort:18080,ingressImage:'unused'},runtime as never);
  await agent.listen({path:socketPath});
  const app=await createApp({dataDir,store,agentConnection:{socketPath,token}});
  cleanup.push(async()=>{await app.close();await agent.close();store.close();rmSync(dataDir,{recursive:true,force:true});});
  const setup=await app.inject({method:'POST',url:'/api/v1/setup',payload:{email:'admin@example.test',password:'testing-password'}});
  const headers={cookie:`panel_session=${setup.cookies.find(cookie=>cookie.name==='panel_session')!.value}`,'x-csrf-token':setup.json().csrfToken};
  const project=store.createProject('fixture');
  const created=await app.inject({method:'POST',url:`/api/v1/projects/${project.id}/services`,headers:{...headers,'idempotency-key':'create'},payload:{name:'database',kind:'postgres',database:{database:'app',user:'app'}}});
  const service=created.json().service,job=store.claimNextJob('worker',60000)!;
  store.completeAction(job.actionId,'worker',{state:'running',deployedRevision:job.snapshot.revision});
  const prepared=await app.inject({method:'POST',url:`/api/v1/services/${service.id}/database-export`,headers,payload:{}});
  expect(prepared.statusCode).toBe(200);
  const ticket=prepared.cookies.find(cookie=>cookie.name==='panel_export')!;
  const result=await app.inject({url:prepared.json().downloadUrl,headers:{cookie:`${headers.cookie}; panel_export=${ticket.value}`}});
  expect(result.statusCode).toBe(200);expect(result.rawPayload.toString()).toBe('export-data');
});
