import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../../src/server/app.js';
import { AlertsManager } from '../../src/server/alerts.js';
import { MetricsHistory } from '../../src/server/metrics-history.js';
import { Store } from '../../src/server/store.js';
import { normalizeServiceInput } from '../../src/server/configuration.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  delete process.env.PANEL_ALERT_ALLOW_HOSTS;
  for (const fn of cleanups.splice(0).reverse()) await fn();
  vi.restoreAllMocks();
});

describe('alerts and notification channels', () => {
  it('blocks private SSRF targets, encrypts channel secrets, signs HMAC webhooks, retries and enforces cooldown + hourly rate limit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'servus-alerts-'));
    const store = new Store(dir);
    const admin = store.setup('admin@example.test', 'fixture-hash');
    const member = store.createUser('member@example.test', 'fixture-hash');
    const project = store.createProject('alerts-proj');
    const { service } = store.createService(
      project.id,
      normalizeServiceInput({ name: 'api', image: 'nginx:alpine', port: 80, hostname: 'api.localhost' }),
      admin.id,
    );
    const job = store.claimNextJob('alerts-worker', 60_000)!;
    store.completeAction(job.actionId, 'alerts-worker', { state: 'running', deployedRevision: 1 });

    let clock = new Date('2026-11-25T10:00:00.000Z');
    const deliveries: { url: string; headers: Record<string, string>; body: string }[] = [];
    let failFirst = true;
    const mockFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (failFirst) {
        failFirst = false;
        return new Response('temporary upstream failure', { status: 503 });
      }
      deliveries.push({
        url: String(url),
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: String(init?.body ?? ''),
      });
      return new Response('ok', { status: 200 });
    });

    const metricsHistory = new MetricsHistory({
      store,
      serviceAccess: () => { throw new Error('Unused'); },
      agentRequest: (async () => ({
        cpuPercent: 92.5, memoryBytes: 450 * 1024 * 1024, memoryLimitBytes: 512 * 1024 * 1024,
        networkRxBytes: 0, networkTxBytes: 0, containers: 1, generation: '1111111111111111',
      })) as never,
      now: () => clock,
      startCollector: false,
    });
    await metricsHistory.tick();

    const manager = new AlertsManager({
      store,
      administrator: () => admin,
      metricsHistory,
      fetch: mockFetch as never,
      now: () => clock,
      retryDelayMs: 1,
      startEvaluator: false,
    });
    cleanups.push(async () => { await manager.close(); await metricsHistory.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });

    // SSRF protection rejects private/loopback URLs by default
    await expect(manager.createChannel({ type: 'webhook', name: 'Local', url: 'https://127.0.0.1/hook' }, admin.id))
      .rejects.toThrow(/local or private/);
    await expect(manager.createChannel({ type: 'webhook', name: 'Meta', url: 'https://169.254.169.254/latest' }, admin.id))
      .rejects.toThrow(/local or private/);

    // Allow test host explicitly
    process.env.PANEL_ALERT_ALLOW_HOSTS = 'hooks.example.test';
    const signingSecret = 'super-webhook-signing-secret';
    const channel = await manager.createChannel({
      type: 'webhook',
      name: 'Ops Webhook',
      url: 'https://hooks.example.test/servus',
      secret: signingSecret,
    }, admin.id);
    expect(channel.hasSecret).toBe(true);
    expect(JSON.stringify(channel)).not.toContain(signingSecret);

    // Create rule with 10m cooldown and maxPerHour=1
    const rule = manager.createRule({
      name: 'High CPU',
      metric: 'service_cpu_percent',
      serviceId: service.id,
      threshold: 80,
      cooldownMinutes: 10,
      maxPerHour: 1,
      channelIds: [channel.id],
    }, admin.id);

    // First evaluation breaches -> retries past 503 and succeeds on attempt 2 with valid HMAC signature
    await manager.evaluate();
    expect(deliveries).toHaveLength(1);
    const expectedSig = `sha256=${createHmac('sha256', signingSecret).update(deliveries[0]!.body).digest('hex')}`;
    expect(deliveries[0]!.headers['X-Servus-Signature-256']).toBe(expectedSig);
    expect(manager.listDeliveries()[0]).toMatchObject({ status: 'sent', attempts: 2, ruleId: rule.id });

    // Within 10m cooldown -> deduplicated (no second delivery)
    clock = new Date('2026-11-25T10:05:00.000Z');
    await manager.evaluate();
    expect(deliveries).toHaveLength(1);

    // Past cooldown (15m later), still within same hour -> maxPerHour=1 suppresses delivery
    clock = new Date('2026-11-25T10:15:00.000Z');
    await manager.evaluate();
    expect(deliveries).toHaveLength(1);
    expect(manager.listDeliveries()[0]).toMatchObject({ status: 'suppressed', ruleId: rule.id });

    // Verify admin-only HTTP enforcement through createApp
    const app = await createApp({
      dataDir: dir,
      store,
      metricsCollector: { start: false },
      logsCollector: { start: false },
      alertsEvaluator: { start: false, fetch: mockFetch as never },
    });
    cleanups.push(async () => { await app.close(); });

    const memberSession = store.createSession(member.id);
    const memberHeaders = { cookie: `panel_session=${memberSession.token}`, 'x-csrf-token': memberSession.csrfToken };
    const adminSession = store.createSession(admin.id);
    const adminHeaders = { cookie: `panel_session=${adminSession.token}`, 'x-csrf-token': adminSession.csrfToken };

    expect((await app.inject({ url: '/api/v1/alerts/channels' })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/v1/alerts/channels', headers: memberHeaders })).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/v1/alerts/channels', headers: adminHeaders })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/v1/alerts/rules', headers: adminHeaders })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/v1/alerts/history', headers: adminHeaders })).statusCode).toBe(200);
  });
});
