import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/server/app.js';
import { Store } from '../../src/server/store.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'panel-bind-access-'));
  const store = new Store(directory);
  const app = await createApp({ dataDir: directory, store });
  cleanup.push(async () => { await app.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const setup = await app.inject({ method: 'POST', url: '/api/v1/setup', payload: {
    email: 'admin@example.test', password: 'local-test-password',
  } });
  const admin = { cookie: `panel_session=${setup.cookies[0]!.value}`, 'x-csrf-token': setup.json().csrfToken };
  const project = store.createProject('bind-access');
  const user = store.createUser('editor@example.test', 'unused-login-hash');
  store.addMember(project.id, user.id, 'editor');
  const session = store.createSession(user.id);
  const editor = { cookie: `panel_session=${session.token}`, 'x-csrf-token': session.csrfToken };
  const bind = { type: 'bind', name: 'managed', target: '/data', source: join(process.env.PANEL_MANAGED_BIND_ROOT || '/var/lib/panel/mounts', 'approved') };
  const input = { name: 'web', image: 'nginx:alpine', hostname: 'bind.localhost', port: 80, mounts: [bind] };
  const create = (headers: typeof admin, key: string, payload: unknown = input) => app.inject({
    method: 'POST', url: `/api/v1/projects/${project.id}/services`, headers: { ...headers, 'idempotency-key': key }, payload,
  });
  return { app, store, project, admin, editor, bind, input, create };
}

describe('instance administrator approval for bind mounts', () => {
  it('rejects creation by a project editor without inserting a service or job', async () => {
    const { create, editor, store, project } = await fixture();
    const response = await create(editor, 'editor-create');
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('FORBIDDEN');
    expect(store.listServices(project.id)).toHaveLength(0);
    expect(store.listActions(project.id)).toHaveLength(0);
  });

  it('allows administrator approval and denies editor replacement while permitting deployment', async () => {
    const { app, store, admin, editor, bind, create } = await fixture();
    const created = await create(admin, 'admin-approved');
    expect(created.statusCode).toBe(202);
    const service = created.json().service;
    const initial = store.claimNextJob('initial-worker', 60000)!;
    store.completeAction(initial.actionId, 'initial-worker', { state: 'running', deployedRevision: 1 });
    const denied = await app.inject({ method: 'PATCH', url: `/api/v1/services/${service.id}`, headers: editor,
      payload: { expectedRevision: 1, mounts: [{ ...bind, source: `${bind.source}-changed` }] } });
    expect(denied.statusCode).toBe(403);
    expect(store.getService(service.id)!.revision).toBe(1);
    expect(store.getService(service.id)!.mounts![0]!.source).toBe(bind.source);
    const allowed = await app.inject({ method: 'PATCH', url: `/api/v1/services/${service.id}`, headers: admin,
      payload: { expectedRevision: 1, mounts: [{ ...bind, source: `${bind.source}-approved` }] } });
    expect(allowed.statusCode).toBe(200);
    const ordinaryEdit = await app.inject({ method: 'PATCH', url: `/api/v1/services/${service.id}`, headers: editor,
      payload: { expectedRevision: 2, image: 'nginx:stable-alpine' } });
    expect(ordinaryEdit.statusCode).toBe(200);
    const deploy = await app.inject({ method: 'POST', url: `/api/v1/services/${service.id}/deploy`,
      headers: { ...editor, 'idempotency-key': 'editor-deploy-approved-bind' } });
    expect(deploy.statusCode).toBe(202);
    const queued = store.claimNextJob('deploy-worker', 60000)!;
    expect(queued.snapshot.mounts![0]!.source).toBe(`${bind.source}-approved`);
  });

  it('rejects adding a bind mount to an existing application owned by the editor project', async () => {
    const { app, editor, bind, input, create, store } = await fixture();
    const created = await create(editor, 'editor-plain', { ...input, mounts: [] });
    expect(created.statusCode).toBe(202);
    const service = created.json().service;
    const response = await app.inject({ method: 'PATCH', url: `/api/v1/services/${service.id}`, headers: editor,
      payload: { expectedRevision: 1, mounts: [bind] } });
    expect(response.statusCode).toBe(403);
    expect(store.getService(service.id)!.mounts).toEqual([]);
    expect(store.getService(service.id)!.revision).toBe(1);
  });
});
