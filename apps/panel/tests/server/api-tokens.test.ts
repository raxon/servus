import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/server/app.js';
import { Store } from '../../src/server/store.js';

const cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
async function fixture() {
  const dir=mkdtempSync(join(tmpdir(),'servus-tokens-')),store=new Store(dir),app=await createApp({dataDir:dir,store});
  cleanup.push(async()=>{await app.close();store.close();rmSync(dir,{recursive:true,force:true});});
  const setup=await app.inject({method:'POST',url:'/api/v1/setup',payload:{email:'admin@example.test',password:'original-password'}});
  const user=setup.json().user,headers={cookie:`panel_session=${setup.cookies[0]!.value}`,'x-csrf-token':setup.json().csrfToken};
  const project=store.createProject('allowed'),other=store.createProject('other');
  const {service}=store.createService(project.id,{name:'web',image:'nginx:alpine',port:80,hostname:'allowed.localhost'},user.id);
  const {service:foreign}=store.createService(other.id,{name:'web',image:'nginx:alpine',port:80,hostname:'other.localhost'},user.id);
  for(let job=store.claimNextJob('fixture',60_000);job;job=store.claimNextJob('fixture',60_000))store.completeAction(job.actionId,'fixture',{state:'running',deployedRevision:1});
  const mint=async(scope:'read'|'deploy'='read')=>{
    const result=await app.inject({method:'POST',url:'/api/v1/auth/api-tokens',headers,payload:{projectId:project.id,name:'CI',scope}});
    expect(result.statusCode).toBe(201);return result.json() as {id:string;token:string};
  };
  return {app,store,user,headers,project,other,service,foreign,mint};
}
describe('project API tokens',()=>{
  it('reveals a random token once and stores only its hash',async()=>{
    const {app,store,headers,mint}=await fixture(),created=await mint();
    expect(created.token).toMatch(/^srv_[a-f0-9]{64}$/);
    const row=store.db.prepare('SELECT * FROM api_tokens WHERE id=?').get(created.id);
    expect(JSON.stringify(row)).not.toContain(created.token);
    expect((await app.inject({url:'/api/v1/auth/api-tokens',headers})).body).not.toContain(created.token);
  });
  it('lists only the scoped project and hides foreign services and actions',async()=>{
    const {app,store,project,other,foreign,mint}=await fixture(),token=await mint(),headers={authorization:`Bearer ${token.token}`};
    expect((await app.inject({url:'/api/v1/projects',headers})).json().map((p:{id:string})=>p.id)).toEqual([project.id]);
    for(const url of [`/projects/${other.id}`,`/projects/${other.id}/services`,`/services/${foreign.id}`,`/actions/${store.listActions(other.id)[0]!.id}`])
      expect((await app.inject({url:`/api/v1${url}`,headers})).statusCode).toBe(404);
    expect((await app.inject({url:`/api/v1/projects/${project.id}/services`,headers})).statusCode).toBe(200);
  });
  it('requires deploy scope, idempotency and current project access',async()=>{
    const {app,store,user,project,service,mint}=await fixture(),read=await mint(),deploy=await mint('deploy');
    const url=`/api/v1/services/${service.id}/restart`;
    expect((await app.inject({method:'POST',url,headers:{authorization:`Bearer ${read.token}`,'idempotency-key':'restart'}})).statusCode).toBe(403);
    const headers={authorization:`Bearer ${deploy.token}`,'idempotency-key':'restart'};
    const first=await app.inject({method:'POST',url,headers});expect(first.statusCode).toBe(202);
    expect((await app.inject({method:'POST',url,headers})).json().id).toBe(first.json().id);
    store.db.prepare("UPDATE users SET role='member' WHERE id=?").run(user.id);
    expect((await app.inject({url:`/api/v1/projects/${project.id}/services`,headers})).statusCode).toBe(404);
    store.addMember(project.id,user.id,'viewer');
    expect((await app.inject({url:`/api/v1/projects/${project.id}/services`,headers})).statusCode).toBe(200);
    expect((await app.inject({method:'POST',url,headers})).statusCode).toBe(404);
  });
  it('rejects interactive endpoints and mixed cookie/bearer credentials',async()=>{
    const {app,headers:session,service,mint}=await fixture(),token=await mint('deploy'),headers={authorization:`Bearer ${token.token}`};
    for(const url of ['/auth/session','/auth/api-tokens','/users','/settings/https'])expect((await app.inject({url:`/api/v1${url}`,headers})).statusCode).toBe(403);
    for(const suffix of ['connection/reveal','console-ticket','database-export'])expect((await app.inject({method:'POST',url:`/api/v1/services/${service.id}/${suffix}`,headers,payload:{}})).statusCode).toBe(403);
    expect((await app.inject({url:'/api/v1/projects',headers:{...headers,cookie:session.cookie}})).statusCode).toBe(401);
  });
  it('supports immediate revocation, expiry and password-change revocation',async()=>{
    const {app,store,headers,mint}=await fixture(),a=await mint(),b=await mint(),c=await mint();
    const read=(token:string)=>app.inject({url:'/api/v1/projects',headers:{authorization:`Bearer ${token}`}});
    expect((await app.inject({method:'DELETE',url:`/api/v1/auth/api-tokens/${a.id}`,headers})).statusCode).toBe(200);
    expect((await read(a.token)).statusCode).toBe(401);
    store.db.prepare("UPDATE api_tokens SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(b.id);
    expect((await read(b.token)).statusCode).toBe(401);
    const changed=await app.inject({method:'POST',url:'/api/v1/auth/password',headers,payload:{currentPassword:'original-password',newPassword:'replacement-password'}});
    expect(changed.statusCode).toBe(200);expect((await read(c.token)).statusCode).toBe(401);
  });
  it('keeps browser CSRF and foreign-origin checks on token creation',async()=>{
    const {app,headers,project}=await fixture(),payload={projectId:project.id,name:'CI'};
    expect((await app.inject({method:'POST',url:'/api/v1/auth/api-tokens',headers:{cookie:headers.cookie},payload})).statusCode).toBe(403);
    expect((await app.inject({method:'POST',url:'/api/v1/auth/api-tokens',headers:{...headers,origin:'https://evil.test'},payload})).statusCode).toBe(403);
  });
  it('publishes an authenticated OpenAPI contract for the supported bearer surface',async()=>{
    const {app,mint}=await fixture(),token=await mint();
    expect((await app.inject({url:'/api/v1/openapi.json'})).statusCode).toBe(401);
    const response=await app.inject({url:'/api/v1/openapi.json',headers:{authorization:`Bearer ${token.token}`}});
    expect(response.statusCode).toBe(200);expect(response.json().openapi).toBe('3.1.0');
    expect(response.json().paths['/services/{id}/deploy'].post.parameters[1].name).toBe('Idempotency-Key');
  });
});
