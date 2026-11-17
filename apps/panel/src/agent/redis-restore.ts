import type Database from 'better-sqlite3';
import type Docker from 'dockerode';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { setTimeout as pause } from 'node:timers/promises';
import { z } from 'zod';
import type { SecretVault } from '../shared/secrets.js';
import type { RestoreJournal, RestoreVolumeBinding } from './restore-journal.js';
import { acquireRestoreUploadLock } from './restore-upload-lock.js';
import { readRestoreArchive } from './restore-archive.js';
import { loadRestoreSource } from './restore-source.js';
import { importRedisRestore } from './redis-restore-import.js';
import { DatabaseImportError } from './database-import.js';
import { cancelPreparedRestore } from './restore-candidate-cancel.js';
import { cancelStagedRestore } from './restore-cancel.js';
import { commitPreparedRestore, RestoreCommitUncertainError, type RestoreCommitResult } from './restore-commit.js';
import { prepareRestoreSwitchIntent, readRestoreSwitchIntent, type RestoreSwitchPlan } from './restore-switch-intent.js';
import { verifyRestoreDatabase } from './restore-switch-verify.js';
import { applyRegistryService, registryAuthFromSpec } from './registry-credentials.js';

export const REDIS_RESTORE_SCHEMA_SQL=`CREATE TABLE IF NOT EXISTS redis_restore_plans (
  operation_id TEXT PRIMARY KEY,service_id TEXT NOT NULL,sealed_plan TEXT NOT NULL,
  phase TEXT NOT NULL CHECK(phase IN ('committing','completed','rolling_back','rolled_back')),updated_at TEXT NOT NULL
);`;
type PlanRow={operation_id:string;service_id:string;sealed_plan:string;phase:'committing'|'completed'|'rolling_back'|'rolled_back';updated_at:string};
type RecoveryPlan={version:1;switchPlan:RestoreSwitchPlan;previousBinding:RestoreVolumeBinding|null};
export interface RedisRestoreOptions {db:Database.Database;journal:RestoreJournal;docker:Docker;dockerSocket:string;dataDir:string;vault:SecretVault}

