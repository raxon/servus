import type Database from 'better-sqlite3';
import { validateRestoreBinding } from './restore-binding.js';

export type RestorePhase = 'uploading' | 'reserved' | 'discarding' | 'discarding_candidate' | 'importing' | 'prepared' | 'switching' | 'needs_review' | 'completed' | 'cancelled';
export type RestoreRecord = { id: string; service_id: string; kind: 'postgres' | 'mariadb' | 'redis'; archive_sha256: string; phase: RestorePhase; updated_at: string };
export type RestoreSwitchStage = 'pending'|'candidate_stop'|'candidate_detached'|'applying'|'applied'|'rolling_back'|'rolled_back';
export type RestoreSwitchIntent = { id:string; service_id:string; service_version:number; sealed_plan:string; created_at:string; stage:RestoreSwitchStage };
export type RetainedRestoreVolume = {operation_id:string;service_id:string;volume_name:string;reason:'rollback_candidate'|'pre_restore_source';created_at:string};
export type RestoreVolumeBinding = {service_id:string;operation_id:string;volume_name:string;kind:'postgres'|'mariadb';created_at:string};
const idPattern = /^[a-f0-9]{32}$/;
const servicePattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const digestPattern = /^[a-f0-9]{64}$/;
const transitions: Record<RestorePhase, readonly RestorePhase[]> = {
  uploading: ['cancelled', 'needs_review'],
  reserved: ['importing', 'discarding', 'needs_review'],
  discarding: ['cancelled', 'needs_review'],
  discarding_candidate: ['cancelled'],
  importing: ['prepared', 'needs_review'],
  prepared: ['discarding_candidate', 'needs_review'],
  switching: ['needs_review'],
  needs_review: [], completed: [], cancelled: [],
};

