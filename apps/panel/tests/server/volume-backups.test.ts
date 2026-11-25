import { afterEach, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createApp } from '../../src/server/app.js';
import { Store } from '../../src/server/store.js';
import { normalizeServiceInput } from '../../src/server/configuration.js';
import { VolumeBackups } from '../../src/server/volume-backups.js';
import { LocalDatabaseBackupStorage } from '../../src/agent/backups.js';
import type { agentRequest } from '../../src/agent/client.js';
import type { VolumeRestore } from '../../src/shared/volume-backups.js';
import * as s3Storage from '../../src/agent/s3-storage.js';

const cleanups:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const close of cleanups.splice(0).reverse())await close();vi.restoreAllMocks();});
async function fixture() {
  const dataDir=mkdtempSync(join(tmpdir(),'volume-backup-api-')),store=new Store(dataDir),actor=store.setup('admin@example.test','fixture-hash'),project=store.createProject('volumes');
  const {service:created}=store.createService(project.id,normalizeServiceInput({name:'application',image:'nginx:alpine',domains:[],mounts:[{name:'files',type:'volume',target:'/data'}]}),actor.id);
  const job=store.claimNextJob('fixture',60_000)!;store.completeAction(job.actionId,'fixture',{state:'running',deployedRevision:1});const service=store.getService(created.id)!;
  const storage=new LocalDatabaseBackupStorage(dataDir,'volume-backups'),operations=new Map<string,VolumeRestore>();
  const handler=vi.fn(async(path:string,input:{serviceId:string;operationId:string;backupId?:string})=>{
    if(path==='/volume-backups/capture')return {phase:'completed',...await storage.capture(input.operationId,'tar',Readable.from(['archive-fixture']),15)};
    if(path==='/volume-backups/recover')return {phase:'failed'};
    if(path==='/volume-restores/prepare'){const now=new Date().toISOString(),result:VolumeRestore={id:input.operationId,backupId:input.backupId!,serviceId:input.serviceId,mountTarget:'/data',phase:'prepared',candidateVolume:`panel-volume-restore-${input.operationId}`,previousVolume:`panel-data-${input.serviceId}-files`,error:null,createdAt:now,updatedAt:now};operations.set(input.operationId,result);return result;}
    const previous=operations.get(input.operationId)!;const result={...previous,phase:path.endsWith('/cancel')?'cancelled':path.endsWith('/rollback')?'rolled_back':'completed',updatedAt:new Date().toISOString()};operations.set(input.operationId,result as VolumeRestore);return result;
  });
  // The production agent returns only confirmed size/hash/phase, not storage extension.
  const request=async(path:string,input?:unknown)=>{const result=await handler(path,input as Parameters<typeof handler>[1]);if(path==='/volume-backups/capture'){const {extension:_extension,...rest}=result as {extension?:string};return rest;}return result;};
  const app=await createApp({dataDir,store,agentRequest:request as typeof agentRequest});
  cleanups.push(async()=>{await app.close();store.close();rmSync(dataDir,{recursive:true,force:true});});
  const session=store.createSession(actor.id),headers={cookie:`panel_session=${session.token}`,'x-csrf-token':session.csrfToken,'idempotency-key':'backup-fixture'},base=`/api/v1/services/${service.id}`;
  const backup=async()=>{const response=await app.inject({method:'POST',url:`${base}/volume-backups`,headers,payload:{mountTarget:'/data',name:'Before update'}});expect(response.statusCode).toBe(202);const id=response.json().backup.id;await vi.waitFor(async()=>expect((await app.inject({url:`${base}/volume-backups`,headers})).json().backups.find((backup:{id:string})=>backup.id===id).status).toBe('succeeded'));return id;};
  return {dataDir,store,actor,project,service,app,headers,base,handler,operations,backup,request};
}

it('requires session, CSRF, allowed origin and project write access',async()=>{
  const {app,store,project,headers,base,handler}=await fixture(),url=`${base}/volume-backups`;
  expect((await app.inject({method:'POST',url,payload:{mountTarget:'/data'}})).statusCode).toBe(401);
  expect((await app.inject({method:'POST',url,headers:{cookie:headers.cookie},payload:{mountTarget:'/data'}})).statusCode).toBe(403);
  expect((await app.inject({method:'POST',url,headers:{...headers,origin:'https://untrusted.example'},payload:{mountTarget:'/data'}})).statusCode).toBe(403);
  const viewer=store.createUser('viewer@example.test','fixture-hash');store.addMember(project.id,viewer.id,'viewer');const session=store.createSession(viewer.id);
  expect((await app.inject({method:'POST',url,headers:{cookie:`panel_session=${session.token}`,'x-csrf-token':session.csrfToken,'idempotency-key':'viewer'},payload:{mountTarget:'/data'}})).statusCode).toBe(404);expect(handler).not.toHaveBeenCalled();
});

