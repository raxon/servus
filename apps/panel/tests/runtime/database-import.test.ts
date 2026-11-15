import { afterEach, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { DatabaseImportError, importDatabaseCandidate } from '../../src/agent/database-import.js';

const containerId = 'a'.repeat(64), operationId = 'b'.repeat(32);
const cleanup: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture(options: { network?: string; privileged?: boolean; label?: string; volumeLabel?: string; dataVolume?: string; exec?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'servus-import-test-')); cleanup.push(dir);
  const info = JSON.stringify([{ Id: containerId, Config: { Labels: { 'panel.restore.operation': options.label ?? operationId }, Env: ['POSTGRES_DB=fixture', 'POSTGRES_USER=fixture'] },
    HostConfig: { NetworkMode: options.network ?? 'none', Privileged: options.privileged ?? false, Tmpfs: { '/run/secrets':'rw,noexec,nosuid,nodev,size=1m,mode=0700' } }, State: { Running: true },
    Mounts: [{ Type: 'volume', Name: options.dataVolume ?? `panel-restore-${operationId}`, Destination: '/var/lib/postgresql/data', RW: true }] }]);
  const volume = JSON.stringify([{ Name: `panel-restore-${operationId}`, Labels: { 'panel.restore.operation': options.volumeLabel ?? operationId, 'panel.restore.purpose': 'candidate' } }]);
  const docker = join(dir, 'docker');
  writeFileSync(docker, `#!/bin/sh\ncase "$3" in\ninspect) printf '%s' '${info}' ;;\nvolume) printf '%s' '${volume}' ;;\nexec) ${options.exec ?? 'cat > "$SERVUS_INPUT"'} ;;\n*) exit 3 ;;\nesac\n`);
  chmodSync(docker, 0o700); vi.stubEnv('PATH', dir + delimiter + (process.env.PATH || '')); vi.stubEnv('SERVUS_INPUT', join(dir, 'input')); vi.stubEnv('SERVUS_STARTED', join(dir, 'started'));
  return dir;
}
function target(input: string) { return { containerId, operationId, dockerSocket: '/var/run/docker.sock', kind: 'postgres' as const, database: 'fixture', user: 'fixture', archiveSha256:createHash('sha256').update(input).digest('hex'), input: () => Readable.from([input]) }; }

it('imports only after verifying isolated candidate and its labelled volume', async () => {
  const dir = fixture(); await importDatabaseCandidate(target('synthetic-dump'));
  expect(readFileSync(join(dir, 'input'), 'utf8')).toBe('synthetic-dump');
});

it('rejects unlabelled, networked, or non-candidate storage before importing', async () => {
  for (const options of [{ network: 'bridge' }, { privileged: true }, { label: 'other' }, { volumeLabel: 'other' }, { dataVolume: 'production-volume' }]) {
    const dir = fixture(options);
    const input = vi.fn(() => Readable.from(['synthetic-dump']));
    await expect(importDatabaseCandidate({ ...target('synthetic-dump'), input })).rejects.toMatchObject({ candidateMayBeDirty: false });
    expect(input).not.toHaveBeenCalled();
    expect(existsSync(join(dir, 'input'))).toBe(false);
  }
});

it('marks failed imports as requiring candidate disposal', async () => {
  fixture({ exec: 'cat > "$SERVUS_INPUT"; exit 1' });
  await expect(importDatabaseCandidate(target('synthetic-dump'))).rejects.toMatchObject({ candidateMayBeDirty: true });
  await expect(importDatabaseCandidate({ ...target('x'), operationId: 'bad' })).rejects.toBeInstanceOf(DatabaseImportError);
});

it('marks a candidate dirty when the received archive does not match the reserved digest', async () => {
  fixture();
  await expect(importDatabaseCandidate({ ...target('tampered-data'), archiveSha256: 'f'.repeat(64) })).rejects.toMatchObject({ candidateMayBeDirty: true, message: expect.stringContaining('digest mismatch') });
});

it('marks an interrupted import as requiring candidate disposal', async () => {
  const dir = fixture({ exec: 'touch "$SERVUS_STARTED"; exec sleep 30' });
  const controller = new AbortController();
  const promise = importDatabaseCandidate({ ...target('synthetic-dump'), signal: controller.signal });
  void promise.catch(() => {});
  try {
    await vi.waitFor(() => expect(existsSync(join(dir, 'started'))).toBe(true), {timeout: 10_000});
    controller.abort();
    await expect(promise).rejects.toMatchObject({ candidateMayBeDirty: true });
  } finally {
    controller.abort();
    await promise.catch(() => {});
  }
}, 15_000);
