import { randomUUID } from 'node:crypto';
import { DatabaseBackups } from '../../src/server/backups.js';
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { createApp } from '../../src/server/app.js';
import { Store } from '../../src/server/store.js';
import { normalizeServiceInput } from '../../src/server/configuration.js';
import * as s3Storage from '../../src/agent/s3-storage.js';

const cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const fn of cleanup.splice(0).reverse())await fn();vi.restoreAllMocks();});
async function fixture() {
  const dataDir=mkdtempSync(join(tmpdir(),'servus-backup-api-')),store=new Store(dataDir),admin=store.setup('admin@example.test','fixture-hash'),project=store.createProject('fixture');
  const {service}=store.createService(project.id,normalizeServiceInput({name:'database',kind:'postgres'}),admin.id);
  const job=store.claimNextJob('fixture',60_000)!;store.completeAction(job.actionId,'fixture',{state:'running',deployedRevision:1});
  const databaseExport=vi.fn(async()=>Object.assign(Readable.from(['backup-data']),{headers:{'content-length':'11','x-export-extension':'dump'}}) as IncomingMessage);
  const app=await createApp({dataDir,store,databaseExport});
  cleanup.push(async()=>{await app.close();store.close();rmSync(dataDir,{recursive:true,force:true});});
  const session=store.createSession(admin.id),headers={cookie:`panel_session=${session.token}`,'x-csrf-token':session.csrfToken,'idempotency-key':'backup-test'};
  return {app,store,headers,service,project,databaseExport};
}

it('requires session, CSRF, allowed origin and project write access before creating a backup',async()=>{
  const {app,store,headers,service,project,databaseExport}=await fixture(),url=`/api/v1/services/${service.id}/backups`;
  expect((await app.inject({method:'POST',url,payload:{}})).statusCode).toBe(401);
  expect((await app.inject({method:'POST',url,headers:{cookie:headers.cookie},payload:{}})).statusCode).toBe(403);
  expect((await app.inject({method:'POST',url,headers:{...headers,origin:'https://untrusted.example'},payload:{}})).statusCode).toBe(403);
  const viewer=store.createUser('viewer@example.test','fixture-hash');store.addMember(project.id,viewer.id,'viewer');const session=store.createSession(viewer.id);
  expect((await app.inject({method:'POST',url,headers:{cookie:`panel_session=${session.token}`,'x-csrf-token':session.csrfToken,'idempotency-key':'viewer-backup'},payload:{}})).statusCode).toBe(404);
  expect(databaseExport).not.toHaveBeenCalled();
});

it('isolates history, download and removal across projects and denies viewer downloads',async()=>{
  const {app,store,headers,service,project}=await fixture(),base=`/api/v1/services/${service.id}/backups`;
  const created=await app.inject({method:'POST',url:base,headers,payload:{name:'verified'}});expect(created.statusCode).toBe(202);
  const id=created.json().backup.id;
  await vi.waitFor(async()=>{const history=await app.inject({url:base,headers});expect(history.json().backups[0].status).toBe('succeeded');});
  const downloaded=await app.inject({url:`${base}/${id}/download`,headers});expect(downloaded.statusCode).toBe(200);expect(downloaded.rawPayload.toString()).toBe('backup-data');expect(downloaded.headers['x-backup-sha256']).toMatch(/^[a-f0-9]{64}$/);
  const stranger=store.createUser('stranger@example.test','fixture-hash'),strangerSession=store.createSession(stranger.id),foreign={cookie:`panel_session=${strangerSession.token}`,'x-csrf-token':strangerSession.csrfToken};
  for(const url of [base,`${base}/${id}/download`])expect((await app.inject({url,headers:foreign})).statusCode).toBe(404);
  expect((await app.inject({method:'DELETE',url:`${base}/${id}`,headers:foreign})).statusCode).toBe(404);
  store.addMember(project.id,stranger.id,'viewer');expect((await app.inject({url:base,headers:foreign})).statusCode).toBe(200);expect((await app.inject({url:`${base}/${id}/download`,headers:foreign})).statusCode).toBe(404);
  expect((await app.inject({method:'DELETE',url:`${base}/${id}`,headers})).statusCode).toBe(200);
  expect((await app.inject({url:`${base}/${id}/download`,headers})).statusCode).toBe(404);
});

