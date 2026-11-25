import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createHash, randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { z } from 'zod';
import { agentDatabaseExport, AgentRequestError, type AgentRequestOptions } from '../agent/client.js';
import { LocalDatabaseBackupStorage, type BackupExtension } from '../agent/backups.js';
import { backupCronMatches, describeBackupCron, parseBackupCron, expiredDatabaseBackups, type DatabaseBackup, type DatabaseBackupSettings } from '../shared/backups.js';
import type { Service, SessionResponse, User } from '../shared/types.js';
import { AppError } from './errors.js';
import type { MaintenanceGate } from './maintenance.js';
import type { Store } from './store.js';
import { loadBackupDestination, registerBackupProviders } from './backup-providers.js';
import { backupEncryptionOverhead, encryptDatabaseBackup, decryptDatabaseBackup } from './backup-encryption.js';
import { readS3Backup, removeS3Backup, uploadS3Backup } from '../agent/s3-storage.js';

interface BackupRow {
  id:string; service_id:string; actor_id:string; name:string; status:DatabaseBackup['status']; trigger:DatabaseBackup['trigger'];
  idempotency_key:string; request_hash:string; created_at:string; finished_at:string|null; size:number|null; sha256:string|null;
  extension:BackupExtension|null; error:string|null; owner_id:string|null; lease_until:string|null; destination_ref:string|null; object_key:string|null; encrypted:number; plaintext_size:number|null;
}
interface SettingsRow {service_id:string; actor_id:string; enabled:number; cron:string; retention:number; last_tick:string|null; updated_at:string;destination_ref:string|null;encrypted:number;retention_policy:string|null}
export interface BackupOptions {
  store: Store;
  session?:(req:FastifyRequest,mutation?:boolean)=>SessionResponse;
  serviceAccess:(req:FastifyRequest,id:string,write?:boolean)=>{auth:SessionResponse;service:Service};
  agentConnection?: AgentRequestOptions;
  databaseExport?: typeof agentDatabaseExport;
  maintenance?: MaintenanceGate;
  now?:()=>Date;
  startScheduler?:boolean;
}
const retentionPolicySchema=z.discriminatedUnion('mode',[z.object({mode:z.literal('count')}).strict(),z.object({mode:z.literal('age'),days:z.number().int().min(1).max(3650)}).strict(),z.object({mode:z.literal('gfs'),hourly:z.number().int().min(0).max(168).default(0),yearly:z.number().int().min(0).max(10).default(0),daily:z.number().int().min(1).max(365),weekly:z.number().int().min(0).max(52),monthly:z.number().int().min(0).max(120)}).strict()]);
const settingsSchema = z.object({enabled:z.boolean(),cron:z.string().trim().min(1).max(128),retention:z.number().int().min(1).max(100),encrypted:z.boolean().optional(),retentionPolicy:retentionPolicySchema.optional()}).strict();
const nameSchema = z.object({name:z.string().trim().min(1).max(100).regex(/^[^\x00-\x1f\x7f]+$/).optional()}).strict();
const leaseMs = 15 * 60_000;
const toBackup = (row:BackupRow):DatabaseBackup => ({id:row.id,serviceId:row.service_id,name:row.name,status:row.status,trigger:row.trigger,createdAt:row.created_at,finishedAt:row.finished_at,size:row.size,sha256:row.sha256,extension:row.extension,error:row.error,destination:row.destination_ref?'s3':'local',encrypted:Boolean(row.encrypted)});

function requireDatabase(service:Service) {
  if (!['postgres','mariadb','redis','mysql','mongodb'].includes(service.kind ?? '')) throw new AppError('BACKUP_DATABASE_REQUIRED','Backups are available for managed databases.',400);
  if (service.deployedRevision === null) throw new AppError('BACKUP_DATABASE_NOT_DEPLOYED','Deploy the database before creating a backup.',409);
}

