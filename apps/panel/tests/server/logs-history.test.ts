import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../../src/server/app.js';
import { LogsHistory } from '../../src/server/logs-history.js';
import { MaintenanceGate } from '../../src/server/maintenance.js';
import { Store } from '../../src/server/store.js';
import { normalizeServiceInput } from '../../src/server/configuration.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
  vi.restoreAllMocks();
});

function createRunningService(store: Store, projectId: string, actorId: string, name: string, secretValue?: string) {
  const { service } = store.createService(
    projectId,
    normalizeServiceInput({
      name,
      image: 'nginx:alpine',
      port: 80,
      hostname: `${name}.localhost`,
      ...(secretValue ? { environment: [{ name: 'API_KEY', value: secretValue, secret: true }] } : {}),
    }),
    actorId,
  );
  const job = store.claimNextJob('logs-test', 60_000)!;
  store.completeAction(job.actionId, 'logs-test', { state: 'running', deployedRevision: 1 });
  return store.getService(service.id)!;
}

describe('historical log archive and search', () => {
  it('collects, redacts secrets, deduplicates, filters by level/query and enforces retention + row cap', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'servus-logs-history-'));
    const store = new Store(dir);
    const admin = store.setup('admin@example.test', 'fixture-hash');
    const project = store.createProject('logs-project');
    const secret = 'super-secret-token-value-12345';
    const service = createRunningService(store, project.id, admin.id, 'api', secret);

    let clock = new Date('2026-11-25T10:00:00.000Z');
    const agentRequest = vi.fn(async () => ({
      lines: [
        '2026-11-25T09:59:10.000Z INFO Server started cleanly',
        `2026-11-25T09:59:20.000Z WARN Retry auth header=${secret}`,
        '2026-11-25T09:59:30.000Z ERROR Database connection refused',
      ],
    }));

    const history = new LogsHistory({
      store,
      serviceAccess: () => { throw new Error('Unused'); },
      agentRequest: agentRequest as never,
      now: () => clock,
      maxRows: 4,
      startCollector: false,
    });
    cleanups.push(async () => { await history.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });

    await history.tick();
    // Second tick with identical lines must deduplicate
    await history.tick();

    const all = history.query(service, { window: '1h' });
    expect(all.entries).toHaveLength(3);
    expect(all.entries.map(e => e.level)).toEqual(['info', 'warn', 'error']);
    expect(all.entries[1]!.line).not.toContain(secret);
    expect(all.entries[1]!.line).toContain('[REDACTED]');

    // Level and text filtering
    const errorsOnly = history.query(service, { window: '1h', level: 'error' });
    expect(errorsOnly.entries).toHaveLength(1);
    expect(errorsOnly.entries[0]!.line).toContain('Database connection refused');

    const search = history.query(service, { window: '1h', q: 'connection' });
    expect(search.entries).toHaveLength(1);

    // Row cap eviction sets truncated=true
    agentRequest.mockResolvedValueOnce({
      lines: [
        '2026-11-25T10:01:00.000Z INFO Fourth line',
        '2026-11-25T10:01:10.000Z INFO Fifth line',
      ],
    });
    clock = new Date('2026-11-25T10:02:00.000Z');
    await history.tick();
    const afterCap = history.query(service, { window: '1h' });
    expect(afterCap.entries).toHaveLength(4);
    expect(afterCap.truncated).toBe(true);

    // Advance beyond 7-day TTL -> old entries pruned
    agentRequest.mockResolvedValueOnce({ lines: ['2026-12-05T10:00:00.000Z INFO Fresh line'] });
    clock = new Date('2026-12-05T10:01:00.000Z');
    await history.tick();
    const afterTtl = history.query(service, { window: '7d' });
    expect(afterTtl.entries).toHaveLength(1);
    expect(afterTtl.entries[0]!.line).toContain('Fresh line');
  });

  it('respects maintenance drain, project isolation, API token revocation and OpenAPI', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'servus-logs-api-'));
    const store = new Store(dir);
    const admin = store.setup('admin@example.test', 'fixture-hash');
    const viewer = store.createUser('viewer@example.test', 'fixture-hash');
    const p1 = store.createProject('p1');
    const p2 = store.createProject('p2');
    store.addMember(p1.id, viewer.id, 'viewer');
    const svc1 = createRunningService(store, p1.id, admin.id, 'svc1');
    const svc2 = createRunningService(store, p2.id, admin.id, 'svc2');

    const maintenance = new MaintenanceGate();
    const app = await createApp({
      dataDir: dir,
      store,
      maintenance,
      metricsCollector: { start: false },
      logsCollector: { start: false },
    });
    cleanups.push(async () => { await app.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });

    const viewerSession = store.createSession(viewer.id);
    const viewerHeaders = { cookie: `panel_session=${viewerSession.token}`, 'x-csrf-token': viewerSession.csrfToken };

    expect((await app.inject({ url: `/api/v1/services/${svc1.id}/logs/history` })).statusCode).toBe(401);
    expect((await app.inject({ url: `/api/v1/services/${svc1.id}/logs/history?window=30d`, headers: viewerHeaders })).statusCode).toBe(400);
    expect((await app.inject({ url: `/api/v1/services/${svc1.id}/logs/history`, headers: viewerHeaders })).statusCode).toBe(200);
    expect((await app.inject({ url: `/api/v1/services/${svc2.id}/logs/history`, headers: viewerHeaders })).statusCode).toBe(404);

    const tokenRes = await app.inject({
      method: 'POST', url: '/api/v1/auth/api-tokens', headers: viewerHeaders,
      payload: { projectId: p1.id, name: 'log-reader', scope: 'read', expiresInDays: 7 },
    });
    const { id: tokenId, token } = tokenRes.json() as { id: string; token: string };
    const bearer = { authorization: `Bearer ${token}` };

    expect((await app.inject({ url: `/api/v1/services/${svc1.id}/logs/history?q=test&level=error`, headers: bearer })).statusCode).toBe(200);
    expect((await app.inject({ url: `/api/v1/services/${svc2.id}/logs/history`, headers: bearer })).statusCode).toBe(404);

    const spec = (await app.inject({ url: '/api/v1/openapi.json', headers: bearer })).json();
    expect(spec.paths['/services/{id}/logs/history'].get).toBeDefined();

    // Revoke token -> immediate 401
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/auth/api-tokens/${tokenId}`, headers: viewerHeaders })).statusCode).toBe(200);
    expect((await app.inject({ url: `/api/v1/services/${svc1.id}/logs/history`, headers: bearer })).statusCode).toBe(401);
  });
});
