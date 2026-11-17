import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '../../src/server/store.js';
import {createApp} from '../../src/server/app.js';
import {hashPassword} from '../../src/server/auth.js';
import type {agentRequest} from '../../src/agent/client.js';

const cleanup:(()=>Promise<void>)[]=[];afterEach(async()=>{for(const dispose of cleanup.splice(0).reverse())await dispose();});
const input={name:'stack',source:{type:'inline',yaml:'services:\n  web:\n    image: nginx:alpine\n    environment: {TOKEN: "compose-secret-fixture"}\n'},domains:[]};
async function fixture(){
  const root=mkdtempSync(join(tmpdir(),'servus-compose-api-')),store=new Store(root);
  let read:()=>Promise<unknown>=async()=>({logs:'runtime log'});
  let apply:(body:unknown)=>Promise<unknown>=async body=>{const value=body as{type:string;revision:number};return{state:value.type==='stop'?'stopped':value.type==='destroy'?'deleted':'running',revision:value.revision,logs:'completed'};};
  const calls:unknown[]=[];
  const agent:typeof agentRequest=async<T>(path:string,body?:unknown)=>{calls.push({path,body});if(path==='/compose/apply')return await apply(body) as T;return await read() as T;};
  const app=await createApp({dataDir:root,store,agentRequest:agent});cleanup.push(async()=>{await app.close();store.close();rmSync(root,{recursive:true,force:true});});
  const setup=await app.inject({method:'POST',url:'/api/v1/setup',payload:{email:'admin@example.test',password:'fixture-local-password'}}),headers={cookie:`panel_session=${setup.cookies.find(item=>item.name==='panel_session')!.value}`,'x-csrf-token':setup.json().csrfToken},project=store.createProject('compose');
  const create=(body:unknown=input,key=randomUUID())=>app.inject({method:'POST',url:`/api/v1/projects/${project.id}/compose`,headers:{...headers,'idempotency-key':key},payload:body});
  return{store,app,project,headers,create,calls,setRead:(value:()=>Promise<unknown>)=>{read=value;},setApply:(value:(body:unknown)=>Promise<unknown>)=>{apply=value;}};
}