/** Durable intent and fencing. External effects require independent verification. */
export class RestoreJournal {
  private readonly db: Database.Database;
  private readonly isLocked: (serviceId: string) => boolean;
  constructor(db: Database.Database, isLocked: (serviceId: string) => boolean) {
    this.db = db; this.isLocked = isLocked;
    const createTable = `CREATE TABLE restore_operations (
      id TEXT PRIMARY KEY, service_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('postgres','mariadb','redis')),
      archive_sha256 TEXT NOT NULL, phase TEXT NOT NULL CHECK(phase IN ('uploading','reserved','discarding','discarding_candidate','importing','prepared','switching','needs_review','completed','cancelled')),
      updated_at TEXT NOT NULL
    )`;
    db.transaction(() => {
      const table = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='restore_operations'").get() as { sql: string } | undefined;
      if (!table) db.exec(createTable);
      else if (!table.sql.includes("'uploading'") || !table.sql.includes("'discarding'") || !table.sql.includes("'discarding_candidate'")) {
        if (!['reserved','importing','prepared','switching','needs_review','completed','cancelled'].every(phase => table.sql.includes(`'${phase}'`))) throw new Error('Unsupported restore journal schema.');
        db.exec('DROP INDEX IF EXISTS restore_one_active_per_service; ALTER TABLE restore_operations RENAME TO restore_operations_old');
        db.exec(createTable);
        db.exec('INSERT INTO restore_operations SELECT * FROM restore_operations_old; DROP TABLE restore_operations_old');
      }
      db.exec("CREATE UNIQUE INDEX IF NOT EXISTS restore_one_active_per_service ON restore_operations(service_id) WHERE phase NOT IN ('completed','cancelled')");
      const switchSchema="CREATE TABLE restore_switch_intents (id TEXT PRIMARY KEY, service_id TEXT NOT NULL, service_version INTEGER NOT NULL, sealed_plan TEXT NOT NULL, created_at TEXT NOT NULL, stage TEXT NOT NULL DEFAULT 'pending' CHECK(stage IN ('pending','candidate_stop','candidate_detached','applying','applied','rolling_back','rolled_back')))";
      const switchTable=db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='restore_switch_intents'").get() as {sql:string}|undefined;
      if(!switchTable)db.exec(switchSchema);
      const columns=db.prepare('PRAGMA table_info(restore_switch_intents)').all() as {name:string}[];
      if(!columns.some(column=>column.name==='stage'))db.exec("ALTER TABLE restore_switch_intents ADD COLUMN stage TEXT NOT NULL DEFAULT 'pending' CHECK(stage IN ('pending','candidate_stop','candidate_detached','applying','applied','rolling_back','rolled_back'))");
      else if(switchTable&&!switchTable.sql.includes("'rolling_back'")) {
        db.exec('ALTER TABLE restore_switch_intents RENAME TO restore_switch_intents_old');db.exec(switchSchema);
        db.exec('INSERT INTO restore_switch_intents SELECT id,service_id,service_version,sealed_plan,created_at,stage FROM restore_switch_intents_old; DROP TABLE restore_switch_intents_old');
      }
      const retainedSchema="CREATE TABLE restore_retained_volumes (operation_id TEXT PRIMARY KEY, service_id TEXT NOT NULL, volume_name TEXT NOT NULL UNIQUE, reason TEXT NOT NULL CHECK(reason IN ('rollback_candidate','pre_restore_source')), created_at TEXT NOT NULL)";
      const retainedTable=db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='restore_retained_volumes'").get() as {sql:string}|undefined;
      if(!retainedTable)db.exec(retainedSchema);
      else if(!retainedTable.sql.includes("'pre_restore_source'")){db.exec('ALTER TABLE restore_retained_volumes RENAME TO restore_retained_volumes_old');db.exec(retainedSchema);db.exec('INSERT INTO restore_retained_volumes SELECT * FROM restore_retained_volumes_old; DROP TABLE restore_retained_volumes_old');}
      db.exec("CREATE TABLE IF NOT EXISTS restore_volume_bindings (service_id TEXT PRIMARY KEY, operation_id TEXT NOT NULL UNIQUE, volume_name TEXT NOT NULL UNIQUE, kind TEXT NOT NULL CHECK(kind IN ('postgres','mariadb')), created_at TEXT NOT NULL)");
    }).immediate();
  }
  get(id: string): RestoreRecord | undefined { return this.db.prepare('SELECT * FROM restore_operations WHERE id=?').get(id) as RestoreRecord | undefined; }
  latestForService(serviceId: string): RestoreRecord | undefined {
    return this.db.prepare("SELECT * FROM restore_operations WHERE service_id=? ORDER BY CASE WHEN phase NOT IN ('completed','cancelled') THEN 0 ELSE 1 END, updated_at DESC, rowid DESC LIMIT 1").get(serviceId) as RestoreRecord | undefined;
  }
  hasUnresolved(serviceId?: string): boolean {
    return serviceId === undefined
      ? Boolean(this.db.prepare("SELECT 1 FROM restore_operations WHERE phase NOT IN ('completed','cancelled') LIMIT 1").get())
      : Boolean(this.db.prepare("SELECT 1 FROM restore_operations WHERE service_id=? AND phase NOT IN ('completed','cancelled') LIMIT 1").get(serviceId));
  }
  reserve(input: { id: string; serviceId: string; kind: RestoreRecord['kind']; archiveSha256: string }): RestoreRecord {
    if (!idPattern.test(input.id) || !servicePattern.test(input.serviceId) || !digestPattern.test(input.archiveSha256) || !['postgres', 'mariadb', 'redis'].includes(input.kind)) throw new Error('Invalid restore intent.');
    return this.db.transaction(() => {
      const existing = this.get(input.id);
      if (existing) {
        if (existing.service_id !== input.serviceId || existing.kind !== input.kind || existing.archive_sha256 !== input.archiveSha256) throw new Error('Restore identity conflicts with an existing intent.');
        return existing;
      }
      if (this.isLocked(input.serviceId) || this.hasUnresolved(input.serviceId) || this.db.prepare("SELECT 1 FROM operations WHERE service_id=? AND state='running' LIMIT 1").get(input.serviceId)) throw new Error('Service has an unresolved operation.');
      this.db.prepare("INSERT INTO restore_operations(id,service_id,kind,archive_sha256,phase,updated_at) VALUES(?,?,?,?,'reserved',?)").run(input.id,input.serviceId,input.kind,input.archiveSha256,new Date().toISOString());
      return this.get(input.id)!;
    }).immediate();
  }
  beginUpload(input: { id: string; serviceId: string; kind: RestoreRecord['kind'] }): RestoreRecord {
    if (!idPattern.test(input.id) || !servicePattern.test(input.serviceId) || !['postgres', 'mariadb'].includes(input.kind)) throw new Error('Invalid restore upload.');
    return this.db.transaction(() => {
      if (this.get(input.id) || this.isLocked(input.serviceId) || this.hasUnresolved(input.serviceId) || this.db.prepare("SELECT 1 FROM operations WHERE service_id=? AND state='running' LIMIT 1").get(input.serviceId)) throw new Error('Service has an unresolved operation.');
      this.db.prepare("INSERT INTO restore_operations(id,service_id,kind,archive_sha256,phase,updated_at) VALUES(?,?,?,?,'uploading',?)").run(input.id,input.serviceId,input.kind,'0'.repeat(64),new Date().toISOString());
      return this.get(input.id)!;
    }).immediate();
  }
  finishUpload(id: string, archiveSha256: string): RestoreRecord {
    if (!idPattern.test(id) || !digestPattern.test(archiveSha256)) throw new Error('Invalid restore upload.');
    return this.db.transaction(() => {
      const update = this.db.prepare("UPDATE restore_operations SET archive_sha256=?,phase='reserved',updated_at=? WHERE id=? AND phase='uploading'").run(archiveSha256,new Date().toISOString(),id);
      if (update.changes !== 1) throw new Error('Restore upload phase does not match.');
      return this.get(id)!;
    }).immediate();
  }
  switchIntent(id:string):RestoreSwitchIntent|undefined { return this.db.prepare('SELECT * FROM restore_switch_intents WHERE id=?').get(id) as RestoreSwitchIntent|undefined; }
  beginSwitch(input:{id:string;serviceId:string;serviceVersion:number;sealedPlan:string}):RestoreRecord {
    if(!idPattern.test(input.id)||!servicePattern.test(input.serviceId)||!Number.isSafeInteger(input.serviceVersion)||input.serviceVersion<1||!/^enc:v1:[A-Za-z0-9+/]+={0,2}$/.test(input.sealedPlan)||input.sealedPlan.length<47||input.sealedPlan.length>1_000_000)throw new Error('Invalid restore switch intent.');
    return this.db.transaction(()=>{
      const record=this.get(input.id);
      if(!record||record.service_id!==input.serviceId||record.phase!=='prepared'||this.switchIntent(input.id))throw new Error('Restore is not ready to switch.');
      const timestamp=new Date().toISOString();
      this.db.prepare('INSERT INTO restore_switch_intents(id,service_id,service_version,sealed_plan,created_at) VALUES(?,?,?,?,?)').run(input.id,input.serviceId,input.serviceVersion,input.sealedPlan,timestamp);
      this.db.prepare("UPDATE restore_operations SET phase='switching',updated_at=? WHERE id=? AND phase='prepared'").run(timestamp,input.id);
      return this.get(input.id)!;
    }).immediate();
  }
  advanceSwitchStage(id:string,expected:RestoreSwitchStage,next:RestoreSwitchStage):RestoreSwitchIntent {
    const stages:Record<RestoreSwitchStage,readonly RestoreSwitchStage[]>={pending:['candidate_stop','rolling_back'],candidate_stop:['candidate_detached','rolling_back'],candidate_detached:['applying','rolling_back'],applying:['applied','rolling_back'],applied:['rolling_back'],rolling_back:['rolled_back'],rolled_back:[]};
    if(!idPattern.test(id)||!Object.hasOwn(stages,expected)||!stages[expected].includes(next))throw new Error('Invalid restore switch stage.');
    return this.db.transaction(()=>{
      if(this.get(id)?.phase!=='switching'||this.switchIntent(id)?.stage!==expected)throw new Error('Restore switch stage does not match.');
      this.db.prepare('UPDATE restore_switch_intents SET stage=? WHERE id=? AND stage=?').run(next,id,expected);
      return this.switchIntent(id)!;
    }).immediate();
  }
  retainedVolume(id:string):RetainedRestoreVolume|undefined { return this.db.prepare('SELECT * FROM restore_retained_volumes WHERE operation_id=?').get(id) as RetainedRestoreVolume|undefined; }
  volumeBinding(serviceId:string):RestoreVolumeBinding|undefined { return this.db.prepare('SELECT * FROM restore_volume_bindings WHERE service_id=?').get(serviceId) as RestoreVolumeBinding|undefined; }
  validatedVolumeBinding(serviceId:string,kind:'postgres'|'mariadb'):RestoreVolumeBinding|undefined { return validateRestoreBinding(this.db,serviceId,kind); }
  completeSwitch(id:string,serviceId:string,sourceVolume:string):RestoreRecord {
    if(!idPattern.test(id)||!servicePattern.test(serviceId))throw new Error('Invalid restore switch identity.');
    return this.db.transaction(()=>{
      const record=this.get(id),binding=this.volumeBinding(serviceId),target=`panel-restore-${id}`;
      if(record?.phase==='completed'&&record.service_id===serviceId&&binding?.operation_id===id&&binding.volume_name===target&&this.retainedVolume(id)?.reason==='pre_restore_source'&&this.retainedVolume(id)?.volume_name===sourceVolume)return record;
      if(!record||record.service_id!==serviceId||record.phase!=='switching'||!['postgres','mariadb'].includes(record.kind)||this.switchIntent(id)?.stage!=='applied'||this.retainedVolume(id))throw new Error('Restore switch is not ready for completion.');
      if(sourceVolume!==(binding?.volume_name??`panel-data-${serviceId}-database`)||sourceVolume===target)throw new Error('Original database volume binding changed.');
      const prior=binding?this.get(binding.operation_id):undefined;
      if(binding&&(binding.kind!==record.kind||binding.volume_name!==`panel-restore-${binding.operation_id}`||prior?.phase!=='completed'||prior.service_id!==serviceId||prior.kind!==record.kind))throw new Error('Previous database volume binding is invalid.');
      const timestamp=new Date().toISOString();
      this.db.prepare("INSERT INTO restore_retained_volumes(operation_id,service_id,volume_name,reason,created_at) VALUES(?,?,?,'pre_restore_source',?)").run(id,serviceId,sourceVolume,timestamp);
      this.db.prepare('INSERT INTO restore_volume_bindings(service_id,operation_id,volume_name,kind,created_at) VALUES(?,?,?,?,?) ON CONFLICT(service_id) DO UPDATE SET operation_id=excluded.operation_id,volume_name=excluded.volume_name,kind=excluded.kind,created_at=excluded.created_at').run(serviceId,id,target,record.kind,timestamp);
      this.db.prepare('DELETE FROM restore_switch_intents WHERE id=?').run(id);
      this.db.prepare("UPDATE restore_operations SET phase='completed',updated_at=? WHERE id=? AND phase='switching'").run(timestamp,id);
      return this.get(id)!;
    }).immediate();
  }
  finalizeRollback(id:string,serviceId:string):RestoreRecord {
    if(!idPattern.test(id)||!servicePattern.test(serviceId))throw new Error('Invalid restore rollback identity.');
    return this.db.transaction(()=>{
      const record=this.get(id),existing=this.retainedVolume(id);
      if(record?.phase==='cancelled'&&record.service_id===serviceId&&existing?.service_id===serviceId&&existing.volume_name===`panel-restore-${id}`)return record;
      if(!record||record.service_id!==serviceId||record.phase!=='switching'||this.switchIntent(id)?.stage!=='rolled_back'||existing)throw new Error('Restore rollback is not ready for finalization.');
      const timestamp=new Date().toISOString();
      this.db.prepare("INSERT INTO restore_retained_volumes(operation_id,service_id,volume_name,reason,created_at) VALUES(?,?,?,'rollback_candidate',?)").run(id,serviceId,`panel-restore-${id}`,timestamp);
      this.db.prepare('DELETE FROM restore_switch_intents WHERE id=?').run(id);
      this.db.prepare("UPDATE restore_operations SET phase='cancelled',updated_at=? WHERE id=? AND phase='switching'").run(timestamp,id);
      return this.get(id)!;
    }).immediate();
  }
  advance(id: string, expected: RestorePhase, next: RestorePhase): RestoreRecord {
    if (!idPattern.test(id) || !Object.hasOwn(transitions, expected) || !transitions[expected].includes(next)) throw new Error('Invalid restore transition.');
    return this.db.transaction(() => {
      const previous = this.get(id);
      if (!previous || previous.phase !== expected) throw new Error('Restore phase does not match the expected state.');
      this.db.prepare('UPDATE restore_operations SET phase=?,updated_at=? WHERE id=? AND phase=?').run(next,new Date().toISOString(),id,expected);
      return this.get(id)!;
    }).immediate();
  }
}
