import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../../src/server/app.js';
import { normalizeServiceInput } from '../../src/server/configuration.js';
import { Store } from '../../src/server/store.js';
import { compileApplicationEndpointSpec, compileHealthCheck, compileUpdateConfig } from '../../src/agent/service-options.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

describe('published TCP/UDP ports, Swarm DNSRR, healthchecks and deployment strategy', () => {
  it('validates and compiles ports, DNSRR, healthcheck and update strategy cleanly', () => {
    const appWithPorts = normalizeServiceInput({
      name: 'game-srv',
      image: 'nginx:alpine',
      hostname: 'game.localhost',
      port: 80,
      ports: [
        { publishedPort: 25565, targetPort: 25565, protocol: 'tcp' },
        { publishedPort: 25565, targetPort: 25565, protocol: 'udp' },
      ],
      healthcheck: { command: ['curl', '-f', 'http://127.0.0.1:80/health'], intervalSeconds: 15, timeoutSeconds: 3, retries: 5, startPeriodSeconds: 10 },
      deploymentStrategy: { order: 'start-first', parallelism: 2, failureAction: 'rollback', monitorSeconds: 30 },
    });

    expect(compileApplicationEndpointSpec(appWithPorts)).toEqual({
      Mode: 'vip',
      Ports: [
        { Protocol: 'tcp', PublishedPort: 25565, TargetPort: 25565, PublishMode: 'host' },
        { Protocol: 'udp', PublishedPort: 25565, TargetPort: 25565, PublishMode: 'host' },
      ],
    });
    expect(compileHealthCheck(appWithPorts.healthcheck)).toEqual({
      Test: ['CMD', 'curl', '-f', 'http://127.0.0.1:80/health'],
      Interval: 15e9,
      Timeout: 3e9,
      Retries: 5,
      StartPeriod: 10e9,
    });
    expect(compileUpdateConfig(appWithPorts, false)).toEqual({
      Parallelism: 2,
      Order: 'start-first',
      FailureAction: 'rollback',
      Monitor: 30e9,
    });
    // Stateful services always enforce stop-first and parallelism=1
    expect(compileUpdateConfig(appWithPorts, true)).toEqual({
      Parallelism: 1,
      Order: 'stop-first',
      FailureAction: 'rollback',
      Monitor: 30e9,
    });

    // DNSRR mode compiles cleanly when no published host ports are configured
    const dnsrrApp = normalizeServiceInput({ name: 'mesh', image: 'nginx:alpine', domains: [], endpointMode: 'dnsrr' });
    expect(compileApplicationEndpointSpec(dnsrrApp)).toEqual({ Mode: 'dnsrr' });

    // Reject combining DNSRR with published host ports
    expect(() => normalizeServiceInput({
      name: 'bad-dnsrr', image: 'nginx:alpine', domains: [], endpointMode: 'dnsrr',
      ports: [{ publishedPort: 9000, targetPort: 9000, protocol: 'tcp' }],
    })).toThrow(/DNSRR/);

    // Reject reserved control-plane ports and stateful start-first
    expect(() => normalizeServiceInput({
      name: 'bad-port', image: 'nginx:alpine', domains: [],
      ports: [{ publishedPort: 2377, targetPort: 80, protocol: 'tcp' }],
    })).toThrow(/reserved/i);
    expect(() => normalizeServiceInput({
      name: 'bad-stateful', image: 'nginx:alpine', domains: [],
      mounts: [{ type: 'volume', name: 'data', target: '/data' }],
      deploymentStrategy: { order: 'start-first' },
    })).toThrow(/stop-first/);
  });

  it('enforces admin-only port publishing and prevents cross-service/database port conflicts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'servus-ports-'));
    const store = new Store(dir);
    const admin = store.setup('admin@example.test', 'fixture-hash');
    const editor = store.createUser('editor@example.test', 'fixture-hash');
    const projectA = store.createProject('pa');
    const projectB = store.createProject('pb');
    store.addMember(projectA.id, editor.id, 'editor');

    const app = await createApp({
      dataDir: dir,
      store,
      metricsCollector: { start: false },
      logsCollector: { start: false },
      alertsEvaluator: { start: false },
    });
    cleanups.push(async () => { await app.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });

    const adminSession = store.createSession(admin.id);
    const adminHeaders = { cookie: `panel_session=${adminSession.token}`, 'x-csrf-token': adminSession.csrfToken };
    const editorSession = store.createSession(editor.id);
    const editorHeaders = { cookie: `panel_session=${editorSession.token}`, 'x-csrf-token': editorSession.csrfToken };

    // Non-admin editor cannot publish host TCP/UDP ports
    const denied = await app.inject({
      method: 'POST', url: `/api/v1/projects/${projectA.id}/services`, headers: { ...editorHeaders, 'idempotency-key': 'port-denied-1' },
      payload: { name: 'ed-app', image: 'nginx:alpine', domains: [], ports: [{ publishedPort: 29000, targetPort: 80, protocol: 'tcp' }] },
    });
    expect(denied.statusCode).toBe(403);

    // Admin creates service A on TCP 29000
    const createdA = await app.inject({
      method: 'POST', url: `/api/v1/projects/${projectA.id}/services`, headers: { ...adminHeaders, 'idempotency-key': 'port-a-1' },
      payload: { name: 'svc-a', image: 'nginx:alpine', domains: [], ports: [{ publishedPort: 29000, targetPort: 80, protocol: 'tcp' }] },
    });
    expect(createdA.statusCode).toBe(202);

    // Service B in another project cannot steal TCP 29000, but CAN use UDP 29000
    const conflict = await app.inject({
      method: 'POST', url: `/api/v1/projects/${projectB.id}/services`, headers: { ...adminHeaders, 'idempotency-key': 'port-b-conflict' },
      payload: { name: 'svc-b', image: 'nginx:alpine', domains: [], ports: [{ publishedPort: 29000, targetPort: 80, protocol: 'tcp' }] },
    });
    expect(conflict.statusCode).toBe(409);

    const udpOk = await app.inject({
      method: 'POST', url: `/api/v1/projects/${projectB.id}/services`, headers: { ...adminHeaders, 'idempotency-key': 'port-b-udp' },
      payload: { name: 'svc-b-udp', image: 'nginx:alpine', domains: [], ports: [{ publishedPort: 29000, targetPort: 80, protocol: 'udp' }] },
    });
    expect(udpOk.statusCode).toBe(202);
  });
});
