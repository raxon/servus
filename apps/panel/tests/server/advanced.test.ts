import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import Database from 'better-sqlite3';
import { createApp, type AppOptions } from '../../src/server/app.js';
import { Store } from '../../src/server/store.js';
import { hashPassword } from '../../src/server/auth.js';
import type { agentRequest } from '../../src/agent/client.js';

const cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const fn of cleanup.splice(0).reverse())await fn();});
const containerId='a'.repeat(64);
const defaultAgent:typeof agentRequest=async<T>(path:string)=>{
  if(path.includes('/containers'))return [{id:containerId,name:'managed',state:'running'}] as T;
  if(path.includes('/metrics'))return {cpuPercent:2,memoryBytes:100,memoryLimitBytes:200,networkRxBytes:3,networkTxBytes:4,containers:1} as T;
  if(path.includes('/logs'))return {lines:['2026-11-13T15:00:00.000Z healthy']} as T;
  throw new Error('Unexpected runtime read');
};
async function fixture(options:Partial<AppOptions>={}) {
  const dir=mkdtempSync(join(tmpdir(),'panel-advanced-')),store=new Store(dir),app=await createApp({dataDir:dir,store,agentRequest:defaultAgent,...options});
  cleanup.push(async()=>{await app.close();store.close();rmSync(dir,{recursive:true,force:true});});
  const setup=await app.inject({method:'POST',url:'/api/v1/setup',payload:{email:'admin@example.test',password:'local-testing-password'}});
  const auth=setup.json(),cookie=`panel_session=${setup.cookies.find(c=>c.name==='panel_session')!.value}`;
  const headers={cookie,'x-csrf-token':auth.csrfToken};
  const project=store.createProject('advanced');
  const create=(payload:unknown,key='create-one')=>app.inject({method:'POST',url:`/api/v1/projects/${project.id}/services`,headers:{...headers,'idempotency-key':key},payload});
  return {dir,store,app,auth,headers,project,create};
}
const appInput={name:'web',image:'nginx:alpine',port:80,hostname:'advanced.localhost'};
function finishFirst(store:Store) {const job=store.claimNextJob('test-worker',60000)!;store.completeAction(job.actionId,'test-worker',{state:'running',deployedRevision:job.snapshot.revision});}

