import { afterEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { RestoreJournal } from '../../src/agent/restore-journal.js';
import { createAgent } from '../../src/agent/app.js';
import { AgentMaintenanceGate } from '../../src/agent/maintenance.js';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const remove of cleanup.splice(0).reverse()) await remove(); });
function database() {
  const dir = mkdtempSync(join(tmpdir(), 'restore-journal-test-')); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'journal.sqlite'), db = new Database(path); db.pragma('journal_mode=WAL');
  db.exec('CREATE TABLE operations(id TEXT PRIMARY KEY, service_id TEXT, state TEXT)');
  cleanup.push(() => { if (db.open) db.close(); }); return { db, path };
}
function intent(serviceId = randomUUID()) { return { id: 'a'.repeat(32), serviceId, kind: 'postgres' as const, archiveSha256: 'b'.repeat(64) }; }

it('records an upload and its lock identity atomically and preserves it across restart', () => {
  const {db,path}=database(),journal=new RestoreJournal(db,()=>false),request=intent(),lockId='c'.repeat(32);
  journal.beginUpload({...request,lockId});
  db.close();
  const reopened=new Database(path);cleanup.push(()=>reopened.close());
  const recovered=new RestoreJournal(reopened,()=>false);
  expect(recovered.get(request.id)?.phase).toBe('uploading');
  expect(recovered.uploadLockId(request.id)).toBe(lockId);
  expect(recovered.get(request.id)?.archive_sha256).toBe(lockId.repeat(2));
  expect(reopened.prepare("SELECT name FROM sqlite_master WHERE name IN ('restore_upload_locks','restore_review_phases')").all()).toEqual([]);
});

it('persists immutable identity and unresolved phases across restart', () => {
  const { db, path } = database(), journal = new RestoreJournal(db, () => false), request = intent();
  expect(journal.reserve(request).phase).toBe('reserved');
  expect(journal.reserve(request)).toEqual(journal.get(request.id));
  expect(() => journal.reserve({ ...request, archiveSha256: 'c'.repeat(64) })).toThrow('conflicts');
  journal.advance(request.id, 'reserved', 'importing'); db.close();
  const reopened = new Database(path); cleanup.push(() => reopened.close());
  const recovered = new RestoreJournal(reopened, () => false);
  expect(recovered.get(request.id)?.phase).toBe('importing');
  expect(recovered.hasUnresolved(request.serviceId)).toBe(true);
  expect(() => recovered.reserve({ ...request, id: 'd'.repeat(32) })).toThrow('unresolved');
  expect(() => recovered.advance(request.id, 'importing', 'cancelled')).toThrow('transition');
  recovered.advance(request.id, 'importing', 'needs_review');
  expect(recovered.reviewPhase(request.id)).toBeUndefined();
  expect(() => recovered.advance(request.id, 'needs_review', 'completed')).toThrow('transition');
  expect(recovered.hasUnresolved()).toBe(true);
});

it('does not invent a review reason for an existing legacy record', () => {
  const {db}=database(),journal=new RestoreJournal(db,()=>false),request=intent();
  db.prepare("INSERT INTO restore_operations VALUES(?,?,?,?,'needs_review',?)").run(request.id,request.serviceId,request.kind,request.archiveSha256,new Date().toISOString());
  expect(journal.reviewPhase(request.id)).toBeUndefined();
});