it('lists named mounts and validates schedules without permitting bind or missing targets',async()=>{
  const {app,base,headers}=await fixture();expect((await app.inject({url:`${base}/volume-backup-settings`,headers})).json().settings).toMatchObject([{mountTarget:'/data',enabled:false,timeZone:'UTC'}]);
  expect((await app.inject({method:'PUT',url:`${base}/volume-backup-settings`,headers,payload:{mountTarget:'/data',enabled:true,cron:'* * * * * *',retention:7}})).statusCode).toBe(400);
  expect((await app.inject({method:'POST',url:`${base}/volume-backups`,headers,payload:{mountTarget:'/unmanaged'}})).statusCode).toBe(400);
});

it('persists named backups, replays idempotency and serves only authorized verified bytes',async()=>{
  const {app,base,headers,backup,store,project}=await fixture(),id=await backup();
  const repeated=await app.inject({method:'POST',url:`${base}/volume-backups`,headers,payload:{mountTarget:'/data',name:'Before update'}});expect(repeated.json().backup.id).toBe(id);
  expect((await app.inject({method:'POST',url:`${base}/volume-backups`,headers,payload:{mountTarget:'/data',name:'Changed'}})).statusCode).toBe(409);
  const downloaded=await app.inject({url:`${base}/volume-backups/${id}/download`,headers});expect(downloaded.statusCode).toBe(200);expect(downloaded.rawPayload.toString()).toBe('archive-fixture');expect(downloaded.headers['x-backup-sha256']).toBe(createHash('sha256').update('archive-fixture').digest('hex'));
  const user=store.createUser('viewer@example.test','fixture-hash');const session=store.createSession(user.id),foreign={cookie:`panel_session=${session.token}`,'x-csrf-token':session.csrfToken};
  for(const path of ['/volume-backups','/volume-restores',`/volume-backups/${id}/download`])expect((await app.inject({url:`${base}${path}`,headers:foreign})).statusCode).toBe(404);
  store.addMember(project.id,user.id,'viewer');
  expect((await app.inject({url:`${base}/volume-backups`,headers:foreign})).statusCode).toBe(200);expect((await app.inject({url:`${base}/volume-backups/${id}/download`,headers:foreign})).statusCode).toBe(404);
  expect((await app.inject({method:'POST',url:`${base}/volume-backups/${id}/restore`,headers:{...foreign,'idempotency-key':'foreign'},payload:{}})).statusCode).toBe(404);
});

it('stages restores and requires explicit confirmation before a switch',async()=>{
  const {app,base,headers,backup}=await fixture(),backupId=await backup();
  const prepared=await app.inject({method:'POST',url:`${base}/volume-backups/${backupId}/restore`,headers:{...headers,'idempotency-key':'restore'},payload:{}});expect(prepared.statusCode).toBe(202);const id=prepared.json().restore.id;
  await vi.waitFor(async()=>expect((await app.inject({url:`${base}/volume-restores`,headers})).json().restores[0].phase).toBe('prepared'));
  const repeated=await app.inject({method:'POST',url:`${base}/volume-backups/${backupId}/restore`,headers:{...headers,'idempotency-key':'restore'},payload:{}});expect(repeated.json().restore.id).toBe(id);
  expect((await app.inject({method:'POST',url:`${base}/volume-restores/${id}/commit`,headers,payload:{}})).statusCode).toBe(400);
  expect((await app.inject({method:'POST',url:`${base}/volume-restores/${id}/commit`,headers,payload:{confirm:true}})).statusCode).toBe(202);
  await vi.waitFor(async()=>expect((await app.inject({url:`${base}/volume-restores`,headers})).json().restores[0].phase).toBe('completed'));
  expect((await app.inject({method:'POST',url:`${base}/volume-restores/${id}/rollback`,headers,payload:{confirm:true}})).statusCode).toBe(202);
});

