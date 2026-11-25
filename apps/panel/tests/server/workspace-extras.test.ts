import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../../src/server/app.js';
import { Store } from '../../src/server/store.js';
import { readProjectEnvironment, readBuildConcurrency } from '../../src/server/workspace-extras.js';
import { compileDomainLabels } from '../../src/agent/route-labels.js';
import { Worker } from '../../src/worker/runner.js';
import type { agentRequest } from '../../src/agent/client.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), 'servus-extras-'));
  const store = new Store(dataDir);
  const execCalls: Array<{ path: string; body: unknown }> = [];
  const agent: typeof agentRequest = async <T>(path, body) => {
    execCalls.push({ path, body });
    if (path.endsWith('/exec')) {
      return { exitCode: 0, output: 'ran-ok\n', timedOut: false, truncated: false, durationMs: 42 } as T;
    }
    if (path === '/compose/apply') {
      return { state: 'running', revision: (body as { revision: number }).revision, logs: 'ok' } as T;
    }
    return {} as T;
  };
  const app = await createApp({ dataDir, store, agentRequest: agent });
  cleanup.push(async () => {
    await app.close();
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  const setup = await app.inject({ method: 'POST', url: '/api/v1/setup', payload: { email: 'admin@example.test', password: 'fixture-password' } });
  const user = setup.json().user as { id: string };
  const session = { cookie: `panel_session=${setup.cookies[0]!.value}`, 'x-csrf-token': setup.json().csrfToken };
  const project = store.createProject('extras-project');
  const { service } = store.createService(project.id, { name: 'web', image: 'nginx:alpine', hostname: 'web.example.test', port: 80, replicas: 1 }, user.id);
  // Drain/mark initial queued deploy so test can queue its own actions cleanly
  store.db.prepare("UPDATE jobs SET status='succeeded' WHERE service_id=?").run(service.id);
  store.db.prepare("UPDATE actions SET status='succeeded', phase='completed' WHERE service_id=?").run(service.id);
  return { app, store, dataDir, user, session, project, service, execCalls };
}

describe('P2-A workspace extras, trusted proxies & P2-C Compose private Git', () => {
  it('manages project-level shared environment variables with secret sealing and deletion', async () => {
    const f = await fixture();
    const put = await f.app.inject({
      method: 'PUT',
      url: `/api/v1/projects/${f.project.id}/env`,
      headers: f.session,
      payload: {
        variables: [
          { name: 'APP_ENV', value: 'production', secret: false },
          { name: 'SHARED_API_KEY', value: 'super-secret-value-123', secret: true },
        ],
      },
    });
    expect(put.statusCode).toBe(200);
    const listed = put.json().variables as Array<{ name: string; value?: string; secret: boolean; hasValue: boolean }>;
    expect(listed.find(v => v.name === 'APP_ENV')?.value).toBe('production');
    expect(listed.find(v => v.name === 'SHARED_API_KEY')?.value).toBeUndefined();
    expect(listed.find(v => v.name === 'SHARED_API_KEY')?.hasValue).toBe(true);

    // Updating without resending secret value preserves the sealed secret
    const preserve = await f.app.inject({
      method: 'PUT',
      url: `/api/v1/projects/${f.project.id}/env`,
      headers: f.session,
      payload: {
        variables: [
          { name: 'APP_ENV', value: 'staging', secret: false },
          { name: 'SHARED_API_KEY', secret: true },
        ],
      },
    });
    expect(preserve.statusCode).toBe(200);
    const decrypted = readProjectEnvironment(f.dataDir, f.project.id, f.store.vault);
    expect(decrypted).toEqual([
      { name: 'APP_ENV', value: 'staging', secret: false },
      { name: 'SHARED_API_KEY', value: 'super-secret-value-123', secret: true },
    ]);

    const del = await f.app.inject({
      method: 'DELETE',
      url: `/api/v1/projects/${f.project.id}/env/SHARED_API_KEY`,
      headers: f.session,
    });
    expect(del.statusCode).toBe(200);
    expect(readProjectEnvironment(f.dataDir, f.project.id, f.store.vault).map(v => v.name)).toEqual(['APP_ENV']);
  });

  it('creates, updates, runs and deletes saved operational scripts', async () => {
    const f = await fixture();
    const created = await f.app.inject({
      method: 'POST',
      url: `/api/v1/projects/${f.project.id}/scripts`,
      headers: f.session,
      payload: { name: 'Run migrations', description: 'Apply SQL migrations', command: 'npm run migrate', serviceId: f.service.id },
    });
    expect(created.statusCode).toBe(201);
    const scriptId = created.json().script.id as string;

    // Fails before service is deployed
    const blocked = await f.app.inject({
      method: 'POST',
      url: `/api/v1/projects/${f.project.id}/scripts/${scriptId}/run`,
      headers: f.session,
      payload: {},
    });
    expect(blocked.statusCode).toBe(409);

    // Mark service running and execute
    f.store.db.prepare("UPDATE services SET state='running', deployed_revision=1 WHERE id=?").run(f.service.id);
    const run = await f.app.inject({
      method: 'POST',
      url: `/api/v1/projects/${f.project.id}/scripts/${scriptId}/run`,
      headers: f.session,
      payload: { timeoutSeconds: 15 },
    });
    expect(run.statusCode).toBe(200);
    expect(run.json()).toMatchObject({ exitCode: 0, output: 'ran-ok\n', scriptId, serviceId: f.service.id });
    expect(f.execCalls.some(c => c.path === `/services/${f.service.id}/exec`)).toBe(true);

    const updated = await f.app.inject({
      method: 'PUT',
      url: `/api/v1/projects/${f.project.id}/scripts/${scriptId}`,
      headers: f.session,
      payload: { name: 'Seed DB', description: 'Seed', command: 'npm run seed', serviceId: f.service.id },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().script.name).toBe('Seed DB');

    const removed = await f.app.inject({
      method: 'DELETE',
      url: `/api/v1/projects/${f.project.id}/scripts/${scriptId}`,
      headers: f.session,
    });
    expect(removed.statusCode).toBe(200);
  });

  it('persists build concurrency settings and runs concurrent worker jobs up to limit', async () => {
    const f = await fixture();
    expect(readBuildConcurrency(f.dataDir)).toBe(1);
    const put = await f.app.inject({
      method: 'PUT',
      url: '/api/v1/settings/build-concurrency',
      headers: f.session,
      payload: { maxConcurrentBuilds: 3 },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().maxConcurrentBuilds).toBe(3);
    expect(readBuildConcurrency(f.dataDir)).toBe(3);

    const bad = await f.app.inject({
      method: 'PUT',
      url: '/api/v1/settings/build-concurrency',
      headers: f.session,
      payload: { maxConcurrentBuilds: 99 },
    });
    expect(bad.statusCode).toBe(400);

    // Verify Worker runs two different services concurrently when limit=2
    const { service: s2 } = f.store.createService(f.project.id, { name: 'api', image: 'nginx:alpine', hostname: 'api.example.test', port: 80, replicas: 1 }, f.user.id);
    f.store.createAction(f.service.id, 'deploy', f.user.id, 'k1');
    // s2 already has an initial queued deploy action from createService
    let inflight = 0, peak = 0;
    const resolvers: Array<() => void> = [];
    const worker = new Worker(f.store, 60000, {
      maxConcurrency: () => 2,
      apply: async () => {
        inflight++;
        peak = Math.max(peak, inflight);
        await new Promise<void>(resolve => {
          resolvers.push(resolve);
          if (resolvers.length === 2) resolvers.splice(0).forEach(fn => fn());
        });
        inflight--;
        return { state: 'running', deployedRevision: 1, messages: ['ok'] };
      },
    });
    await Promise.all([worker.once(), worker.once()]);
    await worker.drain(1000);
    expect(peak).toBe(2);
  });

  it('validates trustedProxies on domains and compiles Traefik ipStrategy labels', async () => {
    const f = await fixture();
    // Rejected without ipAllowList
    const invalid = await f.app.inject({
      method: 'PATCH',
      url: `/api/v1/services/${f.service.id}`,
      headers: f.session,
      payload: {
        expectedRevision: 1,
        domains: [{ hostname: 'web.example.test', port: 80, trustedProxies: { depth: 1 } }],
      },
    });
    expect(invalid.statusCode).toBe(400);

    // Accepted with ipAllowList
    const valid = await f.app.inject({
      method: 'PATCH',
      url: `/api/v1/services/${f.service.id}`,
      headers: f.session,
      payload: {
        expectedRevision: 1,
        domains: [{ hostname: 'web.example.test', port: 80, ipAllowList: ['10.0.0.0/8'], trustedProxies: { excludedIps: ['172.16.0.0/12', '127.0.0.1'] } }],
      },
    });
    expect(valid.statusCode).toBe(200);

    const depthLabels = compileDomainLabels(f.service.id, 0, {
      hostname: 'web.example.test',
      port: 80,
      ipAllowList: ['203.0.113.10/32'],
      trustedProxies: { depth: 2 },
    });
    const key = `${f.service.id.replaceAll('-', '')}-0`;
    expect(depthLabels[`traefik.http.middlewares.${key}-ipallow.ipallowlist.ipstrategy.depth`]).toBe('2');

    const excludedLabels = compileDomainLabels(f.service.id, 0, {
      hostname: 'web.example.test',
      port: 80,
      ipAllowList: ['203.0.113.10/32'],
      trustedProxies: { excludedIps: ['172.16.0.0/12', '10.0.0.1'] },
    });
    expect(excludedLabels[`traefik.http.middlewares.${key}-ipallow.ipallowlist.ipstrategy.excludedips`]).toBe('172.16.0.0/12,10.0.0.1');
  });

  it('redacts and preserves private Git credentials on Compose workloads', async () => {
    const f = await fixture();
    const created = await f.app.inject({
      method: 'POST',
      url: `/api/v1/projects/${f.project.id}/compose`,
      headers: { ...f.session, 'idempotency-key': randomUUID() },
      payload: {
        name: 'priv-git',
        source: {
          type: 'git',
          repository: 'https://github.com/org/private-compose.git',
          branch: 'main',
          path: 'compose.yaml',
          credential: { username: 'x-access-token', token: 'ghp_super_secret_token_999' },
        },
        domains: [],
      },
    });
    expect(created.statusCode).toBe(202);
    const workloadId = created.json().workload.id as string;

    const config = await f.app.inject({
      method: 'GET',
      url: `/api/v1/compose/${workloadId}/configuration`,
      headers: f.session,
    });
    expect(config.statusCode).toBe(200);
    expect(config.body).not.toContain('ghp_super_secret_token_999');
    expect(config.json().source.credential).toEqual({ username: 'x-access-token', hasToken: true });

    // Patching branch without resending token keeps stored token
    const patched = await f.app.inject({
      method: 'PATCH',
      url: `/api/v1/compose/${workloadId}`,
      headers: f.session,
      payload: {
        expectedRevision: 1,
        source: {
          type: 'git',
          repository: 'https://github.com/org/private-compose.git',
          branch: 'release',
          path: 'compose.yaml',
          credential: { username: 'x-access-token' },
        },
        domains: [],
      },
    });
    expect(patched.statusCode).toBe(200);
    const afterPatch = await f.app.inject({
      method: 'GET',
      url: `/api/v1/compose/${workloadId}/configuration`,
      headers: f.session,
    });
    expect(afterPatch.json().source.branch).toBe('release');
    expect(afterPatch.json().source.credential).toEqual({ username: 'x-access-token', hasToken: true });
  });
});