it('retains the in-progress fence after a process is killed', async () => {
  const { db, path } = database(), request = intent(); db.close();
  const sqlitePath = createRequire(import.meta.url).resolve('better-sqlite3');
  const moduleUrl = new URL('../../src/agent/restore-journal.ts', import.meta.url).href;
  const program = `const {default:Database}=await import(process.argv[1]);const {RestoreJournal}=await import(process.argv[2]);const db=new Database(process.argv[3]);const journal=new RestoreJournal(db,()=>false);const request=JSON.parse(process.argv[4]);journal.reserve(request);journal.advance(request.id,'reserved','importing');process.stdout.write('ready\\n');setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', program, sqlitePath, moduleUrl, path, JSON.stringify(request)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const started = await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(() => { throw new Error('Restore fixture exited before writing its journal.'); }), new Promise<never>((_, reject) => { timeout=setTimeout(() => reject(new Error('Restore fixture did not start.')), 5000); })]);
    expect(started[0].toString()).toBe('ready\n');
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  } finally { if(timeout)clearTimeout(timeout);if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
  const reopened = new Database(path); cleanup.push(() => reopened.close());
  const journal = new RestoreJournal(reopened, () => false);
  expect(journal.get(request.id)?.phase).toBe('importing'); expect(journal.hasUnresolved(request.serviceId)).toBe(true);
}, 10000);

it('fences running service operations and rejects concurrent reservations', () => {
  const { db, path } = database(), request = intent(), busy = vi.fn(() => true), journal = new RestoreJournal(db, busy);
  expect(() => journal.reserve(request)).toThrow('unresolved'); busy.mockReturnValue(false);
  db.prepare("INSERT INTO operations VALUES(?,?, 'running')").run(randomUUID(), request.serviceId);
  expect(() => journal.reserve(request)).toThrow('unresolved'); db.prepare('DELETE FROM operations').run();
  journal.reserve(request);
  const other = new Database(path); cleanup.push(() => other.close()); const second = new RestoreJournal(other, () => false);
  expect(() => second.reserve({ ...request, id: 'c'.repeat(32) })).toThrow('unresolved');
  expect(() => journal.advance(request.id, 'reserved', 'switching')).toThrow('transition');
  journal.advance(request.id, 'reserved', 'discarding'); journal.advance(request.id, 'discarding', 'cancelled');
  expect(second.reserve({ ...request, id: 'c'.repeat(32) }).phase).toBe('reserved');
});

it('clears the fence only after ordered recorded transitions', () => {
  const { db } = database(), journal = new RestoreJournal(db, () => false), request = intent();
  journal.reserve(request); journal.advance(request.id, 'reserved', 'importing'); journal.advance(request.id, 'importing', 'prepared');
  expect(journal.hasUnresolved(request.serviceId)).toBe(true);
  journal.beginSwitch({id:request.id,serviceId:request.serviceId,serviceVersion:1,sealedPlan:`enc:v1:${'a'.repeat(40)}`});
  expect(() => journal.advance(request.id, 'switching', 'completed')).toThrow('transition');
  expect(journal.hasUnresolved(request.serviceId)).toBe(true);
});

it('blocks export, deployment, console and maintenance after a restart with an unresolved restore', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'restore-agent-test-')); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const config = { dataDir: dir, token: 'token', socketPath: join(dir, 'sock'), dockerSocket: '/unused', ingressPort: 18080, ingressImage: 'unused' };
  const apply = vi.fn(async () => ({ state: 'running' as const, deployedRevision: 1, messages: [] }));
  const runtime = { status: async () => ({ online: true }), inspectService: async () => ({ state: 'unknown' as const }), apply, consoleContainer: vi.fn() };
  const initial = await createAgent(config, runtime as never); await initial.close();
  const db = new Database(join(dir, 'agent.sqlite')), request = intent(), journal = new RestoreJournal(db, () => false);
  journal.reserve(request); journal.advance(request.id, 'reserved', 'importing'); db.close();
  const gate = new AgentMaintenanceGate(), app = await createAgent(config, runtime as never, gate); cleanup.push(() => app.close());
  const headers = { authorization: 'Bearer token' }, id = request.serviceId;
  const exportResponse = await app.inject({ method: 'POST', url: `/services/${id}/database-export`, headers, payload: { kind: 'postgres', database: 'fixture', user: 'fixture' } });
  expect(exportResponse.statusCode).toBe(409);
  const service = { id, projectId: randomUUID(), name: 'fixture', image: 'postgres:17', hostname: 'fixture.localhost', port: 5432, replicas: 1, revision: 1, deployedRevision: 1, state: 'running', createdAt: '', updatedAt: '', lastError: null };
  expect((await app.inject({ method: 'POST', url: '/services/apply', headers, payload: { operationId: randomUUID(), type: 'restart', service } })).statusCode).toBe(409);
  expect((await app.inject({ method: 'GET', url: `/services/${id}/console`, headers: { ...headers, connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' } })).statusCode).toBe(409);
  expect(apply).not.toHaveBeenCalled(); expect(runtime.consoleContainer).not.toHaveBeenCalled();
  expect(await gate.drain(1000)).toEqual({ status: 'uncertain' });
});
