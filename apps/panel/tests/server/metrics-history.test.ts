import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../../src/server/app.js';
import { MaintenanceGate } from '../../src/server/maintenance.js';
import { MetricsHistory } from '../../src/server/metrics-history.js';
import { Store } from '../../src/server/store.js';
import { normalizeServiceInput } from '../../src/server/configuration.js';
import { collectHostMetrics } from '../../src/agent/observability.js';
import type { ServiceMetrics } from '../../src/shared/types.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
  vi.restoreAllMocks();
});

function createRunningService(store: Store, projectId: string, actorId: string, name: string) {
  const { service } = store.createService(projectId, normalizeServiceInput({ name, image: 'nginx:alpine', port: 80, hostname: `${name}.localhost` }), actorId);
  const job = store.claimNextJob('metrics-test', 60_000)!;
  store.completeAction(job.actionId, 'metrics-test', { state: 'running', deployedRevision: 1 });
  return store.getService(service.id)!;
}

it('samples independently of browser requests, persists across reopen, records gaps and tracks container generations', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'servus-metrics-history-'));
  const store = new Store(dataDir);
  const admin = store.setup('admin@example.test', 'fixture-hash');
  const project = store.createProject('metrics-project');
  const service = createRunningService(store, project.id, admin.id, 'web');
  let clock = new Date('2026-11-25T10:00:00.000Z');
  const responses: (ServiceMetrics | Error)[] = [
    { cpuPercent: 145.6, memoryBytes: 64 * 1024 * 1024, memoryLimitBytes: 512 * 1024 * 1024, networkRxBytes: 1000, networkTxBytes: 2000, containers: 2, generation: 'aaaaaaaaaaaaaaaa' },
    new Error('Agent temporarily unreachable'),
    { cpuPercent: 0, memoryBytes: 32 * 1024 * 1024, memoryLimitBytes: 512 * 1024 * 1024, networkRxBytes: 1200, networkTxBytes: 2400, containers: 1, generation: 'bbbbbbbbbbbbbbbb' },
  ];
  let call = 0;
  const agentRequest = vi.fn(async () => {
    const next = responses[call++];
    if (!next || next instanceof Error) throw next ?? new Error('Unexpected call');
    return next;
  });

  const history = new MetricsHistory({
    store,
    serviceAccess: () => { throw new Error('Unused'); },
    agentRequest: agentRequest as never,
    now: () => clock,
    intervalMs: 60_000,
    startCollector: false,
  });
  cleanups.push(async () => { await history.close(); store.close(); rmSync(dataDir, { recursive: true, force: true }); });

  await history.tick();
  clock = new Date('2026-11-25T10:01:00.000Z');
  await history.tick();
  clock = new Date('2026-11-25T10:02:00.000Z');
  await history.tick();
  await history.close();

  // Reopen metrics.sqlite to prove persistence across process restarts.
  const reopened = new MetricsHistory({
    store,
    serviceAccess: () => { throw new Error('Unused'); },
    now: () => clock,
    startCollector: false,
  });
  cleanups.push(async () => { await reopened.close(); });

  const result = reopened.query(service, '1h');
  expect(result.samples).toHaveLength(3);
  expect(result.samples[0]).toMatchObject({ status: 'ok', cpuPercent: 145.6, containers: 2, generation: 'aaaaaaaaaaaaaaaa' });
  expect(result.samples[1]).toMatchObject({ status: 'gap', cpuPercent: null, memoryBytes: null, containers: null, generation: null });
  expect(result.samples[2]).toMatchObject({ status: 'ok', cpuPercent: 0, containers: 1, generation: 'bbbbbbbbbbbbbbbb' });
  expect(result.earliestAvailableAt).toBe('2026-11-25T10:00:00.000Z');
  expect(result.truncated).toBe(false);
});

