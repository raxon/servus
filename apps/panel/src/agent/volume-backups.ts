import Database from 'better-sqlite3';
import Docker from 'dockerode';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { LocalDatabaseBackupStorage } from './backups.js';
import { SecretVault } from '../shared/secrets.js';
import { AGENT_VOLUME_BACKUP_SCHEMA_SQL, type VolumeRestoreBinding } from '../shared/volume-backups.js';
import type { agentConfig } from './config.js';
import type { AgentMaintenanceGate } from './maintenance.js';
import { inspectVolumeArchive, volumeManifestsMatch, type VolumeArchiveManifest } from './volume-archive.js';
import { applyRegistryService, registryAuthFromSpec } from './registry-credentials.js';

const owner='self-hosted-panel',stamp=()=>new Date().toISOString();
const identity=z.string().uuid(),target=z.string().min(2).max(255).startsWith('/').refine(value=>!/[\\\x00-\x1f]/.test(value)&&!value.split('/').includes('..'));
const requestSchema=z.object({serviceId:identity,operationId:identity}).strict();
interface CaptureRow {id:string;service_id:string;mount_target:string;mount_name:string;source_volume:string;phase:string;sealed_plan:string;sealed_manifest:string|null;size:number|null;sha256:string|null;error:string|null;created_at:string;updated_at:string}
interface RestoreRow {id:string;service_id:string;backup_id:string;mount_target:string;mount_name:string;phase:string;sealed_plan:string;candidate_volume:string;previous_volume:string;error:string|null;created_at:string;updated_at:string}
interface Plan {serviceDockerId:string;previousSpec:Docker.ServiceSpec;stoppedSpec:Docker.ServiceSpec;helperImage:string;targetSpec?:Docker.ServiceSpec;previousBinding?:VolumeRestoreBinding}
export interface VolumeAgentOptions {
  config:ReturnType<typeof agentConfig>;
  withServiceLock:<T>(serviceId:string,operationId:string,task:()=>Promise<T>)=>Promise<T>;
  maintenance?:AgentMaintenanceGate;
}
const clone=<T>(value:T):T=>structuredClone(value);
const pause=(milliseconds:number)=>new Promise(resolve=>setTimeout(resolve,milliseconds));
const specMounts=(spec:Docker.ServiceSpec)=>spec.TaskTemplate&&'ContainerSpec' in spec.TaskTemplate?spec.TaskTemplate.ContainerSpec?.Mounts??[]:[];

