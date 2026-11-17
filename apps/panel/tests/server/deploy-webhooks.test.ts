import { afterEach, expect, it } from 'vitest';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/server/app.js';
import { Store } from '../../src/server/store.js';

const cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
async function fixture() {
  const dir=mkdtempSync(join(tmpdir(),'servus-hooks-')),store=new Store(dir),app=await createApp({dataDir:dir,store});
  cleanup.push(async()=>{await app.close();store.close();rmSync(dir,{recursive:true,force:true});});
  const setup=await app.inject({method:'POST',url:'/api/v1/setup',payload:{email:'admin@example.test',password:'fixture-password'}});
  const headers={cookie:`panel_session=${setup.cookies[0]!.value}`,'x-csrf-token':setup.json().csrfToken},user=setup.json().user;
  const project=store.createProject('hooks'),{service}=store.createService(project.id,{name:'web',image:'pending',hostname:'hooks.localhost',port:80,source:{type:'git',repository:'https://github.com/example/repo.git',branch:'main',context:'.',dockerfile:'Dockerfile'}},user.id);
  const job=store.claimNextJob('fixture',60_000)!;store.completeAction(job.actionId,'fixture',{state:'running',deployedRevision:1});
  const url=`/api/v1/services/${service.id}/deploy-webhook`;
  const rotate=async()=>{const result=await app.inject({method:'POST',url,headers,payload:{}});expect(result.statusCode).toBe(200);return result.json() as {path:string;secret:string};};
  const push=(hook:{path:string;secret:string},body:string,delivery=randomUUID())=>app.inject({method:'POST',url:hook.path,headers:{'content-type':'application/json','x-github-event':'push','x-github-delivery':delivery,'x-hub-signature-256':`sha256=${createHmac('sha256',hook.secret).update(body).digest('hex')}`},payload:body});
  return {app,store,user,project,service,headers,url,rotate,push};
}
it('hashes URL tokens, encrypts signing secrets and requires interactive mutation checks',async()=>{
  const f=await fixture();
  expect((await f.app.inject({method:'POST',url:f.url,payload:{}})).statusCode).toBe(401);
  expect((await f.app.inject({method:'POST',url:f.url,headers:{cookie:f.headers.cookie},payload:{}})).statusCode).toBe(403);
  const hook=await f.rotate(),row=f.store.db.prepare('SELECT * FROM deployment_webhooks').get();
  expect(JSON.stringify(row)).not.toContain(hook.secret);
  expect(hook.path).not.toContain(hook.secret);
  expect(JSON.stringify(row)).not.toContain(hook.path.split('/').at(-1));
  expect((await f.app.inject({url:f.url,headers:f.headers})).body).not.toContain(hook.secret);
  const status=await f.app.inject({url:f.url,headers:{cookie:f.headers.cookie}});
  expect(status.statusCode).toBe(200);expect(status.json().enabled).toBe(true);
  expect(status.body).not.toContain(hook.secret);
});
it('verifies exact GitHub payload bytes, ignores other branches, and deduplicates delivery IDs',async()=>{
  const f=await fixture(),hook=await f.rotate(),body='{ "ref": "refs/heads/main", "repository": {"full_name":"example/repo"} }',id=randomUUID();
  const first=await f.push(hook,body,id);expect(first.statusCode).toBe(202);
  expect((await f.push(hook,body,id)).json().id).toBe(first.json().id);
  expect((await f.push(hook,body,randomUUID())).json().id).toBe(first.json().id);
  const nextBody=JSON.stringify({...JSON.parse(body),after:'b'.repeat(40)});
  expect((await f.push(hook,nextBody,id)).statusCode).toBe(409);
  const nextDelivery=randomUUID();
  expect((await f.push(hook,nextBody,nextDelivery)).statusCode).toBe(409);
  expect(f.store.listActions(undefined,f.service.id)).toHaveLength(2);
  expect((await f.push(hook,'{"ref":"refs/heads/other","repository":{"full_name":"example/repo"}}')).json()).toEqual({ignored:true});
  const forged=await f.app.inject({method:'POST',url:hook.path,headers:{'content-type':'application/json','x-github-event':'push','x-github-delivery':randomUUID(),'x-hub-signature-256':`sha256=${'a'.repeat(64)}`},payload:body});
  expect(forged.statusCode).toBe(401);
  const reserialized=await f.app.inject({method:'POST',url:hook.path,headers:{'content-type':'application/json','x-github-event':'push','x-github-delivery':randomUUID(),'x-hub-signature-256':`sha256=${createHmac('sha256',hook.secret).update(body).digest('hex')}`},payload:JSON.stringify(JSON.parse(body))});
  expect(reserialized.statusCode).toBe(401);
  const job=f.store.claimNextJob('delivery-worker',60_000)!;
  f.store.completeAction(job.actionId,'delivery-worker',{state:'running',deployedRevision:1});
  const next=await f.push(hook,nextBody,nextDelivery);
  expect(next.statusCode).toBe(202);expect(next.json().id).not.toBe(first.json().id);
});
it('invalidates old credentials on rotation and disabling and respects revoked project access',async()=>{
  const f=await fixture(),old=await f.rotate(),next=await f.rotate();
  expect((await f.push(old,'{"ref":"refs/heads/main","repository":{"full_name":"example/repo"}}')).statusCode).toBe(404);
  f.store.db.prepare("UPDATE users SET role='member' WHERE id=?").run(f.user.id);
  expect((await f.push(next,'{"ref":"refs/heads/main","repository":{"full_name":"example/repo"}}')).statusCode).toBe(404);
  f.store.addMember(f.project.id,f.user.id,'editor');
  expect((await f.app.inject({method:'DELETE',url:f.url,headers:f.headers})).statusCode).toBe(200);
  expect((await f.push(next,'{"ref":"refs/heads/main","repository":{"full_name":"example/repo"}}')).statusCode).toBe(404);
});
it('supports idempotent CI requests and Force Rebuild without browser CSRF exemption',async()=>{
  const f=await fixture(),hook=await f.rotate(),headers={'content-type':'application/json','idempotency-key':'ci-release'};
  const first=await f.app.inject({method:'POST',url:hook.path,headers,payload:'{"forceRebuild":true}'});expect(first.statusCode).toBe(202);
  expect((await f.app.inject({method:'POST',url:hook.path,headers,payload:'{"forceRebuild":true}'})).json().id).toBe(first.json().id);
  expect((await f.app.inject({method:'POST',url:hook.path,headers,payload:'{}'})).statusCode).toBe(409);
  expect((await f.app.inject({method:'POST',url:hook.path,headers:{...headers,origin:'https://evil.test'},payload:'{}'})).statusCode).toBe(403);
  const snapshot=f.store.db.prepare('SELECT snapshot FROM jobs WHERE action_id=?').get(first.json().id) as {snapshot:string};
  expect(JSON.parse(snapshot.snapshot).deploymentOptions).toEqual({forceRebuild:true});
});
it('limits management to project writers and preserves the ordinary JSON parser',async()=>{
  const f=await fixture();
  const member=f.store.createUser('member@example.test','fixture-only'),session=f.store.createSession(member.id);
  const headers={cookie:`panel_session=${session.token}`,'x-csrf-token':session.csrfToken};
  f.store.addMember(f.project.id,member.id,'viewer');
  for(const method of ['GET','POST','DELETE'] as const)expect((await f.app.inject({method,url:f.url,headers,...(method==='POST'?{payload:{}}:{})})).statusCode).toBe(404);
  f.store.addMember(f.project.id,member.id,'editor');
  expect((await f.app.inject({url:f.url,headers:{cookie:headers.cookie}})).statusCode).toBe(200);
  expect((await f.app.inject({method:'POST',url:f.url,headers:{cookie:headers.cookie},payload:{}})).statusCode).toBe(403);
  expect((await f.app.inject({method:'POST',url:f.url,headers:{...headers,origin:'https://attacker.test'},payload:{}})).statusCode).toBe(403);
  const ordinary=await f.app.inject({method:'POST',url:'/api/v1/projects',headers:f.headers,payload:{name:'ordinary-json'}});
  expect(ordinary.statusCode).toBe(201);expect(ordinary.json().name).toBe('ordinary-json');
});
it('requires the signed GitHub event to match the saved repository as well as the branch',async()=>{
  const f=await fixture(),hook=await f.rotate();
  const body=(repository:string)=>JSON.stringify({ref:'refs/heads/main',repository:{full_name:repository}});
  expect((await f.push(hook,body('unrelated/repository'))).json()).toEqual({ignored:true});
  expect((await f.push(hook,JSON.stringify({ref:'refs/heads/main',repository:{full_name:'example/repo'},deleted:true}))).json()).toEqual({ignored:true});
  expect(f.store.listActions(undefined,f.service.id)).toHaveLength(1);
  expect((await f.push(hook,body('EXAMPLE/REPO'))).statusCode).toBe(202);
});
it('does not accept the URL token as the independent GitHub signing secret',async()=>{
  const f=await fixture(),hook=await f.rotate(),body=JSON.stringify({ref:'refs/heads/main',repository:{full_name:'example/repo'}});
  const token=hook.path.split('/').at(-1)!;
  const result=await f.app.inject({method:'POST',url:hook.path,headers:{'content-type':'application/json','x-github-event':'push','x-github-delivery':randomUUID(),'x-hub-signature-256':`sha256=${createHmac('sha256',token).update(body).digest('hex')}`},payload:body});
  expect(result.statusCode).toBe(401);
  expect(f.store.listActions(undefined,f.service.id)).toHaveLength(1);
});