/** Durable local application database backups, separate from installation snapshots. */
export class DatabaseBackups {
  private readonly storage:LocalDatabaseBackupStorage;
  private readonly owner = randomUUID();
  private readonly active = new Map<string,{promise:Promise<void>;controller:AbortController}>();
  private timer:ReturnType<typeof setInterval>|undefined;
  private closing = false;
  constructor(private readonly options:BackupOptions) {
    this.storage = new LocalDatabaseBackupStorage(options.store.dataDir);
  }
  private now() {return (this.options.now ?? (()=>new Date()))();}
  private row(id:string) {return this.options.store.db.prepare('SELECT * FROM database_backups WHERE id=?').get(id) as BackupRow|undefined;}
  private settingsRow(serviceId:string) {return this.options.store.db.prepare('SELECT * FROM database_backup_settings WHERE service_id=?').get(serviceId) as SettingsRow|undefined;}
  settings(serviceId:string):DatabaseBackupSettings {
    const value=this.settingsRow(serviceId);
    const cron=value?.cron ?? '0 2 * * *';
    return {enabled:Boolean(value?.enabled),cron,retention:value?.retention ?? 7,timeZone:'UTC',description:describeBackupCron(cron),encrypted:Boolean(value?.encrypted),retentionPolicy:value?.retention_policy?retentionPolicySchema.parse(JSON.parse(value.retention_policy)):{mode:'count'}};
  }
  saveSettings(service:Service,actor:User,input:unknown) {
    requireDatabase(service);
    const value=settingsSchema.parse(input);
    try {parseBackupCron(value.cron);} catch (error) {throw new AppError('BACKUP_SCHEDULE',error instanceof Error ? error.message : 'Invalid backup schedule.',400);}
    const now=this.now().toISOString();
    this.options.store.db.transaction(()=>{
      this.options.store.db.prepare(`INSERT INTO database_backup_settings (service_id,actor_id,enabled,cron,retention,last_tick,updated_at) VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(service_id) DO UPDATE SET actor_id=excluded.actor_id,enabled=excluded.enabled,cron=excluded.cron,retention=excluded.retention,last_tick=excluded.last_tick,updated_at=excluded.updated_at`)
        .run(service.id,actor.id,value.enabled?1:0,value.cron,value.retention,now.slice(0,16),now);
      this.options.store.db.prepare('UPDATE database_backup_settings SET encrypted=?,retention_policy=? WHERE service_id=?').run(value.encrypted===undefined?(this.settingsRow(service.id)?.encrypted??0):value.encrypted?1:0,JSON.stringify(value.retentionPolicy??this.settings(service.id).retentionPolicy),service.id);
      this.options.store.recordAudit(actor.id,'database.backup.settings',service.id);
    }).immediate();
    return this.settings(service.id);
  }
  list(serviceId:string) {return (this.options.store.db.prepare('SELECT * FROM database_backups WHERE service_id=? ORDER BY created_at DESC,id DESC LIMIT 100').all(serviceId) as BackupRow[]).map(toBackup);}
  private enqueue(service:Service,actor:User,input:unknown,key:string,trigger:DatabaseBackup['trigger']) {
    requireDatabase(service);
    const value=nameSchema.parse(input);
    const hash=createHash('sha256').update(JSON.stringify({serviceId:service.id,name:value.name??null})).digest('hex');
    return this.options.store.db.transaction(()=>{
      const existing=this.options.store.db.prepare('SELECT * FROM database_backups WHERE actor_id=? AND service_id=? AND idempotency_key=?').get(actor.id,service.id,key) as BackupRow|undefined;
      if(existing) {
        if(existing.request_hash!==hash)throw new AppError('IDEMPOTENCY_CONFLICT','This idempotency key was already used for a different backup.',409);
        return toBackup(existing);
      }
      if(this.options.store.db.prepare("SELECT 1 FROM database_backups WHERE service_id=? AND status IN ('queued','running')").get(service.id)) throw new AppError('BACKUP_BUSY','A database backup is already queued or running.',409);
      const id=randomUUID(),now=this.now().toISOString(),name=value.name ?? `Backup ${now}`,reference=this.settingsRow(service.id)?.destination_ref??null;
      const destination=reference?loadBackupDestination(this.options.store,service.id,reference):null;
      const extension={postgres:'dump',mariadb:'sql',mysql:'sql',redis:'rdb',mongodb:'archive'}[service.kind as 'postgres'|'mariadb'|'mysql'|'redis'|'mongodb'];
      const objectKey=destination?`${destination.prefix?`${destination.prefix}/`:''}servus/${service.id}/${id}.${extension}`:null;
      this.options.store.db.prepare(`INSERT INTO database_backups (id,service_id,actor_id,name,status,trigger,idempotency_key,request_hash,created_at,destination_ref,object_key) VALUES (?,?,?,?,'queued',?,?,?,?,?,?)`)
        .run(id,service.id,actor.id,name,trigger,key,hash,now,reference,objectKey);
      this.options.store.db.prepare('UPDATE database_backups SET encrypted=? WHERE id=?').run(this.settingsRow(service.id)?.encrypted??0,id);
      this.options.store.recordAudit(actor.id,'database.backup.queued',service.id);
      return toBackup(this.row(id)!);
    }).immediate();
  }
  create(service:Service,actor:User,input:unknown,key:unknown) {
    if(typeof key!=='string'||!/^[a-zA-Z0-9_-][a-zA-Z0-9_.:-]{0,127}$/.test(key))throw new AppError('IDEMPOTENCY_REQUIRED','Send an Idempotency-Key of 1-128 letters, numbers, dots, colons, underscores or hyphens.',400);
    const result=this.enqueue(service,actor,input,`manual:${key}`,'manual');
    this.tick();
    return result;
  }
  private actor(id:string) {return this.options.store.db.prepare('SELECT id,email,role,created_at AS createdAt FROM users WHERE id=?').get(id) as User|undefined;}
  private discard(row:BackupRow) {
    this.storage.remove(row.id,'partial');
    for(const extension of ['dump','sql','rdb','archive'] as const)this.storage.remove(row.id,extension);
  }
  private remoteIdentity(row:BackupRow) {
    if(!row.object_key||!row.size||!row.sha256)throw new Error('Remote backup identity is incomplete.');
    return {serviceId:row.service_id,backupId:row.id,objectKey:row.object_key,size:row.size,sha256:row.sha256};
  }
  private async discardCompleted(row:BackupRow) {
    if(row.destination_ref&&row.size&&row.sha256&&row.object_key)await removeS3Backup(loadBackupDestination(this.options.store,row.service_id,row.destination_ref),this.remoteIdentity(row));
    this.discard(row);
  }
  private recoverExpired(now:Date) {
    const rows=this.options.store.db.prepare("SELECT * FROM database_backups WHERE status='running' AND lease_until<=?").all(now.toISOString()) as BackupRow[];
    for(const row of rows) {
      const changed=this.options.store.db.prepare("UPDATE database_backups SET status='failed',error=?,finished_at=?,owner_id=NULL,lease_until=NULL WHERE id=? AND status='running' AND lease_until<=?")
        .run('Backup interrupted before completion. Create a new backup.',now.toISOString(),row.id,now.toISOString()).changes;
      if(changed) {try{this.discard(row);}catch{/* Keep failed artifacts private when safe cleanup cannot be proven. */}}
    }
  }
  tick() {
    if(this.closing||this.options.maintenance?.isDraining)return;
    const release=this.options.maintenance?.admit();
    if(this.options.maintenance&&!release)return;
    try {
      const now=this.now(),minute=now.toISOString().slice(0,16),db=this.options.store.db;
      this.recoverExpired(now);
      for(const setting of db.prepare('SELECT * FROM database_backup_settings WHERE enabled=1').all() as SettingsRow[]) {
        if(setting.last_tick===minute)continue;
        db.transaction(()=>{
          const current=this.settingsRow(setting.service_id);
          if(!current?.enabled||current.last_tick===minute)return;
          db.prepare('UPDATE database_backup_settings SET last_tick=? WHERE service_id=?').run(minute,current.service_id);
          const service=this.options.store.getService(current.service_id),actor=this.actor(current.actor_id);
          if(!service||!actor||!this.options.store.canAccess(actor,service.projectId,true)) {
            db.prepare('UPDATE database_backup_settings SET enabled=0,updated_at=? WHERE service_id=?').run(now.toISOString(),current.service_id);
            return;
          }
          if(!backupCronMatches(current.cron,now))return;
          try {this.enqueue(service,actor,{name:`Scheduled backup ${minute} UTC`},`scheduled:${minute}`,'scheduled');}
          catch(error) {if(!(error instanceof AppError && ['BACKUP_BUSY','BACKUP_DATABASE_REQUIRED','BACKUP_DATABASE_NOT_DEPLOYED'].includes(error.code)))throw error;}
        }).immediate();
      }
      while(this.active.size<2) {
        const row=db.transaction(()=>{
          if((db.prepare("SELECT COUNT(*) AS n FROM database_backups WHERE status='running'").get() as {n:number}).n>=2)return;
          const next=db.prepare("SELECT * FROM database_backups WHERE status='queued' ORDER BY created_at,id LIMIT 1").get() as BackupRow|undefined;
          if(!next)return;
          db.prepare("UPDATE database_backups SET status='running',owner_id=?,lease_until=? WHERE id=? AND status='queued'").run(this.owner,new Date(now.getTime()+leaseMs).toISOString(),next.id);
          return this.row(next.id);
        }).immediate();
        if(!row)break;
        const controller=new AbortController();
        const promise=this.run(row,controller).finally(()=>this.active.delete(row.id));
        this.active.set(row.id,{promise,controller});
        void promise.catch(()=>{/* run stores a fixed, redacted failure; timer remains live. */});
      }
    } finally {release?.();}
  }
  private owns(id:string) {const row=this.row(id);return row?.status==='running'&&row.owner_id===this.owner&&!!row.lease_until&&row.lease_until>this.now().toISOString();}
  private async run(row:BackupRow,controller:AbortController) {
    const {store,maintenance}=this.options;
    const release=maintenance?.admit();
    if(maintenance&&!release) {store.db.prepare("UPDATE database_backups SET status='queued',owner_id=NULL,lease_until=NULL WHERE id=? AND owner_id=?").run(row.id,this.owner);return;}
    const heartbeat=setInterval(()=>{
      try {if(!this.owns(row.id)){controller.abort();return;}store.db.prepare("UPDATE database_backups SET lease_until=? WHERE id=? AND status='running' AND owner_id=?").run(new Date(this.now().getTime()+leaseMs).toISOString(),row.id,this.owner);}
      catch {controller.abort();}
    },30_000);heartbeat.unref();
    const deadline=setTimeout(()=>controller.abort(),11*60_000);deadline.unref();
    try {
      const service=store.getService(row.service_id),actor=this.actor(row.actor_id);
      if(!service||!actor||!store.canAccess(actor,service.projectId,true))throw new Error('Backup access is no longer available.');
      requireDatabase(service);
      const connection=store.connectionInfo(service.id);
      const upstream=await (this.options.databaseExport??agentDatabaseExport)(service.id,{kind:service.kind as 'postgres'|'mariadb'|'redis'|'mysql'|'mongodb',database:connection.database,user:connection.user},this.options.agentConnection);
      try {
        controller.signal.throwIfAborted();
        const extension={postgres:'dump',mariadb:'sql',mysql:'sql',redis:'rdb',mongodb:'archive'}[service.kind as 'postgres'|'mariadb'|'mysql'|'redis'|'mongodb'] as BackupExtension;
        const length=upstream.headers['content-length'];
        if(typeof length!=='string'||!/^[1-9][0-9]*$/.test(length)||upstream.headers['x-export-extension']!==extension)throw new Error('Invalid export metadata.');
        if(!this.owns(row.id))throw new Error('Backup lease was lost.');
        store.db.prepare('UPDATE database_backups SET extension=? WHERE id=? AND owner_id=?').run(extension,row.id,this.owner);
        const plaintextSize=Number(length);
        const input=row.encrypted?encryptDatabaseBackup(upstream,store.vault.databaseBackupKey(row.id),row.id):upstream;
        const result=await this.storage.capture(row.id,extension,input,plaintextSize+(row.encrypted?backupEncryptionOverhead:0),{encryptionOverhead:row.encrypted?backupEncryptionOverhead:0,signal:controller.signal,publish:()=>{if(!this.owns(row.id))throw new Error('Backup lease was lost.');}});
        if(!this.owns(row.id))throw new Error('Backup lease was lost.');
        store.db.prepare('UPDATE database_backups SET size=?,sha256=?,plaintext_size=? WHERE id=? AND owner_id=?').run(result.size,result.sha256,plaintextSize,row.id,this.owner);
        if(row.destination_ref) {
          const current=this.row(row.id)!;
          await uploadS3Backup(loadBackupDestination(store,service.id,row.destination_ref),this.remoteIdentity(current),this.storage.read(row.id,extension,result.size,result.sha256),controller.signal);
          if(!this.owns(row.id))throw new Error('Backup lease was lost.');
          this.storage.remove(row.id,extension);
        }
        store.db.transaction(()=>{
          store.db.prepare("UPDATE database_backups SET status='succeeded',finished_at=?,size=?,sha256=?,error=NULL,owner_id=NULL,lease_until=NULL WHERE id=? AND status='running' AND owner_id=?")
            .run(this.now().toISOString(),result.size,result.sha256,row.id,this.owner);
          store.recordAudit(actor.id,'database.backup.completed',service.id);
        }).immediate();
        if(!await this.retain(service.id))store.db.prepare('UPDATE database_backups SET error=? WHERE id=? AND status=\'succeeded\'').run('Backup completed, but older backups could not be removed. Check backup storage permissions.',row.id);
      } finally {upstream.destroy();}
    } catch(error) {
      if(error instanceof AgentRequestError&&error.certainty==='uncertain')maintenance?.markUncertain('unknown');
      if(this.owns(row.id)) {
        store.db.prepare("UPDATE database_backups SET status='failed',finished_at=?,error=?,owner_id=NULL,lease_until=NULL WHERE id=? AND owner_id=?")
          .run(this.now().toISOString(),'The database backup failed. Check the database, agent and free storage, then create a new backup.',row.id,this.owner);
        try {this.discard(this.row(row.id)!);}catch{/* Leave an unverified artifact private and unavailable. */}
      }
    } finally {clearInterval(heartbeat);clearTimeout(deadline);release?.();}
  }
  private async retain(serviceId:string) {
    let complete=true;
    const settings=this.settings(serviceId);
    const completed=this.options.store.db.prepare("SELECT * FROM database_backups WHERE service_id=? AND status='succeeded' ORDER BY created_at DESC,id DESC").all(serviceId) as BackupRow[];
    const rows=expiredDatabaseBackups(completed.map(row=>({...row,createdAt:row.created_at})),settings.retention,settings.retentionPolicy??{mode:'count'},this.now());
    for(const row of rows) {
      try {await this.discardCompleted(row);this.options.store.db.prepare("UPDATE database_backups SET status='deleted' WHERE id=? AND status='succeeded'").run(row.id);}
      catch {complete=false;}
    }
    return complete;
  }
  async read(serviceId:string,id:string,signal?:AbortSignal) {
    const row=z.string().uuid().safeParse(id).success?this.row(id):undefined;
    if(!row||row.service_id!==serviceId||row.status!=='succeeded'||!row.extension||!row.size)throw new AppError('BACKUP_NOT_FOUND','Database backup not found.',404);
    let stream:Readable|undefined,decrypted:Readable|undefined;
    try {
      stream=row.destination_ref?await readS3Backup(loadBackupDestination(this.options.store,serviceId,row.destination_ref),this.remoteIdentity(row)):this.storage.read(row.id,row.extension,row.size,row.sha256??undefined);
      if(!row.encrypted)return {backup:toBackup(row),stream};
      signal?.throwIfAborted();
      const temporary=randomUUID();
      decrypted=decryptDatabaseBackup(stream,this.options.store.vault.databaseBackupKey(row.id),row.id);
      // capture publishes only after GCM authentication and the expected length pass.
      const staged=await this.storage.capture(temporary,row.extension,decrypted,row.plaintext_size??undefined,{signal});
      try {
        const plaintext=this.storage.read(temporary,row.extension,staged.size,staged.sha256);
        // The open file descriptor remains readable after unlink; no plaintext file remains.
        this.storage.remove(temporary,row.extension);
        return {backup:{...toBackup(row),size:staged.size,sha256:staged.sha256},stream:plaintext};
      }catch(error){this.storage.remove(temporary,row.extension);throw error;}
    }
    catch {decrypted?.destroy();stream?.destroy();throw new AppError('BACKUP_UNAVAILABLE','The backup file is unavailable or changed. Restore from another verified copy.',409);}
  }
  async remove(serviceId:string,id:string,actor:User) {
    const row=z.string().uuid().safeParse(id).success?this.row(id):undefined;
    if(!row||row.service_id!==serviceId)throw new AppError('BACKUP_NOT_FOUND','Database backup not found.',404);
    if(['queued','running'].includes(row.status))throw new AppError('BACKUP_BUSY','An active backup cannot be deleted.',409);
    await this.discardCompleted(row);
    this.options.store.db.transaction(()=>{
      this.options.store.db.prepare("UPDATE database_backups SET status='deleted' WHERE id=?").run(row.id);
      this.options.store.recordAudit(actor.id,'database.backup.deleted',serviceId);
    }).immediate();
  }
  start() {if(this.timer||this.closing)return;this.tick();this.timer=setInterval(()=>{try{this.tick();}catch{/* Retry scheduler metadata errors on the next tick. */}},5_000);this.timer.unref();}
  async drain() {await Promise.allSettled([...this.active.values()].map(entry=>entry.promise));}
  async close() {this.closing=true;if(this.timer)clearInterval(this.timer);for(const entry of this.active.values())entry.controller.abort();await this.drain();}
}