it('destroys an opened download when write access is revoked during asynchronous storage lookup',async()=>{
  const {app,store,project,base}=await fixture(),member=store.createUser('member@example.test','fixture-hash');store.addMember(project.id,member.id,'editor');const session=store.createSession(member.id),headers={cookie:`panel_session=${session.token}`};
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),stream=Readable.from(['SECRET-ARCHIVE']),id=randomUUID();
  const read=vi.spyOn(VolumeBackups.prototype,'read').mockImplementationOnce(async()=>{await gate;return {backup:{id,serviceId:base.split('/')[4]!,mountTarget:'/data',name:'fixture',status:'succeeded',trigger:'manual',createdAt:new Date().toISOString(),finishedAt:new Date().toISOString(),size:14,sha256:'a'.repeat(64),error:null,destination:'s3'},stream};});
  const pending=app.inject({url:`${base}/volume-backups/${id}/download`,headers}).then(response=>response);await vi.waitFor(()=>expect(read).toHaveBeenCalled());store.addMember(project.id,member.id,'viewer');release();const response=await pending;
  expect(response.statusCode).toBe(404);expect(response.payload).not.toContain('SECRET-ARCHIVE');expect(stream.destroyed).toBe(true);
});

it('serializes cancellation against a concurrent commit and never records cancellation after a switch',async()=>{
  const {app,base,headers,backup,handler,operations}=await fixture(),backupId=await backup();
  const prepared=await app.inject({method:'POST',url:`${base}/volume-backups/${backupId}/restore`,headers:{...headers,'idempotency-key':'restore'},payload:{}}),id=prepared.json().restore.id;
  await vi.waitFor(async()=>expect((await app.inject({url:`${base}/volume-restores`,headers})).json().restores[0].phase).toBe('prepared'));
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
  handler.mockImplementationOnce(async(path,input)=>{expect(path).toBe('/volume-restores/cancel');await gate;return {...operations.get(input.operationId)!,phase:'cancelled'};});
  const pending=app.inject({method:'POST',url:`${base}/volume-restores/${id}/cancel`,headers,payload:{}}).then(response=>response);
  await vi.waitFor(()=>expect(handler.mock.calls.at(-1)?.[0]).toBe('/volume-restores/cancel'));
  expect((await app.inject({method:'POST',url:`${base}/volume-restores/${id}/commit`,headers,payload:{confirm:true}})).statusCode).toBe(409);
  release();expect((await pending).statusCode).toBe(200);expect((await app.inject({url:`${base}/volume-restores`,headers})).json().restores[0].phase).toBe('cancelled');
});

it('runs a numeric UTC schedule once per minute and retains only completed archives for that mount',async()=>{
  const {app,store,actor,service,request}=await fixture();await app.close();let now=new Date('2026-11-17T03:00:00.000Z');
  const manager=new VolumeBackups({store,serviceAccess:()=>{throw new Error('Not an HTTP request.');},agentRequest:request as typeof agentRequest,now:()=>now,startScheduler:false});cleanups.push(()=>manager.close());
  manager.saveSettings(service,actor,{mountTarget:'/data',enabled:true,cron:'* * * * *',retention:1});manager.tick();expect(manager.list(service.id)).toHaveLength(0);
  now=new Date('2026-11-17T03:01:00.000Z');manager.tick();await vi.waitFor(()=>expect(manager.list(service.id)[0]?.status).toBe('succeeded'));manager.tick();expect(manager.list(service.id)).toHaveLength(1);
  const first=manager.list(service.id)[0]!;now=new Date('2026-11-17T03:02:00.000Z');manager.tick();await vi.waitFor(()=>expect(manager.list(service.id)).toMatchObject([{status:'succeeded',trigger:'scheduled'},{id:first.id,status:'deleted'}]));
  await expect(manager.read(service.id,first.id)).rejects.toMatchObject({code:'VOLUME_BACKUP_NOT_FOUND'});
});

it('disables schedules whose configuring member loses project access',async()=>{
  const {app,store,project,service,request}=await fixture();await app.close();const actor=store.createUser('editor@example.test','fixture-hash');store.addMember(project.id,actor.id,'editor');let now=new Date('2026-11-17T03:00:00.000Z');
  const manager=new VolumeBackups({store,serviceAccess:()=>{throw new Error('Not an HTTP request.');},agentRequest:request as typeof agentRequest,now:()=>now,startScheduler:false});cleanups.push(()=>manager.close());
  manager.saveSettings(service,actor,{mountTarget:'/data',enabled:true,cron:'* * * * *',retention:1});store.addMember(project.id,actor.id,'viewer');now=new Date('2026-11-17T03:01:00.000Z');manager.tick();expect(manager.list(service.id)).toHaveLength(0);expect(manager.settings(service)[0]?.enabled).toBe(false);
});

