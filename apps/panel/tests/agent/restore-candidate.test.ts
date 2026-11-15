import { afterEach, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createRestoreCandidate } from '../../src/agent/restore-candidate.js';

const cleanup: string[] = [], operationId = 'a'.repeat(32), sourceId = 'b'.repeat(64), candidateId = 'c'.repeat(64), imageId = `sha256:${'d'.repeat(64)}`;
afterEach(() => { vi.unstubAllEnvs(); for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture(kind: 'postgres' | 'mariadb' = 'postgres') {
  const dir = mkdtempSync(join(tmpdir(), 'restore-candidate-test-')); cleanup.push(dir);
  const dockerPath = join(dir, 'docker'); writeFileSync(dockerPath, '#!/bin/sh\nprintf "%s\\n" "$@" >> "$SERVUS_ARGS"\nif [ "$4" = "-i" ]; then cat >> "$SERVUS_SECRETS"; fi\nexit 0\n'); chmodSync(dockerPath, 0o700);
  vi.stubEnv('PATH', dir + delimiter + (process.env.PATH || '')); vi.stubEnv('SERVUS_ARGS', join(dir, 'args')); vi.stubEnv('SERVUS_SECRETS', join(dir, 'secret-input'));
  const serviceId = randomUUID(), password = 'synthetic-password-secret', rootPassword = 'synthetic-root-secret';
  const source = { Id: sourceId, Image: imageId, State: { Running: true }, Config: { Labels: { 'panel.owner': 'self-hosted-panel', 'panel.service': serviceId, 'com.docker.swarm.service.name': `panel-app-${serviceId}` }, Env: kind === 'postgres' ? ['POSTGRES_DB=fixture', 'POSTGRES_USER=fixture'] : ['MARIADB_DATABASE=fixture', 'MARIADB_USER=fixture'] } };
  let volume: { Name: string; Labels: Record<string,string> } | undefined, spec: Record<string,unknown> | undefined;
  const candidate = { id: candidateId, start: vi.fn(async () => {}), inspect: vi.fn(async () => ({ Id: candidateId, State: { Running: true }, Config: { Labels: { 'panel.restore.operation': operationId } } })) };
  const docker = { getContainer: vi.fn(() => ({ inspect: async () => source })), getImage: vi.fn(() => ({ inspect: async () => ({ Id: imageId }) })),
    getVolume: vi.fn(() => ({ inspect: async () => { if (!volume) throw { statusCode: 404 }; return volume; } })),
    createVolume: vi.fn(async (input: { Name: string; Labels: Record<string,string> }) => { volume = input; return input; }),
    createContainer: vi.fn(async (input: Record<string,unknown>) => { spec = input; return candidate; }) };
  const journal = { get: vi.fn(() => ({ id: operationId, service_id: serviceId, kind, phase: 'importing' })) };
  const options = { docker: docker as never, dockerSocket: '/var/run/docker.sock', journal: journal as never, operationId, serviceId, sourceContainerId: sourceId, kind, database: 'fixture', user: 'fixture', password, ...(kind === 'mariadb' ? { rootPassword } : {}) };
  return { dir, source, docker, journal, options, candidate, password, rootPassword, spec: () => spec };
}

for (const kind of ['postgres', 'mariadb'] as const) it(`creates an isolated ${kind} candidate without recording passwords in Docker metadata`, async () => {
  const f = fixture(kind), result = await createRestoreCandidate(f.options);
  expect(result).toEqual({ containerId: candidateId, volumeName: `panel-restore-${operationId}` });
  expect(f.candidate.start).toHaveBeenCalledOnce();
  const spec = JSON.stringify(f.spec()), args = readFileSync(join(f.dir, 'args'), 'utf8'), secrets = readFileSync(join(f.dir, 'secret-input'), 'utf8');
  expect(spec).toContain('"NetworkMode":"none"'); expect(spec).toContain('"/run/secrets":"rw,noexec,nosuid,nodev,size=1m,mode=0700"');
  expect(spec).not.toContain(f.password); expect(args).not.toContain(f.password); expect(secrets).toContain(f.password);
  if (kind === 'mariadb') { expect(spec).not.toContain(f.rootPassword); expect(args).not.toContain(f.rootPassword); expect(secrets).toContain(f.rootPassword); }
});

it('rejects mismatched source identity before allocating a volume', async () => {
  const f = fixture(); f.source.Config.Labels['panel.service'] = randomUUID();
  await expect(createRestoreCandidate(f.options)).rejects.toThrow('identity'); expect(f.docker.createVolume).not.toHaveBeenCalled();
});

it('does not adopt a pre-existing candidate volume', async () => {
  const f = fixture(); f.docker.getVolume.mockReturnValue({ inspect: async () => ({ Name: 'existing', Labels: {} }) } as never);
  await expect(createRestoreCandidate(f.options)).rejects.toThrow('already exists'); expect(f.docker.createVolume).not.toHaveBeenCalled();
});

it('requires an importing journal record and never allocates on invalid input', async () => {
  const f = fixture(); f.journal.get.mockReturnValue({ id: operationId, service_id: f.options.serviceId, kind: 'postgres', phase: 'reserved' });
  await expect(createRestoreCandidate(f.options)).rejects.toThrow('Invalid restore'); expect(f.docker.createVolume).not.toHaveBeenCalled();
});

it('stops waiting when Docker inspection is interrupted', async () => {
  const f = fixture(), controller = new AbortController();
  f.docker.getContainer.mockReturnValue({ inspect: () => new Promise(() => {}) } as never);
  const result = createRestoreCandidate({ ...f.options, signal: controller.signal }); controller.abort();
  await expect(result).rejects.toThrow('interrupted'); expect(f.docker.createVolume).not.toHaveBeenCalled();
});