it('discards stale delayed samples when service changes or is deleted and respects maintenance drain', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'servus-metrics-race-'));
  const store = new Store(dataDir);
  const admin = store.setup('admin@example.test', 'fixture-hash');
  const project = store.createProject('race-project');
  const service = createRunningService(store, project.id, admin.id, 'worker');
  const maintenance = new MaintenanceGate();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const agentRequest = vi.fn(async () => {
    await gate;
    return { cpuPercent: 42, memoryBytes: 1024, memoryLimitBytes: 2048, networkRxBytes: 0, networkTxBytes: 0, containers: 1, generation: '1111111111111111' };
  });

  const history = new MetricsHistory({
    store,
    serviceAccess: () => { throw new Error('Unused'); },
    agentRequest: agentRequest as never,
    maintenance,
    startCollector: false,
  });
  cleanups.push(async () => { await history.close(); store.close(); rmSync(dataDir, { recursive: true, force: true }); });

  const pendingTick = history.tick();
  await vi.waitFor(() => expect(agentRequest).toHaveBeenCalledTimes(1));
  // Mutate deployed_revision while the agent sample is in flight.
  store.db.prepare('UPDATE services SET deployed_revision = 2 WHERE id = ?').run(service.id);
  release();
  await pendingTick;
  expect(history.query(store.getService(service.id)!, '1h').samples).toHaveLength(0);

  // During maintenance drain, new ticks must be refused.
  expect(await maintenance.drain(500)).toEqual({ status: 'drained' });
  await history.tick();
  expect(agentRequest).toHaveBeenCalledTimes(1);
});

it('enforces 24h TTL and row capacity cap with injected clock', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'servus-metrics-ttl-'));
  const store = new Store(dataDir);
  const admin = store.setup('admin@example.test', 'fixture-hash');
  const project = store.createProject('ttl-project');
  const service = createRunningService(store, project.id, admin.id, 'api');
  let clock = new Date('2026-11-24T00:00:00.000Z');
  const agentRequest = vi.fn(async () => ({
    cpuPercent: 12.5, memoryBytes: 10 * 1024 * 1024, memoryLimitBytes: 128 * 1024 * 1024, networkRxBytes: 0, networkTxBytes: 0, containers: 1, generation: 'cccccccccccccccc',
  }));
  const history = new MetricsHistory({
    store,
    serviceAccess: () => { throw new Error('Unused'); },
    agentRequest: agentRequest as never,
    now: () => clock,
    maxRows: 3,
    startCollector: false,
  });
  cleanups.push(async () => { await history.close(); store.close(); rmSync(dataDir, { recursive: true, force: true }); });

  for (let i = 0; i < 5; i++) {
    clock = new Date(Date.parse('2026-11-24T00:00:00.000Z') + i * 60_000);
    await history.tick();
  }
  const capped = history.query(service, '24h');
  expect(capped.samples).toHaveLength(3);
  expect(capped.truncated).toBe(true);
  expect(capped.earliestAvailableAt).toBe('2026-11-24T00:02:00.000Z');

  // Advance past 24h TTL; old samples must be pruned.
  clock = new Date('2026-11-25T05:00:00.000Z');
  await history.tick();
  const afterTtl = history.query(service, '24h');
  expect(afterTtl.samples).toHaveLength(1);
  expect(afterTtl.samples[0]!.sampledAt).toBe('2026-11-25T05:00:00.000Z');
});