it('keeps an interrupted deletion fenced across manager restart and permits only a deletion retry',async()=>{
  const {app,store,actor,service,backup,request}=await fixture(),id=await backup();await app.close();
  const options={store,serviceAccess:()=>{throw new Error('Not an HTTP request.');},agentRequest:request as typeof agentRequest,startScheduler:false},first=new VolumeBackups(options);
  const discard=vi.spyOn(first as unknown as {discard:(row:unknown)=>Promise<void>},'discard').mockRejectedValueOnce(new Error('Uncertain remote deletion.'));
  await expect(first.remove(service,actor,id)).rejects.toThrow('Uncertain');discard.mockRestore();await first.close();
  const restarted=new VolumeBackups(options);cleanups.push(()=>restarted.close());expect(()=>restarted.prepareRestore(service,actor,id,'after-restart')).toThrow('being deleted');
  expect(restarted.list(service.id)[0]?.deletionPending).toBe(true);await expect(restarted.read(service.id,id)).rejects.toMatchObject({code:'VOLUME_BACKUP_BUSY'});
  await restarted.remove(service,actor,id);expect(restarted.list(service.id)[0]?.status).toBe('deleted');
});

it('reconciles a failed capture without claiming an archive succeeded from an agent phase alone',async()=>{
  const {app,store,actor,service,backup,request}=await fixture(),id=await backup();await app.close();
  store.db.prepare("UPDATE volume_backups SET status='failed',error='Application recovery is required.' WHERE id=?").run(id);
  const manager=new VolumeBackups({store,serviceAccess:()=>{throw new Error('Not an HTTP request.');},agentRequest:request as typeof agentRequest,startScheduler:false});cleanups.push(()=>manager.close());
  expect(await manager.recover(service,id)).toEqual({phase:'failed'});expect(manager.list(service.id)[0]).toMatchObject({status:'failed',error:'Backup was interrupted; application replicas recovered. Create a new backup.'});
});

it('rechecks access after asynchronous volume destination validation before sealing credentials',async()=>{
  const {app,store,project,service,base}=await fixture(),member=store.createUser('editor@example.test','fixture-hash');store.addMember(project.id,member.id,'editor');const session=store.createSession(member.id),headers={cookie:`panel_session=${session.token}`,'x-csrf-token':session.csrfToken};
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),validation=vi.spyOn(s3Storage,'validateBackupEndpoint').mockImplementationOnce(async()=>{await gate;return {endpoint:new URL('https://s3.example.test'),addresses:[{address:'8.8.8.8',family:4}]};});
  const pending=app.inject({method:'PUT',url:`${base}/volume-backup-destination`,headers,payload:{mountTarget:'/data',destination:{type:'s3',provider:'s3',endpoint:'https://s3.example.test',region:'us-east-1',bucket:'backup-fixture',prefix:'',accessKeyId:'fixture-access',secretAccessKey:'fixture-secret'}}}).then(response=>response);
  await vi.waitFor(()=>expect(validation).toHaveBeenCalled());store.addMember(project.id,member.id,'viewer');release();expect((await pending).statusCode).toBe(404);expect(store.db.prepare("SELECT 1 FROM service_secret_refs WHERE service_id=? AND purpose='backup-storage'").get(service.id)).toBeUndefined();
});


it('selects shared local profiles without changing existing volume archives or restore behavior',async()=>{
  const {app,base,headers,backup}=await fixture(),url='/api/v1/backup-storage';
  const archive=await backup();
  const created=await app.inject({method:'POST',url,headers,payload:{name:'Local recovery',destination:{type:'local'}}});expect(created.statusCode).toBe(201);const profileId=created.json().profile.id;
  const selected=await app.inject({method:'PUT',url:`${base}/volume-backup-destination`,headers,payload:{mountTarget:'/data',profileId}});expect(selected.statusCode).toBe(200);expect(selected.json()).toMatchObject({profileId,profileName:'Local recovery',legacy:false,destination:{type:'local'}});
  expect((await app.inject({method:'DELETE',url:`${url}/${profileId}`,headers})).statusCode).toBe(200);
  expect((await app.inject({url:`${base}/volume-backup-destination?mountTarget=%2Fdata`,headers})).json()).toMatchObject({profileId,profileName:'Local recovery'});
  expect((await app.inject({url:`${base}/volume-backups/${archive}/download`,headers})).rawPayload.toString()).toBe('archive-fixture');
  const prepared=await app.inject({method:'POST',url:`${base}/volume-backups/${archive}/restore`,headers:{...headers,'idempotency-key':'profile-restore'},payload:{}});expect(prepared.statusCode).toBe(202);
  await vi.waitFor(async()=>expect((await app.inject({url:`${base}/volume-restores`,headers})).json().restores[0].phase).toBe('prepared'));
});