export function registerBackups(app:FastifyInstance,options:BackupOptions) {
  const backups=new DatabaseBackups(options),prefix='/api/v1/services/:id';
  registerBackupProviders(app,options);
  app.get<{Params:{id:string}}>(`${prefix}/backups`,async req=>{options.serviceAccess(req,req.params.id);return {backups:backups.list(req.params.id)};});
  app.get<{Params:{id:string}}>(`${prefix}/backup-settings`,async req=>{const {service}=options.serviceAccess(req,req.params.id);requireDatabase(service);return {settings:backups.settings(service.id)};});
  app.put<{Params:{id:string}}>(`${prefix}/backup-settings`,async req=>{const {auth,service}=options.serviceAccess(req,req.params.id,true);return {settings:backups.saveSettings(service,auth.user,req.body)};});
  app.post<{Params:{id:string}}>(`${prefix}/backups`,async(req,reply)=>{const {auth,service}=options.serviceAccess(req,req.params.id,true);return reply.code(202).send({backup:backups.create(service,auth.user,req.body??{},req.headers['idempotency-key'])});});
  app.get<{Params:{id:string;backupId:string}}>(`${prefix}/backups/:backupId/download`,async(req,reply)=>{
    const {auth,service}=options.serviceAccess(req,req.params.id);
    if(!options.store.canAccess(auth.user,service.projectId,true))throw new AppError('BACKUP_NOT_FOUND','Database backup not found.',404);
    const controller=new AbortController();
    const abort=()=>controller.abort();req.raw.once('aborted',abort);reply.raw.once('close',abort);
    let result:Awaited<ReturnType<DatabaseBackups['read']>>;
    try {result=await backups.read(service.id,req.params.backupId,controller.signal);}
    finally{req.raw.removeListener('aborted',abort);reply.raw.removeListener('close',abort);}
    const {backup,stream}=result;
    try {
      controller.signal.throwIfAborted();
      const latest=options.serviceAccess(req,req.params.id);
      if(!options.store.canAccess(latest.auth.user,latest.service.projectId,true))throw new AppError('BACKUP_NOT_FOUND','Database backup not found.',404);
    }catch(error){stream.destroy();throw error;}
    options.store.recordAudit(auth.user.id,'database.backup.download',service.id);
    reply.header('Content-Type','application/octet-stream').header('Content-Length',backup.size!).header('Content-Disposition',`attachment; filename="servus-${backup.id}.${backup.extension}"`).header('X-Backup-SHA256',backup.sha256!);
    reply.raw.once('close',()=>stream.destroy());
    return reply.send(stream);
  });
  app.delete<{Params:{id:string;backupId:string}}>(`${prefix}/backups/:backupId`,async req=>{const {auth,service}=options.serviceAccess(req,req.params.id,true);await backups.remove(service.id,req.params.backupId,auth.user);return {success:true};});
  if(options.startScheduler!==false)app.addHook('onReady',async()=>backups.start());
  app.addHook('onClose',async()=>backups.close());
  return backups;
}
