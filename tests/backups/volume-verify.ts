import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Docker from 'dockerode';
import { VolumeBackupRuntime } from '../../apps/panel/src/agent/volume-backups.js';
import { SecretVault } from '../../apps/panel/src/shared/secrets.js';
import { compileConfiguration } from '../../apps/panel/src/agent/configuration.js';
import { readVolumeBindings } from '../../apps/panel/src/agent/volume-binding.js';
import { DockerRuntime } from '../../apps/panel/src/agent/runtime.js';
import type { Service } from '../../apps/panel/src/shared/types.js';
import { Store } from '../../apps/panel/src/server/store.js';
import { normalizeServiceInput } from '../../apps/panel/src/server/configuration.js';
import { createAgent } from '../../apps/panel/src/agent/app.js';
import { createApp } from '../../apps/panel/src/server/app.js';
import { minioFixture } from './minio-fixture.js';
import { CreateBucketCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';

const context='colima-panel-dev',socket=execFileSync('docker',['context','inspect',context,'--format','{{.Endpoints.docker.Host}}'],{encoding:'utf8'}).trim().replace('unix://','');assert.match(socket,/\/\.colima\/panel-dev\/docker\.sock$/);
const dataDir=mkdtempSync('/tmp/servus-volume-e2e-'),store=new Store(dataDir),actor=store.setup('volume-fixture@example.test','fixture-hash'),project=store.createProject('volume-fixture');
const {service:created}=store.createService(project.id,normalizeServiceInput({name:'volume-fixture',image:'nginx:alpine',domains:[],mounts:[{name:'files',type:'volume',target:'/data'}]}),actor.id),job=store.claimNextJob('fixture',60_000)!;store.completeAction(job.actionId,'fixture',{state:'running',deployedRevision:1});
const serviceId=created.id,projectId=project.id,sourceVolume=`panel-data-${serviceId}-files`,serviceName=`panel-app-${serviceId}`;
const config={dataDir,dockerSocket:socket,socketPath:join(dataDir,'agent.sock'),token:'fixture',ingressPort:18080,ingressImage:'traefik:3.7.13'};
const options={config,withServiceLock:async<T>(_serviceId:string,_operationId:string,task:()=>Promise<T>)=>task()};
let runtime=new VolumeBackupRuntime(options);const docker=new Docker({socketPath:socket}),run=(args:string[])=>execFileSync('docker',['--host',`unix://${socket}`,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const checkContainer=async()=>{for(let i=0;i<120;i++){const list=await docker.listContainers({filters:{label:[`com.docker.swarm.service.name=${serviceName}`]}});if(list.length===1)return list[0]!.Id;await new Promise(resolve=>setTimeout(resolve,250));}throw new Error('Fixture service did not become ready.');};
const helpers:string[]=[];
let agent:Awaited<ReturnType<typeof createAgent>>|undefined,app:Awaited<ReturnType<typeof createApp>>|undefined,remote:Awaited<ReturnType<typeof minioFixture>>|undefined,remoteClient:S3Client|undefined;
const oldTestEndpoints=process.env.PANEL_BACKUP_TEST_ENDPOINTS;
let verified=false;
async function until<T>(check:()=>Promise<T|undefined>) {const deadline=Date.now()+180_000;while(Date.now()<deadline){const result=await check();if(result!==undefined)return result;await new Promise(resolve=>setTimeout(resolve,250));}throw new Error('Volume API operation did not finish.');}
const now=new Date().toISOString(),snapshot:Service={id:serviceId,projectId,name:'volume-fixture',kind:'app',source:{type:'image'},image:'nginx:alpine',port:80,hostname:'',domains:[],replicas:1,revision:1,deployedRevision:1,state:'running',createdAt:now,updatedAt:now,lastError:null,mounts:[{type:'volume',name:'files',target:'/data'}]};
try {
  const info=await docker.info();assert.equal(info.Swarm?.Nodes,1);const node=info.Swarm!.NodeID;
  await docker.createVolume({Name:sourceVolume,Labels:{'panel.owner':'self-hosted-panel','panel.service':serviceId,'servus.volume.test':serviceId}});
  await docker.createService({Name:serviceName,Labels:{'panel.owner':'self-hosted-panel','panel.service':serviceId,'panel.project':projectId,'panel.kind':'app'},Mode:{Replicated:{Replicas:1}},TaskTemplate:{ContainerSpec:{Image:snapshot.image,Mounts:[{Type:'volume',Source:sourceVolume,Target:'/data'}],Labels:{'panel.owner':'self-hosted-panel','panel.service':serviceId}},Placement:{Constraints:[`node.id==${node}`]}}});
  let container=await checkContainer();
  run(['exec',container,'sh','-c','mkdir -p /data/folder; printf "Zażółć gęślą jaźń" > /data/folder/unicode.txt; chmod 640 /data/folder/unicode.txt; chown 1000:1000 /data/folder/unicode.txt; touch -t 202611170100.00 /data/folder/unicode.txt; ln -s unicode.txt /data/folder/link; chmod 750 /data/folder']);
  const backupId=randomUUID(),backup=await runtime.capture({serviceId,operationId:backupId,mountTarget:'/data'});assert.equal(backup.phase,'completed');assert(backup.size>0);assert.match(backup.sha256,/^[a-f0-9]{64}$/);
  if(process.env.VOLUME_BACKUP_DEBUG==='1') {
    const implementation=runtime as unknown as {helper:(...args:unknown[])=>Promise<unknown>},original=implementation.helper.bind(runtime);
    const expected=JSON.parse(new SecretVault(dataDir).open(runtime.captureRow(backupId)!.sealed_manifest!));
    implementation.helper=async(...args)=>{try{const result=await original(...args);if(args[4]==='verify')console.log(JSON.stringify({expected,actual:result}));return result;}catch(error){console.log('Fixture helper failed',args[4],error instanceof Error?error.message:'unknown');throw error;}};
  }
  container=await checkContainer();assert.equal((await docker.getService(serviceName).inspect()).Spec.Mode.Replicated.Replicas,1);
  assert.equal(run(['exec',container,'cat','/data/folder/unicode.txt']),'Zażółć gęślą jaźń');
  run(['exec',container,'sh','-c','printf newer-live-data > /data/folder/unicode.txt']);
  const restoreId=randomUUID(),prepared=await runtime.prepare({serviceId,operationId:restoreId,backupId});assert.equal(prepared.phase,'prepared');assert.equal((await docker.getService(serviceName).inspect()).Spec.Mode.Replicated.Replicas,1);assert.equal(run(['exec',container,'cat','/data/folder/unicode.txt']),'newer-live-data');
  const committed=await runtime.restoreAction('commit',{serviceId,operationId:restoreId});assert.equal(committed.phase,'completed');container=await checkContainer();
  assert.equal(run(['exec',container,'cat','/data/folder/unicode.txt']),'Zażółć gęślą jaźń');assert.equal(run(['exec',container,'stat','-c','%a:%u:%g','/data/folder/unicode.txt']),'640:1000:1000');assert.equal(run(['exec',container,'readlink','/data/folder/link']),'unicode.txt');
  assert.equal((await runtime.restoreAction('commit',{serviceId,operationId:restoreId})).phase,'completed');
  const compiled=await compileConfiguration(docker,snapshot,new SecretVault(dataDir),dataDir,{volumeBindings:readVolumeBindings(dataDir,serviceId)});assert.equal(compiled.mounts[0]?.Source,committed.candidateVolume);
  assert.equal((await runtime.restoreAction('rollback',{serviceId,operationId:restoreId})).phase,'rolled_back');container=await checkContainer();assert.equal(run(['exec',container,'cat','/data/folder/unicode.txt']),'newer-live-data');
  assert.equal((await runtime.restoreAction('rollback',{serviceId,operationId:restoreId})).phase,'rolled_back');
  console.log('PASS quiesced volume backup, staged restore, Unicode/modes/ownership/symlink verification, explicit switch and retained original rollback');
  const interruptedId=randomUUID(),row=runtime.captureRow(backupId)!,plan=JSON.parse(new SecretVault(dataDir).open(row.sealed_plan));
  const current=await docker.getService(serviceName).inspect();plan.previousSpec=current.Spec;plan.stoppedSpec=structuredClone(current.Spec);plan.stoppedSpec.Mode={Replicated:{Replicas:0}};
  runtime.db.prepare("INSERT INTO volume_backup_operations(id,service_id,mount_target,mount_name,source_volume,phase,sealed_plan,created_at,updated_at) VALUES(?,?,?,?,?,'capturing',?,?,?)").run(interruptedId,serviceId,'/data','files',sourceVolume,new SecretVault(dataDir).seal(JSON.stringify(plan)),new Date().toISOString(),new Date().toISOString());
  await docker.getService(serviceName).update({...plan.stoppedSpec,version:current.Version.Index});runtime.close();runtime=new VolumeBackupRuntime(options);await runtime.recoverAll();assert.equal(runtime.captureRow(interruptedId)!.phase,'failed');container=await checkContainer();assert.equal(run(['exec',container,'cat','/data/folder/unicode.txt']),'newer-live-data');
  console.log('PASS durable interrupted capture recovery restores original replicas and data');
  const foreignName=`servus-volume-foreign-${randomUUID()}`;helpers.push(foreignName);run(['run','-d','--network','none','--name',foreignName,'--label',`servus.volume.test=${serviceId}`,'--mount',`type=volume,src=${sourceVolume},dst=/data`,'alpine:3.21','sleep','3600']);
  await assert.rejects(runtime.capture({serviceId,operationId:randomUUID(),mountTarget:'/data'}));container=await checkContainer();assert.equal((await docker.getService(serviceName).inspect()).Spec.Mode.Replicated.Replicas,1);assert.equal(run(['inspect','--format','{{.State.Running}}',foreignName]),'true');
  console.log('PASS foreign attached writer prevents capture without deleting unrelated containers');
  run(['rm','-f',foreignName]);helpers.splice(helpers.indexOf(foreignName),1);
  const finalId=randomUUID();await runtime.prepare({serviceId,operationId:finalId,backupId});const final=await runtime.restoreAction('commit',{serviceId,operationId:finalId});
  const runtimeDeployment=new DockerRuntime(socket,config.ingressPort,config.ingressImage,dataDir),oldLocalImages=process.env.PANEL_ALLOW_LOCAL_IMAGES;process.env.PANEL_ALLOW_LOCAL_IMAGES='1';
  try {
    for(const action of ['deploy','restart']){await runtimeDeployment.apply(snapshot,action,randomUUID());container=await checkContainer();assert.equal(run(['exec',container,'cat','/data/folder/unicode.txt']),'Zażółć gęślą jaźń');assert.equal((await docker.getService(serviceName).inspect()).Spec.TaskTemplate.ContainerSpec.Mounts.find((mount:{Target:string})=>mount.Target==='/data').Source,final.candidateVolume);}
    await assert.rejects(runtimeDeployment.apply({...snapshot,mounts:[]},'deploy',randomUUID()),/restored application mount/);
    assert.equal(run(['exec',container,'cat','/data/folder/unicode.txt']),'Zażółć gęślą jaźń');
    console.log('PASS committed volume binding survives configuration compile, real redeploy and restart; removed mount fails closed');
  } finally {if(oldLocalImages===undefined)delete process.env.PANEL_ALLOW_LOCAL_IMAGES;else process.env.PANEL_ALLOW_LOCAL_IMAGES=oldLocalImages;}
  agent=await createAgent(config);await agent.listen({path:config.socketPath});app=await createApp({dataDir,store,agentConnection:{socketPath:config.socketPath,token:config.token}});
  const session=store.createSession(actor.id),headers={cookie:`panel_session=${session.token}`,'x-csrf-token':session.csrfToken},base=`/api/v1/services/${serviceId}`;
  if(process.env.SERVUS_VOLUME_S3==='1') {
    remote=await minioFixture();process.env.PANEL_BACKUP_TEST_ENDPOINTS=remote.endpoint;remoteClient=new S3Client({region:'us-east-1',endpoint:remote.endpoint,forcePathStyle:true,credentials:{accessKeyId:remote.accessKeyId,secretAccessKey:remote.secretAccessKey}});await remoteClient.send(new CreateBucketCommand({Bucket:'volume-fixture'}));
    const response=await app.inject({method:'PUT',url:`${base}/volume-backup-destination`,headers,payload:{mountTarget:'/data',destination:{type:'s3',provider:'s3',endpoint:remote.endpoint,region:'us-east-1',bucket:'volume-fixture',prefix:'volumes',accessKeyId:remote.accessKeyId,secretAccessKey:remote.secretAccessKey}}});assert.equal(response.statusCode,200);assert(!response.payload.includes(remote.secretAccessKey));
  }
  const response=await app.inject({method:'POST',url:`${base}/volume-backups`,headers:{...headers,'idempotency-key':'api-real-capture'},payload:{mountTarget:'/data',name:'Real API archive'}});assert.equal(response.statusCode,202);const apiBackupId=response.json().backup.id;
  await until(async()=>{const backup=(await app!.inject({url:`${base}/volume-backups`,headers})).json().backups.find((item:{id:string})=>item.id===apiBackupId);if(backup.status==='failed')throw new Error(backup.error);return backup.status==='succeeded'?backup:undefined;});
  const download=await app.inject({url:`${base}/volume-backups/${apiBackupId}/download`,headers});assert.equal(download.statusCode,200);assert(download.rawPayload.length>0);
  container=await checkContainer();run(['exec',container,'sh','-c','printf after-api-backup > /data/folder/unicode.txt']);
  const preparation=await app.inject({method:'POST',url:`${base}/volume-backups/${apiBackupId}/restore`,headers:{...headers,'idempotency-key':'api-real-restore'},payload:{}});assert.equal(preparation.statusCode,202);const apiRestoreId=preparation.json().restore.id;
  const waitRestore=(phase:string)=>until(async()=>{const restore=(await app!.inject({url:`${base}/volume-restores`,headers})).json().restores.find((item:{id:string})=>item.id===apiRestoreId);if(['failed','needs_review'].includes(restore.phase))throw new Error(restore.error);return restore.phase===phase?restore:undefined;});
  await waitRestore('prepared');assert.equal(run(['exec',container,'cat','/data/folder/unicode.txt']),'after-api-backup');
  assert.equal((await app.inject({method:'POST',url:`${base}/volume-restores/${apiRestoreId}/commit`,headers,payload:{confirm:true}})).statusCode,202);await waitRestore('completed');container=await checkContainer();assert.equal(run(['exec',container,'cat','/data/folder/unicode.txt']),'Zażółć gęślą jaźń');
  if(remoteClient){
    const objects=await remoteClient.send(new ListObjectsV2Command({Bucket:'volume-fixture'}));assert.equal(objects.Contents?.length,1);assert.equal(objects.Contents?.[0]?.Key,`volumes/servus-volumes/${serviceId}/${apiBackupId}.tar`);
    assert.equal((await app.inject({method:'PUT',url:`${base}/volume-backup-settings`,headers,payload:{mountTarget:'/data',enabled:false,cron:'0 3 * * *',retention:1}})).statusCode,200);
    const next=await app.inject({method:'POST',url:`${base}/volume-backups`,headers:{...headers,'idempotency-key':'api-retention'},payload:{mountTarget:'/data',name:'Retention successor'}});assert.equal(next.statusCode,202);const nextId=next.json().backup.id;
    await until(async()=>{const backups=(await app!.inject({url:`${base}/volume-backups`,headers})).json().backups;if(backups.some((item:{status:string})=>item.status==='failed'))throw new Error('Remote retention fixture backup failed.');return backups.find((item:{id:string;status:string})=>item.id===apiBackupId&&item.status==='deleted')?true:undefined;});
    const retained=await remoteClient.send(new ListObjectsV2Command({Bucket:'volume-fixture'}));assert.equal(retained.Contents?.length,1);assert.equal(retained.Contents?.[0]?.Key,`volumes/servus-volumes/${serviceId}/${nextId}.tar`);
    assert.equal((await app.inject({method:'DELETE',url:`${base}/volume-backups/${nextId}`,headers})).statusCode,200);assert.equal((await remoteClient.send(new ListObjectsV2Command({Bucket:'volume-fixture'}))).Contents?.length??0,0);
  }
  console.log(`PASS authenticated API -> agent named capture, history, download and staged restore (${remote?'real MinIO upload/list/download/restore/retention/delete':'local private storage'})`);verified=true;
} finally {
  await app?.close();await agent?.close();remoteClient?.destroy();await remote?.close();if(oldTestEndpoints===undefined)delete process.env.PANEL_BACKUP_TEST_ENDPOINTS;else process.env.PANEL_BACKUP_TEST_ENDPOINTS=oldTestEndpoints;
  for(const name of helpers){try{if(run(['inspect','--format','{{index .Config.Labels "servus.volume.test"}}',name])===serviceId)run(['rm','-f',name]);}catch{/* only fixture helpers */}}
  try{const service=await docker.getService(serviceName).inspect();if(service.Spec.Labels['panel.service']===serviceId)await docker.getService(serviceName).remove();}catch{/* fixture may not have started */}
  for(let i=0;i<120;i++){if(!(await docker.listContainers({all:true,filters:{label:[`panel.service=${serviceId}`]}})).length)break;await new Promise(resolve=>setTimeout(resolve,250));}
  for(const item of await docker.listContainers({all:true,filters:{label:[`panel.service=${serviceId}`]}})){assert.equal(item.Labels['panel.owner'],'self-hosted-panel');await docker.getContainer(item.Id).remove({force:true});}
  for(const volume of (await docker.listVolumes({filters:{label:[`panel.service=${serviceId}`]}})).Volumes??[]){assert.equal(volume.Labels?.['panel.owner'],'self-hosted-panel');await docker.getVolume(volume.Name).remove();}
  try{const network=await docker.getNetwork(`panel-project-${projectId}`).inspect();if(network.Labels?.['panel.project']===projectId)await docker.getNetwork(network.Id).remove();}catch{/* only this run's optional project network */}
  runtime.close();store.close();rmSync(dataDir,{recursive:true,force:true});
  if(verified){const directory=fileURLToPath(new URL('../../artifacts/backups/',import.meta.url));mkdirSync(directory,{recursive:true});writeFileSync(join(directory,'volume-e2e.json'),JSON.stringify({runAt:now,completedAt:new Date().toISOString(),context,localChecks:['quiesced-capture-and-resume','staged-new-volume-restore','unicode-file-mode-owner-symlink-verification','explicit-switch-and-retained-original-rollback','repeated-commit-and-rollback','interrupted-capture-recovery','foreign-writer-refusal','binding-configuration-compile','real-redeploy-and-restart','removed-bound-mount-refused'],apiChecks:['authenticated-named-capture','history','verified-download','staged-restore','explicit-switch'],realMinIOChecks:remote?['upload','list','download','restore-from-remote-after-local-staging-removal','retention','delete']:[],officialMinIOChecksumVerified:Boolean(remote),cleanupStatus:'completed',limitations:['External Cloudflare R2 account not exercised.','Public S3 HTTPS/TLS endpoint not exercised.']},null,2)+'\n',{mode:0o600});}
}
