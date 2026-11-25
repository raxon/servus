import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createApp} from '../../src/server/app.js';
import {Store} from '../../src/server/store.js';
import type {agentRequest} from '../../src/agent/client.js';

const cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
async function fixture(){
  const dataDir=mkdtempSync(join(tmpdir(),'servus-compose-tokens-')),store=new Store(dataDir);
  let read=async()=>({logs:'authorized-runtime-output'});
  const agent:typeof agentRequest=async<T>(path,body)=>path==='/compose/apply'?{state:(body as{type:string}).type==='stop'?'stopped':'running',revision:(body as{revision:number}).revision,logs:'applied'} as T:await read() as T;
  const app=await createApp({dataDir,store,agentRequest:agent});cleanup.push(async()=>{await app.close();store.close();rmSync(dataDir,{recursive:true,force:true});});
  const setup=await app.inject({method:'POST',url:'/api/v1/setup',payload:{email:'admin@example.test',password:'fixture-password'}}),user=setup.json().user;
  const session={cookie:`panel_session=${setup.cookies[0]!.value}`,'x-csrf-token':setup.json().csrfToken},project=store.createProject('allowed-compose'),other=store.createProject('foreign-compose');
  const create=async(projectId:string)=>{const result=await app.inject({method:'POST',url:`/api/v1/projects/${projectId}/compose`,headers:{...session,'idempotency-key':randomUUID()},payload:{name:'web',source:{type:'inline',yaml:'services:\n  web:\n    image: nginx:alpine\n    environment: {TOKEN: source-must-stay-private}\n'},domains:[]}});expect(result.statusCode).toBe(202);await vi.waitFor(()=>expect(store.db.prepare('SELECT status FROM compose_actions WHERE id=?').get(result.json().action.id)).toEqual({status:'succeeded'}));return result.json().workload;};
  const workload=await create(project.id),foreign=await create(other.id);
  const mint=async(scope:'read'|'deploy')=>{const result=await app.inject({method:'POST',url:'/api/v1/auth/api-tokens',headers:session,payload:{projectId:project.id,name:'Compose automation',scope}});expect(result.statusCode).toBe(201);return result.json() as{id:string;token:string};};
  const readToken=await mint('read'),deployToken=await mint('deploy');
  const headers=(token=deployToken.token,key=randomUUID())=>({authorization:`Bearer ${token}`,'idempotency-key':key});
  const settled=async()=>{await vi.waitFor(()=>expect(store.db.prepare("SELECT count(*) AS n FROM compose_actions WHERE status IN ('queued','running')").get()).toEqual({n:0}));};
  return{app,store,user,project,other,workload,foreign,session,readToken,deployToken,headers,settled,setRead:(value:typeof read)=>{read=value;}};
}

