export interface VolumeBackup {
  id:string;serviceId:string;mountTarget:string;name:string;status:'queued'|'running'|'succeeded'|'failed'|'deleted';
  trigger:'manual'|'scheduled';createdAt:string;finishedAt:string|null;size:number|null;sha256:string|null;error:string|null;destination:'local'|'s3';
  deletionPending?:boolean;
}
export interface VolumeBackupSettings {mountTarget:string;enabled:boolean;cron:string;retention:number;timeZone:'UTC';description:string}
export interface VolumeRestore {
  id:string;backupId:string;serviceId:string;mountTarget:string;
  phase:'preparing'|'prepared'|'switching'|'completed'|'rolling_back'|'rolled_back'|'cancelled'|'failed'|'needs_review';
  candidateVolume:string|null;previousVolume:string|null;error:string|null;createdAt:string;updatedAt:string;
}
export interface VolumeRestoreBinding {service_id:string;mount_target:string;mount_name:string;volume_name:string;operation_id:string;created_at:string}

export const VOLUME_BACKUP_SCHEMA_SQL=`
CREATE TABLE IF NOT EXISTS volume_backup_settings (
  service_id TEXT NOT NULL REFERENCES services(id),mount_target TEXT NOT NULL,actor_id TEXT NOT NULL REFERENCES users(id),
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),cron TEXT NOT NULL,retention INTEGER NOT NULL CHECK(retention BETWEEN 1 AND 100),
  last_tick TEXT,updated_at TEXT NOT NULL,destination_ref TEXT,PRIMARY KEY(service_id,mount_target)
);
CREATE TABLE IF NOT EXISTS volume_backups (
  id TEXT PRIMARY KEY,service_id TEXT NOT NULL REFERENCES services(id),mount_target TEXT NOT NULL,actor_id TEXT NOT NULL REFERENCES users(id),name TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','deleted')),trigger TEXT NOT NULL CHECK(trigger IN ('manual','scheduled')),
  idempotency_key TEXT NOT NULL,request_hash TEXT NOT NULL,created_at TEXT NOT NULL,finished_at TEXT,size INTEGER,sha256 TEXT,error TEXT,
  owner_id TEXT,lease_until TEXT,destination_ref TEXT,object_key TEXT,UNIQUE(actor_id,service_id,idempotency_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS volume_backup_active_service ON volume_backups(service_id) WHERE status IN ('queued','running');
CREATE TABLE IF NOT EXISTS volume_restores (
  id TEXT PRIMARY KEY,backup_id TEXT NOT NULL REFERENCES volume_backups(id),service_id TEXT NOT NULL REFERENCES services(id),mount_target TEXT NOT NULL,
  actor_id TEXT NOT NULL REFERENCES users(id),phase TEXT NOT NULL,candidate_volume TEXT,previous_volume TEXT,error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,owner_id TEXT,lease_until TEXT,UNIQUE(actor_id,service_id,idempotency_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS volume_restore_active_service ON volume_restores(service_id) WHERE phase IN ('preparing','prepared','switching','rolling_back','needs_review');
`;

export const AGENT_VOLUME_BACKUP_SCHEMA_SQL=`
CREATE TABLE IF NOT EXISTS volume_backup_operations (
  id TEXT PRIMARY KEY,service_id TEXT NOT NULL,mount_target TEXT NOT NULL,mount_name TEXT NOT NULL,source_volume TEXT NOT NULL,
  phase TEXT NOT NULL,sealed_plan TEXT NOT NULL,sealed_manifest TEXT,size INTEGER,sha256 TEXT,error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS volume_backup_one_active_service ON volume_backup_operations(service_id) WHERE phase NOT IN ('completed','failed');
CREATE TABLE IF NOT EXISTS volume_restore_operations (
  id TEXT PRIMARY KEY,service_id TEXT NOT NULL,backup_id TEXT NOT NULL,mount_target TEXT NOT NULL,mount_name TEXT NOT NULL,
  phase TEXT NOT NULL,sealed_plan TEXT NOT NULL,candidate_volume TEXT NOT NULL,previous_volume TEXT NOT NULL,error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS volume_restore_one_active_service ON volume_restore_operations(service_id) WHERE phase NOT IN ('completed','cancelled','failed','rolled_back');
CREATE TABLE IF NOT EXISTS volume_restore_bindings (
  service_id TEXT NOT NULL,mount_target TEXT NOT NULL,mount_name TEXT NOT NULL,volume_name TEXT NOT NULL,operation_id TEXT NOT NULL,created_at TEXT NOT NULL,
  PRIMARY KEY(service_id,mount_target),UNIQUE(volume_name)
);
`;
