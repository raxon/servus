import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createApp } from '../../src/server/app.js';
import { Store } from '../../src/server/store.js';
import { hashPassword } from '../../src/server/auth.js';

const cleanups: (()=>Promise<void>)[]=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0).reverse())await cleanup();});
async function fixture() {
  const dir=mkdtempSync(join(tmpdir(),'panel-server-')),store=new Store(dir);
  const app=await createApp({dataDir:dir,store});
  cleanups.push(async()=>{await app.close();store.close();rmSync(dir,{recursive:true,force:true});});
  const setup=await app.inject({method:'POST',url:'/api/v1/setup',payload:{email:'admin@example.test',password:'a-long-local-password'}});
  expect(setup.statusCode).toBe(200);
  const auth=setup.json(),cookie=setup.cookies.find(c=>c.name==='panel_session')!.value;
  const headers={cookie:`panel_session=${cookie}`,'x-csrf-token':auth.csrfToken};
  return {dir,store,app,auth,headers,cookie};
}

describe('authentication and request security',()=>{
  it('creates one local administrator and hashes session credentials',async()=>{
    const dir=mkdtempSync(join(tmpdir(),'panel-setup-')),store=new Store(dir),app=await createApp({dataDir:dir,store});
    cleanups.push(async()=>{await app.close();store.close();rmSync(dir,{recursive:true,force:true});});
    expect(existsSync(join(dir,'bootstrap-token'))).toBe(false);
    expect((await app.inject({url:'/api/v1/setup'})).json()).toEqual({required:true});
    const badOrigin=await app.inject({method:'POST',url:'/api/v1/setup',headers:{origin:'https://attacker.test'},payload:{email:'admin@example.test',password:'a-long-local-password'}});
    expect(badOrigin.statusCode).toBe(403);expect(store.isSetup()).toBe(false);
    const short=await app.inject({method:'POST',url:'/api/v1/setup',payload:{email:'admin@example.test',password:'short'}});
    expect(short.statusCode).toBe(400);expect(store.isSetup()).toBe(false);
    const created=await app.inject({method:'POST',url:'/api/v1/setup',payload:{email:'admin@example.test',password:'a-long-local-password'}});
    expect(created.statusCode).toBe(200);
    const raw=created.cookies[0]!.value;
    expect((store.db.prepare('SELECT token_hash FROM sessions').get() as {token_hash:string}).token_hash).not.toBe(raw);
    const repeated=await app.inject({method:'POST',url:'/api/v1/setup',payload:{email:'second@example.test',password:'a-long-local-password'}});
    expect(repeated.statusCode).toBe(409);
    expect((await app.inject({url:'/api/v1/setup'})).json()).toEqual({required:false});
    expect(created.headers['set-cookie']).toContain('HttpOnly');expect(created.headers['set-cookie']).toContain('SameSite=Strict');
  });
  it('completes a previously unfinished installation without the legacy token',async()=>{
    const dir=mkdtempSync(join(tmpdir(),'panel-legacy-setup-'));writeFileSync(join(dir,'bootstrap-token'),'legacy-token');
    const store=new Store(dir),app=await createApp({dataDir:dir,store});
    cleanups.push(async()=>{await app.close();store.close();rmSync(dir,{recursive:true,force:true});});
    const created=await app.inject({method:'POST',url:'/api/v1/setup',payload:{email:'admin@example.test',password:'a-long-local-password'}});
    expect(created.statusCode).toBe(200);expect(existsSync(join(dir,'bootstrap-token'))).toBe(false);
  });
  it('allows exactly one concurrent first administrator',async()=>{
    const dir=mkdtempSync(join(tmpdir(),'panel-setup-race-')),store=new Store(dir),secondStore=new Store(dir),app=await createApp({dataDir:dir,store}),secondApp=await createApp({dataDir:dir,store:secondStore});
    cleanups.push(async()=>{await app.close();await secondApp.close();store.close();secondStore.close();rmSync(dir,{recursive:true,force:true});});
    const responses=await Promise.all([app,secondApp].map((instance,index)=>instance.inject({method:'POST',url:'/api/v1/setup',payload:{email:`admin${index}@example.test`,password:'a-long-local-password'}})));
    expect(responses.map(response=>response.statusCode).sort()).toEqual([200,409]);
    expect((store.db.prepare("SELECT count(*) AS count FROM users WHERE role='admin'").get() as {count:number}).count).toBe(1);
  });
  it('enforces an eight-character minimum for local setup and login',async()=>{
    const dir=mkdtempSync(join(tmpdir(),'panel-password-bounds-')),store=new Store(dir),app=await createApp({dataDir:dir,store});
    cleanups.push(async()=>{await app.close();store.close();rmSync(dir,{recursive:true,force:true});});
    const email='bounds@example.test';
    expect((await app.inject({method:'POST',url:'/api/v1/setup',payload:{email,password:'1234567'}})).statusCode).toBe(400);
    expect(store.isSetup()).toBe(false);
    expect((await app.inject({method:'POST',url:'/api/v1/setup',payload:{email,password:'12345678'}})).statusCode).toBe(200);
    expect((await app.inject({method:'POST',url:'/api/v1/auth/login',payload:{email,password:'1234567'}})).statusCode).toBe(400);
    expect((await app.inject({method:'POST',url:'/api/v1/auth/login',payload:{email,password:'12345678'}})).statusCode).toBe(200);
    const legacyEmail='legacy@example.test',legacyPassword='a-long-existing-password';
    store.createUser(legacyEmail,await hashPassword(legacyPassword));
    expect((await app.inject({method:'POST',url:'/api/v1/auth/login',payload:{email:legacyEmail,password:legacyPassword}})).statusCode).toBe(200);
  });
  it('denies anonymous, missing-CSRF and foreign-origin mutation, and revokes logout',async()=>{
    const {app,headers}=await fixture();
    expect((await app.inject({url:'/api/v1/projects'})).statusCode).toBe(401);
    expect((await app.inject({method:'POST',url:'/api/v1/projects',headers:{cookie:headers.cookie},payload:{name:'first'}})).statusCode).toBe(403);
    expect((await app.inject({method:'POST',url:'/api/v1/projects',headers:{...headers,origin:'https://attacker.test'},payload:{name:'first'}})).statusCode).toBe(403);
    expect((await app.inject({method:'POST',url:'/api/v1/auth/logout',headers})).statusCode).toBe(200);
    expect((await app.inject({url:'/api/v1/auth/session',headers})).statusCode).toBe(401);
  });
  it('checks credentials and leaves an existing session valid after a failed login',async()=>{
    const {app,headers}=await fixture();
    expect((await app.inject({method:'POST',url:'/api/v1/auth/login',payload:{email:'admin@example.test',password:'incorrect-password'}})).statusCode).toBe(401);
    expect((await app.inject({url:'/api/v1/auth/session',headers})).statusCode).toBe(200);
  });
});

