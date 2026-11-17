import {afterEach, describe, expect, it, vi} from 'vitest';
import {mkdtempSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createApp} from '../../src/server/app.js';
import {Store} from '../../src/server/store.js';
import type {agentRequest} from '../../src/agent/client.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {for (const dispose of cleanup.splice(0).reverse()) await dispose();});
async function fixture() {
  const dataDir = mkdtempSync('/tmp/sch-'), store = new Store(dataDir), actor = store.setup('admin@example.test', 'session-only-fixture'), project = store.createProject('history'), other = store.createProject('other');
  const agent: typeof agentRequest = async <T>(_path: string, body?: unknown) => {
    const input = body as {type: string; revision: number};
    return {state: input.type === 'destroy' ? 'deleted' : 'running', revision: input.revision, logs: 'runtime completed'} as T;
  };
  const app = await createApp({dataDir, store, agentRequest: agent});
  cleanup.push(async () => {await app.close(); store.close(); rmSync(dataDir, {recursive: true, force: true});});
  const session = store.createSession(actor.id), headers = {cookie: `panel_session=${session.token}`, 'x-csrf-token': session.csrfToken};
  const created = await app.inject({method: 'POST', url: `/api/v1/projects/${project.id}/compose`, headers: {...headers, 'idempotency-key': randomUUID()}, payload: {name: 'history', source: {type: 'inline', yaml: 'services: {web: {image: nginx:alpine}}'}, domains: []}});
  expect(created.statusCode).toBe(202);
  const id = created.json().workload.id as string, base = `/api/v1/compose/${id}`;
  await vi.waitFor(async () => expect((await app.inject({url: `${base}/actions`, headers})).json().find((action: {id: string}) => action.id === created.json().action.id).status).toBe('succeeded'));
  const destroyed = await app.inject({method: 'POST', url: `${base}/destroy`, headers: {...headers, 'idempotency-key': randomUUID()}, payload: {confirm: true}});
  expect(destroyed.statusCode).toBe(202);
  await vi.waitFor(() => expect(store.db.prepare('SELECT deleted_at FROM compose_workloads WHERE id=?').get(id)).toMatchObject({deleted_at: expect.any(String)}));
  const member = (role: 'viewer' | 'editor', projectId = project.id) => {
    const user = store.createUser(`${randomUUID()}@example.test`, 'session-only-fixture'); store.addMember(projectId, user.id, role);
    const session = store.createSession(user.id); return {user, headers: {cookie: `panel_session=${session.token}`, 'x-csrf-token': session.csrfToken}};
  };
  const mint = async (selected = headers, projectId = project.id) => {
    const response = await app.inject({method: 'POST', url: '/api/v1/auth/api-tokens', headers: selected, payload: {projectId, name: 'History reader', scope: 'read'}});
    expect(response.statusCode).toBe(201); return response.json() as {id: string; token: string};
  };
  return {app, store, project, other, id, base, headers, member, mint, destroyed: destroyed.json() as {id: string}};
}

describe('deleted Compose workload action history', () => {
  it('exposes terminal destroy history while keeping active metadata and all mutations unavailable', async () => {
    const f = await fixture(), history = await f.app.inject({url: `${f.base}/actions`, headers: f.headers});
    expect(history.statusCode).toBe(200); expect(history.json()).toContainEqual(expect.objectContaining({id: f.destroyed.id, type: 'destroy', status: 'succeeded'}));
    for (const suffix of ['', '/configuration', '/logs', '/containers']) expect((await f.app.inject({url: f.base + suffix, headers: f.headers})).statusCode).toBe(404);
    for (const type of ['deploy', 'start', 'stop', 'restart', 'destroy']) expect((await f.app.inject({method: 'POST', url: `${f.base}/${type}`, headers: {...f.headers, 'idempotency-key': randomUUID()}, payload: {confirm: true}})).statusCode).toBe(404);
    expect((await f.app.inject({method: 'PATCH', url: f.base, headers: f.headers, payload: {}})).statusCode).toBe(404);
    expect((await f.app.inject({url: `/api/v1/projects/${f.project.id}/compose`, headers: f.headers})).json()).toEqual([]);
  });

  it('checks current project membership for session readers and refuses deleted projects', async () => {
    const f = await fixture(), viewer = f.member('viewer'), outsider = f.member('viewer', f.other.id);
    expect((await f.app.inject({url: `${f.base}/actions`, headers: viewer.headers})).statusCode).toBe(200);
    expect((await f.app.inject({url: `${f.base}/actions`, headers: outsider.headers})).statusCode).toBe(404);
    expect((await f.app.inject({url: `${f.base}/actions`})).statusCode).toBe(401);
    f.store.db.prepare('DELETE FROM memberships WHERE project_id=? AND user_id=?').run(f.project.id, viewer.user.id);
    expect((await f.app.inject({url: `${f.base}/actions`, headers: viewer.headers})).statusCode).toBe(404);
    f.store.deleteProject(f.project.id);
    expect((await f.app.inject({url: `${f.base}/actions`, headers: f.headers})).statusCode).toBe(404);
  });

  it('preserves read token scope, revocation, live membership and deleted project refusal', async () => {
    const f = await fixture(), owner = f.member('viewer'), token = await f.mint(owner.headers), foreign = await f.mint(f.headers, f.other.id);
    const bearer = {authorization: `Bearer ${token.token}`}, history = () => f.app.inject({url: `${f.base}/actions`, headers: bearer});
    expect((await history()).statusCode).toBe(200);
    expect((await f.app.inject({method: 'HEAD', url: `${f.base}/actions`, headers: bearer})).statusCode).toBe(200);
    expect((await f.app.inject({url: `${f.base}/actions`, headers: {authorization: `Bearer ${foreign.token}`}})).statusCode).toBe(404);
    for (const suffix of ['', '/logs']) expect((await f.app.inject({url: f.base + suffix, headers: bearer})).statusCode).toBe(404);
    expect((await f.app.inject({method: 'POST', url: `${f.base}/restart`, headers: {...bearer, 'idempotency-key': randomUUID()}})).statusCode).toBe(404);
    f.store.db.prepare('DELETE FROM memberships WHERE project_id=? AND user_id=?').run(f.project.id, owner.user.id);
    expect((await history()).statusCode).toBe(404); f.store.addMember(f.project.id, owner.user.id, 'viewer');
    expect((await history()).statusCode).toBe(200);
    expect((await f.app.inject({method: 'DELETE', url: `/api/v1/auth/api-tokens/${token.id}`, headers: owner.headers})).statusCode).toBe(200);
    expect((await history()).statusCode).toBe(401);
    expect((await f.app.inject({method: 'HEAD', url: `${f.base}/actions`, headers: bearer})).statusCode).toBe(401);
    const active = await f.mint(owner.headers); f.store.deleteProject(f.project.id);
    expect((await f.app.inject({url: `${f.base}/actions`, headers: {authorization: `Bearer ${active.token}`}})).statusCode).toBe(404);
  });
});
