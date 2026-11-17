import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { validateBackupEndpoint } from '../agent/s3-storage.js';
import { redactBackupDestination, s3DestinationSchema, type BackupDestination, type S3Destination } from '../shared/storage-target.js';
import type { BackupOptions } from './backups.js';
import type { Store } from './store.js';
import { AppError } from './errors.js';

export function loadBackupDestination(store:Store,serviceId:string,reference:string):S3Destination {
  const record=JSON.parse(store.vault.getServiceSecret(reference,serviceId,'backup-storage')) as unknown;
  const parsed=z.object({kind:z.literal('backup-storage-v1'),serviceId:z.literal(serviceId),destination:s3DestinationSchema}).strict().parse(record);
  return parsed.destination;
}
export function currentBackupDestination(store:Store,serviceId:string):BackupDestination {
  const setting=store.db.prepare('SELECT destination_ref FROM database_backup_settings WHERE service_id=?').get(serviceId) as {destination_ref:string|null}|undefined;
  return setting?.destination_ref?redactBackupDestination(loadBackupDestination(store,serviceId,setting.destination_ref)):{type:'local'};
}
export function registerBackupProviders(app:FastifyInstance,options:BackupOptions) {
  const prefix='/api/v1/services/:id/backup-destination';
  app.get<{Params:{id:string}}>(prefix,async req=>{const {service}=options.serviceAccess(req,req.params.id);return {destination:currentBackupDestination(options.store,service.id)};});
  app.put<{Params:{id:string}}>(prefix,async req=>{
    const {service,auth}=options.serviceAccess(req,req.params.id,true),{store}=options;
    if(!['postgres','mariadb','redis'].includes(service.kind??''))throw new AppError('BACKUP_DATABASE_REQUIRED','Backup storage is available for managed databases.',400);
    const destination=z.discriminatedUnion('type',[z.object({type:z.literal('local')}).strict(),s3DestinationSchema]).parse(req.body);
    if(destination.type==='s3') {
      try {await validateBackupEndpoint(destination);}catch(error){throw new AppError('BACKUP_ENDPOINT',error instanceof Error?error.message:'Invalid backup endpoint.',400);}
    }
    // DNS validation is asynchronous; permission may have changed while it ran.
    options.serviceAccess(req,req.params.id,true);
    store.db.transaction(()=>{
      const now=new Date().toISOString(),reference=destination.type==='local'?null:store.putBackupDestinationSecret(service.id,JSON.stringify({kind:'backup-storage-v1',serviceId:service.id,destination}));
      store.db.prepare(`INSERT INTO database_backup_settings (service_id,actor_id,enabled,cron,retention,last_tick,updated_at,destination_ref) VALUES (?,?,0,'0 2 * * *',7,?,?,?)
        ON CONFLICT(service_id) DO UPDATE SET destination_ref=excluded.destination_ref,updated_at=excluded.updated_at`).run(service.id,auth.user.id,now.slice(0,16),now,reference);
      store.recordAudit(auth.user.id,'database.backup.destination',service.id);
    }).immediate();
    return {destination:currentBackupDestination(store,service.id)};
  });
}
