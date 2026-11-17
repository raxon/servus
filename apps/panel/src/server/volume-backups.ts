import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { agentRequest as defaultAgentRequest, AgentRequestError, type AgentRequestOptions } from '../agent/client.js';
import { LocalDatabaseBackupStorage } from '../agent/backups.js';
import { readS3Backup, removeS3Backup, uploadS3Backup, validateBackupEndpoint, type S3BackupIdentity } from '../agent/s3-storage.js';
import { backupCronMatches, describeBackupCron, parseBackupCron } from '../shared/backups.js';
import { VOLUME_BACKUP_SCHEMA_SQL, type VolumeBackup, type VolumeBackupSettings, type VolumeRestore } from '../shared/volume-backups.js';
import { redactBackupDestination, s3DestinationSchema, type BackupDestination } from '../shared/storage-target.js';
import { loadBackupDestination } from './backup-providers.js';
import type { Service, SessionResponse, User } from '../shared/types.js';
import type { Store } from './store.js';
import type { MaintenanceGate } from './maintenance.js';
import { AppError } from './errors.js';

interface BackupRow {id:string;service_id:string;mount_target:string;actor_id:string;name:string;status:VolumeBackup['status'];trigger:VolumeBackup['trigger'];idempotency_key:string;request_hash:string;created_at:string;finished_at:string|null;size:number|null;sha256:string|null;error:string|null;owner_id:string|null;lease_until:string|null;destination_ref:string|null;object_key:string|null}
interface SettingsRow {service_id:string;mount_target:string;actor_id:string;enabled:number;cron:string;retention:number;last_tick:string|null;updated_at:string;destination_ref:string|null}
interface RestoreRow {id:string;backup_id:string;service_id:string;mount_target:string;actor_id:string;phase:VolumeRestore['phase'];candidate_volume:string|null;previous_volume:string|null;error:string|null;created_at:string;updated_at:string;idempotency_key:string;owner_id:string|null;lease_until:string|null}
export interface VolumeBackupOptions {
  store:Store;
  serviceAccess:(request:FastifyRequest,id:string,write?:boolean)=>{auth:SessionResponse;service:Service};
  agentConnection?:AgentRequestOptions;
  agentRequest?:typeof defaultAgentRequest;
  maintenance?:MaintenanceGate;
  now?:()=>Date;
  startScheduler?:boolean;
}
const mountSchema=z.string().min(2).max(255).startsWith('/').refine(value=>!/[\\\x00-\x1f]/.test(value)&&!value.split('/').includes('..'));
const manualSchema=z.object({mountTarget:mountSchema,name:z.string().trim().min(1).max(100).regex(/^[^\x00-\x1f\x7f]+$/).optional()}).strict();
const settingsSchema=z.object({mountTarget:mountSchema,enabled:z.boolean(),cron:z.string().trim().min(1).max(128),retention:z.number().int().min(1).max(100)}).strict();
const captureResult=z.object({phase:z.literal('completed'),size:z.number().int().min(1).max(2*1024*1024*1024),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
const restoreResult=z.object({id:z.string().uuid(),backupId:z.string().uuid(),serviceId:z.string().uuid(),mountTarget:mountSchema,phase:z.enum(['preparing','prepared','switching','completed','rolling_back','rolled_back','cancelled','failed','needs_review']),candidateVolume:z.string().regex(/^panel-volume-restore-[a-f0-9-]{36}$/).nullable(),previousVolume:z.string().max(255).nullable(),error:z.string().max(1000).nullable(),createdAt:z.string().datetime(),updatedAt:z.string().datetime()}).strict();
const activeRestore="('preparing','prepared','switching','rolling_back','needs_review')";
const leaseMs=15*60_000;
const summary=(row:BackupRow):VolumeBackup=>({id:row.id,serviceId:row.service_id,mountTarget:row.mount_target,name:row.name,status:row.status,trigger:row.trigger,createdAt:row.created_at,finishedAt:row.finished_at,size:row.size,sha256:row.sha256,error:row.error,destination:row.destination_ref?'s3':'local',deletionPending:['succeeded','failed'].includes(row.status)&&row.owner_id!==null});
const restoreSummary=(row:RestoreRow):VolumeRestore=>({id:row.id,backupId:row.backup_id,serviceId:row.service_id,mountTarget:row.mount_target,phase:row.phase,candidateVolume:row.candidate_volume,previousVolume:row.previous_volume,error:row.error,createdAt:row.created_at,updatedAt:row.updated_at});
export function writableVolumeMounts(service:Service) {return (service.kind??'app')==='app'?(service.mounts??[]).filter(mount=>mount.type==='volume'&&!mount.readOnly):[];}
function requireMount(service:Service,mountTarget:string) {
  if(!writableVolumeMounts(service).some(mount=>mount.target===mountTarget))throw new AppError('VOLUME_BACKUP_MOUNT','Select a writable named volume in this application.',400);
  if(service.deployedRevision===null)throw new AppError('VOLUME_BACKUP_NOT_DEPLOYED','Deploy the application before backing up its volume.',409);
}
function idempotency(value:unknown):string {return z.string().min(1).max(128).regex(/^[a-zA-Z0-9_.:-]+$/).parse(value);}

export class VolumeBackups {
  private readonly storage:LocalDatabaseBackupStorage;
  private readonly owner=randomUUID();
  private readonly active=new Map<string,Promise<void>>();
  private closing=false;
  private timer:ReturnType<typeof setInterval>|undefined;
  constructor(private readonly options:VolumeBackupOptions) {
    options.store.db.transaction(()=>options.store.db.exec(VOLUME_BACKUP_SCHEMA_SQL)).immediate();this.storage=new LocalDatabaseBackupStorage(options.store.dataDir,'volume-backups');
  }
  private now() {return (this.options.now??(()=>new Date()))();}
  private row(id:string) {return this.options.store.db.prepare('SELECT * FROM volume_backups WHERE id=?').get(id) as BackupRow|undefined;}
  private restoreRow(id:string) {return this.options.store.db.prepare('SELECT * FROM volume_restores WHERE id=?').get(id) as RestoreRow|undefined;}
  private setting(serviceId:string,mountTarget:string) {return this.options.store.db.prepare('SELECT * FROM volume_backup_settings WHERE service_id=? AND mount_target=?').get(serviceId,mountTarget) as SettingsRow|undefined;}
  private actor(id:string) {return this.options.store.db.prepare('SELECT id,email,role,created_at AS createdAt FROM users WHERE id=?').get(id) as User|undefined;}
  private assertAccess(serviceId:string,actorId:string) {const service=this.options.store.getService(serviceId),actor=this.actor(actorId);if(!service||!actor||!this.options.store.canAccess(actor,service.projectId,true))throw new AppError('NOT_FOUND','Application not found.',404);return {service,actor};}
  private settingsFor(serviceId:string,mountTarget:string):VolumeBackupSettings {const row=this.setting(serviceId,mountTarget),cron=row?.cron??'0 3 * * *';return {mountTarget,enabled:Boolean(row?.enabled),cron,retention:row?.retention??7,timeZone:'UTC',description:describeBackupCron(cron)};}
  settings(service:Service) {return writableVolumeMounts(service).map(mount=>this.settingsFor(service.id,mount.target));}
  saveSettings(service:Service,actor:User,input:unknown) {
    const value=settingsSchema.parse(input);requireMount(service,value.mountTarget);
    try{parseBackupCron(value.cron);}catch(error){throw new AppError('VOLUME_BACKUP_SCHEDULE',error instanceof Error?error.message:'Invalid schedule.',400);}
    const now=this.now().toISOString();
    this.options.store.db.transaction(()=>{
      this.options.store.db.prepare(`INSERT INTO volume_backup_settings (service_id,mount_target,actor_id,enabled,cron,retention,last_tick,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(service_id,mount_target) DO UPDATE SET actor_id=excluded.actor_id,enabled=excluded.enabled,cron=excluded.cron,retention=excluded.retention,last_tick=excluded.last_tick,updated_at=excluded.updated_at`).run(service.id,value.mountTarget,actor.id,value.enabled?1:0,value.cron,value.retention,now.slice(0,16),now);
      this.options.store.recordAudit(actor.id,'volume.backup.settings',service.id);
    }).immediate();return this.settingsFor(service.id,value.mountTarget);
  }
  destination(serviceId:string,mountTarget:string):BackupDestination {const reference=this.setting(serviceId,mountTarget)?.destination_ref;return reference?redactBackupDestination(loadBackupDestination(this.options.store,serviceId,reference)):{type:'local'};}
  saveDestination(service:Service,actor:User,mountTarget:string,destination:z.infer<typeof s3DestinationSchema>|{type:'local'}) {
    requireMount(service,mountTarget);const now=this.now().toISOString();
    this.options.store.db.transaction(()=>{
      const reference=destination.type==='local'?null:this.options.store.putBackupDestinationSecret(service.id,JSON.stringify({kind:'backup-storage-v1',serviceId:service.id,destination}));
      this.options.store.db.prepare(`INSERT INTO volume_backup_settings (service_id,mount_target,actor_id,enabled,cron,retention,last_tick,updated_at,destination_ref) VALUES(?,?,?,0,'0 3 * * *',7,?,?,?) ON CONFLICT(service_id,mount_target) DO UPDATE SET destination_ref=excluded.destination_ref,updated_at=excluded.updated_at`).run(service.id,mountTarget,actor.id,now.slice(0,16),now,reference);
      this.options.store.recordAudit(actor.id,'volume.backup.destination',service.id);
    }).immediate();return this.destination(service.id,mountTarget);
  }
  list(serviceId:string) {return (this.options.store.db.prepare('SELECT * FROM volume_backups WHERE service_id=? ORDER BY created_at DESC,rowid DESC LIMIT 100').all(serviceId) as BackupRow[]).map(summary);}
  restores(serviceId:string) {return (this.options.store.db.prepare('SELECT * FROM volume_restores WHERE service_id=? ORDER BY created_at DESC,rowid DESC LIMIT 100').all(serviceId) as RestoreRow[]).map(restoreSummary);}
  private idle(serviceId:string,exceptRestoreId?:string) {
    const db=this.options.store.db;
    if(db.prepare("SELECT 1 FROM jobs WHERE service_id=? AND status IN ('queued','running')").get(serviceId)||db.prepare("SELECT 1 FROM volume_backups WHERE service_id=? AND status IN ('queued','running')").get(serviceId)||db.prepare(`SELECT 1 FROM volume_restores WHERE service_id=? AND phase IN ${activeRestore} ${exceptRestoreId?'AND id<>?':''}`).get(...[serviceId,exceptRestoreId].filter(value=>value!==undefined)))throw new AppError('VOLUME_BACKUP_BUSY','Another application or volume operation must finish first.',409);
  }
  private enqueue(service:Service,actor:User,input:z.infer<typeof manualSchema>,key:string,trigger:VolumeBackup['trigger']) {
    requireMount(service,input.mountTarget);const hash=createHash('sha256').update(JSON.stringify(input)).digest('hex'),db=this.options.store.db;
    return db.transaction(()=>{
      const existing=db.prepare('SELECT * FROM volume_backups WHERE actor_id=? AND service_id=? AND idempotency_key=?').get(actor.id,service.id,key) as BackupRow|undefined;
      if(existing){if(existing.request_hash!==hash)throw new AppError('IDEMPOTENCY_CONFLICT','This key was used for a different volume backup.',409);return summary(existing);}
      this.idle(service.id);
      const id=randomUUID(),timestamp=this.now().toISOString(),reference=this.setting(service.id,input.mountTarget)?.destination_ref??null,destination=reference?loadBackupDestination(this.options.store,service.id,reference):null;
      const objectKey=destination?`${destination.prefix?destination.prefix+'/':''}servus-volumes/${service.id}/${id}.tar`:null;
      db.prepare("INSERT INTO volume_backups(id,service_id,mount_target,actor_id,name,status,trigger,idempotency_key,request_hash,created_at,destination_ref,object_key) VALUES(?,?,?,?,?,'queued',?,?,?,?,?,?)").run(id,service.id,input.mountTarget,actor.id,input.name??`Volume backup ${timestamp}`,trigger,key,hash,timestamp,reference,objectKey);
      this.options.store.recordAudit(actor.id,'volume.backup.queued',service.id);return summary(this.row(id)!);
    }).immediate();
  }
  create(service:Service,actor:User,input:unknown,key:unknown) {const result=this.enqueue(service,actor,manualSchema.parse(input),`manual:${idempotency(key)}`,'manual');this.tick();return result;}
  private remote(row:BackupRow):S3BackupIdentity {if(!row.object_key||!row.size||!row.sha256)throw new Error('Volume backup metadata is incomplete.');return {serviceId:row.service_id,backupId:row.id,objectKey:row.object_key,size:row.size,sha256:row.sha256,scope:'volume'};}
  private async discard(row:BackupRow) {if(row.destination_ref&&row.size&&row.sha256&&row.object_key)await removeS3Backup(loadBackupDestination(this.options.store,row.service_id,row.destination_ref),this.remote(row));this.storage.remove(row.id,'tar');this.storage.remove(row.id,'partial');}
  private request<T>(path:string,input:unknown) {return (this.options.agentRequest??defaultAgentRequest)<T>(path,input,{...this.options.agentConnection,timeoutMs:14*60_000});}
  private ownsBackup(id:string) {return Boolean(this.options.store.db.prepare("SELECT 1 FROM volume_backups WHERE id=? AND status='running' AND owner_id=? AND lease_until>?").get(id,this.owner,this.now().toISOString()));}
  private ownsRestore(id:string) {return Boolean(this.options.store.db.prepare('SELECT 1 FROM volume_restores WHERE id=? AND owner_id=? AND lease_until>?').get(id,this.owner,this.now().toISOString()));}
  private async runBackup(row:BackupRow) {
    const {store,maintenance}=this.options,release=maintenance?.admit();if(maintenance&&!release)return;
    const heartbeat=setInterval(()=>store.db.prepare("UPDATE volume_backups SET lease_until=? WHERE id=? AND status='running' AND owner_id=? AND lease_until>?").run(new Date(this.now().getTime()+leaseMs).toISOString(),row.id,this.owner,this.now().toISOString()),30_000);heartbeat.unref();
    try {
      const {service,actor}=this.assertAccess(row.service_id,row.actor_id);requireMount(service,row.mount_target);
      const result=captureResult.parse(await this.request('/volume-backups/capture',{serviceId:row.service_id,operationId:row.id,mountTarget:row.mount_target}));
      if(!this.ownsBackup(row.id))return;
      store.db.prepare("UPDATE volume_backups SET size=?,sha256=? WHERE id=? AND status='running' AND owner_id=? AND lease_until>?").run(result.size,result.sha256,row.id,this.owner,this.now().toISOString());
      if(row.destination_ref) {
        const current=this.row(row.id)!,destination=loadBackupDestination(store,row.service_id,row.destination_ref);
        if(!this.ownsBackup(row.id))return;
        try{await uploadS3Backup(destination,this.remote(current),this.storage.read(row.id,'tar',result.size,result.sha256));}
        catch(error){try{const verified=await readS3Backup(destination,this.remote(current));for await(const _chunk of verified){/* Verify a previous conditional upload after retry. */}}catch{throw error;}}
      }
      const completed=store.db.transaction(()=>{const changed=store.db.prepare("UPDATE volume_backups SET status='succeeded',finished_at=?,error=NULL,owner_id=NULL,lease_until=NULL WHERE id=? AND status='running' AND owner_id=? AND lease_until>?").run(this.now().toISOString(),row.id,this.owner,this.now().toISOString()).changes;if(changed)store.recordAudit(actor.id,'volume.backup.completed',service.id);return changed===1;}).immediate();if(!completed)return;
      if(row.destination_ref)try{this.storage.remove(row.id,'tar');}catch{store.db.prepare('UPDATE volume_backups SET error=? WHERE id=?').run('Remote backup completed, but its local staging file could not be removed.',row.id);}
      await this.retain(row.service_id,row.mount_target,row.id);
    } catch(error) {
      if(!this.ownsBackup(row.id))return;
      if(error instanceof AgentRequestError&&error.certainty==='uncertain')store.db.prepare("UPDATE volume_backups SET owner_id=NULL,lease_until=?,error=? WHERE id=? AND status='running' AND owner_id=? AND lease_until>?").run(new Date(this.now().getTime()+5000).toISOString(),'The agent outcome is pending. Recovery will retry this operation.',row.id,this.owner,this.now().toISOString());
      else store.db.prepare("UPDATE volume_backups SET status='failed',finished_at=?,error=?,owner_id=NULL,lease_until=NULL WHERE id=? AND status='running' AND owner_id=? AND lease_until>?").run(this.now().toISOString(),error instanceof AgentRequestError&&error.code==='VOLUME_RECOVERY_REQUIRED'?'Application recovery is required before further operations.':'The volume backup failed. The original data was retained. Check application recovery and storage before retrying.',row.id,this.owner,this.now().toISOString());
    } finally {clearInterval(heartbeat);release?.();}
  }
  private async retain(serviceId:string,mountTarget:string,currentId:string) {
    const db=this.options.store.db,rows=db.prepare("SELECT * FROM volume_backups WHERE service_id=? AND mount_target=? AND status='succeeded' ORDER BY created_at DESC,rowid DESC LIMIT -1 OFFSET ?").all(serviceId,mountTarget,this.settingsFor(serviceId,mountTarget).retention) as BackupRow[];
    for(const row of rows){try{await this.deleteArchive(serviceId,row.id);}catch{db.prepare('UPDATE volume_backups SET error=? WHERE id=?').run('Backup completed, but older archives could not be removed. Check backup storage permissions.',currentId);}}
  }
  private schedule(now:Date) {
    const db=this.options.store.db,minute=now.toISOString().slice(0,16);
    for(const row of db.prepare('SELECT * FROM volume_backup_settings WHERE enabled=1').all() as SettingsRow[]) {
      db.transaction(()=>{
        const current=this.setting(row.service_id,row.mount_target);if(!current?.enabled||current.last_tick===minute)return;
        db.prepare('UPDATE volume_backup_settings SET last_tick=? WHERE service_id=? AND mount_target=?').run(minute,row.service_id,row.mount_target);
        try{const {service,actor}=this.assertAccess(row.service_id,row.actor_id);requireMount(service,row.mount_target);if(backupCronMatches(current.cron,now))this.enqueue(service,actor,{mountTarget:row.mount_target,name:`Scheduled volume backup ${minute} UTC`},`scheduled:${row.mount_target}:${minute}`,'scheduled');}
        catch(error){if(error instanceof AppError&&error.code==='VOLUME_BACKUP_BUSY')return;db.prepare('UPDATE volume_backup_settings SET enabled=0,updated_at=? WHERE service_id=? AND mount_target=?').run(now.toISOString(),row.service_id,row.mount_target);}
      }).immediate();
    }
  }
  tick() {
    if(this.closing||this.options.maintenance?.isDraining||this.active.size)return;
    const release=this.options.maintenance?.admit();if(this.options.maintenance&&!release)return;
    try {
      const db=this.options.store.db,now=this.now();this.schedule(now);
      const restore=db.transaction(()=>{const row=db.prepare("SELECT * FROM volume_restores WHERE phase IN ('preparing','switching','rolling_back') AND (lease_until IS NULL OR lease_until<=?) ORDER BY created_at,rowid LIMIT 1").get(now.toISOString()) as RestoreRow|undefined;if(!row)return;db.prepare('UPDATE volume_restores SET owner_id=?,lease_until=? WHERE id=?').run(this.owner,new Date(now.getTime()+leaseMs).toISOString(),row.id);return this.restoreRow(row.id);}).immediate();
      if(restore){const pending=this.runRestore(restore).finally(()=>this.active.delete(restore.id));this.active.set(restore.id,pending);void pending.catch(()=>this.options.maintenance?.markUncertain('handler'));return;}
      const backup=db.transaction(()=>{const row=db.prepare("SELECT * FROM volume_backups WHERE status='queued' OR(status='running' AND lease_until<=?) ORDER BY created_at,rowid LIMIT 1").get(now.toISOString()) as BackupRow|undefined;if(!row)return;db.prepare("UPDATE volume_backups SET status='running',owner_id=?,lease_until=? WHERE id=?").run(this.owner,new Date(now.getTime()+leaseMs).toISOString(),row.id);return this.row(row.id);}).immediate();
      if(backup){const pending=this.runBackup(backup).finally(()=>this.active.delete(backup.id));this.active.set(backup.id,pending);void pending.catch(()=>this.options.maintenance?.markUncertain('handler'));}
    } finally {release?.();}
  }
  prepareRestore(service:Service,actor:User,backupId:string,key:unknown) {
    const backup=this.row(z.string().uuid().parse(backupId));if(!backup||backup.service_id!==service.id||backup.status!=='succeeded')throw new AppError('VOLUME_BACKUP_NOT_FOUND','Completed volume backup not found.',404);requireMount(service,backup.mount_target);
    const idempotencyKey=idempotency(key),db=this.options.store.db;
    const result=db.transaction(()=>{
      const available=this.row(backupId);if(!available||available.status!=='succeeded'||available.owner_id)throw new AppError('VOLUME_BACKUP_BUSY','This archive is being deleted and cannot be restored. Retry its deletion before using another backup.',409);
      const duplicate=db.prepare('SELECT * FROM volume_restores WHERE actor_id=? AND service_id=? AND idempotency_key=?').get(actor.id,service.id,idempotencyKey) as RestoreRow|undefined;if(duplicate){if(duplicate.backup_id!==backupId)throw new AppError('IDEMPOTENCY_CONFLICT','This key was used for a different volume restore.',409);return restoreSummary(duplicate);}
      this.idle(service.id);const id=randomUUID(),now=this.now().toISOString();db.prepare("INSERT INTO volume_restores(id,backup_id,service_id,mount_target,actor_id,phase,created_at,updated_at,idempotency_key) VALUES(?,?,?,?,?,'preparing',?,?,?)").run(id,backup.id,service.id,backup.mount_target,actor.id,now,now,idempotencyKey);this.options.store.recordAudit(actor.id,'volume.restore.prepare',service.id);return restoreSummary(this.restoreRow(id)!);
    }).immediate();this.tick();return result;
  }
  private async runRestore(row:RestoreRow) {
    const {store,maintenance}=this.options,release=maintenance?.admit();if(maintenance&&!release)return;
    const heartbeat=setInterval(()=>store.db.prepare('UPDATE volume_restores SET lease_until=? WHERE id=? AND phase=? AND owner_id=? AND lease_until>?').run(new Date(this.now().getTime()+leaseMs).toISOString(),row.id,row.phase,this.owner,this.now().toISOString()),30_000);heartbeat.unref();
    try {
      const {service}=this.assertAccess(row.service_id,row.actor_id);requireMount(service,row.mount_target);
      if(row.phase==='preparing') {
        const backup=this.row(row.backup_id);if(!backup||backup.status!=='succeeded'||!backup.size||!backup.sha256)throw new Error('Volume backup unavailable.');
        if(backup.destination_ref) {
          let present=false;
          try{const local=this.storage.read(backup.id,'tar',backup.size,backup.sha256);for await(const _chunk of local){/* Verify an existing staged copy. */}present=true;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
          if(!present){const stream=await readS3Backup(loadBackupDestination(store,row.service_id,backup.destination_ref),this.remote(backup));await this.storage.capture(backup.id,'tar',stream,backup.size);}
        }
      }
      if(!this.ownsRestore(row.id))return;
      const path=row.phase==='preparing'?'/volume-restores/prepare':row.phase==='rolling_back'?'/volume-restores/rollback':'/volume-restores/commit';
      const result=restoreResult.parse(await this.request(path,{serviceId:row.service_id,operationId:row.id,...(row.phase==='preparing'?{backupId:row.backup_id}:{})}));
      if(!this.ownsRestore(row.id))return;
      if(result.id!==row.id||result.serviceId!==row.service_id||result.backupId!==row.backup_id||result.mountTarget!==row.mount_target)throw new Error('Agent restore identity mismatch.');
      store.db.transaction(()=>{const changed=store.db.prepare('UPDATE volume_restores SET phase=?,candidate_volume=?,previous_volume=?,error=?,updated_at=?,owner_id=NULL,lease_until=NULL WHERE id=? AND phase=? AND owner_id=? AND lease_until>?').run(result.phase,result.candidateVolume,result.previousVolume,result.error,this.now().toISOString(),row.id,row.phase,this.owner,this.now().toISOString()).changes;if(changed)store.recordAudit(row.actor_id,`volume.restore.${result.phase}`,row.service_id);}).immediate();
    } catch(error) {
      if(!this.ownsRestore(row.id))return;
      if(error instanceof AgentRequestError&&error.certainty==='uncertain')store.db.prepare('UPDATE volume_restores SET owner_id=NULL,lease_until=?,error=?,updated_at=? WHERE id=? AND phase=? AND owner_id=? AND lease_until>?').run(new Date(this.now().getTime()+5000).toISOString(),'The agent outcome is pending. Recovery will retry this operation.',this.now().toISOString(),row.id,row.phase,this.owner,this.now().toISOString());
      else store.db.prepare('UPDATE volume_restores SET phase=?,error=?,updated_at=?,owner_id=NULL,lease_until=NULL WHERE id=? AND phase=? AND owner_id=? AND lease_until>?').run(error instanceof AgentRequestError&&error.code==='VOLUME_RECOVERY_REQUIRED'?'needs_review':'failed','Volume restore could not finish. Both original and candidate data were retained when present.',this.now().toISOString(),row.id,row.phase,this.owner,this.now().toISOString());
    } finally {clearInterval(heartbeat);release?.();}
  }
  action(service:Service,actor:User,restoreId:string,action:'commit'|'rollback') {
    const db=this.options.store.db,id=z.string().uuid().parse(restoreId);
    const result=db.transaction(()=>{
      const row=this.restoreRow(id);if(!row||row.service_id!==service.id)throw new AppError('NOT_FOUND','Volume restore not found.',404);
      if(action==='commit'&&row.phase==='completed'||action==='rollback'&&row.phase==='rolled_back')return restoreSummary(row);
      if(action==='commit'&&row.phase==='switching'||action==='rollback'&&row.phase==='rolling_back')return restoreSummary(row);
      if(row.owner_id&&row.lease_until&&row.lease_until>this.now().toISOString())throw new AppError('VOLUME_RESTORE_BUSY','Another restore operation is still running.',409);
      if(action==='commit'&&row.phase!=='prepared'||action==='rollback'&&!['completed','needs_review'].includes(row.phase))throw new AppError('VOLUME_RESTORE_PHASE','This volume restore is not ready for that operation.',409);
      this.idle(service.id,row.id);db.prepare('UPDATE volume_restores SET phase=?,actor_id=?,owner_id=NULL,lease_until=NULL,error=NULL,updated_at=? WHERE id=?').run(action==='commit'?'switching':'rolling_back',actor.id,this.now().toISOString(),row.id);this.options.store.recordAudit(actor.id,`volume.restore.${action}`,service.id);return restoreSummary(this.restoreRow(id)!);
    }).immediate();this.tick();return result;
  }
  async cancel(service:Service,actor:User,id:string) {
    z.string().uuid().parse(id);const db=this.options.store.db,cancelOwner=randomUUID();
    const row=db.transaction(()=>{
      const current=this.restoreRow(id);if(!current||current.service_id!==service.id)throw new AppError('NOT_FOUND','Volume restore not found.',404);
      if(current.phase==='cancelled')return current;
      if(!['prepared','failed'].includes(current.phase))throw new AppError('VOLUME_RESTORE_PHASE','Wait for preparation before cancelling this restore.',409);
      if(current.owner_id&&current.lease_until&&current.lease_until>this.now().toISOString())throw new AppError('VOLUME_RESTORE_BUSY','Another restore operation is still running.',409);
      db.prepare('UPDATE volume_restores SET owner_id=?,lease_until=? WHERE id=?').run(cancelOwner,new Date(this.now().getTime()+leaseMs).toISOString(),id);return current;
    }).immediate();
    if(row.phase==='cancelled')return restoreSummary(row);
    try {
      const result=restoreResult.parse(await this.request('/volume-restores/cancel',{serviceId:service.id,operationId:id}));
      if(result.id!==id||result.serviceId!==service.id||result.backupId!==row.backup_id||result.phase!=='cancelled')throw new AppError('VOLUME_RESTORE_RESPONSE','The cancellation outcome could not be verified.',503);
      return db.transaction(()=>{
        const changed=db.prepare("UPDATE volume_restores SET phase='cancelled',updated_at=?,error=NULL,owner_id=NULL,lease_until=NULL WHERE id=? AND phase=? AND owner_id=? AND lease_until>?").run(this.now().toISOString(),id,row.phase,cancelOwner,this.now().toISOString()).changes;
        if(changed!==1)throw new AppError('VOLUME_RESTORE_RESPONSE','The cancellation outcome requires reconciliation.',503);
        this.options.store.recordAudit(actor.id,'volume.restore.cancelled',service.id);return restoreSummary(this.restoreRow(id)!);
      }).immediate();
    } catch(error) {
      if(error instanceof AgentRequestError&&error.certainty==='definitive')db.prepare('UPDATE volume_restores SET owner_id=NULL,lease_until=NULL WHERE id=? AND phase=? AND owner_id=?').run(id,row.phase,cancelOwner);
      throw error;
    }
  }
  async read(serviceId:string,id:string) {
    const row=z.string().uuid().safeParse(id).success?this.row(id):undefined;if(!row||row.service_id!==serviceId||row.status!=='succeeded'||!row.size||!row.sha256)throw new AppError('VOLUME_BACKUP_NOT_FOUND','Volume backup not found.',404);
    if(row.owner_id)throw new AppError('VOLUME_BACKUP_BUSY','This archive is being deleted and cannot be downloaded.',409);
    try{const stream=row.destination_ref?await readS3Backup(loadBackupDestination(this.options.store,serviceId,row.destination_ref),this.remote(row)):this.storage.read(row.id,'tar',row.size,row.sha256),current=this.row(id);if(!current||current.status!=='succeeded'||current.owner_id){stream.destroy();throw new Error('Archive deletion began during storage lookup.');}return {backup:summary(row),stream};}catch{throw new AppError('VOLUME_BACKUP_UNAVAILABLE','The volume archive could not be verified.',409);}
  }
  private async deleteArchive(serviceId:string,id:string) {
    const db=this.options.store.db,deletionOwner=randomUUID(),row=db.transaction(()=>{
      const current=this.row(id);if(!current||current.service_id!==serviceId)throw new AppError('VOLUME_BACKUP_NOT_FOUND','Volume backup not found.',404);
      if(current.status==='deleted')return current;
      if(['queued','running'].includes(current.status)||current.owner_id&&current.lease_until&&current.lease_until>this.now().toISOString()||db.prepare(`SELECT 1 FROM volume_restores WHERE backup_id=? AND phase IN ${activeRestore}`).get(id))throw new AppError('VOLUME_BACKUP_BUSY','An active backup, restore or deletion must finish first.',409);
      db.prepare('UPDATE volume_backups SET owner_id=?,lease_until=?,error=? WHERE id=?').run(deletionOwner,new Date(this.now().getTime()+leaseMs).toISOString(),'Archive deletion is pending. Restore remains disabled until deletion completes.',id);return current;
    }).immediate();
    if(row.status==='deleted')return;
    try {
      await this.discard(row);
      const changed=db.prepare("UPDATE volume_backups SET status='deleted',owner_id=NULL,lease_until=NULL,error=NULL WHERE id=? AND owner_id=? AND status=?").run(id,deletionOwner,row.status).changes;
      if(changed!==1)throw new AppError('VOLUME_BACKUP_DELETE_PENDING','Archive deletion requires reconciliation. Retry deletion after the current operation finishes.',503);
    } catch(error) {
      // Preserve intent even when the lease expires: an interrupted remote delete
      // may already have removed bytes. Only another deletion may reclaim it.
      db.prepare('UPDATE volume_backups SET lease_until=?,error=? WHERE id=? AND owner_id=?').run(this.now().toISOString(),'Archive deletion did not finish. Retry deletion; restoring this archive remains disabled.',id,deletionOwner);
      throw error;
    }
  }
  async remove(service:Service,actor:User,id:string) {
    await this.deleteArchive(service.id,z.string().uuid().parse(id));this.options.store.recordAudit(actor.id,'volume.backup.deleted',service.id);
  }
  async recover(service:Service,id:string) {
    const row=this.row(z.string().uuid().parse(id));if(!row||row.service_id!==service.id)throw new AppError('VOLUME_BACKUP_NOT_FOUND','Volume backup not found.',404);
    const result=z.object({phase:z.enum(['completed','failed'])}).strict().parse(await this.request('/volume-backups/recover',{serviceId:service.id,operationId:row.id}));
    this.options.store.db.transaction(()=>{
      const current=this.row(id);if(!current||current.service_id!==service.id)return;
      if(current.status==='failed'&&!current.owner_id)this.options.store.db.prepare("UPDATE volume_backups SET error=? WHERE id=? AND status='failed' AND owner_id IS NULL").run('Backup was interrupted; application replicas recovered. Create a new backup.',id);
      else if(current.status==='running'&&(!current.lease_until||current.lease_until<=this.now().toISOString())) {
        if(result.phase==='failed')this.options.store.db.prepare("UPDATE volume_backups SET status='failed',error=?,finished_at=?,owner_id=NULL,lease_until=NULL WHERE id=? AND status='running' AND (lease_until IS NULL OR lease_until<=?)").run('Backup was interrupted; application replicas recovered. Create a new backup.',this.now().toISOString(),id,this.now().toISOString());
        else this.options.store.db.prepare("UPDATE volume_backups SET error=?,owner_id=NULL,lease_until=? WHERE id=? AND status='running' AND (lease_until IS NULL OR lease_until<=?)").run('Application replicas recovered. Backup finalization is pending.',this.now().toISOString(),id,this.now().toISOString());
      }
    }).immediate();this.tick();return result;
  }
  start() {if(this.timer||this.closing)return;this.tick();this.timer=setInterval(()=>{try{this.tick();}catch{this.options.maintenance?.markUncertain('handler');}},5000);this.timer.unref();}
  async drain() {await Promise.allSettled([...this.active.values()]);}
  async close() {this.closing=true;if(this.timer)clearInterval(this.timer);await this.drain();}
}

export function registerVolumeBackups(app:FastifyInstance,options:VolumeBackupOptions) {
  const manager=new VolumeBackups(options),prefix='/api/v1/services/:id';
  app.get<{Params:{id:string}}>(`${prefix}/volume-backups`,async request=>{options.serviceAccess(request,request.params.id);return {backups:manager.list(request.params.id)};});
  app.post<{Params:{id:string}}>(`${prefix}/volume-backups`,async(request,reply)=>{const {service,auth}=options.serviceAccess(request,request.params.id,true);return reply.code(202).send({backup:manager.create(service,auth.user,request.body,request.headers['idempotency-key'])});});
  app.get<{Params:{id:string}}>(`${prefix}/volume-backup-settings`,async request=>{const {service}=options.serviceAccess(request,request.params.id);return {settings:manager.settings(service)};});
  app.put<{Params:{id:string}}>(`${prefix}/volume-backup-settings`,async request=>{const {service,auth}=options.serviceAccess(request,request.params.id,true);return {settings:manager.saveSettings(service,auth.user,request.body)};});
  app.get<{Params:{id:string};Querystring:{mountTarget?:string}}>(`${prefix}/volume-backup-destination`,async request=>{const {service}=options.serviceAccess(request,request.params.id),mountTarget=mountSchema.parse(request.query.mountTarget);requireMount(service,mountTarget);return {destination:manager.destination(service.id,mountTarget)};});
  app.put<{Params:{id:string}}>(`${prefix}/volume-backup-destination`,async request=>{
    let access=options.serviceAccess(request,request.params.id,true);
    const input=z.object({mountTarget:mountSchema,destination:z.discriminatedUnion('type',[z.object({type:z.literal('local')}).strict(),s3DestinationSchema])}).strict().parse(request.body);requireMount(access.service,input.mountTarget);
    if(input.destination.type==='s3')try{await validateBackupEndpoint(input.destination);}catch(error){throw new AppError('VOLUME_BACKUP_ENDPOINT',error instanceof Error?error.message:'Invalid backup endpoint.',400);}
    access=options.serviceAccess(request,request.params.id,true);return {destination:manager.saveDestination(access.service,access.auth.user,input.mountTarget,input.destination)};
  });
  app.get<{Params:{id:string;backupId:string}}>(`${prefix}/volume-backups/:backupId/download`,async(request,reply)=>{const {service,auth}=options.serviceAccess(request,request.params.id);if(!options.store.canAccess(auth.user,service.projectId,true))throw new AppError('NOT_FOUND','Volume backup not found.',404);const {backup,stream}=await manager.read(service.id,request.params.backupId);try{const latest=options.serviceAccess(request,request.params.id);if(!options.store.canAccess(latest.auth.user,latest.service.projectId,true))throw new AppError('NOT_FOUND','Volume backup not found.',404);}catch(error){stream.destroy();throw error;}options.store.recordAudit(auth.user.id,'volume.backup.download',service.id);reply.header('Content-Type','application/octet-stream').header('Content-Length',backup.size!).header('X-Backup-SHA256',backup.sha256!).header('Content-Disposition',`attachment; filename="servus-volume-${backup.id}.tar"`);reply.raw.once('close',()=>stream.destroy());return reply.send(stream);});
  app.delete<{Params:{id:string;backupId:string}}>(`${prefix}/volume-backups/:backupId`,async request=>{const {service,auth}=options.serviceAccess(request,request.params.id,true);await manager.remove(service,auth.user,request.params.backupId);return {success:true};});
  app.post<{Params:{id:string;backupId:string}}>(`${prefix}/volume-backups/:backupId/restore`,async(request,reply)=>{const {service,auth}=options.serviceAccess(request,request.params.id,true);z.object({}).strict().parse(request.body??{});return reply.code(202).send({restore:manager.prepareRestore(service,auth.user,request.params.backupId,request.headers['idempotency-key'])});});
  app.post<{Params:{id:string;backupId:string}}>(`${prefix}/volume-backups/:backupId/recover`,async request=>{const {service}=options.serviceAccess(request,request.params.id,true);z.object({}).strict().parse(request.body??{});return manager.recover(service,request.params.backupId);});
  app.get<{Params:{id:string}}>(`${prefix}/volume-restores`,async request=>{options.serviceAccess(request,request.params.id);return {restores:manager.restores(request.params.id)};});
  for(const action of ['commit','rollback'] as const)app.post<{Params:{id:string;restoreId:string}}>(`${prefix}/volume-restores/:restoreId/${action}`,async(request,reply)=>{const {service,auth}=options.serviceAccess(request,request.params.id,true);z.object({confirm:z.literal(true)}).strict().parse(request.body);return reply.code(202).send({restore:manager.action(service,auth.user,request.params.restoreId,action)});});
  app.post<{Params:{id:string;restoreId:string}}>(`${prefix}/volume-restores/:restoreId/cancel`,async request=>{const {service,auth}=options.serviceAccess(request,request.params.id,true);z.object({}).strict().parse(request.body??{});return {restore:await manager.cancel(service,auth.user,request.params.restoreId)};});
  if(options.startScheduler!==false)app.addHook('onReady',async()=>manager.start());app.addHook('onClose',async()=>manager.close());return manager;
}