export class VolumeBackupRuntime {
  readonly db:Database.Database;
  readonly docker:Docker;
  private readonly vault:SecretVault;
  private readonly storage:LocalDatabaseBackupStorage;
  constructor(private readonly options:VolumeAgentOptions) {
    this.db=new Database(join(options.config.dataDir,'agent.sqlite'));this.db.pragma('busy_timeout=5000');this.db.exec(AGENT_VOLUME_BACKUP_SCHEMA_SQL);
    this.docker=new Docker({socketPath:options.config.dockerSocket,timeout:60_000});this.vault=new SecretVault(options.config.dataDir);
    this.storage=new LocalDatabaseBackupStorage(options.config.dataDir,'volume-backups');
  }
  close() {this.db.close();}
  captureRow(id:string) {return this.db.prepare('SELECT * FROM volume_backup_operations WHERE id=?').get(id) as CaptureRow|undefined;}
  restoreRow(id:string) {return this.db.prepare('SELECT * FROM volume_restore_operations WHERE id=?').get(id) as RestoreRow|undefined;}
  hasUnresolved(serviceId?:string,exceptOperationId?:string) {
    return Boolean(this.db.prepare(`SELECT 1 FROM volume_backup_operations WHERE phase NOT IN ('completed','failed') ${serviceId?'AND service_id=?':''} ${exceptOperationId?'AND id<>?':''} LIMIT 1`).get(...[serviceId,exceptOperationId].filter(value=>value!==undefined)))||
      Boolean(this.db.prepare(`SELECT 1 FROM volume_restore_operations WHERE phase NOT IN ('completed','failed','cancelled','rolled_back') ${serviceId?'AND service_id=?':''} ${exceptOperationId?'AND id<>?':''} LIMIT 1`).get(...[serviceId,exceptOperationId].filter(value=>value!==undefined)));
  }
  private plan(row:CaptureRow|RestoreRow):Plan {return JSON.parse(this.vault.open(row.sealed_plan)) as Plan;}
  private setCapture(id:string,phase:string,error:string|null=null) {this.db.prepare('UPDATE volume_backup_operations SET phase=?,error=?,updated_at=? WHERE id=?').run(phase,error,stamp(),id);}
  private setRestore(id:string,phase:string,error:string|null=null) {this.db.prepare('UPDATE volume_restore_operations SET phase=?,error=?,updated_at=? WHERE id=?').run(phase,error,stamp(),id);}
  private async helperImage() {
    try{return (await this.docker.getImage('alpine:3.21').inspect()).Id;}
    catch(error){if((error as {statusCode?:number}).statusCode!==404)throw error;}
    const stream=await this.docker.pull('alpine:3.21');
    await new Promise<void>((resolve,reject)=>{const timeout=setTimeout(()=>{(stream as Readable).destroy();reject(new Error('Volume backup helper image could not be downloaded.'));},60_000);this.docker.modem.followProgress(stream,error=>{clearTimeout(timeout);error?reject(error):resolve();});});
    return (await this.docker.getImage('alpine:3.21').inspect()).Id;
  }
  private async source(serviceId:string,mountTarget:string) {
    const service=await this.docker.getService(`panel-app-${serviceId}`).inspect(),spec=service.Spec as Docker.ServiceSpec;
    if(!spec||service.Spec.Labels?.['panel.owner']!==owner||spec.Labels?.['panel.service']!==serviceId||spec.Labels?.['panel.kind']!=='app'||!service.ID||!service.Version?.Index)throw new Error('Volume backups require an owned application service.');
    const replicas=spec.Mode?.Replicated?.Replicas;
    if(replicas!==0&&replicas!==1)throw new Error('Volume backups require a single-replica application.');
    const info=await this.docker.info();
    if(!info.Swarm?.ControlAvailable||info.Swarm.Nodes!==1)throw new Error('Volume backups currently require a single-node Swarm manager.');
    const mounts=specMounts(spec),mount=mounts.find(item=>item.Target===mountTarget);
    if(!mount||mount.Type!=='volume'||!mount.Source||mount.ReadOnly||mount.VolumeOptions?.Subpath)throw new Error('Select a writable named volume mount. File and bind mounts are unsupported.');
    await this.ownedVolume(mount.Source,serviceId);
    const binding=this.db.prepare('SELECT * FROM volume_restore_bindings WHERE service_id=? AND mount_target=?').get(serviceId,mountTarget) as VolumeRestoreBinding|undefined;
    const prefix=`panel-data-${serviceId}-`,mountName=binding&&binding.volume_name===mount.Source?binding.mount_name:mount.Source.startsWith(prefix)?mount.Source.slice(prefix.length):'';
    if(!/^[a-z0-9][a-z0-9-]{0,62}$/.test(mountName))throw new Error('The volume cannot be matched to a managed named mount.');
    return {service,spec,mount,volume:mount.Source,mountName,binding};
  }
  private async ownedVolume(name:string,serviceId:string,candidateId?:string) {
    const info=await this.docker.getVolume(name).inspect();
    if(info.Name!==name||info.Driver!=='local'||Object.keys(info.Options??{}).length||info.Labels?.['panel.owner']!==owner||info.Labels?.['panel.service']!==serviceId)throw new Error('Volume ownership or local storage cannot be verified.');
    if(candidateId&&(name!==`panel-volume-restore-${candidateId}`||info.Labels?.['panel.volume.restore.operation']!==candidateId||info.Labels?.['panel.volume.restore.purpose']!=='candidate'))throw new Error('Restore candidate volume ownership cannot be verified.');
    return info;
  }
  private async noWriters(volume:string,serviceId:string) {
    for(const item of await this.docker.listContainers({all:true,filters:{volume:[volume]}})) {
      if(item.Labels?.['panel.owner']!==owner||item.Labels?.['panel.service']!==serviceId||item.State==='running'||item.State==='restarting'||item.State==='paused')throw new Error('The selected volume has an active or unrelated container attachment.');
    }
  }
  private async stopped(serviceId:string,volume:string) {
    for(let attempt=0;attempt<60;attempt++) {
      const tasks=await this.docker.listTasks({filters:{service:[`panel-app-${serviceId}`]}});
      if(!tasks.some(task=>['running','starting','preparing','ready','assigned'].includes(task.Status?.State??''))) {await this.noWriters(volume,serviceId);return;}
      await pause(250);
    }
    throw new Error('Application tasks did not stop before the backup deadline.');
  }
  private async ready(serviceId:string,spec:Docker.ServiceSpec) {
    if(spec.Mode?.Replicated?.Replicas===0)return;
    for(let attempt=0;attempt<120;attempt++) {
      const tasks=await this.docker.listTasks({filters:{service:[`panel-app-${serviceId}`],'desired-state':['running']}});
      const running=tasks.filter(task=>task.Status?.State==='running'&&task.Status.ContainerStatus?.ContainerID);
      if(running.length===1) {
        const container=await this.docker.getContainer(running[0]!.Status.ContainerStatus!.ContainerID!).inspect();
        const matches=container.State.Running&&specMounts(spec).filter(mount=>mount.Type==='volume').every(expected=>container.Mounts.some(mount=>mount.Type==='volume'&&mount.Name===expected.Source&&mount.Destination===expected.Target));
        if(matches&&(!container.State.Health||container.State.Health.Status==='healthy'))return;
        if(matches&&container.State.Health?.Status==='unhealthy')throw new Error('The application health check failed after restoring replicas.');
      }
      await pause(500);
    }
    throw new Error('Application replicas could not be verified after volume maintenance.');
  }
  private async update(serviceId:string,expected:Docker.ServiceSpec,next:Docker.ServiceSpec,serviceDockerId:string) {
    const service=this.docker.getService(`panel-app-${serviceId}`),current=await service.inspect();
    if(current.ID!==serviceDockerId||!isDeepStrictEqual(current.Spec,expected))throw new Error('The application configuration changed during volume maintenance.');
    await applyRegistryService(this.docker,next,current.Version.Index,registryAuthFromSpec(serviceId,next,this.vault));
  }
  private helperName(id:string,mode:string) {return `servus-volume-${id}-${mode}`;}
  private async removeHelper(id:string,serviceId:string,mode:'capture'|'extract'|'verify',volume:string) {
    const helper=this.docker.getContainer(this.helperName(id,mode));let info;
    try{info=await helper.inspect();}catch(error){if((error as {statusCode?:number}).statusCode===404)return;throw error;}
    const mounts=info.Mounts??[];
    if(info.Config.Labels?.['panel.owner']!==owner||info.Config.Labels?.['panel.service']!==serviceId||info.Config.Labels?.['panel.volume.operation']!==id||info.Config.Labels?.['panel.volume.helper']!==mode||mounts.length!==1||mounts[0]?.Name!==volume||mounts[0].Destination!=='/data'||info.HostConfig.NetworkMode!=='none'||!info.HostConfig.ReadonlyRootfs||info.HostConfig.Privileged)throw new Error('Volume helper ownership cannot be verified.');
    await helper.remove({force:true});
  }
  private async helper<T>(id:string,serviceId:string,volume:string,image:string,mode:'capture'|'extract'|'verify',consume:(stdout:Readable)=>Promise<T>,input?:Readable) {
    await this.removeHelper(id,serviceId,mode,volume);
    const name=this.helperName(id,mode),extract=mode==='extract';
    await this.docker.createContainer({name,Image:image,Cmd:extract?['tar','-C','/data','-xpf','-']:['tar','-C','/data','-cpf','-','.'],OpenStdin:extract,StdinOnce:extract,AttachStdin:extract,AttachStdout:true,AttachStderr:true,Tty:false,
      Labels:{'panel.owner':owner,'panel.service':serviceId,'panel.volume.operation':id,'panel.volume.helper':mode},
      HostConfig:{NetworkMode:'none',ReadonlyRootfs:true,Privileged:false,CapDrop:['ALL'],CapAdd:extract?['CHOWN','FOWNER','DAC_OVERRIDE']:['DAC_OVERRIDE'],SecurityOpt:['no-new-privileges:true'],Memory:128*1024*1024,PidsLimit:32,Mounts:[{Type:'volume',Source:volume,Target:'/data',ReadOnly:!extract}],LogConfig:{Type:'none',Config:{}}}});
    const child=spawn('docker',['--host',`unix://${this.options.config.dockerSocket}`,'start','--attach',...(extract?['--interactive']:[]),name],{stdio:[extract?'pipe':'ignore','pipe','pipe'],env:{PATH:process.env.PATH??'/usr/bin:/bin'}});
    child.stderr!.resume();
    const exit=new Promise<void>((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>code===0&&!signal?resolve():reject(new Error('Volume archive helper failed.')));});
    const timeout=setTimeout(()=>child.kill('SIGKILL'),300_000);timeout.unref();
    try {
      const reading=consume(child.stdout!),writing=input?pipeline(input,child.stdin!):Promise.resolve();
      const [result]=await Promise.all([reading,writing,exit]);return result;
    } finally {clearTimeout(timeout);child.kill('SIGKILL');input?.destroy();child.stdout!.destroy();await this.removeHelper(id,serviceId,mode,volume);}
  }
  private async resumeCapture(row:CaptureRow,success:boolean) {
    const plan=this.plan(row);await this.removeHelper(row.id,row.service_id,'capture',row.source_volume);
    const current=await this.docker.getService(`panel-app-${row.service_id}`).inspect();
    if(current.ID!==plan.serviceDockerId)throw new Error('The application service identity changed.');
    if(isDeepStrictEqual(current.Spec,plan.stoppedSpec))await this.update(row.service_id,plan.stoppedSpec,plan.previousSpec,plan.serviceDockerId);
    else if(!isDeepStrictEqual(current.Spec,plan.previousSpec))throw new Error('The application changed before replica recovery.');
    await this.ready(row.service_id,plan.previousSpec);
    this.setCapture(row.id,success?'completed':'failed',success?null:'Volume backup was interrupted or could not be verified. Application replicas were restored.');
    if(!success){this.storage.remove(row.id,'tar');this.storage.remove(row.id,'partial');}
  }
  async capture(input:{serviceId:string;operationId:string;mountTarget:string}) {
    const value=requestSchema.extend({mountTarget:target}).parse(input);
    return this.options.withServiceLock(value.serviceId,value.operationId,async()=>{
      const existing=this.captureRow(value.operationId);
      if(existing) {
        if(existing.service_id!==value.serviceId||existing.mount_target!==value.mountTarget)throw new Error('Volume backup identity was reused.');
        if(existing.phase==='completed')return {size:existing.size!,sha256:existing.sha256!,phase:'completed' as const};
        if(existing.phase==='failed')throw new Error(existing.error??'The previous volume backup failed.');
        await this.recoverCapture(existing);const recovered=this.captureRow(existing.id)!;
        if(recovered.phase==='completed')return {size:recovered.size!,sha256:recovered.sha256!,phase:'completed' as const};
        throw new Error(recovered.error??'The volume backup requires recovery.');
      }
      if(this.hasUnresolved(value.serviceId))throw new Error('Another volume operation requires recovery.');
      const {service,spec,mountName,volume}=await this.source(value.serviceId,value.mountTarget),image=await this.helperImage();
      const stopped=clone(spec);stopped.Mode={Replicated:{Replicas:0}};
      const plan:Plan={serviceDockerId:service.ID!,previousSpec:spec,stoppedSpec:stopped,helperImage:image},now=stamp();
      this.db.prepare("INSERT INTO volume_backup_operations(id,service_id,mount_target,mount_name,source_volume,phase,sealed_plan,created_at,updated_at) VALUES(?,?,?,?,?,'stopping',?,?,?)").run(value.operationId,value.serviceId,value.mountTarget,mountName,volume,this.vault.seal(JSON.stringify(plan)),now,now);
      try {
        await this.update(value.serviceId,spec,stopped,service.ID!);await this.stopped(value.serviceId,volume);this.setCapture(value.operationId,'capturing');
        const result=await this.helper(value.operationId,value.serviceId,volume,image,'capture',stream=>this.storage.capture(value.operationId,'tar',stream,undefined));
        const manifest=await inspectVolumeArchive(this.storage.read(value.operationId,'tar',result.size,result.sha256));
        this.db.prepare("UPDATE volume_backup_operations SET phase='resuming',sealed_manifest=?,size=?,sha256=?,updated_at=? WHERE id=?").run(this.vault.seal(JSON.stringify(manifest)),result.size,result.sha256,stamp(),value.operationId);
        await this.resumeCapture(this.captureRow(value.operationId)!,true);return {size:result.size,sha256:result.sha256,phase:'completed' as const};
      } catch(error) {
        try{const row=this.captureRow(value.operationId)!;if(row.phase!=='completed')await this.resumeCapture(row,false);}
        catch{this.setCapture(value.operationId,'needs_review','Application replica recovery must be completed before further service changes.');}
        throw new Error(this.captureRow(value.operationId)?.error??'The volume backup could not be completed.');
      }
    });
  }
  private async recoverCapture(row:CaptureRow) {
    let success=false;
    if(row.phase==='resuming'&&row.size&&row.sha256&&row.sealed_manifest) {
      try{const manifest=await inspectVolumeArchive(this.storage.read(row.id,'tar',row.size,row.sha256));success=volumeManifestsMatch(JSON.parse(this.vault.open(row.sealed_manifest)),manifest);}catch{/* Fail the archive while preserving the original volume. */}
    }
    try{await this.resumeCapture(row,success);}catch{this.setCapture(row.id,'needs_review','Application replica recovery must be completed before further service changes.');throw new Error('Volume backup recovery requires review.');}
  }
  private publicRestore(row:RestoreRow) {return {id:row.id,backupId:row.backup_id,serviceId:row.service_id,mountTarget:row.mount_target,phase:row.phase,candidateVolume:row.candidate_volume,previousVolume:row.previous_volume,error:row.error,createdAt:row.created_at,updatedAt:row.updated_at};}
  private async discardCandidate(row:RestoreRow) {
    for(const mode of ['extract','verify'] as const)await this.removeHelper(row.id,row.service_id,mode,row.candidate_volume);
    let volume;
    try{volume=await this.ownedVolume(row.candidate_volume,row.service_id,row.id);}catch(error){if((error as {statusCode?:number}).statusCode===404)return;throw error;}
    if((await this.docker.listContainers({all:true,filters:{volume:[volume.Name]}})).length)throw new Error('The restore candidate is still attached.');
    await this.docker.getVolume(volume.Name).remove();
  }
  async prepare(input:{serviceId:string;operationId:string;backupId:string}) {
    const value=requestSchema.extend({backupId:identity}).parse(input);
    return this.options.withServiceLock(value.serviceId,value.operationId,async()=>{
      let row=this.restoreRow(value.operationId);
      if(row&&(row.service_id!==value.serviceId||row.backup_id!==value.backupId))throw new Error('Volume restore identity was reused.');
      if(row&&['prepared','completed','cancelled','rolled_back'].includes(row.phase))return this.publicRestore(row);
      if(this.hasUnresolved(value.serviceId,value.operationId))throw new Error('Another volume operation requires recovery.');
      const backup=this.captureRow(value.backupId);
      if(!backup||backup.service_id!==value.serviceId||backup.phase!=='completed'||!backup.size||!backup.sha256||!backup.sealed_manifest)throw new Error('A completed owned volume backup is required.');
      const manifest=await inspectVolumeArchive(this.storage.read(backup.id,'tar',backup.size,backup.sha256));
      if(!volumeManifestsMatch(JSON.parse(this.vault.open(backup.sealed_manifest)),manifest))throw new Error('The volume backup manifest changed.');
      if(!row) {
        const source=await this.source(value.serviceId,backup.mount_target),image=await this.helperImage(),stopped=clone(source.spec);stopped.Mode={Replicated:{Replicas:0}};
        const plan:Plan={serviceDockerId:source.service.ID!,previousSpec:source.spec,stoppedSpec:stopped,helperImage:image,...(source.binding?{previousBinding:source.binding}:{})},now=stamp();
        this.db.prepare("INSERT INTO volume_restore_operations(id,service_id,backup_id,mount_target,mount_name,phase,sealed_plan,candidate_volume,previous_volume,created_at,updated_at) VALUES(?,?,?,?,?,'preparing',?,?,?,?,?)")
          .run(value.operationId,value.serviceId,backup.id,backup.mount_target,backup.mount_name,this.vault.seal(JSON.stringify(plan)),`panel-volume-restore-${value.operationId}`,source.volume,now,now);
        row=this.restoreRow(value.operationId)!;
      }
      if(!['preparing','failed'].includes(row.phase))throw new Error('The volume restore requires recovery before preparation.');
      try {
        await this.discardCandidate(row);this.setRestore(row.id,'preparing');
        await this.docker.createVolume({Name:row.candidate_volume,Driver:'local',Labels:{'panel.owner':owner,'panel.service':row.service_id,'panel.volume.restore.operation':row.id,'panel.volume.restore.purpose':'candidate'}});
        await this.ownedVolume(row.candidate_volume,row.service_id,row.id);
        const plan=this.plan(row);
        await this.helper(row.id,row.service_id,row.candidate_volume,plan.helperImage,'extract',async stream=>{stream.resume();},this.storage.read(backup.id,'tar',backup.size,backup.sha256));
        const verified=await this.helper(row.id,row.service_id,row.candidate_volume,plan.helperImage,'verify',inspectVolumeArchive);
        if(!volumeManifestsMatch(manifest,verified))throw new Error('The restored file content or metadata did not match the backup.');
        const current=await this.docker.getService(`panel-app-${row.service_id}`).inspect();
        if(current.ID!==plan.serviceDockerId||!isDeepStrictEqual(current.Spec,plan.previousSpec))throw new Error('The source application changed during restore preparation.');
        this.setRestore(row.id,'prepared');return this.publicRestore(this.restoreRow(row.id)!);
      } catch {
        try{await this.discardCandidate(row);this.setRestore(row.id,'failed','The candidate could not be verified. The original volume was not changed.');}
        catch{this.setRestore(row.id,'needs_review','The candidate cleanup requires review. The original volume was not changed.');}
        throw new Error(this.restoreRow(row.id)!.error!);
      }
    });
  }
  private async switchRestore(row:RestoreRow,rollback=false) {
    const plan=this.plan(row),service=this.docker.getService(`panel-app-${row.service_id}`),original=plan.previousSpec;
    let next=plan.targetSpec;
    if(!next) {next=clone(original);const mount=specMounts(next).find(mount=>mount.Target===row.mount_target);if(!mount||mount.Source!==row.previous_volume)throw new Error('The original mount changed.');mount.Source=row.candidate_volume;plan.targetSpec=next;this.db.prepare('UPDATE volume_restore_operations SET sealed_plan=? WHERE id=?').run(this.vault.seal(JSON.stringify(plan)),row.id);}
    const from=rollback?next:original,to=rollback?original:next,stoppedFrom=clone(from),stoppedTo=clone(to);stoppedFrom.Mode={Replicated:{Replicas:0}};stoppedTo.Mode={Replicated:{Replicas:0}};
    const sourceVolume=rollback?row.candidate_volume:row.previous_volume,targetVolume=rollback?row.previous_volume:row.candidate_volume;
    await this.ownedVolume(row.candidate_volume,row.service_id,row.id);await this.ownedVolume(row.previous_volume,row.service_id);
    let current=await service.inspect();if(current.ID!==plan.serviceDockerId)throw new Error('The application service identity changed.');
    if(isDeepStrictEqual(current.Spec,from)){await this.update(row.service_id,from,stoppedFrom,plan.serviceDockerId);await this.stopped(row.service_id,sourceVolume);current=await service.inspect();}
    if(isDeepStrictEqual(current.Spec,stoppedFrom)||isDeepStrictEqual(current.Spec,stoppedTo)) {
      await this.noWriters(sourceVolume,row.service_id);await this.noWriters(targetVolume,row.service_id);
      await this.update(row.service_id,current.Spec!,to,plan.serviceDockerId);
    } else if(!isDeepStrictEqual(current.Spec,to))throw new Error('The application changed before the volume switch.');
    await this.ready(row.service_id,to);
    const verified=await service.inspect();if(!isDeepStrictEqual(verified.Spec,to))throw new Error('The restored application configuration changed.');
    this.db.transaction(()=>{
      if(rollback) {
        if(plan.previousBinding)this.db.prepare('INSERT OR REPLACE INTO volume_restore_bindings VALUES(?,?,?,?,?,?)').run(plan.previousBinding.service_id,plan.previousBinding.mount_target,plan.previousBinding.mount_name,plan.previousBinding.volume_name,plan.previousBinding.operation_id,plan.previousBinding.created_at);
        else this.db.prepare('DELETE FROM volume_restore_bindings WHERE service_id=? AND mount_target=?').run(row.service_id,row.mount_target);
      } else this.db.prepare('INSERT OR REPLACE INTO volume_restore_bindings VALUES(?,?,?,?,?,?)').run(row.service_id,row.mount_target,row.mount_name,row.candidate_volume,row.id,stamp());
      this.setRestore(row.id,rollback?'rolled_back':'completed');
    }).immediate();
    return this.publicRestore(this.restoreRow(row.id)!);
  }
  async restoreAction(action:'commit'|'cancel'|'rollback',input:{serviceId:string;operationId:string}) {
    const value=requestSchema.parse(input);
    return this.options.withServiceLock(value.serviceId,value.operationId,async()=>{
      const row=this.restoreRow(value.operationId);if(!row||row.service_id!==value.serviceId)throw new Error('Volume restore not found.');
      if(action==='cancel') {
        if(row.phase==='cancelled')return this.publicRestore(row);
        if(!['preparing','prepared','failed'].includes(row.phase))throw new Error('This volume restore cannot be cancelled.');
        await this.discardCandidate(row);this.setRestore(row.id,'cancelled');return this.publicRestore(this.restoreRow(row.id)!);
      }
      if(action==='commit'&&row.phase==='completed'||action==='rollback'&&row.phase==='rolled_back')return this.publicRestore(row);
      if(action==='commit'&&!['prepared','switching'].includes(row.phase)||action==='rollback'&&!['completed','switching','rolling_back','needs_review'].includes(row.phase))throw new Error('The volume restore is not ready for this action.');
      this.setRestore(row.id,action==='rollback'?'rolling_back':'switching');
      try{return await this.switchRestore(this.restoreRow(row.id)!,action==='rollback');}
      catch {this.setRestore(row.id,'needs_review','The volume switch requires recovery. Both original and candidate volumes were retained.');throw new Error('The volume switch requires recovery.');}
    });
  }
  async recover(serviceId:string,operationId:string) {
    return this.options.withServiceLock(serviceId,operationId,async()=>{
      const capture=this.captureRow(operationId);if(capture&&capture.service_id===serviceId){if(!['completed','failed'].includes(capture.phase))await this.recoverCapture(capture);return {phase:this.captureRow(operationId)!.phase};}
      const restore=this.restoreRow(operationId);if(!restore||restore.service_id!==serviceId)throw new Error('Volume operation not found.');
      if(restore.phase==='switching')return this.switchRestore(restore);
      if(restore.phase==='rolling_back')return this.switchRestore(restore,true);
      if(restore.phase==='preparing'){await this.discardCandidate(restore);this.setRestore(restore.id,'failed','Restore preparation was interrupted. The original volume was not changed.');}
      return this.publicRestore(this.restoreRow(restore.id)!);
    });
  }
  async recoverAll() {
    const captures=this.db.prepare("SELECT id,service_id FROM volume_backup_operations WHERE phase NOT IN ('completed','failed')").all() as {id:string;service_id:string}[];
    const restores=this.db.prepare("SELECT id,service_id FROM volume_restore_operations WHERE phase IN ('preparing','switching','rolling_back')").all() as {id:string;service_id:string}[];
    for(const row of [...captures,...restores]){try{await this.recover(row.service_id,row.id);}catch{this.options.maintenance?.markUncertain();}}
  }
}

