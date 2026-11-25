import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../../src/server/app.js';
import { Store } from '../../src/server/store.js';
import { normalizeServiceInput } from '../../src/server/configuration.js';
import { Worker } from '../../src/worker/runner.js';
import { AgentRequestError } from '../../src/agent/client.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
  vi.restoreAllMocks();
});

describe('action cancellation, build resources, service notes and extended public API', () => {
  it('cancels queued actions durably and delegates active build cancellation to the agent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'servus-action-cancel-'));
    const store = new Store(dir);
    const admin = store.setup('admin@example.test', 'fixture-hash');
    const project = store.createProject('cancel-project');
    const otherProject = store.createProject('other-project');
    const member = store.createUser('viewer@example.test', 'fixture-hash');
    store.addMember(project.id, member.id, 'viewer');

    const agentRequest = vi.fn(async (path: string) => {
      if (path.includes('/cancel-build/')) return { cancelled: true };
      throw new Error(`Unexpected path: ${path}`);
    });
    const app = await createApp({
      dataDir: dir,
      store,
      agentRequest: agentRequest as never,
      metricsCollector: { start: false },
    });
    cleanups.push(async () => { await app.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });

    const adminSession = store.createSession(admin.id);
    const adminHeaders = { cookie: `panel_session=${adminSession.token}`, 'x-csrf-token': adminSession.csrfToken };
    const viewerSession = store.createSession(member.id);
    const viewerHeaders = { cookie: `panel_session=${viewerSession.token}`, 'x-csrf-token': viewerSession.csrfToken };

    const { service, action: queuedAction } = store.createService(
      project.id,
      normalizeServiceInput({
        name: 'builder',
        source: {
          type: 'git',
          repository: 'https://github.com/example/repo.git',
          branch: 'main',
          context: '.',
          dockerfile: 'Dockerfile',
          buildResources: { cpuQuotaPercent: 200, memoryMb: 2048, timeoutSeconds: 300 },
        },
        hostname: 'builder.localhost',
        port: 3000,
        notes: 'Production build service\nMaintained by ops',
      }),
      admin.id,
    );
    expect(service.notes).toContain('Maintained by ops');
    expect(service.source?.type === 'git' ? service.source.buildResources : undefined).toEqual({
      cpuQuotaPercent: 200,
      memoryMb: 2048,
      timeoutSeconds: 300,
    });

    // Viewer cannot cancel queued action
    expect((await app.inject({ method: 'POST', url: `/api/v1/actions/${queuedAction.id}/cancel`, headers: viewerHeaders, payload: {} })).statusCode).toBe(404);

    // Admin cancels queued action cleanly and idempotently
    const firstCancel = await app.inject({ method: 'POST', url: `/api/v1/actions/${queuedAction.id}/cancel`, headers: adminHeaders, payload: {} });
    expect(firstCancel.statusCode).toBe(200);
    expect(firstCancel.json()).toMatchObject({ cancelled: true, action: { id: queuedAction.id, status: 'cancelled' } });
    // Second cancel is idempotent
    const secondCancel = await app.inject({ method: 'POST', url: `/api/v1/actions/${queuedAction.id}/cancel`, headers: adminHeaders, payload: {} });
    expect(secondCancel.statusCode).toBe(200);
    expect(secondCancel.json().action.status).toBe('cancelled');

    // A new deploy action can now be queued because the cancelled job released the active slot
    const nextAction = store.createAction(service.id, 'deploy', admin.id, 'deploy-2');
    const claimed = store.claimNextJob('worker-test', 60_000)!;
    expect(claimed.actionId).toBe(nextAction.id);

    // Cancelling a running deploy delegates to the agent build cancellation endpoint
    const runningCancel = await app.inject({ method: 'POST', url: `/api/v1/actions/${nextAction.id}/cancel`, headers: adminHeaders, payload: {} });
    expect(runningCancel.statusCode).toBe(202);
    expect(runningCancel.json()).toMatchObject({ cancellationRequested: true });
    expect(agentRequest).toHaveBeenCalledWith(`/services/${service.id}/cancel-build/${nextAction.id}`, {}, expect.any(Object));

    // Complete first service's running job, then let worker run a cancelled build on a fresh service
    store.completeAction(nextAction.id, 'worker-test', { state: 'running', deployedRevision: 1 });
    const { action: thirdAction } = store.createService(
      otherProject.id,
      normalizeServiceInput({ name: 'other', image: 'nginx:alpine', hostname: 'other.localhost', port: 80 }),
      admin.id,
    );

    const worker = new Worker(store, 60_000, {
      apply: async () => { throw new AgentRequestError('Build cancelled by operator.', 'definitive', 422, 'BUILD_CANCELLED'); },
      readState: async () => ({ state: 'stopped' }),
    });
    expect(await worker.once()).toBe(true);
    expect(store.getAction(thirdAction.id)?.status).toBe('cancelled');
  });

  it('allows project-scoped API tokens for backups, action cancellation and OpenAPI documentation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'servus-extended-api-'));
    const store = new Store(dir);
    const admin = store.setup('admin@example.test', 'fixture-hash');
    const project = store.createProject('db-api-project');
    const app = await createApp({ dataDir: dir, store, metricsCollector: { start: false } });
    cleanups.push(async () => { await app.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });

    const adminSession = store.createSession(admin.id);
    const adminHeaders = { cookie: `panel_session=${adminSession.token}`, 'x-csrf-token': adminSession.csrfToken };

    const { service: db } = store.createService(project.id, normalizeServiceInput({ name: 'pg', kind: 'postgres' }), admin.id);
    const job = store.claimNextJob('db-worker', 60_000)!;
    store.completeAction(job.actionId, 'db-worker', { state: 'running', deployedRevision: 1 });

    const readTokenRes = await app.inject({
      method: 'POST', url: '/api/v1/auth/api-tokens', headers: adminHeaders,
      payload: { projectId: project.id, name: 'read-tok', scope: 'read', expiresInDays: 7 },
    });
    const deployTokenRes = await app.inject({
      method: 'POST', url: '/api/v1/auth/api-tokens', headers: adminHeaders,
      payload: { projectId: project.id, name: 'deploy-tok', scope: 'deploy', expiresInDays: 7 },
    });
    const readBearer = { authorization: `Bearer ${readTokenRes.json().token}` };
    const deployBearer = { authorization: `Bearer ${deployTokenRes.json().token}` };

    // Read token can list backups, cannot create backup or cancel action
    expect((await app.inject({ url: `/api/v1/services/${db.id}/backups`, headers: readBearer })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/api/v1/services/${db.id}/backups`, headers: { ...readBearer, 'idempotency-key': 'b1' }, payload: {} })).statusCode).toBe(403);

    // Deploy token can trigger database backup and cancel a queued action
    const createdBackup = await app.inject({
      method: 'POST', url: `/api/v1/services/${db.id}/backups`,
      headers: { ...deployBearer, 'idempotency-key': 'backup-tok-1' },
      payload: { name: 'API triggered backup' },
    });
    expect(createdBackup.statusCode).toBe(202);
    expect(createdBackup.json().backup.name).toBe('API triggered backup');

    const queued = store.createAction(db.id, 'restart', admin.id, 'restart-cancel-1');
    const cancelled = await app.inject({ method: 'POST', url: `/api/v1/actions/${queued.id}/cancel`, headers: deployBearer, payload: {} });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().action.status).toBe('cancelled');

    const spec = (await app.inject({ url: '/api/v1/openapi.json', headers: readBearer })).json();
    expect(spec.paths['/services/{id}/backups'].get).toBeDefined();
    expect(spec.paths['/services/{id}/backups'].post).toBeDefined();
    expect(spec.paths['/actions/{id}/cancel'].post).toBeDefined();
  });
});
