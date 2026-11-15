import { afterEach, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import Database from 'better-sqlite3';
import { createAgent } from '../../src/agent/app.js';
import { createApp } from '../../src/server/app.js';
import { Store } from '../../src/server/store.js';
import { hashPassword } from '../../src/server/auth.js';

const cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const fn of cleanup.splice(0).reverse())await fn();});
async function fixture(){
  const dataDir=mkdtempSync(join(tmpdir(),'panel-restore-upload-')),store=new Store(dataDir),socketPath=join(dataDir,'agent.sock'),token='agent-test-token';
  const runtime={status:async()=>({online:true}),inspectService:async()=>({state:'unknown' as const}),apply:async()=>({state:'running' as const,deployedRevision:1,messages:[]})};
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
  const operationId=randomBytes(16).toString('hex'),path=`/api/v1/services/${service.id}/database-restore/${operationId}`;
  return {app,store,headers,project,service,operationId,path};
}

it('checks session, CSRF, project access and origin before accepting an upload',async()=>{
  const {app,store,headers,project,path}=await fixture(), payload=Buffer.from('archive'), upload=`${path}/upload`, content={'content-type':'application/octet-stream'};
  expect((await app.inject({method:'POST',url:upload,headers:content,payload})).statusCode).toBe(401);
  expect((await app.inject({method:'POST',url:upload,headers:{...content,cookie:headers.cookie},payload})).statusCode).toBe(403);
  const viewer=store.createUser('viewer@example.test',await hashPassword('testing-password'));
  store.addMember(project.id,viewer.id,'viewer'); const session=store.createSession(viewer.id);
  expect((await app.inject({method:'POST',url:upload,headers:{...content,cookie:`panel_session=${session.token}`,'x-csrf-token':session.csrfToken},payload})).statusCode).toBe(404);
  expect((await app.inject({method:'POST',url:upload,headers:{...content,...headers,origin:'https://attacker.example'},payload})).statusCode).toBe(403);
  expect((await app.inject({method:'POST',url:upload,headers:{...headers,'content-type':'application/json'},payload:'{}'})).statusCode).toBe(400);
  expect((await app.inject({method:'POST',url:upload.replace(path.split('/').pop()!,'invalid'),headers:{...content,...headers},payload})).statusCode).toBe(400);
});

it('stages, reports and cancels an archive through the authenticated agent',async()=>{
  const {app,store,headers,service,operationId,path}=await fixture(),payload=Buffer.from('private fixture');
  const upload=await app.inject({method:'POST',url:`${path}/upload`,headers:{...headers,'content-type':'application/octet-stream'},payload});
  expect(upload.statusCode).toBe(200); expect(upload.json()).toMatchObject({operationId,size:payload.length,phase:'reserved'});
  const status=await app.inject({url:path,headers}); expect(status.statusCode).toBe(200);expect(status.json()).toEqual({operationId,phase:'reserved',kind:'postgres'});
  expect((await app.inject({method:'POST',url:`${path}/cancel`,headers:{cookie:headers.cookie},payload:{}})).statusCode).toBe(403);
  const cancelled=await app.inject({method:'POST',url:`${path}/cancel`,headers,payload:{}});
  expect(cancelled.statusCode).toBe(200); expect(cancelled.json()).toEqual({operationId,phase:'cancelled'});
  expect((await app.inject({url:path,headers})).json().phase).toBe('cancelled');
  const events=store.db.prepare('SELECT operation FROM audit_events WHERE resource_id=?').all(service.id) as {operation:string}[];
  expect(events.map(event=>event.operation)).toEqual(expect.arrayContaining(['database.restore.upload.started','database.restore.upload.staged','database.restore.cancelled']));
});

it('streams archives larger than the JSON body limit',async()=>{
  const {app,headers,path}=await fixture(),payload=Buffer.alloc(1024*1024,7);
  const response=await app.inject({method:'POST',url:`${path}/upload`,headers:{...headers,'content-type':'application/octet-stream'},payload});
  expect(response.statusCode).toBe(200); expect(response.json().size).toBe(payload.length);
  expect((await app.inject({method:'POST',url:`${path}/cancel`,headers,payload:{}})).statusCode).toBe(200);
});

it('cancels the agent upload when a panel client disconnects mid-stream',async()=>{
  const {app,store,headers,operationId,path}=await fixture();
  const address=new URL(await app.listen({host:'127.0.0.1',port:0}));
  const db=new Database(join(store.dataDir,'agent.sqlite'),{readonly:true});
  const phase=()=> (db.prepare('SELECT phase FROM restore_operations WHERE id=?').get(operationId) as {phase:string}|undefined)?.phase;
  const waitFor=async(expected:string)=>{for(let i=0;i<100;i++){if(phase()===expected)return;await delay(10);}throw new Error(`Restore upload did not reach ${expected}.`);};
  const outgoing=request({hostname:'127.0.0.1',port:address.port,path:`${path}/upload`,method:'POST',headers:{...headers,'content-type':'application/octet-stream','content-length':'10000'}});
  outgoing.on('error',()=>{});outgoing.write('partial restore data');
  try{await waitFor('uploading');outgoing.destroy();await waitFor('cancelled');}
  finally{outgoing.destroy();db.close();}
});