describe('versioned configuration and secret ownership',()=>{
  it('encrypts and binds Git tokens to the service and repository, retaining queued revisions across rotation',async()=>{
    const {dir,store,app,headers,create}=await fixture();
    const token='git-token-example-4938',replacement='git-token-rotated-2098';
    const source={type:'git',repository:'https://github.com/example/private.git',branch:'main',context:'.',dockerfile:'Dockerfile',credential:{username:'git-user',token}};
    const response=await create({...appInput,source});expect(response.statusCode).toBe(202);expect(response.body).not.toContain(token);
    const {service,action}=response.json(),ref=service.source.credential.secretRef;
    expect(service.source.credential.token).toBeUndefined();
    const snapshot=(store.db.prepare('SELECT snapshot FROM jobs WHERE action_id=?').get(action.id) as {snapshot:string}).snapshot;
    expect(snapshot).not.toContain(token);expect(snapshot).toContain(ref);
    const record=JSON.parse(store.vault.get(ref));expect(record).toMatchObject({serviceId:service.id,repository:source.repository,username:'git-user',token});
    const rotated=await app.inject({method:'PATCH',url:`/api/v1/services/${service.id}`,headers,payload:{expectedRevision:1,source:{...source,credential:{username:'git-user',token:replacement}}}});
    expect(rotated.statusCode).toBe(200);expect(rotated.body).not.toContain(replacement);expect(rotated.json().source.credential.secretRef).not.toBe(ref);expect(JSON.parse(store.vault.get(ref)).token).toBe(token);
    const stolen=await create({...appInput,name:'second',hostname:'second.localhost',source:{...source,credential:{username:'git-user',secretRef:ref}}},'git-second');expect(stolen.statusCode).toBe(403);
    const changed=await app.inject({method:'PATCH',url:`/api/v1/services/${service.id}`,headers,payload:{expectedRevision:2,source:{...source,repository:'https://github.com/other/repo.git',credential:{username:'git-user',secretRef:ref}}}});expect(changed.statusCode).toBe(403);
    const asEnv=await app.inject({method:'PATCH',url:`/api/v1/services/${service.id}`,headers,payload:{expectedRevision:2,environment:[{name:'GIT_TOKEN',secret:true,secretRef:ref}]}});expect(asEnv.statusCode).toBe(403);
    const noCsrf=await app.inject({method:'PATCH',url:`/api/v1/services/${service.id}`,headers:{cookie:headers.cookie},payload:{expectedRevision:2,source}});expect(noCsrf.statusCode).toBe(403);
    const viewer=store.createUser('git-viewer@example.test',await hashPassword('viewer-testing-password'));store.addMember(service.projectId,viewer.id,'viewer');const session=store.createSession(viewer.id);
    const viewerResult=await app.inject({method:'PATCH',url:`/api/v1/services/${service.id}`,headers:{cookie:`panel_session=${session.token}`,'x-csrf-token':session.csrfToken},payload:{expectedRevision:2,source}});expect(viewerResult.statusCode).toBe(404);
    const envSaved=await app.inject({method:'PATCH',url:`/api/v1/services/${service.id}`,headers,payload:{expectedRevision:2,environment:[{name:'ENV_TOKEN',secret:true,value:'environment-secret'}]}});expect(envSaved.statusCode).toBe(200);
    const envRef=envSaved.json().environment[0].secretRef;
    const asGit=await app.inject({method:'PATCH',url:`/api/v1/services/${service.id}`,headers,payload:{expectedRevision:3,source:{...source,credential:{username:'git-user',secretRef:envRef}}}});expect(asGit.statusCode).toBe(403);
    const db=(await create({name:'db-purpose',kind:'mariadb'},'purpose-db')).json().service;
    const databaseAsEnv=await app.inject({method:'PATCH',url:`/api/v1/services/${db.id}`,headers,payload:{expectedRevision:1,environment:[{name:'LEAK',secret:true,secretRef:db.database.passwordSecretRef}]}});expect(databaseAsEnv.statusCode).toBe(403);
    const plain=JSON.stringify(store.db.prepare('SELECT config FROM services').all())+JSON.stringify(store.db.prepare('SELECT snapshot FROM jobs').all());expect(plain).not.toContain(token);expect(plain).not.toContain(replacement);
    for(const name of ['panel.sqlite','panel.sqlite-wal'])if(existsSync(join(dir,name))){const data=readFileSync(join(dir,name));expect(data.includes(Buffer.from(token))).toBe(false);expect(data.includes(Buffer.from(replacement))).toBe(false);}
    expect(readFileSync(join(dir,'secrets',ref)).includes(Buffer.from(token))).toBe(false);
    expect(store.vault.redact(`failure ${token}`)).not.toContain(token);
  });
  it('encrypts environment secrets, keeps snapshots immutable and redacts event output',async()=>{
    const {store,app,headers,create}=await fixture();const secret='original-secret-2468',replacement='replacement-secret-1357';
    const response=await create({...appInput,environment:[{name:'API_KEY',value:secret,secret:true},{name:'MODE',value:'production'}]});
    expect(response.statusCode).toBe(202);
    const {service,action}=response.json(),reference=service.environment[0].secretRef;
    expect(service.environment[0].value).toBeUndefined();expect(store.vault.get(reference)).toBe(secret);
    const snapshot=(store.db.prepare('SELECT snapshot FROM jobs WHERE action_id=?').get(action.id) as {snapshot:string}).snapshot;
    expect(snapshot).not.toContain(secret);expect(snapshot).toContain(reference);
    const updated=await app.inject({method:'PATCH',url:`/api/v1/services/${service.id}`,headers,payload:{expectedRevision:1,environment:[{name:'API_KEY',secret:true,value:replacement}]}});
    expect(updated.statusCode).toBe(200);expect(updated.json().environment[0].secretRef).not.toBe(reference);expect(store.vault.get(reference)).toBe(secret);
    store.appendEvent(action.id,'error',`Do not expose ${secret} or ${replacement}`);
    const events=await app.inject({url:`/api/v1/actions/${action.id}`,headers});
    expect(events.body).not.toContain(secret);expect(events.body).not.toContain(replacement);expect(events.body).toContain('[REDACTED]');
    expect((store.db.prepare('SELECT config FROM services WHERE id=?').get(service.id) as {config:string}).config).not.toContain(replacement);
  });
  it('allows preserving an owned reference but rejects references from a different service',async()=>{
    const {app,headers,create}=await fixture();
    const first=(await create({...appInput,environment:[{name:'TOKEN',secret:true,value:'secret-first-2468'}]})).json().service;
    const second=(await create({...appInput,name:'other',hostname:'other.localhost'},'create-other')).json().service;
    const ref=first.environment[0].secretRef;
    const keep=await app.inject({method:'PATCH',url:`/api/v1/services/${first.id}`,headers,payload:{expectedRevision:1,environment:[{name:'TOKEN',secret:true,secretRef:ref}]}});
    expect(keep.statusCode).toBe(200);
    const steal=await app.inject({method:'PATCH',url:`/api/v1/services/${second.id}`,headers,payload:{expectedRevision:1,environment:[{name:'STOLEN',secret:true,secretRef:ref}]}});
    expect(steal.statusCode).toBe(403);expect(steal.json().error.code).toBe('SECRET_REFERENCE');
  });
  it('generates database credentials, reveals them only explicitly and keeps them out of API snapshots',async()=>{
    const {app,store,headers,create}=await fixture();
    const response=await create({name:'database',kind:'postgres'});
    expect(response.statusCode).toBe(202);const {service}=response.json();
    expect(service.image).toBe('postgres:17-alpine');expect(service.port).toBe(5432);expect(service.domains).toEqual([]);
    expect(service.database.password).toBeUndefined();expect(service.database.passwordSecretRef).toBeTruthy();
    expect((await app.inject({url:`/api/v1/services/${service.id}/connection`,headers})).statusCode).toBe(409);finishFirst(store);
    const connection=await app.inject({url:`/api/v1/services/${service.id}/connection`,headers});expect(connection.json().password).toBeUndefined();expect(connection.json().host).toBe(`panel-app-${service.id}`);
    expect((await app.inject({method:'POST',url:`/api/v1/services/${service.id}/connection/reveal`,headers:{cookie:headers.cookie}})).statusCode).toBe(403);
    const revealed=await app.inject({method:'POST',url:`/api/v1/services/${service.id}/connection/reveal`,headers});expect(revealed.statusCode).toBe(200);expect(revealed.json().password.length).toBeGreaterThanOrEqual(24);
    expect(JSON.stringify(store.listServices())).not.toContain(revealed.json().password);
    expect((store.db.prepare("SELECT count(*) AS count FROM audit_events WHERE operation='connection.reveal'").get() as {count:number}).count).toBe(1);
  });
  it('rejects inactive database credential edits and reveals the confirmed deployment credentials',async()=>{
    const {app,store,headers,create}=await fixture();
    const response=await create({name:'database',kind:'postgres',database:{database:'app',user:'app',password:'original-database-password'}});
    const {service}=response.json();finishFirst(store);
    const patch=await app.inject({method:'PATCH',url:`/api/v1/services/${service.id}`,headers,payload:{expectedRevision:1,database:{database:'app',user:'app',password:'new-inactive-password'}}});
    expect(patch.statusCode).toBe(409);expect(patch.json().error.code).toBe('DATABASE_CREDENTIALS_IMMUTABLE');
    const revealed=await app.inject({method:'POST',url:`/api/v1/services/${service.id}/connection/reveal`,headers});expect(revealed.json().password).toBe('original-database-password');
    store.db.prepare('UPDATE services SET config=? WHERE id=?').run(JSON.stringify({...service,database:{database:'not-deployed',user:'not-deployed',passwordSecretRef:service.database.passwordSecretRef}}),service.id);
    const connection=await app.inject({url:`/api/v1/services/${service.id}/connection`,headers});expect(connection.json().database).toBe('app');expect(connection.json().user).toBe('app');
  });
  it('rejects an unplanned image upgrade of a deployed database without mutating its configuration',async()=>{
    const {app,store,headers,create}=await fixture();const {service}=(await create({name:'database',kind:'postgres'})).json();finishFirst(store);
    const response=await app.inject({method:'PATCH',url:`/api/v1/services/${service.id}`,headers,payload:{expectedRevision:1,image:'postgres:18-alpine'}});
    expect(response.statusCode).toBe(409);expect(response.json().error.code).toBe('DATABASE_UPGRADE_REQUIRES_MIGRATION');expect(store.getService(service.id)!.revision).toBe(1);expect(store.getService(service.id)!.image).toBe('postgres:17-alpine');
  });
  it('rejects stateful replicas, duplicate env/domain fields and conflicting secondary domains',async()=>{
    const {app,headers,create}=await fixture();
    for(const payload of [
      {name:'db',kind:'postgres',replicas:2},
      {...appInput,replicas:2,mounts:[{type:'volume',name:'data',target:'/data'}]},
      {...appInput,environment:[{name:'MODE',value:'a'},{name:'MODE',value:'b'}]},
      {...appInput,domains:[{hostname:'same.localhost',port:80},{hostname:'same.localhost',port:8080}]},
      {...appInput,mounts:[{type:'bind',name:'outside',target:'/data',source:'/etc'}]},
    ])expect((await create(payload)).statusCode).toBe(400);
    const first=await create({...appInput,domains:[{hostname:'first.localhost',port:80,primary:true},{hostname:'shared.localhost',port:80}]});expect(first.statusCode).toBe(202);
    const conflict=await create({...appInput,name:'second',hostname:'second.localhost',domains:[{hostname:'shared.localhost',port:80}]},'second');expect(conflict.statusCode).toBe(409);
    const service=first.json().service;
    const change=await app.inject({method:'PATCH',url:`/api/v1/services/${service.id}`,headers,payload:{expectedRevision:1,kind:'redis'}});expect(change.statusCode).toBe(400);
  });
  it('preserves legacy hostname and port edits when a service has explicit domains',async()=>{
    const {app,headers,create}=await fixture();
    const {service}=(await create({...appInput,domains:[{hostname:'primary.localhost',port:80,primary:true},{hostname:'secondary.localhost',port:8080}]})).json();
    const response=await app.inject({method:'PATCH',url:`/api/v1/services/${service.id}`,headers,payload:{expectedRevision:1,hostname:'changed.localhost',port:3000}});
    expect(response.statusCode).toBe(200);expect(response.json().hostname).toBe('changed.localhost');
    expect(response.json().domains).toEqual([{hostname:'changed.localhost',port:3000,primary:true},{hostname:'secondary.localhost',port:8080}]);
  });
  it('reserves deployed and in-flight domains until a later deployment replaces them',async()=>{
    const {app,store,headers,create,auth}=await fixture();
    const first=await create({...appInput,hostname:'active.localhost'});
    const {service}=first.json();
    finishFirst(store);
    const update=(revision:number,hostname:string)=>app.inject({method:'PATCH',url:`/api/v1/services/${service.id}`,headers,payload:{expectedRevision:revision,hostname}});
    const collision=(hostname:string,key:string)=>create({...appInput,name:key,hostname},key);
    expect((await update(1,'pending.localhost')).statusCode).toBe(200);
    expect((await collision('active.localhost','collision1')).statusCode).toBe(409);
    const deploy=store.createAction(service.id,'deploy',auth.user.id,'domain-deploy');
    const job=store.claimNextJob('domain-worker',60000)!;
    expect(job.actionId).toBe(deploy.id);
    expect((await update(2,'next.localhost')).statusCode).toBe(200);
    expect((await collision('pending.localhost','collision2')).statusCode).toBe(409);
    expect((await collision('active.localhost','collision3')).statusCode).toBe(409);
    expect(store.completeAction(deploy.id,'domain-worker',{state:'running',deployedRevision:2})).toBe(true);
    expect((await collision('pending.localhost','collision4')).statusCode).toBe(409);
    expect((await collision('active.localhost','available')).statusCode).toBe(202);
  });
  it('retains a failed deployment domain until a later deployment succeeds',async()=>{
    const {app,store,headers,create,auth}=await fixture();
    const {service}=(await create({...appInput,hostname:'live.localhost'})).json();finishFirst(store);
    const update=(revision:number,hostname:string)=>app.inject({method:'PATCH',url:`/api/v1/services/${service.id}`,headers,payload:{expectedRevision:revision,hostname}});
    expect((await update(1,'attempt.localhost')).statusCode).toBe(200);
    const action=store.createAction(service.id,'deploy',auth.user.id,'failed-domain');store.claimNextJob('failed-domain-worker',60000);
    expect((await update(2,'planned.localhost')).statusCode).toBe(200);
    expect(store.failAction(action.id,'failed-domain-worker','Failed to start')).toBe(true);
    expect((await create({...appInput,name:'new-one',hostname:'live.localhost'},'new-one')).statusCode).toBe(409);
    expect((await create({...appInput,name:'new-two',hostname:'attempt.localhost'},'new-two')).statusCode).toBe(409);
    const resolved=store.createAction(service.id,'deploy',auth.user.id,'reconciled-domain');store.claimNextJob('reconciled-worker',60000);
    expect(store.completeAction(resolved.id,'reconciled-worker',{state:'running',deployedRevision:3})).toBe(true);
    expect((await create({...appInput,name:'new-two',hostname:'attempt.localhost'},'new-two')).statusCode).toBe(202);
  });
  it('rejects a database credential reference bound to another service',async()=>{
    const {create}=await fixture();
    const {service}=(await create({name:'first-db',kind:'postgres'})).json();
    const response=await create({name:'second-db',kind:'postgres',database:{database:'app',user:'app',passwordSecretRef:service.database.passwordSecretRef}},'second-db');
    expect(response.statusCode).toBe(403);expect(response.json().error.code).toBe('SECRET_REFERENCE');
  });
  it('preserves absent metadata but clears an explicitly null source commit',async()=>{
    const {store,create}=await fixture();const {service}=(await create(appInput)).json();
    store.updateServiceRuntime(service.id,{state:'running',sourceCommit:'abc123',imageDigest:'sha256:digest'});
    store.updateServiceRuntime(service.id,{state:'stopped'});expect(store.getService(service.id)!.sourceCommit).toBe('abc123');
    store.updateServiceRuntime(service.id,{state:'running',sourceCommit:null});expect(store.getService(service.id)!.sourceCommit).toBeNull();expect(store.getService(service.id)!.imageDigest).toBe('sha256:digest');
  });
  it('validates public Git source paths and permits HTTP only through the explicit fixture allowlist',async()=>{
    const {create}=await fixture();
    const source={type:'git',repository:'https://github.com/example/public.git',branch:'main',context:'.',dockerfile:'Dockerfile'};
    expect((await create({name:'git',hostname:'git.localhost',source:{...source,context:'../outside'}})).statusCode).toBe(400);
    expect((await create({name:'git',hostname:'git.localhost',source:{...source,repository:'https://user:password@github.com/example/repo'}})).statusCode).toBe(400);
    expect((await create({name:'git',hostname:'git.localhost',source:{...source,repository:'http://127.0.0.1/repo'}})).statusCode).toBe(400);
    expect((await create({name:'git',hostname:'git.localhost',source})).statusCode).toBe(202);
  });
});

