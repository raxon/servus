import {afterEach,describe,it,expect,vi} from 'vitest';
import Database from 'better-sqlite3';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {PassThrough} from 'node:stream';
import ssh2 from 'ssh2';
import WebSocket from 'ws';
import {createAgent} from '../../src/agent/app.js';
import {VolumeBackupRuntime} from '../../src/agent/volume-backups.js';
import {DockerRuntime} from '../../src/agent/runtime.js';
import {registryLabels} from '../../src/agent/registry-credentials.js';
import {AgentMaintenanceGate} from '../../src/agent/maintenance.js';
import {RedisRestore} from '../../src/agent/redis-restore.js';
import {RestoreJournal} from '../../src/agent/restore-journal.js';
import {SecretVault} from '../../src/shared/secrets.js';
import {Store} from '../../src/server/store.js';
import {normalizeServiceInput} from '../../src/server/configuration.js';
import {VolumeBackups} from '../../src/server/volume-backups.js';
import {AppError} from '../../src/server/errors.js';
import type {agentRequest} from '../../src/agent/client.js';
import type {Service} from '../../src/shared/types.js';

const cleanup:(()=>void|Promise<void>)[]=[];
afterEach(async()=>{for(const dispose of cleanup.splice(0).reverse())await dispose();vi.restoreAllMocks();});
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(error:Error)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}
function root(){const path=mkdtempSync(join(tmpdir(),'servus-parity-security-'));cleanup.push(()=>rmSync(path,{recursive:true,force:true}));return path;}
function storeFixture(){const path=root(),store=new Store(path);cleanup.push(()=>store.close());const actor=store.setup('security@example.test','fixture-hash'),project=store.createProject('security');const service=store.createService(project.id,normalizeServiceInput({name:'files',domains:[],image:'nginx:alpine',mounts:[{type:'volume',name:'files',target:'/data'}]}),actor.id).service;const job=store.claimNextJob('fixture',60_000)!;store.completeAction(job.actionId,'fixture',{state:'running',deployedRevision:1});return{path,store,actor,project,service:store.getService(service.id)!};}
async function agentFixture(){const path=root(),apply=vi.fn(async()=>({state:'running' as const,deployedRevision:1,messages:[]})),consoleContainer=vi.fn(),gate=new AgentMaintenanceGate();const config={dataDir:path,token:'fixture-token',socketPath:join(path,'agent.sock'),dockerSocket:'/never-connect',ingressPort:18080,ingressImage:'unused'};const app=await createAgent(config,{status:async()=>({online:true}),inspectService:async()=>({state:'running'}),apply,consoleContainer},gate);await app.ready();cleanup.push(()=>app.close());return{path,app,apply,consoleContainer,gate,headers:{authorization:'Bearer fixture-token'}};}
function service(id=randomUUID()):Service {const stamp=new Date().toISOString();return{id,projectId:randomUUID(),name:'files',kind:'app',image:'nginx:alpine',hostname:'files.localhost',port:80,replicas:1,revision:1,deployedRevision:1,state:'running',createdAt:stamp,updatedAt:stamp,lastError:null};}
function managerFixture(){const f=storeFixture();let now=new Date();const handler=vi.fn(async(path:string,input:any)=>path==='/volume-backups/capture'?{phase:'completed',size:10,sha256:'a'.repeat(64)}:{id:input.operationId,backupId:input.backupId,serviceId:input.serviceId,mountTarget:'/data',phase:'prepared',candidateVolume:`panel-volume-restore-${input.operationId}`,previousVolume:`panel-data-${input.serviceId}-files`,error:null,createdAt:now.toISOString(),updatedAt:now.toISOString()});const manager=new VolumeBackups({store:f.store,serviceAccess:()=>{throw Error('Unused direct manager fixture');},agentRequest:handler as unknown as typeof agentRequest,startScheduler:false,now:()=>now});cleanup.push(()=>manager.close());return{...f,manager,handler,advance:()=>{now=new Date(now.getTime()+16*60_000);}};}

