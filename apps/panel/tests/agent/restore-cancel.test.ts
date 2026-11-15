import { afterEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { RestoreJournal } from '../../src/agent/restore-journal.js';
import { uploadRestoreArchive } from '../../src/agent/restore-upload.js';
import { cancelStagedRestore } from '../../src/agent/restore-cancel.js';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const remove of cleanup.splice(0).reverse()) remove(); });
async function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(),'restore-cancel-')); cleanup.push(() => rmSync(dataDir,{recursive:true,force:true}));
  const db = new Database(join(dataDir,'agent.sqlite')); db.exec('CREATE TABLE operations(id TEXT PRIMARY KEY,service_id TEXT,state TEXT)'); cleanup.push(() => {if(db.open)db.close();});
  const journal = new RestoreJournal(db,() => false), operationId = randomBytes(16).toString('hex'), serviceId = randomUUID();
  await uploadRestoreArchive({journal,dataDir,operationId,serviceId,kind:'postgres',key:randomBytes(32),input:()=>Readable.from(['fixture database'])});
  return {db,journal,dataDir,operationId,serviceId,path:join(dataDir,'restore-archives',`${operationId}.enc`)};
}

it('deletes the staged archive before clearing the durable fence and is idempotent', async () => {
  const base = await fixture(); expect(existsSync(base.path)).toBe(true);
  expect(cancelStagedRestore(base).phase).toBe('cancelled');
  expect(existsSync(base.path)).toBe(false); expect(base.journal.hasUnresolved(base.serviceId)).toBe(false);
  expect(cancelStagedRestore(base).phase).toBe('cancelled');
});

it('resumes after a crash between deleting the file and recording cancellation', async () => {
  const base = await fixture(); base.journal.advance(base.operationId,'reserved','discarding'); unlinkSync(base.path); base.db.close();
  const db = new Database(join(base.dataDir,'agent.sqlite')); cleanup.push(() => db.close());
  const journal = new RestoreJournal(db,()=>false);
  expect(journal.hasUnresolved(base.serviceId)).toBe(true);
  expect(cancelStagedRestore({...base,journal}).phase).toBe('cancelled');
});

it('does not cancel a different service or an import that has started', async () => {
  const base = await fixture();
  expect(() => cancelStagedRestore({...base,serviceId:randomUUID()})).toThrow('does not belong');
  base.journal.advance(base.operationId,'reserved','importing');
  expect(() => cancelStagedRestore(base)).toThrow('cannot be cancelled');
  expect(existsSync(base.path)).toBe(true); expect(base.journal.hasUnresolved(base.serviceId)).toBe(true);
});

it('leaves the service fenced if the archive path has been replaced', async () => {
  const base = await fixture(); unlinkSync(base.path); symlinkSync('/nonexistent',base.path);
  expect(() => cancelStagedRestore(base)).toThrow('requires recovery');
  expect(base.journal.get(base.operationId)?.phase).toBe('needs_review');
  expect(base.journal.hasUnresolved(base.serviceId)).toBe(true);
});

it('migrates an existing uploading journal without clearing its fence', async () => {
  const base = await fixture();
  base.db.exec("DROP INDEX restore_one_active_per_service; ALTER TABLE restore_operations RENAME TO new_restore; CREATE TABLE restore_operations(id TEXT PRIMARY KEY, service_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('postgres','mariadb','redis')),archive_sha256 TEXT NOT NULL,phase TEXT NOT NULL CHECK(phase IN ('uploading','reserved','importing','prepared','switching','needs_review','completed','cancelled')),updated_at TEXT NOT NULL); INSERT INTO restore_operations SELECT * FROM new_restore; DROP TABLE new_restore");
  base.db.prepare("UPDATE restore_operations SET phase='uploading' WHERE id=?").run(base.operationId);
  const migrated = new RestoreJournal(base.db,()=>false);
  expect(migrated.get(base.operationId)?.phase).toBe('uploading');
  expect(migrated.hasUnresolved(base.serviceId)).toBe(true);
});
