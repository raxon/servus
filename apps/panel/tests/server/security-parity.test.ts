import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { createApp, type AppOptions } from '../../src/server/app.js';
import { Store } from '../../src/server/store.js';
import type { agentRequest } from '../../src/agent/client.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const containerId = 'a'.repeat(64);
const defaultAgent: typeof agentRequest = async <T>(path: string) => {
  if (path.includes('/containers')) return [{ id: containerId, name: 'managed', state: 'running' }] as T;
  if (path.includes('/logs')) return { lines: ['2026-11-17T00:00:00.000Z runtime output'] } as T;
  if (path.includes('/metrics')) return { cpuPercent: 0, memoryBytes: 10, containers: 1 } as T;
  throw new Error('Unexpected runtime request');
};

async function fixture(options: Partial<AppOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'servus-security-'));
  const store = new Store(dir);
  const app = await createApp({ dataDir: dir, store, agentRequest: defaultAgent, ...options });
  cleanup.push(async () => { await app.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const admin = store.createUser('admin@example.test', 'fixture-only', 'admin');
  const adminSession = store.createSession(admin.id);
  const headers = { cookie: `panel_session=${adminSession.token}`, 'x-csrf-token': adminSession.csrfToken };
  const project = store.createProject('security');
  const created = await app.inject({
    method: 'POST', url: `/api/v1/projects/${project.id}/services`, headers: { ...headers, 'idempotency-key': 'security-fixture' },
    payload: { name: 'app', image: 'nginx:alpine', port: 80, hostname: 'security.localhost' },
  });
  expect(created.statusCode).toBe(202);
  const { service, action } = created.json();
  const member = store.createUser('member@example.test', 'fixture-only');
  store.addMember(project.id, member.id, 'editor');
  const memberSession = store.createSession(member.id);
  const memberHeaders = { cookie: `panel_session=${memberSession.token}`, 'x-csrf-token': memberSession.csrfToken };
  return { app, store, project, service, action, headers, member, memberSession, memberHeaders };
}

async function terminalFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'sec-ws-'));
  const socketPath = join(directory, 'agent.sock');
  const server = createServer();
  const wss = new WebSocketServer({ noServer: true });
  const received: string[] = [];
  let upstream: WebSocket | undefined;
  server.on('upgrade', (request, socket, head) => wss.handleUpgrade(request, socket, head, ws => {
    upstream = ws;
    ws.on('message', data => received.push(data.toString()));
  }));
  await new Promise<void>(resolve => server.listen(socketPath, resolve));
  cleanup.push(async () => {
    for (const ws of wss.clients) ws.terminate();
    wss.close(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  });
  const value = await fixture({ agentConnection: { socketPath, token: 'fixture-agent-token' } });
  const grant = await value.app.inject({
    method: 'POST', url: `/api/v1/services/${value.service.id}/console-ticket`,
    headers: value.memberHeaders, payload: { containerId },
  });
  expect(grant.statusCode).toBe(200);
  const output: string[] = [];
  const ws = await value.app.injectWS(`/api/v1/services/${value.service.id}/console`, {
    headers: { cookie: value.memberHeaders.cookie, origin: 'http://localhost:4180' },
  }, { onInit: client => client.on('message', data => output.push(data.toString())) });
  ws.send(JSON.stringify({ type: 'authenticate', ticket: grant.json().ticket }));
  await vi.waitFor(() => expect(output).toContain(JSON.stringify({ type: 'ready' })), { interval: 5 });
  return { ...value, ws, received, output, upstream: upstream! };
}