describe('soft deletion and audit history',()=>{
  it('queues destruction, tombstones only on success, frees domains and preserves project history',async()=>{
    const {app,store,headers,project,create}=await fixture();
    const {service}=((await create(appInput)).json());finishFirst(store);
    expect((await app.inject({method:'DELETE',url:`/api/v1/projects/${project.id}`,headers})).statusCode).toBe(409);
    const removed=await app.inject({method:'DELETE',url:`/api/v1/services/${service.id}`,headers:{...headers,'idempotency-key':'destroy-web'}});
    expect(removed.statusCode).toBe(202);expect(store.getService(service.id)).toBeTruthy();
    const job=store.claimNextJob('destroy-worker',60000)!;expect(job.type).toBe('destroy');
    store.completeAction(job.actionId,'destroy-worker',{state:'stopped',deployedRevision:1});
    expect(store.getService(service.id)).toBeUndefined();expect(store.getService(service.id,true)!.deletedAt).toBeTruthy();
    expect((await app.inject({url:`/api/v1/services/${service.id}`,headers})).statusCode).toBe(404);
    expect((await app.inject({url:`/api/v1/services/${service.id}/actions`,headers})).statusCode).toBe(200);
    const repeated=await app.inject({method:'DELETE',url:`/api/v1/services/${service.id}`,headers:{...headers,'idempotency-key':'destroy-web'}});expect(repeated.json().id).toBe(removed.json().id);
    expect((await app.inject({method:'DELETE',url:`/api/v1/projects/${project.id}`,headers})).statusCode).toBe(200);
    expect((await app.inject({url:`/api/v1/actions?projectId=${project.id}`,headers})).json().length).toBe(2);
    expect((await app.inject({url:`/api/v1/actions/${job.actionId}`,headers})).statusCode).toBe(200);
  });
  it('allows a destroyed service name and domain to be reused without deleting old records',async()=>{
    const {store,create}=await fixture();const {service}=((await create(appInput)).json());finishFirst(store);
    const actor=store.findUser('admin@example.test')!;
    const action=store.createAction(service.id,'destroy',actor.id,'destroy');store.claimNextJob('destroy',60000);store.completeAction(action.id,'destroy',{state:'stopped',deployedRevision:1});
    const replacement=await create(appInput,'replacement');expect(replacement.statusCode).toBe(202);expect(replacement.json().service.id).not.toBe(service.id);expect(store.getAction(action.id)).toBeTruthy();
  });
  it('updates project details without changing service identities',async()=>{
    const {app,headers,project,create}=await fixture();const {service}=((await create(appInput)).json());
    const changed=await app.inject({method:'PATCH',url:`/api/v1/projects/${project.id}`,headers,payload:{name:'renamed',description:'Updated project'}});
    expect(changed.statusCode).toBe(200);expect(changed.json().name).toBe('renamed');
    expect((await app.inject({url:`/api/v1/services/${service.id}`,headers})).json().projectId).toBe(project.id);
  });
  it('rolls a project update back if its audit event cannot be persisted',async()=>{
    const {app,store,headers,project}=await fixture();
    const audit=vi.spyOn(store,'recordAudit').mockImplementation(()=>{throw new Error('Audit storage unavailable');});
    const response=await app.inject({method:'PATCH',url:`/api/v1/projects/${project.id}`,headers,payload:{name:'should-not-commit'}});
    expect(response.statusCode).toBe(500);expect(store.getProject(project.id)!.name).toBe('advanced');audit.mockRestore();
  });
});