it('validates schedules and reuses manual idempotency results through the HTTP API',async()=>{
  const {app,headers,service}=await fixture(),base=`/api/v1/services/${service.id}`;
  expect((await app.inject({method:'PUT',url:`${base}/backup-settings`,headers,payload:{enabled:true,cron:'* * * * * *',retention:7}})).statusCode).toBe(400);
  const saved=await app.inject({method:'PUT',url:`${base}/backup-settings`,headers,payload:{enabled:true,cron:'0 2 * * *',retention:3}});
  expect(saved.statusCode).toBe(200);expect(saved.json().settings).toMatchObject({enabled:true,description:'Every day at 02:00 UTC',timeZone:'UTC',retention:3});
  const first=await app.inject({method:'POST',url:`${base}/backups`,headers,payload:{name:'same'}});
  const repeated=await app.inject({method:'POST',url:`${base}/backups`,headers,payload:{name:'same'}});
  expect(first.statusCode).toBe(202);expect(repeated.json().backup.id).toBe(first.json().backup.id);
  expect((await app.inject({method:'POST',url:`${base}/backups`,headers,payload:{name:'changed'}})).statusCode).toBe(409);
});

it('rechecks project write access after asynchronous destination validation',async()=>{
  const {app,store,service,project}=await fixture(),member=store.createUser('editor@example.test','fixture-hash');store.addMember(project.id,member.id,'editor');
  const session=store.createSession(member.id),headers={cookie:`panel_session=${session.token}`,'x-csrf-token':session.csrfToken};
  let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const validation=vi.spyOn(s3Storage,'validateBackupEndpoint').mockImplementationOnce(async()=>{await gate;return {endpoint:new URL('https://s3.example.test'),addresses:[{address:'8.8.8.8',family:4}]};});
  const pending=app.inject({method:'PUT',url:`/api/v1/services/${service.id}/backup-destination`,headers,payload:{type:'s3',provider:'s3',endpoint:'https://s3.example.test',region:'us-east-1',bucket:'backup-bucket',prefix:'backups',storageClass:'STANDARD',accessKeyId:'fixture-key',secretAccessKey:'fixture-secret'}}).then(response=>response);
  await vi.waitFor(()=>expect(validation).toHaveBeenCalled());
  store.addMember(project.id,member.id,'viewer');release();
  expect((await pending).statusCode).toBe(404);
  expect((store.db.prepare("SELECT COUNT(*) AS n FROM service_secret_refs WHERE purpose='backup-storage'").get() as {n:number}).n).toBe(0);
});

it('stores immutable encrypted destination credentials without returning them or allowing foreign references',async()=>{
  const {app,store,headers,service}=await fixture();
  vi.spyOn(s3Storage,'validateBackupEndpoint').mockResolvedValue({endpoint:new URL('https://s3.example.test'),addresses:[{address:'8.8.8.8',family:4}]});
  const endpoint=`/api/v1/services/${service.id}/backup-destination`,payload={type:'s3',provider:'s3',endpoint:'https://s3.example.test',region:'us-east-1',bucket:'backup-bucket',prefix:'backups',storageClass:'STANDARD',accessKeyId:'SYNTHETIC-ACCESS-KEY',secretAccessKey:'SYNTHETIC-SECRET-KEY'};
  const saved=await app.inject({method:'PUT',url:endpoint,headers,payload});expect(saved.statusCode).toBe(200);expect(saved.payload).not.toContain(payload.accessKeyId);expect(saved.payload).not.toContain(payload.secretAccessKey);expect(saved.json().destination.credentialsConfigured).toBe(true);
  const original=(store.db.prepare('SELECT destination_ref FROM database_backup_settings WHERE service_id=?').get(service.id) as {destination_ref:string}).destination_ref;
  const changed=await app.inject({method:'PUT',url:endpoint,headers,payload:{...payload,prefix:'rotated'}});expect(changed.statusCode).toBe(200);
  const rotated=(store.db.prepare('SELECT destination_ref FROM database_backup_settings WHERE service_id=?').get(service.id) as {destination_ref:string}).destination_ref;expect(rotated).not.toBe(original);
  expect(store.vault.getServiceSecret(original,service.id,'backup-storage')).toContain('"prefix":"backups"');
  expect(()=>store.vault.getServiceSecret(original,'foreign-service','backup-storage')).toThrow();
  expect((await app.inject({method:'PUT',url:endpoint,headers,payload:{type:'s3',secretRef:original}})).statusCode).toBe(400);
  expect((await app.inject({method:'PUT',url:endpoint,headers,payload:{type:'local'}})).statusCode).toBe(200);
  expect((await app.inject({url:endpoint,headers})).json().destination).toEqual({type:'local'});
});


