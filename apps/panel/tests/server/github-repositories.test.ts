import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { z } from 'zod';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/server/store.js';
import { AppError } from '../../src/server/errors.js';
import { registerGithubRepositories } from '../../src/server/github-repositories.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const token = 'synthetic-github-secret';
const endpoint = '/api/v1/integrations/github/repositories';
const row = { name: 'app', owner: { login: 'organization' }, private: true, default_branch: 'main', ignored: token };
const response = (value: unknown, headers?: HeadersInit) => Response.json(value, { headers });

async function fixture(transport: typeof fetch = vi.fn(async () => response([row])), timeoutMs = 10_000) {
  const dir = mkdtempSync(join(tmpdir(), 'servus-repositories-'));
  const store = new Store(dir), app = Fastify();
  await app.register(cookie);
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
    if (error instanceof z.ZodError) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR' } });
    return reply.code(500).send({ error: { code: 'INTERNAL_ERROR' } });
  });
  const administrator = (request: import('fastify').FastifyRequest) => {
    const auth = request.cookies.panel_session ? store.getSession(request.cookies.panel_session) : null;
    if (!auth) throw new AppError('UNAUTHORIZED', 'Sign in to continue', 401);
    if (auth.user.role !== 'admin') throw new AppError('FORBIDDEN', 'Administrator access required', 403);
    return auth.user;
  };
  registerGithubRepositories(app, { store, administrator, fetch: transport, timeoutMs });
  const admin = store.createUser('admin@example.test', 'fixture-only', 'admin');
  const session = store.createSession(admin.id);
  const member = store.createUser('member@example.test', 'fixture-only');
  const memberSession = store.createSession(member.id);
  store.vault.setGithubConnection('x-access-token', token);
  cleanup.push(async () => { await app.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { app, store, admin, session, transport, headers: { cookie: `panel_session=${session.token}` }, memberHeaders: { cookie: `panel_session=${memberSession.token}` } };
}

describe('GitHub repository and branch picker', () => {
  it('returns only repository display fields and sends the token only to the fixed HTTPS GitHub endpoint', async () => {
    const transport = vi.fn<typeof fetch>(async () => response([row]));
    const { app, headers } = await fixture(transport);
    const result = await app.inject({ url: endpoint, headers });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual({ repositories: [{ owner: 'organization', name: 'app', fullName: 'organization/app', defaultBranch: 'main', private: true }], page: 1, nextPage: null });
    expect(result.body).not.toContain(token);
    const [input, options] = transport.mock.calls[0]!;
    const url = new URL(input.toString());
    expect(url.origin).toBe('https://api.github.com'); expect(url.pathname).toBe('/user/repos');
    expect(url.searchParams.get('per_page')).toBe('50'); expect(url.searchParams.get('page')).toBe('1');
    expect(url.searchParams.get('affiliation')).toBe('owner,collaborator,organization_member');
    expect(options).toMatchObject({ method: 'GET', redirect: 'error', headers: { authorization: `Bearer ${token}` } });
    expect(options!.signal).toBeInstanceOf(AbortSignal);
  });

  it('rejects anonymous and non-admin callers without contacting GitHub', async () => {
    const transport = vi.fn<typeof fetch>();
    const { app, memberHeaders } = await fixture(transport);
    for (const url of [endpoint, `${endpoint}/organization/app/branches`]) {
      expect((await app.inject({ url })).statusCode).toBe(401);
      expect((await app.inject({ url, headers: memberHeaders })).statusCode).toBe(403);
    }
    expect(transport).not.toHaveBeenCalled();
  });

  it('requires a saved connection before contacting GitHub', async () => {
    const transport = vi.fn<typeof fetch>();
    const { app, store, headers } = await fixture(transport);
    store.vault.deleteGithubConnection();
    expect((await app.inject({ url: endpoint, headers })).statusCode).toBe(409);
    expect(transport).not.toHaveBeenCalled();
  });

  it('lists branch names without exposing upstream repository metadata', async () => {
    const transport = vi.fn<typeof fetch>(async () => response([{ name: 'main', commit: { sha: 'a'.repeat(40), url: token } }, { name: 'feature/example' }]));
    const { app, headers } = await fixture(transport);
    const result = await app.inject({ url: `${endpoint}/organization/app/branches?page=2`, headers });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual({ branches: ['main', 'feature/example'], page: 2, nextPage: null });
    expect(new URL(transport.mock.calls[0]![0].toString()).pathname).toBe('/repos/organization/app/branches');
    expect(result.body).not.toContain(token);
  });

  it('returns bounded numeric pagination without following upstream URLs', async () => {
    const transport = vi.fn<typeof fetch>(async () => response([], { link: '<https://attacker.invalid/secret>; rel="next", <https://attacker.invalid/last>; rel="last"' }));
    const { app, headers } = await fixture(transport);
    expect((await app.inject({ url: `${endpoint}?page=3`, headers })).json().nextPage).toBe(4);
    expect((await app.inject({ url: `${endpoint}?page=20`, headers })).json().nextPage).toBeNull();
    expect(transport).toHaveBeenCalledTimes(2);
    for (const [url] of transport.mock.calls) expect(new URL(url.toString()).origin).toBe('https://api.github.com');
  });

  it.each(['page=0', 'page=21', 'page=1.5', 'page=bad', 'url=https://attacker.invalid', 'per_page=1000'])('rejects unbounded or extra parameters %s', async search => {
    const transport = vi.fn<typeof fetch>();
    const { app, headers } = await fixture(transport);
    expect((await app.inject({ url: `${endpoint}?${search}`, headers })).statusCode).toBe(400);
    expect(transport).not.toHaveBeenCalled();
  });

  it.each(['bad%2Fowner/app', 'organization/%2E%2E', 'organization/bad%3Frepo'])('rejects invalid repository path %s without fetch', async path => {
    const transport = vi.fn<typeof fetch>();
    const { app, headers } = await fixture(transport);
    expect([400, 404]).toContain((await app.inject({ url: `${endpoint}/${path}/branches`, headers })).statusCode);
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([
    [401, 502, 'GITHUB_AUTHENTICATION_FAILED'], [403, 503, 'GITHUB_ACCESS_LIMITED'],
    [429, 503, 'GITHUB_ACCESS_LIMITED'], [404, 404, 'GITHUB_REPOSITORY_NOT_FOUND'], [500, 503, 'GITHUB_UNAVAILABLE'],
  ])('maps upstream %s without returning its error body', async (upstreamStatus, expectedStatus, code) => {
    const transport = vi.fn<typeof fetch>(async () => new Response(`do not expose ${token}`, { status: upstreamStatus as number }));
    const { app, headers } = await fixture(transport);
    const result = await app.inject({ url: endpoint, headers });
    expect(result.statusCode).toBe(expectedStatus); expect(result.json().error.code).toBe(code);
    expect(result.body).not.toContain(token);
  });

  for (const change of ['session', 'role', 'token', 'disconnect'] as const) {
    it(`discards pending repository data after changing ${change}`, async () => {
      let resolve!: (value: Response) => void;
      const pending = new Promise<Response>(done => { resolve = done; });
      const transport = vi.fn<typeof fetch>(async () => await pending);
      const { app, store, admin, session, headers } = await fixture(transport);
      const request = app.inject({ url: endpoint, headers });
      const result = request.then(value => value);
      await vi.waitFor(() => expect(transport).toHaveBeenCalled(), { interval: 5 });
      if (change === 'session') store.deleteSession(session.token);
      else if (change === 'role') store.db.prepare("UPDATE users SET role='member' WHERE id=?").run(admin.id);
      else if (change === 'token') store.vault.setGithubConnection('x-access-token', 'replacement-token');
      else store.vault.deleteGithubConnection();
      resolve(response([row]));
      const rejected = await result;
      expect(rejected.statusCode).toBe(change === 'session' ? 401 : change === 'role' ? 403 : 409);
      expect(rejected.body).not.toContain('organization/app');
      expect(rejected.body).not.toContain(token);
    });
  }

  it('rejects oversized or invalid repository responses', async () => {
    const transport = vi.fn<typeof fetch>();
    transport.mockResolvedValueOnce(new Response('[]', { headers: { 'content-length': String(3 * 1024 * 1024) } }));
    transport.mockResolvedValueOnce(new Response('x'.repeat(2 * 1024 * 1024 + 1)));
    transport.mockResolvedValueOnce(response(Array.from({ length: 51 }, () => row)));
    transport.mockResolvedValueOnce(response([{ ...row, owner: { login: 'bad/owner' } }]));
    const { app, headers } = await fixture(transport);
    for (let i = 0; i < 4; i++) expect((await app.inject({ url: endpoint, headers })).statusCode).toBe(502);
  });

  it('aborts timed out fetches and hides transport errors', async () => {
    const transport = vi.fn<typeof fetch>(async (_url, options) => await new Promise((_resolve, reject) => {
      options!.signal!.addEventListener('abort', () => reject(new Error(token)), { once: true });
    }));
    const { app, headers } = await fixture(transport, 10);
    const result = await app.inject({ url: endpoint, headers });
    expect(result.statusCode).toBe(504); expect(result.body).not.toContain(token);
    transport.mockRejectedValueOnce(new Error(`request failed with ${token}`));
    const failed = await app.inject({ url: endpoint, headers });
    expect(failed.statusCode).toBe(503); expect(failed.body).not.toContain(token);
  });
});