describe('runtime reads and console grants',()=>{
  it('scopes runtime reads and redacts secrets from actual log results',async()=>{
    const secret='private-log-token-1234';
    const runtime:typeof agentRequest=async<T>(path,body,options)=>path.includes('/logs')?{lines:[`2026-11-13T00:00:00Z token=${secret}`]} as T:defaultAgent<T>(path,body,options);
    const {app,headers,create}=await fixture({agentRequest:runtime});
    const {service}=((await create({...appInput,environment:[{name:'TOKEN',secret:true,value:secret}]})).json());
    const logs=await app.inject({url:`/api/v1/services/${service.id}/logs?tail=20`,headers});expect(logs.statusCode).toBe(200);expect(logs.body).not.toContain(secret);expect(logs.body).toContain('[REDACTED]');
    expect((await app.inject({url:`/api/v1/services/${service.id}/metrics`,headers})).json().memoryBytes).toBe(100);
    expect((await app.inject({url:`/api/v1/services/${service.id}/containers`,headers})).json()[0].id).toBe(containerId);
    expect((await app.inject({url:`/api/v1/services/${service.id}/logs`})).statusCode).toBe(401);
    expect((await app.inject({url:`/api/v1/services/${service.id}/logs?tail=999999`,headers})).statusCode).toBe(400);
  });
  it('requires an owned container, a write grant and CSRF to create a console ticket',async()=>{
    const {app,store,headers,project,create}=await fixture();const {service}=((await create(appInput)).json());
    const request={method:'POST' as const,url:`/api/v1/services/${service.id}/console-ticket`,payload:{containerId,shell:'/bin/sh'}};
    expect((await app.inject(request)).statusCode).toBe(401);
    expect((await app.inject({...request,headers:{cookie:headers.cookie}})).statusCode).toBe(403);
    expect((await app.inject({...request,headers,payload:{containerId:'b'.repeat(64)}})).statusCode).toBe(404);
    const viewer=store.createUser('viewer@example.test',await hashPassword('viewer-local-password'));store.addMember(project.id,viewer.id,'viewer');const session=store.createSession(viewer.id);
    expect((await app.inject({...request,headers:{cookie:`panel_session=${session.token}`,'x-csrf-token':session.csrfToken}})).statusCode).toBe(404);
    const granted=await app.inject({...request,headers});expect(granted.statusCode).toBe(200);expect(granted.json().ticket).toHaveLength(64);
  });
  it('binds console grants to one session and expires them after thirty seconds',async()=>{
    const {app,store,auth,headers,create}=await fixture();const {service}=(await create(appInput)).json();
    const grant=async()=> (await app.inject({method:'POST',url:`/api/v1/services/${service.id}/console-ticket`,headers,payload:{containerId}})).json().ticket;
    const bound=await grant(),other=store.createSession(auth.user.id);
    const wrong=await app.injectWS(`/api/v1/services/${service.id}/console`,{headers:{cookie:`panel_session=${other.token}`,origin:'http://localhost:4180'}});
    wrong.send(JSON.stringify({type:'authenticate',ticket:bound}));
    await vi.waitFor(()=>expect(wrong.readyState).toBe(WebSocket.CLOSED));
    const expiring=await grant();
    const ws=await app.injectWS(`/api/v1/services/${service.id}/console`,{headers:{cookie:headers.cookie,origin:'http://localhost:4180'}});
    const clock=vi.spyOn(Date,'now').mockReturnValue(Date.now()+31000);
    try{ws.send(JSON.stringify({type:'authenticate',ticket:expiring}));await vi.waitFor(()=>expect(ws.readyState).toBe(WebSocket.CLOSED));}
    finally{clock.mockRestore();}
  });
  it('closes unauthenticated console connections after the deadline',async()=>{
    const {app,headers,create}=await fixture();const {service}=(await create(appInput)).json();
    const ws=await app.injectWS(`/api/v1/services/${service.id}/console`,{headers:{cookie:headers.cookie,origin:'http://localhost:4180'}});
    await vi.waitFor(()=>expect(ws.readyState).toBe(WebSocket.CLOSED),{timeout:7000,interval:100});
  },10000);
  it('limits connections waiting for console authentication',async()=>{
    const {app,headers,create}=await fixture();const {service}=(await create(appInput)).json();
    const sockets=await Promise.all(Array.from({length:101},()=>app.injectWS(`/api/v1/services/${service.id}/console`,{headers:{cookie:headers.cookie,origin:'http://localhost:4180'}})));
    try {
      await vi.waitFor(()=>expect(sockets.filter(socket=>socket.readyState===WebSocket.CLOSED).length).toBeGreaterThanOrEqual(1));
      expect(sockets.filter(socket=>socket.readyState===WebSocket.OPEN)).toHaveLength(100);
    } finally { for(const ws of sockets)ws.terminate(); }
  });
  it('does not accept terminal input before the agent connection is ready',async()=>{
    const dir=mkdtempSync(join(tmpdir(),'panel-console-wait-')),socketPath=join(dir,'upstream.sock'),server=createServer();
    let upgradeSeen=false;const connections=new Set<import('node:stream').Duplex>();
    server.on('upgrade',(_req,socket)=>{upgradeSeen=true;connections.add(socket);socket.on('error',()=>{});socket.on('close',()=>connections.delete(socket));});
    await new Promise<void>(resolve=>server.listen(socketPath,resolve));
    cleanup.push(async()=>{for(const socket of connections)socket.destroy();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(dir,{recursive:true,force:true});});
    const {app,headers,create}=await fixture({agentConnection:{socketPath,token:'local-agent-token'}});const {service}=(await create(appInput)).json();
    const ticket=(await app.inject({method:'POST',url:`/api/v1/services/${service.id}/console-ticket`,headers,payload:{containerId}})).json().ticket;
    const messages:string[]=[];
    const ws=await app.injectWS(`/api/v1/services/${service.id}/console`,{headers:{cookie:headers.cookie,origin:'http://localhost:4180'}},{onInit:socket=>socket.on('message',data=>messages.push(data.toString()))});
    ws.send(JSON.stringify({type:'authenticate',ticket}));
    await vi.waitFor(()=>expect(upgradeSeen).toBe(true));expect(messages).not.toContain(JSON.stringify({type:'ready'}));
    ws.send(JSON.stringify({type:'input',data:'not ready'}));
    await vi.waitFor(()=>expect(ws.readyState).toBe(WebSocket.CLOSED));expect(messages).not.toContain(JSON.stringify({type:'ready'}));
  });
  it('reports an agent connection failure without a ready frame',async()=>{
    const dir=mkdtempSync(join(tmpdir(),'panel-console-missing-'));
    cleanup.push(async()=>rmSync(dir,{recursive:true,force:true}));
    const {app,headers,create}=await fixture({agentConnection:{socketPath:join(dir,'missing.sock'),token:'local-agent-token'}});const {service}=(await create(appInput)).json();
    const ticket=(await app.inject({method:'POST',url:`/api/v1/services/${service.id}/console-ticket`,headers,payload:{containerId}})).json().ticket;
    const messages:string[]=[],codes:number[]=[];
    const ws=await app.injectWS(`/api/v1/services/${service.id}/console`,{headers:{cookie:headers.cookie,origin:'http://localhost:4180'}},{onInit:socket=>{socket.on('message',data=>messages.push(data.toString()));socket.on('close',code=>codes.push(code));}});
    ws.send(JSON.stringify({type:'authenticate',ticket}));
    await vi.waitFor(()=>expect(ws.readyState).toBe(WebSocket.CLOSED));
    expect(codes).toContain(1011);expect(messages).not.toContain(JSON.stringify({type:'ready'}));
  });
  it('distinguishes a clean shell exit from an upstream failure',async()=>{
    const dir=mkdtempSync(join(tmpdir(),'panel-console-exit-')),socketPath=join(dir,'upstream.sock'),server=createServer(),wss=new WebSocketServer({noServer:true});
    let exitCode=1000;
    server.on('upgrade',(req,socket,head)=>wss.handleUpgrade(req,socket,head,upstream=>{setTimeout(()=>upstream.close(exitCode,'internal detail'),100);}));
    await new Promise<void>(resolve=>server.listen(socketPath,resolve));
    cleanup.push(async()=>{for(const ws of wss.clients)ws.terminate();wss.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(dir,{recursive:true,force:true});});
    const {app,headers,create}=await fixture({agentConnection:{socketPath,token:'local-agent-token'}});const {service}=(await create(appInput)).json();
    const connect=async()=>{
      const ticket=(await app.inject({method:'POST',url:`/api/v1/services/${service.id}/console-ticket`,headers,payload:{containerId}})).json().ticket;
      const codes:number[]=[],reasons:string[]=[],messages:string[]=[];
      const ws=await app.injectWS(`/api/v1/services/${service.id}/console`,{headers:{cookie:headers.cookie,origin:'http://localhost:4180'}},{onInit:client=>{client.on('close',(code,reason)=>{codes.push(code);reasons.push(reason.toString());});client.on('message',data=>messages.push(data.toString()));}});
      ws.send(JSON.stringify({type:'authenticate',ticket}));await vi.waitFor(()=>expect(ws.readyState).toBe(WebSocket.CLOSED));
      return {codes,reasons,messages};
    };
    const normal=await connect();expect(normal.codes).toEqual([1000]);expect(normal.messages).toContain(JSON.stringify({type:'ready'}));
    exitCode=1011;const failed=await connect();expect(failed.codes).toEqual([1011]);expect(failed.reasons.join(' ')).not.toContain('internal detail');expect(failed.messages).toContain(JSON.stringify({type:'ready'}));
  });
  it('streams redacted runtime logs and closes the stream when its session is revoked',async()=>{
    const secret='stream-token-987654';
    const runtime:typeof agentRequest=async<T>(path,body,options)=>path.includes('/logs')?{lines:[`2026-11-13T00:00:00.000Z credential=${secret}`]} as T:defaultAgent<T>(path,body,options);
    const {app,headers,create}=await fixture({agentRequest:runtime});const {service}=((await create({...appInput,environment:[{name:'TOKEN',secret:true,value:secret}]})).json());
    await app.listen({host:'127.0.0.1',port:0});
    const address=app.server.address();if(!address||typeof address==='string')throw new Error('Expected a local HTTP endpoint');
    const controller=new AbortController();cleanup.push(async()=>controller.abort());
    const response=await fetch(`http://127.0.0.1:${address.port}/api/v1/services/${service.id}/logs/stream`,{headers:{cookie:headers.cookie},signal:controller.signal});
    expect(response.status).toBe(200);expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader=response.body!.getReader(),first=await reader.read(),text=new TextDecoder().decode(first.value);
    expect(text).toContain('data:');expect(text).toContain('[REDACTED]');expect(text).not.toContain(secret);
    await app.inject({method:'POST',url:'/api/v1/auth/logout',headers});
    let ended=false;
    while(!ended){const next=await reader.read();ended=next.done;}
    expect(ended).toBe(true);
  });
  it('bridges terminal data, consumes tickets once, checks Origin and closes after logout',async()=>{
    const dir=mkdtempSync(join(tmpdir(),'panel-console-')),socketPath=join(dir,'upstream.sock'),server=createServer(),wss=new WebSocketServer({noServer:true});
    const received:string[]=[];
    server.on('upgrade',(req,socket,head)=>{if(req.headers.authorization!=='Bearer local-agent-token'){socket.destroy();return;}wss.handleUpgrade(req,socket,head,ws=>{ws.send(Buffer.from('terminal-ready'));ws.on('message',data=>received.push(data.toString()));});});
    await new Promise<void>(resolve=>server.listen(socketPath,resolve));
    cleanup.push(async()=>{for(const ws of wss.clients)ws.terminate();wss.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(dir,{recursive:true,force:true});});
    const {app,headers,create}=await fixture({agentConnection:{socketPath,token:'local-agent-token'}});const {service}=((await create(appInput)).json());
    const grant=async()=> (await app.inject({method:'POST',url:`/api/v1/services/${service.id}/console-ticket`,headers,payload:{containerId,shell:'/bin/sh'}})).json().ticket;
    const deniedTicket=await grant();
    await expect(app.injectWS(`/api/v1/services/${service.id}/console`,{headers:{cookie:headers.cookie,origin:'https://attacker.test'}})).rejects.toThrow();
    await expect(app.injectWS(`/api/v1/services/${service.id}/console?ticket=${deniedTicket}`,{headers:{cookie:headers.cookie,origin:'http://localhost:4180'}})).rejects.toThrow();
    const unauth=await app.injectWS(`/api/v1/services/${service.id}/console`,{headers:{cookie:headers.cookie,origin:'http://localhost:4180'}});
    unauth.send(JSON.stringify({type:'input',data:'do not execute'}));
    await vi.waitFor(()=>expect(unauth.readyState).toBe(WebSocket.CLOSED));expect(wss.clients.size).toBe(0);
    const ticket=await grant(),chunks:string[]=[];
    const ws=await app.injectWS(`/api/v1/services/${service.id}/console`,{headers:{cookie:headers.cookie,origin:'http://localhost:4180'}},{onInit:socket=>socket.on('message',data=>chunks.push(data.toString()))});
    expect(wss.clients.size).toBe(0);
    ws.send(JSON.stringify({type:'authenticate',ticket}));
    await vi.waitFor(()=>expect(chunks).toContain(JSON.stringify({type:'ready'})));
    await vi.waitFor(()=>expect(chunks).toContain('terminal-ready'));
    expect(chunks.indexOf(JSON.stringify({type:'ready'}))).toBeLessThan(chunks.indexOf('terminal-ready'));
    ws.send(JSON.stringify({type:'input',data:'echo hello\r'}));await vi.waitFor(()=>expect(received).toHaveLength(1));
    const replay=await app.injectWS(`/api/v1/services/${service.id}/console`,{headers:{cookie:headers.cookie,origin:'http://localhost:4180'}});
    replay.send(JSON.stringify({type:'authenticate',ticket}));await vi.waitFor(()=>expect(replay.readyState).toBe(WebSocket.CLOSED));
    await app.inject({method:'POST',url:'/api/v1/auth/logout',headers});await vi.waitFor(()=>expect(ws.readyState).toBe(WebSocket.CLOSED),{timeout:3000});
  });
});