describe('Compose project API tokens',()=>{
  it('exposes metadata, action history and logs only in the scoped project',async()=>{
    const f=await fixture(),headers=f.headers(f.readToken.token);
    const list=await f.app.inject({url:`/api/v1/projects/${f.project.id}/compose`,headers});expect(list.statusCode).toBe(200);expect(list.json().map((item:{id:string})=>item.id)).toEqual([f.workload.id]);expect(list.body).not.toContain('source-must-stay-private');
    for(const suffix of ['','/actions','/logs']){const own=await f.app.inject({url:`/api/v1/compose/${f.workload.id}${suffix}`,headers});expect(own.statusCode).toBe(200);expect(own.body).not.toContain('source-must-stay-private');expect((await f.app.inject({url:`/api/v1/compose/${f.foreign.id}${suffix}`,headers})).statusCode).toBe(404);}
    expect((await f.app.inject({url:`/api/v1/projects/${f.other.id}/compose`,headers})).statusCode).toBe(404);
    f.store.db.prepare('UPDATE compose_workloads SET deleted_at=? WHERE id=?').run(new Date().toISOString(),f.workload.id);
    expect((await f.app.inject({url:`/api/v1/compose/${f.workload.id}`,headers})).statusCode).toBe(404);
  });
  it('requires deploy scope and preserves the idempotent deploy and control contracts',async()=>{
    const f=await fixture();
    for(const operation of ['deploy','stop','start','restart']){
      const url=`/api/v1/compose/${f.workload.id}/${operation}`;
      expect((await f.app.inject({method:'POST',url,headers:f.headers(f.readToken.token)})).statusCode).toBe(403);
      const headers=f.headers(),first=await f.app.inject({method:'POST',url,headers});expect(first.statusCode).toBe(202);
      expect((await f.app.inject({method:'POST',url,headers})).json().id).toBe(first.json().id);
      expect((await f.app.inject({method:'POST',url:`/api/v1/compose/${f.foreign.id}/${operation}`,headers:f.headers()})).statusCode).toBe(404);
      await f.settled();
    }
    expect(f.store.db.prepare('SELECT count(*) AS n FROM compose_actions WHERE workload_id=?').get(f.workload.id)).toEqual({n:5});
  });
  it('allows deploy-scoped Compose CRUD while keeping source revelation and certificates interactive',async()=>{
    const f=await fixture(),headers=f.headers();
    for(const suffix of ['configuration','containers'])expect((await f.app.inject({url:`/api/v1/compose/${f.workload.id}/${suffix}`,headers})).statusCode).toBe(403);
    for(const suffix of ['check-managed-certificate','retry-certificate'])expect((await f.app.inject({method:'POST',url:`/api/v1/compose/${f.workload.id}/${suffix}`,headers,payload:{hostname:'app.example.test'}})).statusCode).toBe(403);
    expect((await f.app.inject({method:'POST',url:`/api/v1/projects/${f.project.id}/compose`,headers:f.headers(f.readToken.token),payload:{name:'blocked',source:{type:'inline',yaml:'services: {web: {image: nginx:alpine}}'},domains:[]}})).statusCode).toBe(403);
    const created=await f.app.inject({method:'POST',url:`/api/v1/projects/${f.project.id}/compose`,headers:f.headers(),payload:{name:'api-created',source:{type:'inline',yaml:'services:\n  web:\n    image: nginx:alpine\n'},domains:[]}});
    expect(created.statusCode).toBe(202);
    await f.settled();
    const createdId=created.json().workload.id as string;
    const patched=await f.app.inject({method:'PATCH',url:`/api/v1/compose/${createdId}`,headers:f.headers(),payload:{expectedRevision:1,source:{type:'inline',yaml:'services:\n  web:\n    image: nginx:1.27-alpine\n'},domains:[]}});
    expect(patched.statusCode).toBe(200);
    expect(patched.json().revision).toBe(2);
    expect((await f.app.inject({method:'PATCH',url:`/api/v1/compose/${f.foreign.id}`,headers:f.headers(),payload:{expectedRevision:1,source:{type:'inline',yaml:'services: {web: {image: nginx:alpine}}'},domains:[]}})).statusCode).toBe(404);
    expect((await f.app.inject({method:'POST',url:`/api/v1/compose/${createdId}/destroy`,headers:f.headers(f.readToken.token),payload:{confirm:true}})).statusCode).toBe(403);
    const destroyed=await f.app.inject({method:'POST',url:`/api/v1/compose/${createdId}/destroy`,headers:f.headers(),payload:{confirm:true}});
    expect(destroyed.statusCode).toBe(202);
    await f.settled();
  });
  it('uses current membership for every bearer request and denies a downgraded editor',async()=>{
    const f=await fixture();f.store.db.prepare("UPDATE users SET role='member' WHERE id=?").run(f.user.id);f.store.addMember(f.project.id,f.user.id,'editor');
    expect((await f.app.inject({url:`/api/v1/compose/${f.workload.id}`,headers:f.headers()})).statusCode).toBe(200);
    f.store.db.prepare("UPDATE memberships SET role='viewer' WHERE project_id=? AND user_id=?").run(f.project.id,f.user.id);
    expect((await f.app.inject({method:'POST',url:`/api/v1/compose/${f.workload.id}/deploy`,headers:f.headers()})).statusCode).toBe(404);
    f.store.db.prepare('DELETE FROM memberships WHERE project_id=? AND user_id=?').run(f.project.id,f.user.id);
    expect((await f.app.inject({url:`/api/v1/compose/${f.workload.id}/actions`,headers:f.headers()})).statusCode).toBe(404);
  });
  it.each(['revoked','expired','membership'] as const)('rechecks %s authorization after an awaited agent log request',async mode=>{
    const f=await fixture();f.store.db.prepare("UPDATE users SET role='member' WHERE id=?").run(f.user.id);f.store.addMember(f.project.id,f.user.id,'viewer');
    let release!:(value:{logs:string})=>void,started=false;f.setRead(()=>{started=true;return new Promise(resolve=>{release=resolve;});});
    const response=f.app.inject({url:`/api/v1/compose/${f.workload.id}/logs`,headers:f.headers(f.readToken.token)}).then(value=>value);
    await vi.waitFor(()=>expect(started).toBe(true));
    if(mode==='membership')f.store.db.prepare('DELETE FROM memberships WHERE project_id=? AND user_id=?').run(f.project.id,f.user.id);
    else f.store.db.prepare(`UPDATE api_tokens SET ${mode==='revoked'?'revoked_at':'expires_at'}=? WHERE id=?`).run('2000-01-01T00:00:00.000Z',f.readToken.id);
    release({logs:'must-not-be-returned'});const result=await response;expect(result.statusCode).toBe(mode==='membership'?404:401);expect(result.body).not.toContain('must-not-be-returned');
  });
  it('documents the Compose bearer surface and action polling',async()=>{
    const f=await fixture(),document=(await f.app.inject({url:'/api/v1/openapi.json',headers:f.headers(f.readToken.token)})).json();
    expect(document.paths['/projects/{id}/compose'].get).toBeDefined();
    expect(document.paths['/projects/{id}/compose'].post).toBeDefined();
    expect(document.paths['/compose/{id}'].patch).toBeDefined();
    expect(document.paths['/compose/{id}/destroy'].post).toBeDefined();
    for(const operation of ['deploy','start','stop','restart'])expect(document.paths[`/compose/{id}/${operation}`].post.responses['202'].description).toContain('/compose/{id}/actions');
    for(const suffix of ['configuration','check-managed-certificate','retry-certificate'])expect(document.paths[`/compose/{id}/${suffix}`]).toBeUndefined();
  });
});