describe('projects and deployment contracts',()=>{
  it('keeps configuration revisions and deployment snapshots separate',async()=>{
    const {app,store,headers}=await fixture();
    const project=(await app.inject({method:'POST',url:'/api/v1/projects',headers,payload:{name:'production'}})).json();
    const response=await app.inject({method:'POST',url:`/api/v1/projects/${project.id}/services`,headers:{...headers,'idempotency-key':'create-web'},payload:{name:'web',image:'nginx:alpine',port:80,hostname:'web.localhost'}});
    expect(response.statusCode).toBe(202);
    const {service,action}=response.json();
    const patched=await app.inject({method:'PATCH',url:`/api/v1/services/${service.id}`,headers,payload:{expectedRevision:1,image:'nginx:stable-alpine'}});
    expect(patched.statusCode).toBe(200);expect(patched.json().revision).toBe(2);expect(patched.json().deployedRevision).toBeNull();
    const job=store.claimNextJob('worker-a',60_000)!;
    expect(job.snapshot.image).toBe('nginx:alpine');expect(job.snapshot.revision).toBe(1);
    expect(store.completeAction(action.id,'worker-a',{state:'running',deployedRevision:1})).toBe(true);
    expect(store.getService(service.id)!.revision).toBe(2);expect(store.getService(service.id)!.deployedRevision).toBe(1);
    const stale=await app.inject({method:'PATCH',url:`/api/v1/services/${service.id}`,headers,payload:{expectedRevision:1,image:'nginx:latest'}});
    expect(stale.statusCode).toBe(409);
  });
  it('deduplicates action requests and rejects changed requests sharing the key',async()=>{
    const {app,store,headers,auth}=await fixture(),project=store.createProject('test');
    const {service}=store.createService(project.id,{name:'web',image:'nginx:alpine',port:80,hostname:'a.localhost'},auth.user.id);
    const job=store.claimNextJob('worker',60_000)!;store.completeAction(job.actionId,'worker',{state:'running',deployedRevision:1});
    const request={method:'POST' as const,url:`/api/v1/services/${service.id}/deploy`,headers:{...headers,'idempotency-key':'same-request'}};
    const first=await app.inject(request),second=await app.inject(request);
    expect(first.statusCode).toBe(202);expect(second.json().id).toBe(first.json().id);
    expect((await app.inject({...request,url:`/api/v1/services/${service.id}/stop`})).statusCode).toBe(409);
    expect(store.listActions(undefined,service.id)).toHaveLength(2);
  });
  it('deduplicates initial service creation and rejects a changed create request',async()=>{
    const {app,store,headers}=await fixture();
    const project=store.createProject('initial-create');
    const request={method:'POST' as const,url:`/api/v1/projects/${project.id}/services`,headers:{...headers,'idempotency-key':'create-one'},payload:{name:'web',image:'nginx:alpine',port:80,hostname:'create.localhost'}};
    const first=await app.inject(request),second=await app.inject(request);
    expect(first.statusCode).toBe(202);expect(second.statusCode).toBe(202);expect(second.json().service.id).toBe(first.json().service.id);
    expect(store.listServices(project.id)).toHaveLength(1);expect(store.listActions(project.id)).toHaveLength(1);
    expect((await app.inject({...request,payload:{...request.payload,image:'nginx:stable-alpine'}})).statusCode).toBe(409);
  });
  it('rejects malformed routing hostnames and canonicalizes case',async()=>{
    const {app,store,headers}=await fixture(),project=store.createProject('hostname-validation');
    for(const host of ['bad..localhost','-bad.localhost','bad-.localhost','bad.localhost:80',`${'a'.repeat(64)}.localhost`]) {
      const response=await app.inject({method:'POST',url:`/api/v1/projects/${project.id}/services`,headers:{...headers,'idempotency-key':host},payload:{name:'web',image:'nginx:alpine',port:80,hostname:host}});
      expect(response.statusCode).toBe(400);
    }
    const response=await app.inject({method:'POST',url:`/api/v1/projects/${project.id}/services`,headers:{...headers,'idempotency-key':'valid-host'},payload:{name:'web',image:'nginx:alpine',port:80,hostname:'Web.Localhost'}});
    expect(response.statusCode).toBe(202);expect(response.json().service.hostname).toBe('web.localhost');
  });
  it('restricts projects, services and action logs to project members',async()=>{
    const {app,store,auth}=await fixture(),project=store.createProject('private');
    const {service,action}=store.createService(project.id,{name:'web',image:'nginx:alpine',port:80,hostname:'private.localhost'},auth.user.id);
    const member=store.createUser('member@example.test',await hashPassword('member-password-long'));
    const session=store.createSession(member.id),headers={cookie:`panel_session=${session.token}`,'x-csrf-token':session.csrfToken};
    expect((await app.inject({url:'/api/v1/projects',headers})).json()).toEqual([]);
    for(const url of [`/api/v1/projects/${project.id}`,`/api/v1/services/${service.id}`,`/api/v1/actions/${action.id}`])expect((await app.inject({url,headers})).statusCode).toBe(404);
    store.addMember(project.id,member.id,'viewer');
    expect((await app.inject({url:`/api/v1/services/${service.id}`,headers})).statusCode).toBe(200);
    expect((await app.inject({method:'POST',url:`/api/v1/services/${service.id}/stop`,headers:{...headers,'idempotency-key':'denied'}})).statusCode).toBe(404);
  });
});

