import { afterEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { RestoreJournal } from '../../src/agent/restore-journal.js';
import { prepareRestoreCandidate } from '../../src/agent/restore-preparation.js';

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function fixture(kind: 'postgres' | 'mariadb' | 'redis' = 'postgres') {
  const db = new Database(':memory:'); databases.push(db); db.exec('CREATE TABLE operations(id TEXT PRIMARY KEY, service_id TEXT, state TEXT)');
  const journal = new RestoreJournal(db, () => false), operationId = 'a'.repeat(32), serviceId = randomUUID(), digest = 'b'.repeat(64);
  journal.reserve({ id: operationId, serviceId, kind, archiveSha256: digest });
  const target = { containerId: 'c'.repeat(64), dockerSocket: '/var/run/docker.sock', database: 'fixture', user: 'fixture', input: () => Readable.from(['archive']) };
  return { journal, operationId, serviceId, digest, target };
}

it('binds the import to the durable operation and archive digest', async () => {
  const { journal, operationId, serviceId, digest, target } = fixture(), importCandidate = vi.fn(async () => {});
  const result = await prepareRestoreCandidate({ journal, operationId, serviceId, target, importCandidate });
  expect(result.phase).toBe('prepared'); expect(journal.hasUnresolved(serviceId)).toBe(true);
  expect(importCandidate).toHaveBeenCalledWith(expect.objectContaining({ operationId, kind: 'postgres', archiveSha256: digest, containerId: target.containerId }));
});

it('records intent before import and refuses a concurrent preparation', async () => {
  const { journal, operationId, serviceId, target } = fixture(); let finish!: () => void;
  const importCandidate = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  const running = prepareRestoreCandidate({ journal, operationId, serviceId, target, importCandidate });
  expect(journal.get(operationId)?.phase).toBe('importing');
  await expect(prepareRestoreCandidate({ journal, operationId, serviceId, target, importCandidate })).rejects.toThrow('reserved');
  expect(importCandidate).toHaveBeenCalledOnce(); finish(); expect((await running).phase).toBe('prepared');
});

it('keeps a failed or interrupted candidate fenced for review', async () => {
  const { journal, operationId, serviceId, target } = fixture('mariadb'), importCandidate = vi.fn(async () => { throw new Error('synthetic import failure'); });
  await expect(prepareRestoreCandidate({ journal, operationId, serviceId, target, importCandidate })).rejects.toThrow('synthetic import failure');
  expect(journal.get(operationId)?.phase).toBe('needs_review'); expect(journal.hasUnresolved(serviceId)).toBe(true);
  await expect(prepareRestoreCandidate({ journal, operationId, serviceId, target, importCandidate })).rejects.toThrow('reserved');
});

it('does not report success if recording the prepared state fails', async () => {
  const { journal, operationId, serviceId, target } = fixture(), advance = journal.advance.bind(journal);
  vi.spyOn(journal, 'advance').mockImplementation((id, expected, next) => {
    if (next === 'prepared') throw new Error('synthetic journal failure');
    return advance(id, expected, next);
  });
  await expect(prepareRestoreCandidate({ journal, operationId, serviceId, target, importCandidate: vi.fn(async () => {}) })).rejects.toThrow('synthetic journal failure');
  expect(journal.get(operationId)?.phase).toBe('needs_review'); expect(journal.hasUnresolved(serviceId)).toBe(true);
});

it('does not begin an unsupported or mismatched restore', async () => {
  const { journal, operationId, serviceId, target } = fixture('redis'), importCandidate = vi.fn(async () => {});
  await expect(prepareRestoreCandidate({ journal, operationId, serviceId, target, importCandidate })).rejects.toThrow('reserved');
  await expect(prepareRestoreCandidate({ journal, operationId, serviceId: randomUUID(), target, importCandidate })).rejects.toThrow('reserved');
  expect(journal.get(operationId)?.phase).toBe('reserved'); expect(importCandidate).not.toHaveBeenCalled();
});