export function registerVolumeBackupAgent(app:FastifyInstance,options:VolumeAgentOptions) {
  const runtime=new VolumeBackupRuntime(options),active=new Set<Promise<unknown>>();
  const track=async<T>(task:()=>Promise<T>)=>{
    const release=options.maintenance?.admit();if(options.maintenance&&!release)throw Object.assign(new Error('Agent is draining.'),{code:'SERVICE_BUSY'});
    const pending=task();active.add(pending);try{return await pending;}finally{active.delete(pending);release?.();}
  };
  const respond=async(request:FastifyRequest,reply:FastifyReply,task:()=>Promise<unknown>)=>{
    try{return await track(task);}
    catch(error) {
      if(error instanceof z.ZodError)return reply.code(400).send({error:{code:'INVALID_VOLUME_REQUEST',message:'Invalid volume backup or restore request.'}});
      if(error&&typeof error==='object'&&'code' in error&&error.code==='SERVICE_BUSY')return reply.code(409).send({error:{code:'SERVICE_BUSY',message:'Another operation is changing this application.'}});
      const input=requestSchema.passthrough().safeParse(request.body),capture=input.success?runtime.captureRow(input.data.operationId):undefined,restore=input.success?runtime.restoreRow(input.data.operationId):undefined;
      if(capture?.phase==='needs_review'||restore?.phase==='needs_review')return reply.code(409).send({error:{code:'VOLUME_RECOVERY_REQUIRED',message:'The volume operation requires recovery. Original and candidate data were retained.'}});
      return reply.code(422).send({error:{code:'VOLUME_OPERATION_FAILED',message:'The volume operation could not be completed. Check the operation state before retrying.'}});
    }
  };
  app.post('/volume-backups/capture',async(request,reply)=>respond(request,reply,()=>runtime.capture(request.body as Parameters<VolumeBackupRuntime['capture']>[0])));
  app.post('/volume-backups/recover',async(request,reply)=>respond(request,reply,()=>{const input=requestSchema.parse(request.body);return runtime.recover(input.serviceId,input.operationId);}));
  app.post('/volume-restores/prepare',async(request,reply)=>respond(request,reply,()=>runtime.prepare(request.body as Parameters<VolumeBackupRuntime['prepare']>[0])));
  for(const action of ['commit','cancel','rollback'] as const)app.post(`/volume-restores/${action}`,async(request,reply)=>respond(request,reply,()=>runtime.restoreAction(action,request.body as Parameters<VolumeBackupRuntime['restoreAction']>[1])));
  app.addHook('onReady',async()=>runtime.recoverAll());
  app.addHook('onClose',async()=>{await Promise.allSettled([...active]);runtime.close();});
  return {hasUnresolved:(serviceId?:string,exceptOperationId?:string)=>runtime.hasUnresolved(serviceId,exceptOperationId),recoverAll:()=>runtime.recoverAll()};
}
