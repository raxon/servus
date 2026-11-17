import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../../src/server/app.js';
import { Store } from '../../src/server/store.js';
import { hashPassword } from '../../src/server/auth.js';
import type { Service } from '../../src/shared/types.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'servus-deployment-options-')), store = new Store(dir), app = await createApp({ dataDir: dir, store });
  cleanup.push(async () => { await app.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const setup = await app.inject({ method: 'POST', url: '/api/v1/setup', payload: { email: 'admin@example.test', password: 'fixture-admin-password' } });
  const administrator = setup.json().user, headers = { cookie: `panel_session=${setup.cookies.find(item => item.name === 'panel_session')!.value}`, 'x-csrf-token': setup.json().csrfToken };
  const project = store.createProject('source-options');
  const create = async (configuration: object = {}) => {
    const response = await app.inject({ method: 'POST', url: `/api/v1/projects/${project.id}/services`, headers: { ...headers, 'idempotency-key': randomUUID() }, payload: {
      name: `app-${randomUUID().slice(0, 8)}`, domains: [], source: { type: 'git', repository: 'https://github.com/example/app.git', branch: 'main', context: '.', dockerfile: 'Dockerfile', envFile: '.env' }, ...configuration,
    } });
    expect(response.statusCode).toBe(202);
    const job = store.claimNextJob('fixture', 60_000)!;
    store.completeAction(job.actionId, 'fixture', { state: 'running', deployedRevision: 1, sourceCommit: 'a'.repeat(40), imageDigest: `sha256:${'b'.repeat(64)}` });
    return response.json().service as Service;
  };
  const deploy = (serviceId: string, payload: unknown, key = randomUUID()) => app.inject({ method: 'POST', url: `/api/v1/services/${serviceId}/deploy`, headers: { ...headers, 'idempotency-key': key }, payload });
  const snapshot = (actionId: string) => JSON.parse((store.db.prepare('SELECT snapshot FROM jobs WHERE action_id=?').get(actionId) as { snapshot: string }).snapshot) as Service;
  return { dir, store, app, headers, administrator, project, create, deploy, snapshot };
}

describe('Force Rebuild action contract', () => {
  it('persists the option only in its job and rejects normal versus forced idempotency-key reuse', async () => {
    const f = await fixture(), service = await f.create(), key = randomUUID();
    const response = await f.deploy(service.id, { forceRebuild: true }, key);
    expect(response.statusCode).toBe(202);
    const action = response.json();
    expect(f.snapshot(action.id)).toMatchObject({ deploymentOptions: { forceRebuild: true }, source: { envFile: '.env' } });
    expect(f.store.getService(service.id)).not.toHaveProperty('deploymentOptions');
    expect((f.store.db.prepare('SELECT config FROM services WHERE id=?').get(service.id) as { config: string }).config).not.toContain('forceRebuild');
    const repeated = await f.deploy(service.id, { forceRebuild: true }, key);
    expect(repeated.statusCode).toBe(202); expect(repeated.json().id).toBe(action.id);
    const mismatch = await f.deploy(service.id, { forceRebuild: false }, key);
    expect(mismatch.statusCode).toBe(409); expect(mismatch.json().error.code).toBe('IDEMPOTENCY_CONFLICT');
    const absent = await f.deploy(service.id, {}, key);
    expect(absent.statusCode).toBe(409);
  });

  it('recovers the same durable forced action and does not inherit it on start, restart or history', async () => {
    const f = await fixture(), service = await f.create();
    const response = await f.deploy(service.id, { forceRebuild: true }); expect(response.statusCode).toBe(202);
    const action = response.json(), original = f.store.claimNextJob('old-worker', 60_000)!;
    f.store.db.prepare('UPDATE jobs SET lease_until=? WHERE id=?').run('2000-01-01T00:00:00.000Z', original.id);
    const recoveredStore = new Store(f.dir);
    try {
      const recovered = recoveredStore.claimNextJob('new-worker', 60_000)!;
      expect(recovered).toMatchObject({ actionId: action.id, recovered: true, attempts: 2, snapshot: { deploymentOptions: { forceRebuild: true } } });
      expect(f.store.completeAction(action.id, 'old-worker')).toBe(false);
      expect(recoveredStore.completeAction(action.id, 'new-worker', { state: 'running', deployedRevision: 1, sourceCommit: 'a'.repeat(40), imageDigest: `sha256:${'b'.repeat(64)}` })).toBe(true);
    } finally { recoveredStore.close(); }
    for (const type of ['start', 'restart'] as const) {
      const next = await f.app.inject({ method: 'POST', url: `/api/v1/services/${service.id}/${type}`, headers: { ...f.headers, 'idempotency-key': randomUUID() } });
      expect(next.statusCode).toBe(202); expect(f.snapshot(next.json().id)).not.toHaveProperty('deploymentOptions');
      const job = f.store.claimNextJob('next-worker', 60_000)!; f.store.completeAction(job.actionId, 'next-worker', { state: 'running' });
    }
    const history = await f.app.inject({ method: 'POST', url: `/api/v1/services/${service.id}/deployments/${action.id}/redeploy`, headers: { ...f.headers, 'idempotency-key': randomUUID() }, payload: { confirm: true } });
    expect(history.statusCode).toBe(202);
    expect(f.snapshot(history.json().id)).toMatchObject({ rollbackImage: `sha256:${'b'.repeat(64)}`, rollbackCommit: 'a'.repeat(40) });
    expect(f.snapshot(history.json().id)).not.toHaveProperty('deploymentOptions');
  });

  it('rejects forced builds of image applications and managed databases without queuing work', async () => {
    const f = await fixture();
    for (const configuration of [{ source: { type: 'image' }, image: 'nginx:alpine' }, { kind: 'postgres', source: { type: 'image' } }]) {
      const service = await f.create(configuration), before = f.store.listActions(undefined, service.id).length;
      const response = await f.deploy(service.id, { forceRebuild: true });
      expect(response.statusCode).toBe(400); expect(response.json().error.code).toBe('BUILD_UNSUPPORTED');
      expect(f.store.listActions(undefined, service.id)).toHaveLength(before);
    }
  });

  it.each([{ forceRebuild: 'true' }, { forceRebuild: true, command: 'arbitrary' }, { deploymentOptions: { forceRebuild: true } }])('rejects malformed deploy options: %j', async options => {
    const f = await fixture(), service = await f.create();
    const response = await f.deploy(service.id, options);
    expect(response.statusCode).toBe(400);
    expect(f.store.claimNextJob('unexpected-worker', 60_000)).toBeNull();
  });

  it('keeps CSRF and project write authorization on forced deployments', async () => {
    const f = await fixture(), service = await f.create();
    const withoutCsrf = await f.app.inject({ method: 'POST', url: `/api/v1/services/${service.id}/deploy`, headers: { cookie: f.headers.cookie, 'idempotency-key': randomUUID() }, payload: { forceRebuild: true } });
    expect(withoutCsrf.statusCode).toBe(403);
    for (const role of ['viewer', 'outsider'] as const) {
      const user = f.store.createUser(`${role}@example.test`, await hashPassword('fixture-member-password'));
      if (role === 'viewer') f.store.addMember(f.project.id, user.id, 'viewer');
      const session = f.store.createSession(user.id);
      const denied = await f.app.inject({ method: 'POST', url: `/api/v1/services/${service.id}/deploy`, headers: { cookie: `panel_session=${session.token}`, 'x-csrf-token': session.csrfToken, 'idempotency-key': randomUUID() }, payload: { forceRebuild: true } });
      expect(denied.statusCode).toBe(404);
    }
    expect(f.store.claimNextJob('unexpected-worker', 60_000)).toBeNull();
  });
});