it('enforces project isolation, live membership and API token revocation on /metrics/history and exposes OpenAPI', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'servus-metrics-api-'));
  const store = new Store(dataDir);
  const admin = store.setup('admin@example.test', 'fixture-hash');
  const projectA = store.createProject('project-a');
  const projectB = store.createProject('project-b');
  const serviceA = createRunningService(store, projectA.id, admin.id, 'svc-a');
  const serviceB = createRunningService(store, projectB.id, admin.id, 'svc-b');

  const app = await createApp({
    dataDir,
    store,
    metricsCollector: { start: false },
  });
  cleanups.push(async () => { await app.close(); store.close(); rmSync(dataDir, { recursive: true, force: true }); });

  const adminSession = store.createSession(admin.id);
  const adminHeaders = { cookie: `panel_session=${adminSession.token}`, 'x-csrf-token': adminSession.csrfToken };

  // Unauthenticated access denied
  expect((await app.inject({ url: `/api/v1/services/${serviceA.id}/metrics/history` })).statusCode).toBe(401);

  // Invalid window rejected
  expect((await app.inject({ url: `/api/v1/services/${serviceA.id}/metrics/history?window=7d`, headers: adminHeaders })).statusCode).toBe(400);

  // Valid admin read
  const ok = await app.inject({ url: `/api/v1/services/${serviceA.id}/metrics/history?window=6h`, headers: adminHeaders });
  expect(ok.statusCode).toBe(200);
  expect(ok.json()).toMatchObject({ serviceId: serviceA.id, window: '6h', intervalSeconds: 60, retentionHours: 24, samples: [] });

  // Viewer can read own project, not foreign project
  const viewer = store.createUser('viewer@example.test', 'fixture-hash');
  store.addMember(projectA.id, viewer.id, 'viewer');
  const viewerSession = store.createSession(viewer.id);
  const viewerHeaders = { cookie: `panel_session=${viewerSession.token}`, 'x-csrf-token': viewerSession.csrfToken };
  expect((await app.inject({ url: `/api/v1/services/${serviceA.id}/metrics/history`, headers: viewerHeaders })).statusCode).toBe(200);
  expect((await app.inject({ url: `/api/v1/services/${serviceB.id}/metrics/history`, headers: viewerHeaders })).statusCode).toBe(404);

  // Project-scoped read API token works for projectA, denied for projectB, and immediately revoked
  const tokenRes = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/api-tokens',
    headers: viewerHeaders,
    payload: { projectId: projectA.id, name: 'metrics-reader', scope: 'read', expiresInDays: 7 },
  });
  expect(tokenRes.statusCode).toBe(201);
  const { id: tokenId, token } = tokenRes.json() as { id: string; token: string };
  const bearer = { authorization: `Bearer ${token}` };
  expect((await app.inject({ url: `/api/v1/services/${serviceA.id}/metrics/history?window=24h`, headers: bearer })).statusCode).toBe(200);
  expect((await app.inject({ url: `/api/v1/services/${serviceB.id}/metrics/history?window=24h`, headers: bearer })).statusCode).toBe(404);

  // OpenAPI exposes /services/{id}/metrics/history
  const spec = await app.inject({ url: '/api/v1/openapi.json', headers: bearer });
  expect(spec.statusCode).toBe(200);
  expect(spec.json().paths['/services/{id}/metrics/history']).toBeDefined();

  // Revoke token -> immediate 401
  expect((await app.inject({ method: 'DELETE', url: `/api/v1/auth/api-tokens/${tokenId}`, headers: viewerHeaders })).statusCode).toBe(200);
  expect((await app.inject({ url: `/api/v1/services/${serviceA.id}/metrics/history`, headers: bearer })).statusCode).toBe(401);
});