describe('durable job ownership',()=>{
  it('waits for a transient reader lock while enabling WAL on an existing database',async()=>{
    const dir=mkdtempSync(join(tmpdir(),'panel-wal-contention-'));
    cleanups.push(async()=>rmSync(dir,{recursive:true,force:true}));
    const source=`import Database from 'better-sqlite3';const db=new Database(${JSON.stringify(join(dir,'panel.sqlite'))});db.exec('CREATE TABLE lock_fixture(id INTEGER); BEGIN');db.prepare('SELECT name FROM sqlite_master').all();process.stdout.write('locked');setTimeout(()=>{db.exec('COMMIT');db.close();},300);`;
    const child=spawn(process.execPath,['--input-type=module','-e',source],{stdio:['ignore','pipe','pipe']});
    let stderr='';child.stderr.on('data',chunk=>stderr+=String(chunk));
    const exited=new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
    await new Promise<void>((resolve,reject)=>{child.stdout.once('data',()=>resolve());child.once('error',reject);child.once('exit',code=>{if(code!==0)reject(new Error(stderr));});});
    const store=new Store(dir);
    expect(store.db.pragma('journal_mode',{simple:true})).toBe('wal');store.close();
    expect(await exited).toBe(0);
  });
  it('initializes the schema safely across concurrent processes',async()=>{
    const dir=mkdtempSync(join(tmpdir(),'panel-concurrent-init-'));
    cleanups.push(async()=>rmSync(dir,{recursive:true,force:true}));
    const source=`import { Store } from ${JSON.stringify(new URL('../../src/server/store.ts',import.meta.url).href)};process.stdout.write('ready');process.stdin.once('data',()=>{const store=new Store(${JSON.stringify(dir)});store.close();process.stdin.pause();});`;
    const workers=Array.from({length:3},()=>{
      const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',source],{stdio:['pipe','pipe','pipe']});
      let stderr='';child.stderr.on('data',chunk=>stderr+=String(chunk));
      const ready=new Promise<void>((resolve,reject)=>{child.stdout.once('data',()=>resolve());child.once('error',reject);child.once('exit',code=>{if(code!==0)reject(new Error(stderr));});});
      const result=new Promise<{code:number|null;stderr:string}>((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>resolve({code,stderr}));});
      return {child,ready,result};
    });
    await Promise.all(workers.map(worker=>worker.ready));
    for(const worker of workers)worker.child.stdin.end('go');
    const results=await Promise.all(workers.map(worker=>worker.result));
    expect(results).toEqual(results.map(()=>({code:0,stderr:''})));
    const store=new Store(dir);expect(store.db.pragma('user_version',{simple:true})).toBe(5);store.close();
    expect(existsSync(join(dir,'bootstrap-token'))).toBe(false);
  });
  it('reclaims expired jobs, preserves snapshots and fences stale worker completion',async()=>{
    const {store,auth}=await fixture(),project=store.createProject('queue');
    const {service,action}=store.createService(project.id,{name:'web',image:'nginx:alpine',port:80,hostname:'queue.localhost'},auth.user.id);
    const first=store.claimNextJob('old-worker',60_000)!;
    expect(store.claimNextJob('new-worker',60_000)).toBeNull();
    store.db.prepare('UPDATE jobs SET lease_until=? WHERE id=?').run('2000-01-01T00:00:00.000Z',first.id);
    const recovered=store.claimNextJob('new-worker',60_000)!;
    expect(recovered.recovered).toBe(true);expect(recovered.attempts).toBe(2);expect(recovered.snapshot.id).toBe(service.id);
    expect(store.completeAction(action.id,'old-worker',{state:'running',deployedRevision:1})).toBe(false);
    expect(store.failAction(action.id,'old-worker','late failure')).toBe(false);
    expect(store.renewJob(first.id,'old-worker',60_000)).toBe(false);
    expect(store.completeAction(action.id,'new-worker',{state:'running',deployedRevision:1})).toBe(true);
    expect(store.getAction(action.id)!.status).toBe('succeeded');
  });
  it('rolls back a failed service insert without leaving a queued action',async()=>{
    const {store,auth}=await fixture(),project=store.createProject('atomic');
    store.createService(project.id,{name:'one',image:'nginx:alpine',port:80,hostname:'shared.localhost'},auth.user.id);
    expect(()=>store.createService(project.id,{name:'two',image:'nginx:alpine',port:80,hostname:'shared.localhost'},auth.user.id)).toThrow();
    expect(store.listServices(project.id)).toHaveLength(1);expect(store.listActions(project.id)).toHaveLength(1);
  });
  it('does not let a late failed-action observation overwrite a newer deployment',async()=>{
    const {store,auth}=await fixture(),project=store.createProject('observation-race');
    const {service,action}=store.createService(project.id,{name:'web',image:'nginx:alpine',port:80,hostname:'race.localhost'},auth.user.id);
    store.claimNextJob('worker-a',60_000);store.failAction(action.id,'worker-a','failed rollout');
    const next=store.createAction(service.id,'deploy',auth.user.id,'next-deploy');
    store.claimNextJob('worker-b',60_000);store.completeAction(next.id,'worker-b',{state:'running',deployedRevision:1});
    expect(store.updateServiceRuntime(service.id,{state:'failed',lastError:'stale observation'},action.id)).toBe(false);
    expect(store.getService(service.id)!.state).toBe('running');
  });
});