describe('Compose project API',()=>{
  it('accepts isolated inline Dockerfile builds and rejects unavailable local contexts',async()=>{
    const f=await fixture();
    const response=await f.create({...input,source:{type:'inline',yaml:'services:\n  web:\n    build:\n      dockerfile_inline: |\n        FROM nginx:alpine\n'}});expect(response.statusCode).toBe(202);
    const id=response.json().workload.id;
    const configuration=await f.app.inject({url:`/api/v1/compose/${id}/configuration`,headers:f.headers});expect(configuration.json().source.yaml).toContain('dockerfile_inline');
    expect((await f.create({...input,name:'local-build',source:{type:'inline',yaml:'services: {web: {build: .}}'}})).statusCode).toBe(400);
    expect((await f.create({...input,name:'privileged-build',source:{type:'inline',yaml:'services: {web: {build: {dockerfile_inline: "FROM scratch", privileged: true}}}'}})).statusCode).toBe(400);
  });
  it.each(['success','failure'] as const)('fences a stale worker after its lease is replaced: %s',async outcome=>{
    const f=await fixture();let resolve!:(value:unknown)=>void,reject!:(error:Error)=>void;const pending=new Promise((yes,no)=>{resolve=yes;reject=no;});f.setApply(()=>pending);
    const response=await f.create(),id=response.json().workload.id,actionId=response.json().action.id;
    await vi.waitFor(()=>expect(f.calls.some((entry:any)=>entry.path==='/compose/apply')).toBe(true));
    f.store.db.prepare('UPDATE compose_actions SET worker_id=?,lease_until=? WHERE id=?').run('replacement-worker',new Date(Date.now()+60000).toISOString(),actionId);
    if(outcome==='success')resolve({state:'running',revision:1,logs:'obsolete result'});else reject(new Error('obsolete worker failure'));
    await new Promise(resolvePromise=>setImmediate(resolvePromise));
    const row=f.store.db.prepare('SELECT status,worker_id,error FROM compose_actions WHERE id=?').get(actionId);
    expect(row).toMatchObject({status:'running',worker_id:'replacement-worker',error:null});
    expect(f.store.db.prepare('SELECT state,last_error FROM compose_workloads WHERE id=?').get(id)).toEqual({state:'pending',last_error:null});
  });
  it('encrypts sources and supports creation idempotency without leaking YAML in reads',async()=>{
    const f=await fixture(),key=randomUUID(),first=await f.create(input,key);expect(first.statusCode).toBe(202);const id=first.json().workload.id;
    const again=await f.create(input,key);expect(again.statusCode).toBe(202);expect(again.json().workload.id).toBe(id);expect(again.json().action.id).toBe(first.json().action.id);
    expect((await f.create({...input,name:'different'},key)).statusCode).toBe(409);
    const rows=JSON.stringify(f.store.db.prepare('SELECT configuration FROM compose_workloads').all())+JSON.stringify(f.store.db.prepare('SELECT snapshot FROM compose_actions').all());expect(rows).not.toContain('compose-secret-fixture');expect(rows).toContain('enc:v1:');
    const list=await f.app.inject({url:`/api/v1/projects/${f.project.id}/compose`,headers:f.headers});expect(list.body).not.toContain('compose-secret-fixture');
    const reveal=await f.app.inject({url:`/api/v1/compose/${id}/configuration`,headers:f.headers});expect(reveal.statusCode).toBe(200);expect(reveal.json().source.yaml).toContain('compose-secret-fixture');
    const updated=await f.app.inject({method:'PATCH',url:`/api/v1/compose/${id}`,headers:f.headers,payload:{...input,expectedRevision:1}});expect(updated.statusCode).toBe(400);
    const {name,...configuration}=input;expect(name).toBe('stack');
    expect((await f.app.inject({method:'PATCH',url:`/api/v1/compose/${id}`,headers:f.headers,payload:{...configuration,expectedRevision:1}})).statusCode).toBe(200);
    expect((await f.app.inject({method:'PATCH',url:`/api/v1/compose/${id}`,headers:f.headers,payload:{...configuration,expectedRevision:1}})).statusCode).toBe(409);
  });
  it('enforces CSRF, project write permissions and source reveal permissions',async()=>{
    const f=await fixture(),created=await f.create(),id=created.json().workload.id;
    expect((await f.app.inject({method:'POST',url:`/api/v1/projects/${f.project.id}/compose`,headers:{cookie:f.headers.cookie,'idempotency-key':randomUUID()},payload:{...input,name:'csrf'}})).statusCode).toBe(403);
    for(const role of ['viewer','outsider'] as const){const user=f.store.createUser(`${role}@example.test`,await hashPassword('fixture-member-password'));if(role==='viewer')f.store.addMember(f.project.id,user.id,'viewer');const session=f.store.createSession(user.id),headers={cookie:`panel_session=${session.token}`,'x-csrf-token':session.csrfToken,'idempotency-key':randomUUID()};
      expect((await f.app.inject({method:'POST',url:`/api/v1/compose/${id}/deploy`,headers})).statusCode).toBe(404);
      expect((await f.app.inject({url:`/api/v1/compose/${id}/configuration`,headers})).statusCode).toBe(404);
      expect((await f.app.inject({url:`/api/v1/compose/${id}`,headers})).statusCode).toBe(role==='viewer'?200:404);
    }
  });
  it('rejects unsafe definitions, invalid HTTPS hostnames and domain collisions',async()=>{
    const f=await fixture();
    expect((await f.create({...input,source:{type:'inline',yaml:'services: {web: {image: nginx, privileged: true}}'}})).statusCode).toBe(400);
    expect((await f.create({...input,domains:[{hostname:'compose.localhost',service:'web',port:80,https:true}]})).statusCode).toBe(400);
    const first=await f.create({...input,domains:[{hostname:'compose.localhost',service:'web',port:80}]});expect(first.statusCode).toBe(202);
    const second=await f.create({...input,name:'other',domains:[{hostname:'compose.localhost',service:'web',port:80}]});expect(second.statusCode).toBe(409);
    const conflict=await f.app.inject({method:'POST',url:`/api/v1/projects/${f.project.id}/services`,headers:{...f.headers,'idempotency-key':randomUUID()},payload:{name:'swarm',image:'nginx:alpine',hostname:'compose.localhost',port:80}});expect(conflict.statusCode).toBe(409);
  });
  it('rechecks membership after awaiting runtime logs',async()=>{
    const f=await fixture(),created=await f.create(),id=created.json().workload.id;
    const user=f.store.createUser('reader@example.test',await hashPassword('fixture-reader-password'));f.store.addMember(f.project.id,user.id,'viewer');const session=f.store.createSession(user.id);
    let release!:(value:unknown)=>void;const pending=new Promise(resolve=>{release=resolve;});let started=false;f.setRead(()=>{started=true;return pending;});
    const request=f.app.inject({url:`/api/v1/compose/${id}/logs`,headers:{cookie:`panel_session=${session.token}`}});const result=request.then(value=>value);
    await vi.waitFor(()=>expect(started).toBe(true));f.store.db.prepare('DELETE FROM memberships WHERE project_id=? AND user_id=?').run(f.project.id,user.id);release({logs:'must-not-be-returned'});
    const response=await result;expect(response.statusCode).toBe(404);expect(response.body).not.toContain('must-not-be-returned');
  });
  it('checks only deployed HTTPS domains, rejects extra agent fields, and retries the deployed snapshot',async()=>{
    const f=await fixture(),hostname='compose.example.test',created=await f.create({...input,domains:[{hostname,service:'web',port:80,https:true}]}),id=created.json().workload.id;
    await vi.waitFor(()=>expect(f.store.db.prepare("SELECT status FROM compose_actions WHERE id=?").get(created.json().action.id)).toEqual({status:'succeeded'}));
    const url=`/api/v1/compose/${id}/check-managed-certificate`,payload={hostname};
    const status={hostname,checkedAt:new Date().toISOString(),status:'not_found',publicVerified:false,eventsAvailable:true};f.setRead(async()=>status);
    expect((await f.app.inject({method:'POST',url,headers:f.headers,payload})).json()).toEqual(status);
    expect((await f.app.inject({method:'POST',url,headers:{cookie:f.headers.cookie},payload})).statusCode).toBe(403);
    expect((await f.app.inject({method:'POST',url,headers:f.headers,payload:{hostname:'foreign.example.test'}})).statusCode).toBe(400);
    f.setRead(async()=>({...status,privateKey:'must-not-leak'}));const invalid=await f.app.inject({method:'POST',url,headers:f.headers,payload});expect(invalid.statusCode).toBe(503);expect(invalid.body).not.toContain('must-not-leak');
    const {name,...draft}=input;expect(name).toBe('stack');
    expect((await f.app.inject({method:'PATCH',url:`/api/v1/compose/${id}`,headers:f.headers,payload:{...draft,expectedRevision:1}})).statusCode).toBe(200);
    const retry=await f.app.inject({method:'POST',url:`/api/v1/compose/${id}/retry-certificate`,headers:{...f.headers,'idempotency-key':randomUUID()},payload});expect(retry.statusCode).toBe(202);
    await vi.waitFor(()=>expect(f.calls.filter((call:any)=>call.path==='/compose/apply')).toHaveLength(2));
    const request=(f.calls.filter((call:any)=>call.path==='/compose/apply')[1] as any).body;
    expect(request).toMatchObject({revision:1,certificateRetry:{hostname},configuration:{domains:[{hostname,https:true}]}});
    expect((f.store.db.prepare('SELECT revision FROM compose_workloads WHERE id=?').get(id) as any).revision).toBe(2);
    expect(JSON.stringify(f.store.db.prepare('SELECT snapshot FROM compose_actions').all())).not.toContain('compose-secret-fixture');
  });
  it('does not reveal certificate status after project access is revoked during the probe',async()=>{
    const f=await fixture(),hostname='compose.example.test',created=await f.create({...input,domains:[{hostname,service:'web',port:80,https:true}]}),id=created.json().workload.id;
    await vi.waitFor(()=>expect(f.store.db.prepare('SELECT status FROM compose_actions WHERE id=?').get(created.json().action.id)).toEqual({status:'succeeded'}));
    const user=f.store.createUser('tls-editor@example.test',await hashPassword('fixture-member-password'));f.store.addMember(f.project.id,user.id,'editor');const session=f.store.createSession(user.id);
    let release!:(value:unknown)=>void,started=false;f.setRead(()=>{started=true;return new Promise(resolve=>{release=resolve;});});
    const response=f.app.inject({method:'POST',url:`/api/v1/compose/${id}/check-managed-certificate`,headers:{cookie:`panel_session=${session.token}`,'x-csrf-token':session.csrfToken},payload:{hostname}}).then(value=>value);
    await vi.waitFor(()=>expect(started).toBe(true));f.store.db.prepare('DELETE FROM memberships WHERE user_id=? AND project_id=?').run(user.id,f.project.id);release({hostname,checkedAt:new Date().toISOString(),status:'not_found',publicVerified:false,eventsAvailable:true});
    expect((await response).statusCode).toBe(404);
  });

});
