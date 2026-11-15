import { afterEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { RestoreJournal } from '../../src/agent/restore-journal.js';
import { uploadRestoreArchive } from '../../src/agent/restore-upload.js';
import { prepareRestoreCandidate } from '../../src/agent/restore-preparation.js';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const remove of cleanup.splice(0).reverse()) remove(); });
function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), 'restore-upload-'));
  cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }));
  const db = new Database(join(dataDir, 'journal.sqlite'));
  db.exec('CREATE TABLE operations(id TEXT PRIMARY KEY, service_id TEXT, state TEXT)');
  cleanup.push(() => { if (db.open) db.close(); });
  const journal = new RestoreJournal(db, () => false), operationId = randomBytes(16).toString('hex'), serviceId = randomUUID();
  return { db, journal, operationId, serviceId, dataDir, key: randomBytes(32), kind: 'postgres' as const };
}

it('records the upload before reading and publishes the archive digest only after staging', async () => {
  const base = fixture(), content = Buffer.from('fixture archive'), source = new PassThrough();
  const pending = uploadRestoreArchive({ ...base, input: () => source });
  expect(base.journal.get(base.operationId)?.phase).toBe('uploading');
  const importCandidate = vi.fn(async () => {});
  const target = { containerId: 'c'.repeat(64), dockerSocket: '/unused', database: 'fixture', user: 'fixture', input: () => Readable.from([]) };
  await expect(prepareRestoreCandidate({ ...base, target, importCandidate })).rejects.toThrow('reserved');
  await expect(uploadRestoreArchive({ ...base, input: () => Readable.from(['duplicate']) })).rejects.toThrow('unresolved');
  expect(importCandidate).not.toHaveBeenCalled();
  source.end(content);
  const result = await pending;
  expect(result.record.phase).toBe('reserved');
  expect(result.record.archive_sha256).toBe(createHash('sha256').update(content).digest('hex'));
  expect(result.size).toBe(content.length);
  expect(readdirSync(join(base.dataDir, 'restore-archives'))).toEqual([`${base.operationId}.enc`]);
});

it('fences an interrupted upload for recovery without permitting a new import', async () => {
  const base = fixture(), source = new PassThrough(), controller = new AbortController();
  const pending = uploadRestoreArchive({ ...base, input: () => source, signal: controller.signal });
  source.write('partial'); controller.abort();
  await expect(pending).rejects.toThrow();
  expect(base.journal.get(base.operationId)?.phase).toBe('needs_review');
  expect(base.journal.hasUnresolved(base.serviceId)).toBe(true);
  expect(readdirSync(join(base.dataDir, 'restore-archives'))).toEqual([]);
});

it('keeps the service fenced when recording a completed upload fails', async () => {
  const base = fixture(); vi.spyOn(base.journal, 'finishUpload').mockImplementation(() => { throw new Error('synthetic journal failure'); });
  await expect(uploadRestoreArchive({ ...base, input: () => Readable.from(['archive']) })).rejects.toThrow('synthetic journal failure');
  expect(base.journal.get(base.operationId)?.phase).toBe('needs_review');
  expect(base.journal.hasUnresolved(base.serviceId)).toBe(true);
});

it('migrates existing journal rows and retains upload fences after reopening', () => {
  const base = fixture(), prior = randomBytes(16).toString('hex'), previousService = randomUUID();
  base.db.exec("DROP TABLE restore_operations; CREATE TABLE restore_operations(id TEXT PRIMARY KEY, service_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('postgres','mariadb','redis')), archive_sha256 TEXT NOT NULL, phase TEXT NOT NULL CHECK(phase IN ('reserved','importing','prepared','switching','needs_review','completed','cancelled')), updated_at TEXT NOT NULL)");
  base.db.prepare("INSERT INTO restore_operations VALUES(?,?,? ,?,'completed',?)").run(prior,previousService,'postgres','a'.repeat(64),new Date().toISOString());
  const migrated = new RestoreJournal(base.db, () => false);
  expect(migrated.get(prior)?.phase).toBe('completed');
  migrated.beginUpload({ id: base.operationId, serviceId: base.serviceId, kind: base.kind });
  base.db.close();
  const reopened = new Database(join(base.dataDir, 'journal.sqlite')); cleanup.push(() => reopened.close());
  const recovered = new RestoreJournal(reopened, () => false);
  expect(recovered.get(base.operationId)?.phase).toBe('uploading');
  expect(recovered.hasUnresolved(base.serviceId)).toBe(true);
  expect(() => recovered.beginUpload({ id: randomBytes(16).toString('hex'), serviceId: base.serviceId, kind: base.kind })).toThrow('unresolved');
});

it('retains the upload fence and encrypts partial data when the process is killed', async () => {
  const base = fixture(); base.db.close();
  const sqlitePath = createRequire(import.meta.url).resolve('better-sqlite3');
  const journalUrl = new URL('../../src/agent/restore-journal.ts', import.meta.url).href;
  const uploadUrl = new URL('../../src/agent/restore-upload.ts', import.meta.url).href;
  const program = `const {default:Database}=await import(process.argv[1]);const {RestoreJournal}=await import(process.argv[2]);const {uploadRestoreArchive}=await import(process.argv[3]);const {PassThrough}=await import('node:stream');const db=new Database(process.argv[4]);const journal=new RestoreJournal(db,()=>false);const source=new PassThrough();void uploadRestoreArchive({journal,operationId:process.argv[5],serviceId:process.argv[6],kind:'postgres',dataDir:process.argv[7],key:Buffer.alloc(32),input:()=>source}).catch(()=>{});source.write('partial-private-fixture');process.stdout.write('ready\\n');setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['--import','tsx','--input-type=module','-e',program,sqlitePath,journalUrl,uploadUrl,join(base.dataDir,'journal.sqlite'),base.operationId,base.serviceId,base.dataDir], { stdio: ['ignore','pipe','pipe'] });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const started = await Promise.race([once(child.stdout,'data'),once(child,'exit').then(() => { throw new Error('Upload fixture exited early.'); }),new Promise<never>((_,reject) => { timer=setTimeout(() => reject(new Error('Upload fixture timed out.')),5000); })]);
    expect(started[0].toString()).toBe('ready\n');
    const exit = once(child,'exit'); child.kill('SIGKILL'); await exit;
  } finally { if (timer) clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
  const reopened = new Database(join(base.dataDir,'journal.sqlite')); cleanup.push(() => reopened.close());
  const recovered = new RestoreJournal(reopened, () => false);
  expect(recovered.get(base.operationId)?.phase).toBe('uploading');
  expect(recovered.hasUnresolved(base.serviceId)).toBe(true);
  const files = readdirSync(join(base.dataDir,'restore-archives'));
  expect(files).toHaveLength(1);
  expect(files[0]).toMatch(new RegExp(`^\\.pending-${base.operationId}-`));
  expect(readFileSync(join(base.dataDir,'restore-archives',files[0]!)).includes(Buffer.from('partial-private-fixture'))).toBe(false);
}, 10000);
