/** Actual PostgreSQL export -> scheduled backup -> HTTP download -> fresh restore. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Docker from 'dockerode';
import { createApp } from '../../apps/panel/src/server/app.js';
import { Store } from '../../apps/panel/src/server/store.js';
import { createAgent } from '../../apps/panel/src/agent/app.js';
import { normalizeServiceInput } from '../../apps/panel/src/server/configuration.js';
import { minioFixture } from './minio-fixture.js';
import { CreateBucketCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';

const context='colima-panel-dev',runId=randomBytes(12).toString('hex');
// macOS Unix-domain socket paths are limited to 104 bytes.
const dataDir=mkdtempSync(`/tmp/svb-${runId.slice(0,8)}-`);
const names=[`servus-db-backup-${runId}-source`,`servus-db-backup-${runId}-target`];
const cli=(args:string[],input?:Buffer|string)=>execFileSync('docker',['--context',context,...args],{encoding:'utf8',input,stdio:['pipe','pipe','pipe'],maxBuffer:16*1024*1024});
const store=new Store(dataDir);
let agent:Awaited<ReturnType<typeof createAgent>>|undefined;
let app:Awaited<ReturnType<typeof createApp>>|undefined;
let remote:Awaited<ReturnType<typeof minioFixture>>|undefined;
let remoteClient:S3Client|undefined;
const previousTestEndpoints=process.env.PANEL_BACKUP_TEST_ENDPOINTS;
async function until<T>(check:()=>Promise<T|undefined>,message:string) {
  const deadline=Date.now()+120_000;
  while(Date.now()<deadline){const result=await check();if(result!==undefined)return result;await new Promise(resolve=>setTimeout(resolve,250));}
  throw new Error(`Timed out: ${message}`);
}
try {
  const inspected=JSON.parse(cli(['context','inspect',context]))[0],socket=inspected.Endpoints.docker.Host.replace(/^unix:\/\//,'');
  assert.match(socket,/\/\.colima\/panel-dev\/docker\.sock$/);
  const password=randomBytes(24).toString('hex'),envFile=join(dataDir,'postgres.env'),passwordFile=join(dataDir,'password');
  writeFileSync(envFile,`POSTGRES_DB=app\nPOSTGRES_USER=app\nPOSTGRES_PASSWORD=${password}\n`,{mode:0o600});writeFileSync(passwordFile,password,{mode:0o600});
  for(const name of names) {
    cli(['run','-d','--network','none','--label',`servus.test=${runId}`,'--name',name,'--env-file',envFile,'postgres:17-alpine']);
    await until(async()=>{try{cli(['exec',name,'pg_isready','-q','-h','127.0.0.1','-U','app','-d','app']);return true;}catch{return undefined;}},'PostgreSQL readiness');
    cli(['cp',passwordFile,`${name}:/tmp/servus-fixture-password`]);cli(['exec','--user','0',name,'sh','-c','mkdir -p /run/secrets; cp /tmp/servus-fixture-password /run/secrets/panel-db-password; chmod 600 /run/secrets/panel-db-password']);
  }
  const sql='PGPASSWORD="$POSTGRES_PASSWORD" psql -h 127.0.0.1 -U app -d app -v ON_ERROR_STOP=1 -At';
  cli(['exec','-i',names[0]!,'sh','-c',sql],"CREATE TABLE backup_fixture (id integer PRIMARY KEY, value text NOT NULL); INSERT INTO backup_fixture VALUES (1,'Zażółć gęślą jaźń'),(2,'backup survives restart'); CREATE TABLE empty_fixture (id integer);\n");
  const actor=store.setup('backup-fixture@example.test','fixture-only-not-a-login-hash'),project=store.createProject(`backup-${runId}`);
  const {service}=store.createService(project.id,normalizeServiceInput({name:'database',kind:'postgres'}),actor.id);
  const job=store.claimNextJob('fixture',60_000)!;store.completeAction(job.actionId,'fixture',{state:'running',deployedRevision:1});
  const containerId=cli(['inspect','--format','{{.Id}}',names[0]!]).trim(),docker=new Docker({socketPath:socket}),socketPath=join(dataDir,'agent.sock'),token=randomBytes(32).toString('hex');
  agent=await createAgent({dataDir,token,socketPath,dockerSocket:socket,ingressPort:18080,ingressImage:'traefik:3.7.13'},
    {status:async()=>({online:true}),inspectService:async()=>({state:'running' as const}),apply:async()=>{throw new Error('Fixture does not perform deployments.');},consoleContainer:async id=>{assert.equal(id,service.id);return docker.getContainer(containerId);}});
  await agent.listen({path:socketPath});
  app=await createApp({dataDir,store,agentConnection:{socketPath,token}});
  const session=store.createSession(actor.id),headers={cookie:`panel_session=${session.token}`,'x-csrf-token':session.csrfToken,'idempotency-key':`manual-${runId}`};
  const base=`/api/v1/services/${service.id}`;
  const created=await app.inject({method:'POST',url:`${base}/backups`,headers,payload:{name:'Before fixture update'}});assert.equal(created.statusCode,202);
  const manualId=created.json().backup.id;
  await until(async()=>{const history=await app!.inject({url:`${base}/backups`,headers});const backup=history.json().backups.find((item:{id:string})=>item.id===manualId);if(backup.status==='failed')throw new Error(backup.error);return backup.status==='succeeded'?backup:undefined;},'manual database backup');
  const settings=await app.inject({method:'PUT',url:`${base}/backup-settings`,headers,payload:{enabled:true,cron:'* * * * *',retention:3}});assert.equal(settings.statusCode,200);
  // A persisted last-tick marker simulates a schedule from the preceding minute.
  store.db.prepare('UPDATE database_backup_settings SET last_tick=? WHERE service_id=?').run(new Date(Date.now()-60_000).toISOString().slice(0,16),service.id);
  const scheduled=await until(async()=>{const history=await app!.inject({url:`${base}/backups`,headers});const backup=history.json().backups.find((item:{trigger:string})=>item.trigger==='scheduled');if(backup?.status==='failed')throw new Error(backup.error);return backup?.status==='succeeded'?backup:undefined;},'scheduled database backup');
  await app.close();app=await createApp({dataDir,store,agentConnection:{socketPath,token}});
  const downloaded=await app.inject({url:`${base}/backups/${scheduled.id}/download`,headers});assert.equal(downloaded.statusCode,200);assert(downloaded.rawPayload.length>0);
  assert.equal(downloaded.headers['x-backup-sha256'],scheduled.sha256);
  cli(['exec','-i',names[1]!,'sh','-c','PGPASSWORD="$POSTGRES_PASSWORD" pg_restore -h 127.0.0.1 -U app -d app --exit-on-error --no-owner --no-privileges'],downloaded.rawPayload);
  assert.equal(cli(['exec','-i',names[1]!,'sh','-c',sql],"SELECT count(*) || '|' || (SELECT value FROM backup_fixture WHERE id=1) || '|' || (SELECT count(*) FROM empty_fixture) FROM backup_fixture;\n").trim(),'2|Zażółć gęślą jaźń|0');
  assert.equal(cli(['exec','-i',names[0]!,'sh','-c',sql],'SELECT count(*) FROM backup_fixture;\n').trim(),'2');
  if(process.env.SERVUS_BACKUP_S3==='1') {
    remote=await minioFixture();process.env.PANEL_BACKUP_TEST_ENDPOINTS=remote.endpoint;
    remoteClient=new S3Client({endpoint:remote.endpoint,region:'us-east-1',forcePathStyle:true,credentials:{accessKeyId:remote.accessKeyId,secretAccessKey:remote.secretAccessKey}});
    const bucket=`servus-backup-${runId}`;await remoteClient.send(new CreateBucketCommand({Bucket:bucket}));
    const destination={type:'s3',provider:'s3',endpoint:remote.endpoint,region:'us-east-1',bucket,prefix:'original',storageClass:'STANDARD',accessKeyId:remote.accessKeyId,secretAccessKey:remote.secretAccessKey};
    const save=await app.inject({method:'PUT',url:`${base}/backup-destination`,headers,payload:destination});assert.equal(save.statusCode,200);assert(!save.payload.includes(remote.secretAccessKey));assert(!save.payload.includes(remote.accessKeyId));
    const first=await app.inject({method:'POST',url:`${base}/backups`,headers:{...headers,'idempotency-key':`remote-${runId}`},payload:{name:'Remote original'}});assert.equal(first.statusCode,202);
    const firstId=first.json().backup.id;
    const remoteBackup=await until(async()=>{const history=await app!.inject({url:`${base}/backups`,headers});const backup=history.json().backups.find((item:{id:string})=>item.id===firstId);if(backup.status==='failed')throw new Error(backup.error);return backup.status==='succeeded'?backup:undefined;},'S3 backup upload');
    assert.equal(remoteBackup.destination,'s3');assert(!existsSync(join(dataDir,'database-backups',`${firstId}.dump`)));
    assert.equal((await remoteClient.send(new ListObjectsV2Command({Bucket:bucket,Prefix:`original/servus/${service.id}/`}))).KeyCount,1);
    const rotated=await app.inject({method:'PUT',url:`${base}/backup-destination`,headers,payload:{...destination,prefix:'rotated'}});assert.equal(rotated.statusCode,200);
    const old=await app.inject({url:`${base}/backups/${firstId}/download`,headers});assert.equal(old.statusCode,200);
    cli(['exec','-i',names[1]!,'sh','-c',sql],'DROP TABLE backup_fixture; DROP TABLE empty_fixture;\n');
    cli(['exec','-i',names[1]!,'sh','-c','PGPASSWORD="$POSTGRES_PASSWORD" pg_restore -h 127.0.0.1 -U app -d app --exit-on-error --no-owner --no-privileges'],old.rawPayload);
    assert.equal(cli(['exec','-i',names[1]!,'sh','-c',sql],"SELECT value FROM backup_fixture WHERE id=1;\n").trim(),'Zażółć gęślą jaźń');
    assert.equal((await app.inject({method:'PUT',url:`${base}/backup-settings`,headers,payload:{enabled:false,cron:'0 2 * * *',retention:1}})).statusCode,200);
    const next=await app.inject({method:'POST',url:`${base}/backups`,headers:{...headers,'idempotency-key':`remote-rotated-${runId}`},payload:{name:'Remote rotated'}});const nextId=next.json().backup.id;
    await until(async()=>{const history=await app!.inject({url:`${base}/backups`,headers});const backup=history.json().backups.find((item:{id:string})=>item.id===nextId);if(backup.status==='failed')throw new Error(backup.error);return backup.status==='succeeded'&&history.json().backups.find((item:{id:string})=>item.id===firstId)?.status==='deleted'?backup:undefined;},'S3 retention');
    assert.equal((await remoteClient.send(new ListObjectsV2Command({Bucket:bucket,Prefix:`original/servus/${service.id}/`}))).KeyCount,0);
    assert.equal((await remoteClient.send(new ListObjectsV2Command({Bucket:bucket,Prefix:`rotated/servus/${service.id}/`}))).KeyCount,1);
    const bad=await app.inject({method:'PUT',url:`${base}/backup-destination`,headers,payload:{...destination,secretAccessKey:'deliberately-invalid-secret'}});assert.equal(bad.statusCode,200);
    const failed=await app.inject({method:'POST',url:`${base}/backups`,headers:{...headers,'idempotency-key':`remote-invalid-${runId}`},payload:{name:'Invalid credentials'}});
    await until(async()=>{const history=await app!.inject({url:`${base}/backups`,headers});return history.json().backups.find((item:{id:string})=>item.id===failed.json().backup.id)?.status==='failed'?true:undefined;},'failed credential backup');
    assert.equal((await app.inject({url:`${base}/backups/${nextId}/download`,headers})).statusCode,200);
    assert.equal((await app.inject({method:'DELETE',url:`${base}/backups/${nextId}`,headers})).statusCode,200);
    assert.equal((await remoteClient.send(new ListObjectsV2Command({Bucket:bucket,Prefix:`rotated/servus/${service.id}/`}))).KeyCount,0);
    console.log('PASS actual MinIO S3 upload/list/download/restore, pinned destination rotation, remote retention and failed-upload preservation');
  }
  const repeated=await app.inject({method:'POST',url:`${base}/backups`,headers,payload:{name:'Before fixture update'}});assert.equal(repeated.json().backup.id,manualId);
  const erased=await app.inject({method:'DELETE',url:`${base}/backups/${manualId}`,headers});assert.equal(erased.statusCode,200);
  assert.equal((await app.inject({url:`${base}/backups/${manualId}/download`,headers})).statusCode,404);
  console.log('PASS real PostgreSQL manual and scheduled backups through the authenticated agent');
  console.log('PASS backup persistence across API restart and exact Unicode/empty-table restore into a fresh database');
  console.log('PASS source data preserved, idempotency replay and authorized artifact deletion');
} finally {
  await app?.close();await agent?.close();store.close();remoteClient?.destroy();await remote?.close();
  if(previousTestEndpoints===undefined)delete process.env.PANEL_BACKUP_TEST_ENDPOINTS;else process.env.PANEL_BACKUP_TEST_ENDPOINTS=previousTestEndpoints;
  for(const name of names) {
    try {if(cli(['inspect','--format','{{index .Config.Labels "servus.test"}}',name]).trim()===runId)cli(['rm','-f','-v',name]);}catch{/* A fixture that never started requires no cleanup. */}
  }
  rmSync(dataDir,{recursive:true,force:true});
}
