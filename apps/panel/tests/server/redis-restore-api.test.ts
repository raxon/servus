import { afterEach, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/server/app.js';
import { Store } from '../../src/server/store.js';
import { normalizeServiceInput } from '../../src/server/configuration.js';
import type { agentRequest } from '../../src/agent/client.js';

const cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();vi.restoreAllMocks();});
async function fixture(kind:'redis'|'postgres'='redis') {
  const dataDir=mkdtempSync(join(tmpdir(),'redis-restore-api-')),store=new Store(dataDir),actor=store.setup('admin@example.test','unused-hash'),project=store.createProject('fixture'),{service}=store.createService(project.id,normalizeServiceInput({name:'database',kind}),actor.id),job=store.claimNextJob('fixture',60_000)!;store.completeAction(job.actionId,'fixture',{state:'running',deployedRevision:1});
  const id=randomBytes(16).toString('hex'),operation={operationId:id,kind,phase:'completed',canRollback:true},request=vi.fn(async(path:string)=>path.endsWith('/recover')||path.endsWith('/rollback')?{operationId:id,phase:'cancelled',rolledBack:true}:{operation});
  const app=await createApp({dataDir,store,agentRequest:request as typeof agentRequest});cleanup.push(async()=>{await app.close();store.close();rmSync(dataDir,{recursive:true,force:true});});
  const session=store.createSession(actor.id),headers={cookie:`panel_session=${session.token}`,'x-csrf-token':session.csrfToken},base=`/api/v1/services/${service.id}/database-restore`;
  return {app,store,actor,project,service,id,request,headers,base};
}

it('exposes Redis rollback state without exposing a recovery plan or credentials',async()=>{
  const {app,base,headers,id}=await fixture(),response=await app.inject({url:base,headers});expect(response.statusCode).toBe(200);expect(response.json()).toEqual({operation:{operationId:id,kind:'redis',phase:'completed',canRollback:true}});expect(response.payload).not.toContain('sealed_plan');
});

it('requires authenticated project write access, CSRF and trusted origin before rollback or recovery',async()=>{
  const {app,store,project,base,id,headers,request}=await fixture();
  for(const action of ['rollback','recover']) {
    const url=`${base}/${id}/${action}`,payload=action==='rollback'?{confirm:true}:{};
    expect((await app.inject({method:'POST',url,payload})).statusCode).toBe(401);
    expect((await app.inject({method:'POST',url,headers:{cookie:headers.cookie},payload})).statusCode).toBe(403);
    expect((await app.inject({method:'POST',url,headers:{...headers,origin:'https://foreign.example'},payload})).statusCode).toBe(403);
  }
  const stranger=store.createUser('stranger@example.test','unused'),session=store.createSession(stranger.id),foreign={cookie:`panel_session=${session.token}`,'x-csrf-token':session.csrfToken};
  for(const role of ['foreign','viewer']){if(role==='viewer')store.addMember(project.id,stranger.id,'viewer');expect((await app.inject({url:base,headers:foreign})).statusCode).toBe(404);for(const action of ['rollback','recover'])expect((await app.inject({method:'POST',url:`${base}/${id}/${action}`,headers:foreign,payload:action==='rollback'?{confirm:true}:{}})).statusCode).toBe(404);}
  expect(request).not.toHaveBeenCalled();
});

it('requires explicit rollback confirmation, accepts recovery and records the verified outcome',async()=>{
  const {app,store,base,id,headers}=await fixture();expect((await app.inject({method:'POST',url:`${base}/${id}/rollback`,headers,payload:{}})).statusCode).toBe(400);
  expect((await app.inject({method:'POST',url:`${base}/${id}/recover`,headers,payload:{extra:true}})).statusCode).toBe(400);
  const result=await app.inject({method:'POST',url:`${base}/${id}/rollback`,headers,payload:{confirm:true}});expect(result.statusCode).toBe(200);expect(result.json()).toEqual({operationId:id,phase:'cancelled',rolledBack:true});
  expect((await app.inject({method:'POST',url:`${base}/${id}/recover`,headers,payload:{}})).statusCode).toBe(200);expect((store.db.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE operation='database.restore.rollback.cancelled'").get() as {count:number}).count).toBe(1);
});

it('rejects contradictory recovery results and keeps these new actions limited to Redis',async()=>{
  const redis=await fixture();redis.request.mockResolvedValueOnce({operationId:redis.id,phase:'completed',rolledBack:true} as never);expect((await redis.app.inject({method:'POST',url:`${redis.base}/${redis.id}/recover`,headers:redis.headers,payload:{}})).statusCode).toBe(503);
  const postgres=await fixture('postgres');expect((await postgres.app.inject({method:'POST',url:`${postgres.base}/${postgres.id}/rollback`,headers:postgres.headers,payload:{confirm:true}})).statusCode).toBe(404);expect(postgres.request).not.toHaveBeenCalled();
});
