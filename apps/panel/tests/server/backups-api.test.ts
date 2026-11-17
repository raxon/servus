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