it('restricts global profile writes to administrators and returns no credentials',async()=>{
  const {app,store,headers}=await fixture(),url='/api/v1/backup-storage';
  const input={name:'Offsite',destination:{type:'s3',provider:'s3',endpoint:'https://s3.example.test',region:'us-east-1',bucket:'backup-bucket',prefix:'backups',storageClass:'STANDARD',accessKeyId:'SYNTHETIC-GLOBAL-ACCESS',secretAccessKey:'SYNTHETIC-GLOBAL-SECRET'}};
  vi.spyOn(s3Storage,'validateBackupEndpoint').mockResolvedValue({endpoint:new URL('https://s3.example.test'),addresses:[{address:'8.8.8.8',family:4}]});
  expect((await app.inject({url})).statusCode).toBe(401);
  expect((await app.inject({method:'POST',url,headers:{cookie:headers.cookie},payload:input})).statusCode).toBe(403);
  const user=store.createUser('member@example.test','fixture-hash'),session=store.createSession(user.id),member={cookie:`panel_session=${session.token}`,'x-csrf-token':session.csrfToken};
  expect((await app.inject({method:'POST',url,headers:member,payload:input})).statusCode).toBe(403);
  const saved=await app.inject({method:'POST',url,headers,payload:input});expect(saved.statusCode).toBe(201);
  for(const response of [saved,await app.inject({url,headers:member})]){
    expect(response.statusCode).toBeLessThan(300);expect(response.payload).not.toContain(input.destination.accessKeyId);expect(response.payload).not.toContain(input.destination.secretAccessKey);
  }
  const profile=saved.json().profile;
  expect((await app.inject({method:'PUT',url:`${url}/${profile.id}`,headers:member,payload:input})).statusCode).toBe(403);
  expect((await app.inject({method:'DELETE',url:`${url}/${profile.id}`,headers:member})).statusCode).toBe(403);
  const profileRef=(store.db.prepare('SELECT destination_ref FROM backup_storage_profiles WHERE id=?').get(profile.id) as {destination_ref:string}).destination_ref;
  expect(()=>store.vault.getDatabaseRootSecret(profileRef)).toThrow('Database root secret is invalid');
  expect(store.vault.redact(`${input.destination.accessKeyId} ${input.destination.secretAccessKey}`)).toBe('[REDACTED] [REDACTED]');
});

it('keeps immutable database storage snapshots when profiles rotate or are removed',async()=>{
  const {app,store,headers,service}=await fixture(),url='/api/v1/backup-storage',destination={type:'s3',provider:'r2',endpoint:'https://s3.example.test',region:'auto',bucket:'backup-bucket',prefix:'original',storageClass:'STANDARD',accessKeyId:'fixture-global-key',secretAccessKey:'fixture-global-secret'};
  vi.spyOn(s3Storage,'validateBackupEndpoint').mockResolvedValue({endpoint:new URL('https://s3.example.test'),addresses:[{address:'8.8.8.8',family:4}]});
  const saved=await app.inject({method:'POST',url,headers,payload:{name:'R2 production',destination}});expect(saved.statusCode).toBe(201);const id=saved.json().profile.id,selection=`/api/v1/services/${service.id}/backup-destination`;
  expect((await app.inject({method:'PUT',url:selection,headers,payload:{profileId:randomUUID()}})).statusCode).toBe(400);
  expect((await app.inject({method:'PUT',url:selection,headers,payload:{profileId:id}})).statusCode).toBe(200);
  const reference=(store.db.prepare('SELECT destination_ref FROM database_backup_settings WHERE service_id=?').get(service.id) as {destination_ref:string}).destination_ref;
  const {accessKeyId:_access,secretAccessKey:_secret,...withoutKeys}=destination;
  expect((await app.inject({method:'PUT',url:`${url}/${id}`,headers,payload:{name:'R2 rotated',destination:{...withoutKeys,prefix:'new'}}})).statusCode).toBe(200);
  expect(store.vault.getServiceSecret(reference,service.id,'backup-storage')).toContain('"prefix":"original"');
  expect((await app.inject({method:'DELETE',url:`${url}/${id}`,headers})).statusCode).toBe(200);
  expect((await app.inject({url,headers})).json().profiles).toEqual([]);
  expect((await app.inject({url:selection,headers})).json()).toMatchObject({profileId:id,profileName:'R2 rotated',legacy:false,destination:{prefix:'original'}});
  expect(store.vault.getServiceSecret(reference,service.id,'backup-storage')).toContain(destination.secretAccessKey);
  expect((await app.inject({method:'PUT',url:selection,headers,payload:{profileId:null}})).json().destination).toEqual({type:'local'});
});