describe('security parity regressions', () => {
  it('blocks every service inspection path and action history outside project membership', async () => {
    const { app, store, project, service, action, member, memberHeaders } = await fixture();
    store.db.prepare('DELETE FROM memberships WHERE project_id=? AND user_id=?').run(project.id, member.id);
    const paths = [
      `/projects/${project.id}`, `/projects/${project.id}/services`, `/services/${service.id}`,
      `/services/${service.id}/metrics`, `/services/${service.id}/containers`, `/services/${service.id}/logs`,
      `/services/${service.id}/logs/stream`, `/services/${service.id}/actions`,
      `/services/${service.id}/configuration-changes`, `/actions/${action.id}`, `/actions/${action.id}/build-log`,
    ];
    for (const path of paths) expect((await app.inject({ url: `/api/v1${path}`, headers: memberHeaders })).statusCode, path).toBe(404);
    expect((await app.inject({ url: '/api/v1/projects', headers: memberHeaders })).json()).toEqual([]);
    expect((await app.inject({ url: '/api/v1/actions', headers: memberHeaders })).json()).toEqual([]);
  });

  it.each([
    'safe.example`) || Host(`attacker.example', 'safe.example/anything', '*.example.com',
    'safe.example\nHost(`attacker.example`)', 'safe.example:443', 'safe.example?x=1',
  ])('rejects route expression input %j before saving a domain', async hostname => {
    const { app, store, service, headers } = await fixture();
    const response = await app.inject({
      method: 'PATCH', url: `/api/v1/services/${service.id}`, headers,
      payload: { expectedRevision: 1, domains: [{ hostname, port: 80 }] },
    });
    expect(response.statusCode).toBe(400);
    expect(store.getService(service.id)!.revision).toBe(1);
  });

  for (const revoke of ['session', 'membership', 'write permission'] as const) {
    it(`rejects terminal input immediately after revoking ${revoke}`, async () => {
      const value = await terminalFixture();
      if (revoke === 'session') value.store.deleteSession(value.memberSession.token);
      else if (revoke === 'membership') value.store.db.prepare('DELETE FROM memberships WHERE project_id=? AND user_id=?').run(value.project.id, value.member.id);
      else value.store.addMember(value.project.id, value.member.id, 'viewer');
      value.ws.send(JSON.stringify({ type: 'input', data: 'must never execute\r' }));
      await vi.waitFor(() => expect(value.ws.readyState).toBe(WebSocket.CLOSED), { timeout: 2000, interval: 5 });
      expect(value.received).toEqual([]);
    });
  }

  it('does not forward queued terminal output after project access is removed', async () => {
    const value = await terminalFixture();
    value.store.db.prepare('DELETE FROM memberships WHERE project_id=? AND user_id=?').run(value.project.id, value.member.id);
    value.upstream.send('private output after revocation');
    await vi.waitFor(() => expect(value.ws.readyState).toBe(WebSocket.CLOSED), { timeout: 2000, interval: 5 });
    expect(value.output.join('')).not.toContain('private output after revocation');
  });

  it.each([
    { type: 'resize', cols: 0, rows: 24 },
    { type: 'resize', cols: 80, rows: 301 },
    { type: 'input', data: 'command', unexpected: true },
    { type: 'input', data: 'x'.repeat(32769) },
    { type: 'authenticate', ticket: 'a'.repeat(64) },
  ])('does not pass malformed terminal frame $type to the agent', async frame => {
    const value = await terminalFixture();
    value.ws.send(JSON.stringify(frame));
    await vi.waitFor(() => expect(value.ws.readyState).toBe(WebSocket.CLOSED), { interval: 5 });
    expect(value.received).toEqual([]);
  });

  it('does not deliver a pending log read after its session is revoked', async () => {
    let release!: (result: { lines: string[] }) => void;
    let reading = false;
    const pending = new Promise<{ lines: string[] }>(resolve => { release = resolve; });
    const runtime: typeof agentRequest = async <T>(path: string) => {
      if (path.includes('/logs')) { reading = true; return await pending as T; }
      return defaultAgent<T>(path);
    };
    const value = await fixture({ agentRequest: runtime });
    await value.app.listen({ host: '127.0.0.1', port: 0 });
    const address = value.app.server.address();
    if (!address || typeof address === 'string') throw new Error('Expected local HTTP endpoint');
    const controller = new AbortController();
    cleanup.push(async () => { release({ lines: [] }); controller.abort(); });
    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/services/${value.service.id}/logs/stream`, {
      headers: { cookie: value.memberHeaders.cookie }, signal: controller.signal,
    });
    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(reading).toBe(true), { interval: 5 });
    value.store.deleteSession(value.memberSession.token);
    release({ lines: ['2026-11-17T00:00:00.000Z private log after revocation'] });
    expect(await response.text()).not.toContain('private log after revocation');
  });
});