describe('v1 to v2 migration',()=>{
  it('preserves legacy projects, services and queued jobs while adding configuration storage',async()=>{
    const dir=mkdtempSync(join(tmpdir(),'panel-v1-upgrade-'));cleanup.push(async()=>rmSync(dir,{recursive:true,force:true}));
    const db=new Database(join(dir,'panel.sqlite'));
    db.exec(`CREATE TABLE users(id TEXT PRIMARY KEY,email TEXT,password_hash TEXT,role TEXT,created_at TEXT);
      CREATE TABLE sessions(token_hash TEXT PRIMARY KEY,user_id TEXT,csrf_token TEXT,expires_at TEXT,absolute_expires_at TEXT);
      CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT UNIQUE,description TEXT,created_at TEXT);
      CREATE TABLE memberships(project_id TEXT,user_id TEXT,role TEXT,PRIMARY KEY(project_id,user_id));
      CREATE TABLE services(id TEXT PRIMARY KEY,project_id TEXT,name TEXT,image TEXT,port INTEGER,hostname TEXT UNIQUE,replicas INTEGER,revision INTEGER,deployed_revision INTEGER,state TEXT,last_error TEXT,created_at TEXT,updated_at TEXT,UNIQUE(project_id,name));
      CREATE TABLE actions(id TEXT PRIMARY KEY,project_id TEXT,service_id TEXT,actor_id TEXT,type TEXT,status TEXT,phase TEXT,error TEXT,created_at TEXT,updated_at TEXT,finished_at TEXT);
      CREATE TABLE jobs(id TEXT PRIMARY KEY,action_id TEXT UNIQUE,service_id TEXT,snapshot TEXT,status TEXT,attempts INTEGER DEFAULT 0,worker_id TEXT,lease_until TEXT,created_at TEXT);
      CREATE UNIQUE INDEX active_job_service ON jobs(service_id) WHERE status IN ('queued','running');
      CREATE TABLE action_events(id TEXT PRIMARY KEY,action_id TEXT,sequence INTEGER,level TEXT,message TEXT,created_at TEXT,UNIQUE(action_id,sequence));
      CREATE TABLE idempotency(actor_id TEXT,key TEXT,request_hash TEXT,action_id TEXT,PRIMARY KEY(actor_id,key));PRAGMA user_version=1;`);
    db.prepare('INSERT INTO users VALUES (?,?,?,?,?)').run('admin','admin@example.test','unused','admin','2026-01-01');
    db.prepare('INSERT INTO projects VALUES (?,?,?,?)').run('legacy','legacy','existing data','2026-01-01');
    db.prepare('INSERT INTO services VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run('service','legacy','web','nginx:alpine',80,'legacy.localhost',1,1,null,'pending',null,'2026-01-01','2026-01-01');
    const legacySnapshot={id:'service',projectId:'legacy',name:'web',image:'nginx:alpine',port:80,hostname:'legacy.localhost',replicas:1,revision:1,deployedRevision:null,state:'pending',createdAt:'2026-01-01',updatedAt:'2026-01-01',lastError:null};
    db.prepare('INSERT INTO actions VALUES (?,?,?,?,?,?,?,?,?,?,?)').run('legacy-action','legacy','service','admin','deploy','queued','queued',null,'2026-01-01','2026-01-01',null);
    db.prepare('INSERT INTO jobs(id,action_id,service_id,snapshot,status,created_at) VALUES (?,?,?,?,?,?)').run('legacy-job','legacy-action','service',JSON.stringify(legacySnapshot),'queued','2026-01-01');
    db.close();const store=new Store(dir);cleanup.push(async()=>store.close());
    expect(store.db.pragma('user_version',{simple:true})).toBe(5);expect(store.getProject('legacy')!.description).toBe('existing data');expect(store.getService('service')!.kind).toBe('app');
    const recovered=store.claimNextJob('migration-worker',60000)!;expect(recovered.actionId).toBe('legacy-action');expect(recovered.snapshot).toEqual(legacySnapshot);
    expect(store.updateService('service',{expectedRevision:1,environment:[{name:'TOKEN',secret:true,value:'migration-secret-123'}]}).environment![0]!.secretRef).toBeTruthy();
  });
});

it('checks a saved Git source only for authorized editors and never returns credentials',async()=>{
  const commit='a'.repeat(40), received:unknown[]=[];
  const runtime:typeof agentRequest=async<T>(path:string,body?:unknown)=>{
    expect(path).toBe('/services/check-source');received.push(body);return {commit} as T;
  };
  const {app,headers,create,store}=await fixture({agentRequest:runtime});
  const source={type:'git',repository:'https://github.com/example/private.git',branch:'main',context:'.',dockerfile:'Dockerfile',credential:{username:'git-user',token:'private-token-123'}};
  const {service}=(await create({...appInput,source})).json();
  const url=`/api/v1/services/${service.id}/check-source`;
  expect((await app.inject({method:'POST',url,headers:{cookie:headers.cookie},payload:{}})).statusCode).toBe(403);
  const viewer=store.createUser('source-viewer@example.test',await hashPassword('viewer-testing-password'));store.addMember(service.projectId,viewer.id,'viewer');const session=store.createSession(viewer.id);
  expect((await app.inject({method:'POST',url,headers:{cookie:`panel_session=${session.token}`,'x-csrf-token':session.csrfToken},payload:{}})).statusCode).toBe(404);
  const result=await app.inject({method:'POST',url,headers,payload:{}});
  expect(result.statusCode).toBe(200);expect(result.json()).toEqual({commit});
  expect(JSON.stringify(received)).not.toContain('private-token-123');expect(result.body).not.toContain('private-token-123');
  const candidate={repository:source.repository,branch:'feature',context:'web',dockerfile:'Dockerfile'};
  const preview=await app.inject({method:'POST',url,headers,payload:candidate});expect(preview.statusCode).toBe(200);
  expect((received.at(-1) as {service:{source:{branch:string}}}).service.source.branch).toBe('feature');
  expect(store.getService(service.id)?.source).toMatchObject({branch:'main',context:'.'});
  expect((await app.inject({method:'POST',url,headers,payload:{...candidate,context:'../escape'}})).statusCode).toBe(400);
  expect((await app.inject({method:'POST',url,headers,payload:{...candidate,repository:'https://github.com/other/repo.git'}})).statusCode).toBe(403);
});