it('decrypts encrypted downloads into restore-compatible exports with the plaintext checksum',async()=>{
  const {app,headers,service}=await fixture(),base=`/api/v1/services/${service.id}`;
  const settings=await app.inject({method:'PUT',url:`${base}/backup-settings`,headers,payload:{enabled:false,cron:'0 2 * * *',retention:7,encrypted:true,retentionPolicy:{mode:'age',days:30}}});
  expect(settings.statusCode).toBe(200);expect(settings.json().settings).toMatchObject({encrypted:true,retentionPolicy:{mode:'age',days:30}});
  const created=await app.inject({method:'POST',url:`${base}/backups`,headers,payload:{}});expect(created.statusCode).toBe(202);const id=created.json().backup.id;
  await vi.waitFor(async()=>expect((await app.inject({url:`${base}/backups`,headers})).json().backups[0]).toMatchObject({status:'succeeded',encrypted:true}));
  const downloaded=await app.inject({url:`${base}/backups/${id}/download`,headers});
  expect(downloaded.statusCode).toBe(200);expect(downloaded.rawPayload.toString()).toBe('backup-data');expect(downloaded.headers['content-length']).toBe('11');expect(downloaded.headers['content-disposition']).toContain('.dump');
});

it('rechecks database write access after slow backup decryption before sending bytes',async()=>{
  const {app,store,service,project}=await fixture(),member=store.createUser('download-editor@example.test','fixture-hash');store.addMember(project.id,member.id,'editor');const session=store.createSession(member.id),headers={cookie:`panel_session=${session.token}`};
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),stream=Readable.from(['PRIVATE-DATABASE']),id=randomUUID();
  const read=vi.spyOn(DatabaseBackups.prototype,'read').mockImplementationOnce(async()=>{await gate;return {backup:{id,serviceId:service.id,name:'fixture',status:'succeeded',trigger:'manual',createdAt:new Date().toISOString(),finishedAt:new Date().toISOString(),size:16,sha256:'a'.repeat(64),extension:'dump',error:null,destination:'local',encrypted:true},stream};});
  const pending=app.inject({url:`/api/v1/services/${service.id}/backups/${id}/download`,headers}).then(response=>response);await vi.waitFor(()=>expect(read).toHaveBeenCalled());store.addMember(project.id,member.id,'viewer');release();const response=await pending;
  expect(response.statusCode).toBe(404);expect(response.payload).not.toContain('PRIVATE-DATABASE');expect(stream.destroyed).toBe(true);
});


it('requires new credentials before moving a global profile to another endpoint or provider',async()=>{
  const {app,headers}=await fixture(),url='/api/v1/backup-storage',destination={type:'s3',provider:'s3',endpoint:'https://s3.example.test',region:'us-east-1',bucket:'backup-bucket',prefix:'backups',storageClass:'STANDARD',accessKeyId:'fixture-profile-key',secretAccessKey:'fixture-profile-secret'};
  const validate=vi.spyOn(s3Storage,'validateBackupEndpoint').mockResolvedValue({endpoint:new URL('https://s3.example.test'),addresses:[{address:'8.8.8.8',family:4}]});
  const created=await app.inject({method:'POST',url,headers,payload:{name:'Profile',destination}});expect(created.statusCode).toBe(201);const id=created.json().profile.id;
  const {accessKeyId:_key,secretAccessKey:_secret,...safe}=destination;
  for(const updated of [{...safe,endpoint:'https://another.example.test'},{...safe,provider:'r2'}]){
    const denied=await app.inject({method:'PUT',url:`${url}/${id}`,headers,payload:{name:'Changed',destination:updated}});expect(denied.statusCode).toBe(400);expect(denied.json().error.code).toBe('BACKUP_CREDENTIALS_REQUIRED');
  }
  expect(validate).toHaveBeenCalledTimes(1);
  expect((await app.inject({method:'PUT',url:`${url}/${id}`,headers,payload:{name:'Changed',destination:{...destination,endpoint:'https://another.example.test',accessKeyId:'new-fixture-key',secretAccessKey:'new-fixture-secret'}}})).statusCode).toBe(200);
});
