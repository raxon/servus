import type Database from 'better-sqlite3';

export type RestorePhase = 'uploading' | 'reserved' | 'importing' | 'prepared' | 'switching' | 'needs_review' | 'completed' | 'cancelled';
export type RestoreRecord = { id: string; service_id: string; kind: 'postgres' | 'mariadb' | 'redis'; archive_sha256: string; phase: RestorePhase; updated_at: string };
const idPattern = /^[a-f0-9]{32}$/;
const servicePattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const digestPattern = /^[a-f0-9]{64}$/;
const transitions: Record<RestorePhase, readonly RestorePhase[]> = {
  uploading: ['needs_review'],
  reserved: ['importing', 'cancelled', 'needs_review'],
  importing: ['prepared', 'needs_review'],
  prepared: ['switching', 'needs_review'],
  switching: ['completed', 'needs_review'],
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
      archive_sha256 TEXT NOT NULL, phase TEXT NOT NULL CHECK(phase IN ('uploading','reserved','importing','prepared','switching','needs_review','completed','cancelled')),
      updated_at TEXT NOT NULL
    )`;
    db.transaction(() => {
      const table = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='restore_operations'").get() as { sql: string } | undefined;
      if (!table) db.exec(createTable);
      else if (!table.sql.includes("'uploading'")) {
        if (!['reserved','importing','prepared','switching','needs_review','completed','cancelled'].every(phase => table.sql.includes(`'${phase}'`))) throw new Error('Unsupported restore journal schema.');
        db.exec('DROP INDEX IF EXISTS restore_one_active_per_service; ALTER TABLE restore_operations RENAME TO restore_operations_old');
        db.exec(createTable);
        db.exec('INSERT INTO restore_operations SELECT * FROM restore_operations_old; DROP TABLE restore_operations_old');
      }
      db.exec("CREATE UNIQUE INDEX IF NOT EXISTS restore_one_active_per_service ON restore_operations(service_id) WHERE phase NOT IN ('completed','cancelled')");
    }).immediate();
  }
  get(id: string): RestoreRecord | undefined { return this.db.prepare('SELECT * FROM restore_operations WHERE id=?').get(id) as RestoreRecord | undefined; }
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