describe('integration security boundaries',()=>{
  it('serializes Redis operations by service across independent runtime instances',async()=>{
    const f=await agentFixture(),id=randomUUID(),a=randomBytes(16).toString('hex'),b=randomBytes(16).toString('hex'),stamp=new Date().toISOString(),db=new Database(join(f.path,'agent.sqlite'));cleanup.push(()=>db.close());
    const journal=new RestoreJournal(db,()=>false);db.prepare("INSERT INTO restore_operations VALUES(?,?,? ,?,'completed',?)").run(a,id,'redis','a'.repeat(64),stamp);db.prepare("INSERT INTO restore_operations VALUES(?,?,? ,?,'prepared',?)").run(b,id,'redis','b'.repeat(64),stamp);
    const options={db,journal,docker:{} as never,dockerSocket:'/never-connect',dataDir:f.path,vault:new SecretVault(f.path)},first=new RedisRestore(options),second=new RedisRestore(options),pending=deferred<{operationId:string;phase:'cancelled';rolledBack:boolean}>();
    const rollback=vi.spyOn(RedisRestore.prototype as any,'rollbackLocked').mockReturnValue(pending.promise),commit=vi.spyOn(RedisRestore.prototype as any,'commitLocked').mockResolvedValue({operationId:b,phase:'completed',rolledBack:false});
    const active=first.rollback(id,a);await vi.waitFor(()=>expect(rollback).toHaveBeenCalled());
    let blocked:unknown;try{await second.commit(id,b);}catch(error){blocked=error;}
    pending.resolve({operationId:a,phase:'cancelled',rolledBack:true});await active;expect(blocked).toMatchObject({code:'REDIS_RESTORE_BUSY'});expect(commit).not.toHaveBeenCalled();
  });
  it('holds the service lock before asynchronous capture inspection and excludes lifecycle and console',async()=>{
    const f=await agentFixture(),inspection=deferred<never>(),source=vi.spyOn(VolumeBackupRuntime.prototype as any,'source').mockReturnValue(inspection.promise),id=randomUUID();
    const pending=f.app.inject({method:'POST',url:'/volume-backups/capture',headers:f.headers,payload:{serviceId:id,operationId:randomUUID(),mountTarget:'/data'}}).then(value=>value);
    await vi.waitFor(()=>expect(source).toHaveBeenCalled());
    const lifecycle=await f.app.inject({method:'POST',url:'/services/apply',headers:f.headers,payload:{operationId:randomUUID(),type:'restart',service:service(id)}});
    const terminal=await f.app.inject({url:`/services/${id}/console`,headers:f.headers});
    inspection.reject(new Error('Fixture inspection stopped.'));await pending;
    expect(lifecycle.statusCode).toBe(409);expect(terminal.statusCode).toBe(409);expect(f.apply).not.toHaveBeenCalled();expect(f.consoleContainer).not.toHaveBeenCalled();
  });
  it('excludes candidate cancellation while another lifecycle operation owns the service',async()=>{
    const f=await agentFixture(),work=deferred<{state:'running';deployedRevision:number;messages:string[]}>(),id=randomUUID();f.apply.mockReturnValue(work.promise);
    const pending=f.app.inject({method:'POST',url:'/services/apply',headers:f.headers,payload:{operationId:randomUUID(),type:'restart',service:service(id)}}).then(value=>value);
    await vi.waitFor(()=>expect(f.apply).toHaveBeenCalled());
    const response=await f.app.inject({method:'POST',url:'/volume-restores/cancel',headers:f.headers,payload:{serviceId:id,operationId:randomUUID()}});
    work.resolve({state:'running',deployedRevision:1,messages:[]});await pending;expect(response.statusCode).toBe(409);expect(response.json().error.code).toBe('SERVICE_BUSY');
  });
  it('allows recovery of its own uncertain capture while fencing other service work',async()=>{
    const f=await agentFixture(),id=randomUUID(),operationId=randomUUID(),db=new Database(join(f.path,'agent.sqlite')),stamp=new Date().toISOString();
    db.prepare('INSERT INTO volume_backup_operations VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(operationId,id,'/data','files',`panel-data-${id}-files`,'needs_review','enc:v1:fixture',null,null,null,'fixture recovery pending',stamp,stamp);db.close();
    const resume=vi.spyOn(VolumeBackupRuntime.prototype as any,'resumeCapture').mockImplementation(async function(this:any,row:any){this.db.prepare("UPDATE volume_backup_operations SET phase='failed' WHERE id=?").run(row.id);});
    const lifecycle={method:'POST' as const,url:'/services/apply',headers:f.headers,payload:{operationId:randomUUID(),type:'restart',service:service(id)}};
    expect((await f.app.inject(lifecycle)).statusCode).toBe(409);
    expect((await f.app.inject({method:'POST',url:'/volume-backups/recover',headers:f.headers,payload:{serviceId:randomUUID(),operationId}})).statusCode).toBe(409);expect(resume).not.toHaveBeenCalled();
    const recovered=await f.app.inject({method:'POST',url:'/volume-backups/recover',headers:f.headers,payload:{serviceId:id,operationId}});expect(recovered.statusCode).toBe(200);expect(recovered.json()).toEqual({phase:'failed'});expect(resume).toHaveBeenCalledTimes(1);
    expect((await f.app.inject(lifecycle)).statusCode).toBe(200);expect(await f.gate.drain(100)).toEqual({status:'drained'});
  });
  it('keeps a running terminal exclusive from volume capture and retains uncertainty after failed exec inspection',async()=>{
    const f=await agentFixture(),id=randomUUID(),stream=new PassThrough(),inspect=vi.fn(async()=>{throw Error('Exec identity lost');});
    f.consoleContainer.mockResolvedValue({id:'a'.repeat(64),exec:async()=>({id:'b'.repeat(64),start:async()=>stream,inspect})});
    const address=await f.app.listen({host:'127.0.0.1',port:0}),socket=new WebSocket(`${address.replace('http:','ws:')}/services/${id}/console`,{headers:f.headers});
    socket.on('error',()=>{});cleanup.push(()=>socket.terminate());
    await vi.waitFor(()=>expect(stream.listenerCount('data')).toBeGreaterThan(0));
    const payload={serviceId:id,operationId:randomUUID(),mountTarget:'/data'};
    expect((await f.app.inject({method:'POST',url:'/volume-backups/capture',headers:f.headers,payload})).statusCode).toBe(409);
    const closed=new Promise<void>(resolve=>socket.once('close',()=>resolve()));socket.close();await closed;await vi.waitFor(()=>expect(inspect).toHaveBeenCalled());
    expect((await f.app.inject({method:'POST',url:'/volume-backups/capture',headers:f.headers,payload})).statusCode).toBe(409);
    expect(await f.gate.drain(100)).toEqual({status:'uncertain'});
  });
  it('uses the previous registry reference during real runtime rollback after rotation and removal',async()=>{
    const f=storeFixture(),image='registry.example.test/team/app:latest';
    const initial=f.store.updateService(f.service.id,{expectedRevision:1,image,registry:{server:'registry.example.test',username:'reader',password:'original-fixture-password'}},f.actor.id);
    const old={Name:`panel-app-${initial.id}`,Labels:{'panel.owner':'self-hosted-panel','panel.service':initial.id,...registryLabels(initial)},Mode:{Replicated:{Replicas:1}},TaskTemplate:{ContainerSpec:{Image:`registry.example.test/team/app@sha256:${'a'.repeat(64)}`}}};
    const rotated=f.store.updateService(initial.id,{expectedRevision:2,registry:{server:'registry.example.test',username:'reader',password:'rotated-fixture-password'}},f.actor.id);
    const current={...old,Labels:{...old.Labels,...registryLabels(rotated)}};const configured=f.store.updateService(initial.id,{expectedRevision:3,registry:null},f.actor.id);
    const db=new Database(join(f.path,'agent.sqlite'));db.close();const runtime=new DockerRuntime('/never-connect',18080,'unused',f.path),update=vi.fn(async()=>{});
    vi.spyOn(runtime,'ensureInfrastructure').mockResolvedValue();vi.spyOn(runtime.docker,'getService').mockReturnValue({inspect:async()=>({Spec:current,Version:{Index:7}}),update} as never);vi.spyOn(runtime as any,'waitReady').mockResolvedValue();vi.spyOn(runtime as any,'verifyService').mockResolvedValue();
    await expect(runtime.apply(configured,'restart',randomUUID(),{previousRecorded:true,previousSpec:old,targetSpec:current,stage:'rolling_back',previousError:'fixture failure',recordPrevious(){},recordTarget(){},beginRollback(){}})).rejects.toThrow('recovered the previous runtime configuration');
    expect(update).toHaveBeenCalledWith({username:'reader',password:'original-fixture-password',serveraddress:'registry.example.test'},{...old,version:7});
    expect(JSON.stringify(old)).not.toContain('fixture-password');
  });
  it('cannot repurpose a deploy key as environment or registry material even within the same service',()=>{
    const f=storeFixture(),key=ssh2.utils.generateKeyPairSync('ed25519').public.split(' ').slice(0,2).join(' '),configured=f.store.updateService(f.service.id,{expectedRevision:1,source:{type:'git',repository:'ssh://git@github.com/owner/repo.git',branch:'main',context:'.',dockerfile:'Dockerfile',ssh:{knownHosts:`github.com ${key}`}}},f.actor.id);
    if(configured.source?.type!=='git')throw Error('Missing source');const reference=configured.source.ssh!.secretRef!;
    expect(()=>f.store.vault.getServiceSecret(reference,configured.id,'registry')).toThrow('purpose');
    expect(()=>f.store.updateService(configured.id,{expectedRevision:2,environment:[{name:'KEY',secret:true,secretRef:reference}]},f.actor.id)).toThrow('purpose');
    expect(()=>f.store.updateService(configured.id,{expectedRevision:2,source:{type:'image'},image:'registry.example.test/team/app:latest',registry:{server:'registry.example.test',username:'reader',secretRef:reference}},f.actor.id)).toThrow('purpose');
  });
  it('fences backup completion when its lease has expired',async()=>{
    const f=managerFixture(),capture=deferred<unknown>();f.handler.mockReturnValueOnce(capture.promise as never);const backup=f.manager.create(f.service,f.actor,{mountTarget:'/data'},'lease-fixture');
    await vi.waitFor(()=>expect(f.handler).toHaveBeenCalled());f.advance();capture.resolve({phase:'completed',size:10,sha256:'a'.repeat(64)});await f.manager.drain();
    expect((f.store.db.prepare('SELECT status FROM volume_backups WHERE id=?').get(backup.id) as any).status).not.toBe('succeeded');
  });
  it('refuses restore preparation while archive deletion is in flight',async()=>{
    const f=managerFixture(),backup=f.manager.create(f.service,f.actor,{mountTarget:'/data'},'delete-fixture');await f.manager.drain();
    const deletion=deferred<void>(),discard=vi.spyOn(f.manager as any,'discard').mockReturnValue(deletion.promise),pending=f.manager.remove(f.service,f.actor,backup.id);await vi.waitFor(()=>expect(discard).toHaveBeenCalled());
    let error:unknown;try{f.manager.prepareRestore(f.service,f.actor,backup.id,'restore-during-delete');}catch(value){error=value;}
    deletion.resolve();await pending;await f.manager.drain();expect(error).toBeInstanceOf(AppError);
  });
});