it('serves admin-only host metrics and project-scoped Compose metrics with API token and OpenAPI coverage', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'servus-host-compose-metrics-'));
  const store = new Store(dataDir);
  const admin = store.setup('admin@example.test', 'fixture-hash');
  const member = store.createUser('member@example.test', 'fixture-hash');
  const projectA = store.createProject('compose-a');
  const projectB = store.createProject('compose-b');
  store.addMember(projectA.id, member.id, 'viewer');

  const agentRequest = vi.fn(async (path: string) => {
    if (path === '/host/metrics') {
      return {
        sampledAt: '2026-11-25T10:00:00.000Z',
        cpuCount: 4,
        loadAverage1m: 0.42,
        loadAverage5m: 0.35,
        loadAverage15m: 0.28,
        memoryTotalBytes: 8 * 1024 ** 3,
        memoryUsedBytes: 3 * 1024 ** 3,
        memoryFreeBytes: 5 * 1024 ** 3,
        diskTotalBytes: 100 * 1024 ** 3,
        diskUsedBytes: 40 * 1024 ** 3,
        diskAvailableBytes: 60 * 1024 ** 3,
        uptimeSeconds: 7200,
      };
    }
    if (path.startsWith('/compose/') && path.includes('/metrics')) {
      return {
        cpuPercent: 18.4,
        memoryBytes: 64 * 1024 * 1024,
        memoryLimitBytes: 512 * 1024 * 1024,
        networkRxBytes: 2048,
        networkTxBytes: 4096,
        containers: 2,
        sampledAt: '2026-11-25T10:00:00.000Z',
        generation: 'deadbeefcafebabe',
      };
    }
    throw new Error(`Unexpected agent path: ${path}`);
  });

  const app = await createApp({
    dataDir,
    store,
    agentRequest: agentRequest as never,
    metricsCollector: { start: false },
  });
  cleanups.push(async () => { await app.close(); store.close(); rmSync(dataDir, { recursive: true, force: true }); });

  const adminSession = store.createSession(admin.id);
  const adminHeaders = { cookie: `panel_session=${adminSession.token}`, 'x-csrf-token': adminSession.csrfToken };
  const memberSession = store.createSession(member.id);
  const memberHeaders = { cookie: `panel_session=${memberSession.token}`, 'x-csrf-token': memberSession.csrfToken };

  // Host metrics: admin allowed, member forbidden, unauthenticated 401
  expect((await app.inject({ url: '/api/v1/host/metrics' })).statusCode).toBe(401);
  expect((await app.inject({ url: '/api/v1/host/metrics', headers: memberHeaders })).statusCode).toBe(403);
  const hostRes = await app.inject({ url: '/api/v1/host/metrics', headers: adminHeaders });
  expect(hostRes.statusCode).toBe(200);
  expect(hostRes.json()).toMatchObject({ cpuCount: 4, diskAvailableBytes: 60 * 1024 ** 3 });
  const localHost = collectHostMetrics(dataDir);
  expect(localHost.cpuCount).toBeGreaterThanOrEqual(1);
  expect(localHost.memoryTotalBytes).toBeGreaterThan(0);
  expect(localHost.diskTotalBytes).toBeGreaterThan(0);

  // Create Compose workloads in projectA and projectB
  const yaml = 'services:\n  web:\n    image: nginx:alpine\n';
  const createA = await app.inject({
    method: 'POST',
    url: `/api/v1/projects/${projectA.id}/compose`,
    headers: { ...adminHeaders, 'idempotency-key': 'compose-metrics-a' },
    payload: { name: 'stack-a', source: { type: 'inline', yaml }, domains: [] },
  });
  expect(createA.statusCode).toBe(202);
  const workloadA = createA.json().workload as { id: string };

  const createB = await app.inject({
    method: 'POST',
    url: `/api/v1/projects/${projectB.id}/compose`,
    headers: { ...adminHeaders, 'idempotency-key': 'compose-metrics-b' },
    payload: { name: 'stack-b', source: { type: 'inline', yaml }, domains: [] },
  });
  expect(createB.statusCode).toBe(202);
  const workloadB = createB.json().workload as { id: string };

  // Project-scoped read token works for workloadA, denied for workloadB and /host/metrics
  const tokenRes = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/api-tokens',
    headers: memberHeaders,
    payload: { projectId: projectA.id, name: 'compose-metrics-reader', scope: 'read', expiresInDays: 7 },
  });
  expect(tokenRes.statusCode).toBe(201);
  const bearer = { authorization: `Bearer ${tokenRes.json().token}` };

  expect((await app.inject({ url: '/api/v1/host/metrics', headers: bearer })).statusCode).toBe(403);
  const metricsA = await app.inject({ url: `/api/v1/compose/${workloadA.id}/metrics`, headers: bearer });
  expect(metricsA.statusCode).toBe(200);
  expect(metricsA.json()).toMatchObject({ cpuPercent: 18.4, containers: 2, generation: 'deadbeefcafebabe' });
  expect((await app.inject({ url: `/api/v1/compose/${workloadB.id}/metrics`, headers: bearer })).statusCode).toBe(404);

  const spec = await app.inject({ url: '/api/v1/openapi.json', headers: bearer });
  expect(spec.statusCode).toBe(200);
  expect(spec.json().paths['/compose/{id}/metrics']).toBeDefined();
});