/** Redis uses the existing restore fence and keeps its original volume available for explicit rollback. */
export class RedisRestore {
  constructor(private readonly options:RedisRestoreOptions) {options.db.transaction(()=>options.db.exec(REDIS_RESTORE_SCHEMA_SQL)).immediate();}
  private row(id:string) {return this.options.db.prepare('SELECT * FROM redis_restore_plans WHERE operation_id=?').get(id) as PlanRow|undefined;}
  private requireRecord(serviceId:string,id:string) {if(!z.string().uuid().safeParse(serviceId).success||!/^[a-f0-9]{32}$/.test(id))throw new Error('Invalid Redis restore identity.');const row=this.options.journal.get(id);if(!row||row.service_id!==serviceId||row.kind!=='redis')throw new Error('Redis restore operation not found.');return row;}
  private async exclusive<T>(serviceId:string,id:string,task:()=>Promise<T>) {
    this.requireRecord(serviceId,id);const serviceLockId=createHash('sha256').update(`servus-redis-service:${serviceId}`).digest('hex').slice(0,32),lockId=createHash('sha256').update(`servus-redis-mutex:${serviceId}`).digest('hex').slice(0,32),path=join(this.options.dataDir,'restore-upload-locks',`${serviceLockId}-${lockId}.sqlite`);let release:()=>void;
    try{release=acquireRestoreUploadLock(this.options.dataDir,serviceLockId,!existsSync(path),lockId);}catch{throw Object.assign(new Error('Another process is changing this Redis service.'),{code:'REDIS_RESTORE_BUSY'});}
    try{return await task();}finally{release();}
  }
  metadata(serviceId:string,id:string) {
    const record=this.options.journal.get(id),row=this.row(id);if(record?.kind!=='redis'||record.service_id!==serviceId||!row||row.service_id!==serviceId)return {};
    return {...(row.phase==='completed'&&record.phase==='completed'&&this.options.journal.volumeBinding(serviceId)?.operation_id===id?{canRollback:true as const}:{}),...(row.phase==='rolling_back'?{restoreDirection:'rollback' as const}:{}),...(['committing','rolling_back'].includes(row.phase)?{redisRecoveryRequired:true as const}:{})};
  }
  private plan(serviceId:string,id:string):RecoveryPlan {
    const row=this.row(id);if(!row||row.service_id!==serviceId)throw new Error('Redis restore recovery plan is unavailable.');
    const record=this.requireRecord(serviceId,id),raw=z.object({version:z.literal(1),switchPlan:z.object({version:z.literal(1),inspection:z.object({serviceId:z.literal(serviceId),operationId:z.literal(id),serviceDockerId:z.string().min(1),serviceVersion:z.number().int().positive(),sourceContainerId:z.string().regex(/^[a-f0-9]{64}$/),sourceVolume:z.string().max(255),candidateContainerId:z.string().regex(/^[a-f0-9]{64}$/),candidateVolume:z.literal(`panel-restore-${id}`),imageId:z.string().regex(/^sha256:[a-f0-9]{64}$/),nodeId:z.string().min(1)}).strict(),previousSpec:z.record(z.string(),z.unknown()),targetSpec:z.record(z.string(),z.unknown())}).strict(),previousBinding:z.object({service_id:z.literal(serviceId),operation_id:z.string().regex(/^[a-f0-9]{32}$/),volume_name:z.string(),kind:z.literal('redis'),created_at:z.string().datetime()}).strict().nullable()}).strict().parse(JSON.parse(this.options.vault.open(row.sealed_plan)));
    const plan=raw as unknown as RecoveryPlan,inspection=plan.switchPlan.inspection,previous=plan.previousBinding;
    if(previous&&(previous.operation_id===id||previous.volume_name!==`panel-restore-${previous.operation_id}`||this.options.journal.get(previous.operation_id)?.phase!=='completed'||this.options.journal.get(previous.operation_id)?.kind!=='redis'||this.options.journal.get(previous.operation_id)?.service_id!==serviceId))throw new Error('Redis previous binding is invalid.');
    if(inspection.sourceVolume!==(previous?.volume_name??`panel-data-${serviceId}-database`))throw new Error('Redis original volume identity is invalid.');
    for(const [spec,volume,operation] of [[plan.switchPlan.previousSpec,inspection.sourceVolume,previous?.operation_id],[plan.switchPlan.targetSpec,inspection.candidateVolume,id]] as const) {
      const mounts=spec.TaskTemplate&&'ContainerSpec' in spec.TaskTemplate?spec.TaskTemplate.ContainerSpec?.Mounts??[]:[];
      if(spec.Name!==`panel-app-${serviceId}`||spec.Labels?.['panel.owner']!=='self-hosted-panel'||spec.Labels['panel.service']!==serviceId||spec.Labels['panel.kind']!==record.kind||spec.Labels['panel.restore.operation']!==operation||spec.Mode?.Replicated?.Replicas!==1||spec.UpdateConfig?.Order!=='stop-first'||mounts.length!==1||mounts[0]?.Type!=='volume'||mounts[0].Source!==volume||mounts[0].Target!=='/data'||mounts[0].ReadOnly)throw new Error('Redis recovery specification is invalid.');
    }
    const expected=structuredClone(plan.switchPlan.previousSpec),template=expected.TaskTemplate;if(!template||!('ContainerSpec' in template)||!template.ContainerSpec?.Mounts?.[0])throw new Error('Redis recovery task is invalid.');template.ContainerSpec.Mounts[0].Source=inspection.candidateVolume;expected.Labels={...expected.Labels,'panel.restore.operation':id};if(!isDeepStrictEqual(expected,plan.switchPlan.targetSpec))throw new Error('Redis restore target changes more than its selected volume.');
    return plan;
  }
  async prepare(serviceId:string,id:string,sourceContainerId:string) {
    return this.exclusive(serviceId,id,async()=>{
      const record=this.requireRecord(serviceId,id);if(record.phase==='prepared')return {operationId:id,phase:'prepared' as const};if(record.phase!=='reserved')throw new Error('Redis restore is not ready for preparation.');
      const source=loadRestoreSource({dataDir:this.options.dataDir,serviceId,kind:'redis',vault:this.options.vault});this.options.journal.advance(id,'reserved','importing');
      try {await importRedisRestore({...this.options,serviceId,operationId:id,sourceContainerId,password:source.password,input:()=>readRestoreArchive({dataDir:this.options.dataDir,operationId:id,key:this.options.vault.restoreArchiveKey(id)})});this.options.journal.advance(id,'importing','prepared');return {operationId:id,phase:'prepared' as const};}
      catch(error) {
        if(error instanceof DatabaseImportError){this.options.journal.advance(id,'importing','discarding_candidate');try{await cancelPreparedRestore({...this.options,serviceId,operationId:id});}catch(cause){throw new RestoreCommitUncertainError('Redis candidate cleanup requires recovery.',{cause});}throw error;}
        try{if(this.options.journal.get(id)?.phase==='importing')this.options.journal.advance(id,'importing','needs_review');}catch{/* An unresolved record retains the service fence. */}
        throw new RestoreCommitUncertainError('Redis preparation requires recovery. The original volume was retained.',{cause:error});
      }
    });
  }
  async cancel(serviceId:string,id:string) {return this.exclusive(serviceId,id,async()=>{const record=this.requireRecord(serviceId,id);return ['prepared','discarding_candidate'].includes(record.phase)?cancelPreparedRestore({...this.options,serviceId,operationId:id}):cancelStagedRestore({...this.options,serviceId,operationId:id});});}
  private async commitLocked(serviceId:string,id:string):Promise<RestoreCommitResult> {
    let record=this.requireRecord(serviceId,id);const existing=this.row(id);if(existing?.phase==='rolling_back')throw Object.assign(new Error('Resume the Redis rollback before committing.'),{code:'REDIS_RESTORE_BUSY'});
    if(record.phase==='prepared'){loadRestoreSource({dataDir:this.options.dataDir,serviceId,kind:'redis',vault:this.options.vault});await prepareRestoreSwitchIntent({...this.options,serviceId,operationId:id});record=this.requireRecord(serviceId,id);}
    if(!this.row(id)&&record.phase==='switching') {
      const switchPlan=readRestoreSwitchIntent({...this.options,serviceId,operationId:id}),previousBinding=this.options.journal.validatedVolumeBinding(serviceId,'redis')??null;
      this.options.db.prepare("INSERT INTO redis_restore_plans(operation_id,service_id,sealed_plan,phase,updated_at) VALUES(?,?,?,'committing',?)").run(id,serviceId,this.options.vault.seal(JSON.stringify({version:1,switchPlan,previousBinding})),new Date().toISOString());
    }
    const result=await commitPreparedRestore({...this.options,serviceId,operationId:id});
    if(this.row(id)) {
      if(result.phase==='completed') {const plan=this.plan(serviceId,id);if(this.options.journal.validatedVolumeBinding(serviceId,'redis')?.operation_id!==id)throw new RestoreCommitUncertainError('Redis committed binding requires recovery.');await verifyRestoreDatabase({docker:this.options.docker,plan:plan.switchPlan,side:'target',kind:'redis'});}
      this.options.db.prepare('UPDATE redis_restore_plans SET phase=?,updated_at=? WHERE operation_id=? AND service_id=?').run(result.phase==='completed'?'completed':'rolled_back',new Date().toISOString(),id,serviceId);
    }
    return result;
  }
  async commit(serviceId:string,id:string) {return this.exclusive(serviceId,id,()=>this.commitLocked(serviceId,id));}
  private async ownedVolumes(serviceId:string,id:string,plan:RecoveryPlan) {
    const {inspection}=plan.switchPlan;
    for(const [name,operation] of [[inspection.sourceVolume,plan.previousBinding?.operation_id],[inspection.candidateVolume,id]] as const) {
      const volume=await this.options.docker.getVolume(name).inspect();if(volume.Name!==name||volume.Driver!=='local'||Object.keys(volume.Options??{}).length)throw new Error('Redis recovery volume is not local and owned.');
      if(operation){if(volume.Labels?.['panel.restore.operation']!==operation||volume.Labels?.['panel.restore.service']!==serviceId||volume.Labels?.['panel.restore.purpose']!=='candidate')throw new Error('Redis recovery volume ownership changed.');}
      else if(volume.Labels?.['panel.owner']!=='self-hosted-panel'||volume.Labels?.['panel.service']!==serviceId)throw new Error('Redis original volume ownership changed.');
    }
  }
  private async noWriters(serviceId:string,volume:string,allowOwnedRunning=false) {
    let running=false;
    for(const item of await this.options.docker.listContainers({all:true,filters:{volume:[volume]}})) {
      const container=await this.options.docker.getContainer(item.Id).inspect();if(container.Config.Labels?.['panel.owner']!=='self-hosted-panel'||container.Config.Labels?.['panel.service']!==serviceId||container.Config.Labels?.['com.docker.swarm.service.name']!==`panel-app-${serviceId}`||container.Mounts.length!==1||container.Mounts[0]?.Name!==volume||container.Mounts[0].Destination!=='/data'||!container.Mounts[0].RW)throw new Error('Redis recovery volume has an unrelated attachment.');
      if(container.State.Running||container.State.Paused||container.State.Restarting)running=true;
    }
    if(running&&!allowOwnedRunning)throw new Error('Redis recovery volume still has a writer.');return running;
  }
  private async rollbackLocked(serviceId:string,id:string):Promise<RestoreCommitResult> {
    const record=this.requireRecord(serviceId,id),row=this.row(id);if(row?.phase==='rolled_back'&&record.phase==='cancelled')return {operationId:id,phase:'cancelled',rolledBack:true};
    if(!row||!['completed','rolling_back'].includes(row.phase))throw Object.assign(new Error('Redis restore is not ready for rollback.'),{code:'REDIS_RESTORE_BUSY'});
    const noOtherRestore=()=>{if(this.options.db.prepare("SELECT 1 FROM restore_operations WHERE service_id=? AND id<>? AND phase NOT IN ('completed','cancelled') LIMIT 1").get(serviceId,id)||this.options.db.prepare("SELECT 1 FROM redis_restore_plans WHERE service_id=? AND operation_id<>? AND phase IN ('committing','rolling_back') LIMIT 1").get(serviceId,id))throw Object.assign(new Error('Another database restore must finish before rollback.'),{code:'REDIS_RESTORE_BUSY'});};noOtherRestore();
    const plan=this.plan(serviceId,id),{switchPlan}=plan,{inspection}=switchPlan,service=this.options.docker.getService(`panel-app-${serviceId}`),stopped=structuredClone(switchPlan.targetSpec);stopped.Mode={Replicated:{Replicas:0}};
    const inspect=async()=>{const current=await service.inspect(),node=(await this.options.docker.info()).Swarm;if(node?.Nodes!==1||node.NodeID!==inspection.nodeId||current.ID!==inspection.serviceDockerId)throw new Error('Redis service identity changed.');return current;};
    await this.ownedVolumes(serviceId,id,plan);let current=await inspect();
    if(row.phase==='completed') {
      if(record.phase!=='completed'||this.options.journal.validatedVolumeBinding(serviceId,'redis')?.operation_id!==id||!isDeepStrictEqual(current.Spec,switchPlan.targetSpec))throw Object.assign(new Error('Redis changed after restoration. Rollback was refused.'),{code:'REDIS_RESTORE_BUSY'});
      await this.noWriters(serviceId,inspection.sourceVolume);await this.noWriters(serviceId,inspection.candidateVolume,true);
      this.options.db.transaction(()=>{noOtherRestore();if(this.requireRecord(serviceId,id).phase!=='completed'||this.row(id)?.phase!=='completed')throw new Error('Redis rollback state changed.');this.options.db.prepare("UPDATE redis_restore_plans SET phase='rolling_back',updated_at=? WHERE operation_id=?").run(new Date().toISOString(),id);this.options.db.prepare("UPDATE restore_operations SET phase='switching',updated_at=? WHERE id=? AND phase='completed'").run(new Date().toISOString(),id);}).immediate();
    }
    current=await inspect();
    const update=async(previous:Docker.ServiceSpec,target:Docker.ServiceSpec)=>{const latest=await inspect();if(!isDeepStrictEqual(latest.Spec,previous))throw new Error('Redis service changed before rollback update.');await applyRegistryService(this.options.docker,target,latest.Version.Index,registryAuthFromSpec(serviceId,target,this.options.vault));};
    if(isDeepStrictEqual(current.Spec,switchPlan.targetSpec)){await update(switchPlan.targetSpec,stopped);current=await inspect();}
    if(isDeepStrictEqual(current.Spec,stopped)) {
      let idle=false;for(let attempt=0;attempt<120;attempt++){try{await this.noWriters(serviceId,inspection.candidateVolume);await this.noWriters(serviceId,inspection.sourceVolume);idle=true;break;}catch(error){if(attempt===119)throw error;await pause(250);}}if(!idle)throw new Error('Redis writers did not stop.');
      await this.ownedVolumes(serviceId,id,plan);await update(stopped,switchPlan.previousSpec);
    } else if(!isDeepStrictEqual(current.Spec,switchPlan.previousSpec))throw new Error('Redis rollback runtime differs from its durable plan.');
    await verifyRestoreDatabase({docker:this.options.docker,plan:switchPlan,side:'source',kind:'redis'});await this.ownedVolumes(serviceId,id,plan);await this.noWriters(serviceId,inspection.candidateVolume);current=await inspect();if(!isDeepStrictEqual(current.Spec,switchPlan.previousSpec))throw new Error('Redis changed during rollback verification.');
    this.options.db.transaction(()=>{
      if(this.row(id)?.phase!=='rolling_back'||this.requireRecord(serviceId,id).phase!=='switching'||this.options.journal.volumeBinding(serviceId)?.operation_id!==id)throw new Error('Redis rollback journal changed.');
      if(plan.previousBinding){const b=plan.previousBinding;this.options.db.prepare('UPDATE restore_volume_bindings SET operation_id=?,volume_name=?,kind=?,created_at=? WHERE service_id=? AND operation_id=?').run(b.operation_id,b.volume_name,b.kind,b.created_at,serviceId,id);}
      else this.options.db.prepare('DELETE FROM restore_volume_bindings WHERE service_id=? AND operation_id=?').run(serviceId,id);
      const retained=this.options.db.prepare("UPDATE restore_retained_volumes SET volume_name=?,reason='rollback_candidate',created_at=? WHERE operation_id=? AND service_id=? AND reason='pre_restore_source' AND volume_name=?").run(inspection.candidateVolume,new Date().toISOString(),id,serviceId,inspection.sourceVolume);if(retained.changes!==1)throw new Error('Redis retained volume journal changed.');
      this.options.db.prepare("UPDATE restore_operations SET phase='cancelled',updated_at=? WHERE id=? AND phase='switching'").run(new Date().toISOString(),id);this.options.db.prepare("UPDATE redis_restore_plans SET phase='rolled_back',updated_at=? WHERE operation_id=? AND phase='rolling_back'").run(new Date().toISOString(),id);
    }).immediate();return {operationId:id,phase:'cancelled',rolledBack:true};
  }
  async rollback(serviceId:string,id:string) {return this.exclusive(serviceId,id,async()=>{try{return await this.rollbackLocked(serviceId,id);}catch(error){if(this.row(id)?.phase==='rolling_back')throw new RestoreCommitUncertainError('Redis rollback requires recovery. Both volumes were retained.',{cause:error});throw error;}});}
  async recover(serviceId:string,id:string) {
    return this.exclusive(serviceId,id,async()=>{
      const record=this.requireRecord(serviceId,id),plan=this.row(id);
      if(plan?.phase==='rolling_back')return this.rollbackLocked(serviceId,id);
      if(plan?.phase==='committing'||record.phase==='switching')return this.commitLocked(serviceId,id);
      if(['importing','needs_review','discarding_candidate'].includes(record.phase)) {
        if(this.options.journal.switchIntent(id)||plan)throw new RestoreCommitUncertainError('The Redis restore switch requires separate review.');
        if(record.phase==='importing')this.options.journal.advance(id,'importing','discarding_candidate');
        if(record.phase==='needs_review')this.options.db.prepare("UPDATE restore_operations SET phase='discarding_candidate',updated_at=? WHERE id=? AND service_id=? AND kind='redis' AND phase='needs_review'").run(new Date().toISOString(),id,serviceId);
        const cancelled=await cancelPreparedRestore({...this.options,serviceId,operationId:id});return {operationId:cancelled.id,phase:cancelled.phase,rolledBack:false};
      }
      return {operationId:id,phase:record.phase,rolledBack:record.phase==='cancelled'&&this.options.journal.retainedVolume(id)?.reason==='rollback_candidate'};
    });
  }
}
