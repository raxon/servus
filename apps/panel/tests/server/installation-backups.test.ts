import {createHmac} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {createServer, type Server, type Socket} from 'node:net';
import {join} from 'node:path';
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import {afterEach, describe, expect, it} from 'vitest';
import {z} from 'zod';
import {AppError} from '../../src/server/errors.js';
import {registerInstallationBackups, type InstallationBackupRoutesOptions} from '../../src/server/installation-backups.js';
import {installationBackupApprovalMessage, type InstallationBackupApprovalFields} from '../../src/server/installation-backup-approval.js';

const id = '12345678-1234-4123-8123-123456789abc', actorId = '22345678-1234-4123-8123-123456789abc';
const input = {operationId: id, name: 'Kopia zażółć 🚀'};
const now = 1794916800123, key = 'a'.repeat(64);
const headers = {cookie: 'session=admin', 'x-csrf-token': 'csrf', origin: 'https://panel.example.test'};
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {for (const cleanup of cleanups.splice(0).reverse()) await cleanup();});
const operation = {...input, actorId, state: 'requested', createdAt: now, updatedAt: now, errorCode: null};
const sign = (fields: InstallationBackupApprovalFields) => ({...fields, version: 1 as const,
  proof: createHmac('sha256', Buffer.from(key, 'hex')).update(installationBackupApprovalMessage(fields), 'utf8').digest('hex')});

async function fixture(options: Partial<InstallationBackupRoutesOptions> = {}, responder?: (socket: Socket, value: any) => void, limited = false) {
  const directory = mkdtempSync('/tmp/sib-'), socketPath = join(directory, 'updater.sock');
  const requests: any[] = [], sockets = new Set<Socket>();
  let server: Server | undefined, live = true, clock = now;
  if (responder) {
    server = createServer(socket => {
      sockets.add(socket); socket.on('close', () => sockets.delete(socket));
      let pending = '';
      socket.on('data', chunk => {
        pending += chunk.toString(); if (!pending.includes('\n')) return;
        const request = JSON.parse(pending); requests.push(request); responder(socket, request);
      });
    });
    await new Promise<void>((resolve, reject) => {server!.once('error', reject); server!.listen(socketPath, resolve);});
  }
  const app = Fastify();
  if (limited) await app.register(rateLimit, {global: false});
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) return reply.code(error.statusCode).send({error: {code: error.code, message: error.message}});
    if (error instanceof z.ZodError) return reply.code(400).send({error: {code: 'VALIDATION_ERROR'}});
    return reply.code((error as {statusCode?: number}).statusCode ?? 500).send({error: {code: 'REQUEST_ERROR'}});
  });
  registerInstallationBackups(app, {
    socketPath, applyEnabled: true, signApproval: sign, now: () => clock,
    administrator: (request, mutation) => {
      if (!live || !request.headers.cookie) throw new AppError('UNAUTHORIZED', 'Sign in to continue', 401);
      if (request.headers.cookie !== headers.cookie) throw new AppError('FORBIDDEN', 'Administrator required', 403);
      if (mutation && (request.headers['x-csrf-token'] !== headers['x-csrf-token'] || request.headers.origin !== headers.origin))
        throw new AppError('CSRF_DENIED', 'Invalid session request', 403);
      return {id: actorId};
    }, ...options,
  });
  cleanups.push(async () => {
    await app.close(); for (const socket of sockets) socket.destroy();
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    rmSync(directory, {recursive: true, force: true});
  });
  return {app, requests, revoke: () => {live = false;}, tick: () => {clock++;}};
}
const success = (socket: Socket) => socket.end(`${JSON.stringify({ok: true, operation})}\n`);

describe('installation backup API authorization and protocol', () => {
  it('reads paginated host history only for administrator sessions, including a fresh browser', async () => {
    const page = {operations: [operation], nextCursor: id};
    const {app, requests} = await fixture({}, (socket, request) => {
      expect(request.action).toBe('installation_backup_history');
      socket.end(`${JSON.stringify({ok: true, operation: request.cursor ? {operations: [], nextCursor: null} : page})}\n`);
    });
    const url = '/api/v1/installation-backups/history';
    for (const denied of [{}, {cookie: 'session=member'}, {...headers, authorization: 'Bearer token'}])
      expect((await app.inject({url, headers: denied})).statusCode).toBeGreaterThanOrEqual(401);
    for (const suffix of ['?cursor=../escape', '?cursor=', '?limit=10000'])
      expect((await app.inject({url: url + suffix, headers})).statusCode).toBe(400);
    expect(requests).toEqual([]);
    expect((await app.inject({url, headers})).json()).toEqual({available: true, ...page});
    expect((await app.inject({url, headers: {...headers}})).json()).toEqual({available: true, ...page});
    expect((await app.inject({url: url + `?cursor=${id}`, headers})).json()).toEqual({available: true, operations: [], nextCursor: null});
    expect(requests[0]).toEqual({version: 1, action: 'installation_backup_history', cursor: null});
  });
  it('handles absent history support and rechecks session liveness after reading history', async () => {
    const old = await fixture({}, socket => socket.end(`${JSON.stringify({ok: false, error: 'invalid_request'})}\n`));
    expect((await old.app.inject({url: '/api/v1/installation-backups/history', headers})).json()).toEqual({available: false, reason: 'host_unsupported'});
    const disabled = await fixture({applyEnabled: false}, success);
    expect((await disabled.app.inject({url: '/api/v1/installation-backups/history', headers})).json()).toEqual({available: false, reason: 'not_configured'});
    expect(disabled.requests).toEqual([]);
    const f = await fixture({}, socket => {f.revoke(); socket.end(`${JSON.stringify({ok: true, operation: {operations: [], nextCursor: null}})}\n`);});
    expect((await f.app.inject({url: '/api/v1/installation-backups/history', headers})).statusCode).toBe(401);
  });
  it('requires administrator browser authentication and mutation CSRF/origin before any dispatch', async () => {
    const {app, requests} = await fixture({}, success);
    for (const selected of [{}, {...headers, cookie: 'session=member'}, {...headers, 'x-csrf-token': ''}, {...headers, origin: 'https://foreign.example'}, {...headers, authorization: 'Bearer valid-api-token'}]) {
      expect((await app.inject({method: 'POST', url: '/api/v1/installation-backups', headers: selected, payload: input})).statusCode).toBeGreaterThanOrEqual(400);
    }
    expect((await app.inject({url: `/api/v1/installation-backups/${id}`, headers: {cookie: 'session=member'}})).statusCode).toBe(403);
    expect((await app.inject({url: `/api/v1/installation-backups/${id}`, headers: {...headers, authorization: 'Bearer token'}})).statusCode).toBe(401);
    expect(requests).toEqual([]);
  });

  it('rejects extra paths, proofs, actors, query parameters and invalid names before signing', async () => {
    const {app, requests} = await fixture({}, success);
    for (const payload of [{...input, path: '/root'}, {...input, actorId}, {...input, proof: 'b'.repeat(64)}, {...input, operationId: '../escape'}, {...input, name: '\ud800'}, {...input, name: 'a\n'}, {...input, name: ' padded '}])
      expect((await app.inject({method: 'POST', url: '/api/v1/installation-backups', headers, payload})).statusCode).toBe(400);
    expect((await app.inject({method: 'POST', url: '/api/v1/installation-backups?path=/etc', headers, payload: input})).statusCode).toBe(400);
    expect((await app.inject({url: `/api/v1/installation-backups/${id}?path=/root`, headers})).statusCode).toBe(400);
    expect((await app.inject({url: '/api/v1/installation-backups/not-a-uuid', headers})).statusCode).toBe(400);
    expect(requests).toEqual([]);
  });

  it('stays disabled without both host opt-in and separately configured signer', async () => {
    for (const options of [{applyEnabled: false}, {socketPath: undefined}, {signApproval: undefined, approvalSecretPath: undefined}]) {
      const {app, requests} = await fixture(options, success);
      expect((await app.inject({method: 'POST', url: '/api/v1/installation-backups', headers, payload: input})).statusCode).toBe(503);
      expect((await app.inject({url: `/api/v1/installation-backups/${id}`, headers})).statusCode).toBe(503);
      expect(requests).toEqual([]);
    }
  });

  it('signs server identity with a fresh proof for each idempotent submission and reads status', async () => {
    const {app, requests, tick} = await fixture({}, success);
    for (let index = 0; index < 2; index++) {
      const response = await app.inject({method: 'POST', url: '/api/v1/installation-backups', headers, payload: input});
      expect(response.statusCode).toBe(202); expect(response.json()).toEqual({ok: true, operation}); tick();
    }
    expect(requests[0]).toEqual({version: 1, action: 'installation_backup_submit', approval: sign({...input, actorId, issuedAt: now})});
    expect(requests[1].approval).toEqual(sign({...input, actorId, issuedAt: now + 1}));
    expect(requests[1].approval.proof).not.toBe(requests[0].approval.proof);
    const status = await app.inject({url: `/api/v1/installation-backups/${id}`, headers});
    expect(status.json()).toEqual({ok: true, operation});
    expect(requests[2]).toEqual({version: 1, action: 'installation_backup_status', operationId: id});
    expect(status.body).not.toContain(key); expect(status.body).not.toContain('proof');
  });

  it('rejects forged updater identities, unsafe fields and invalid timestamps', async () => {
    for (const wrong of [{operationId: actorId}, {actorId: id}, {name: 'different'}, {snapshotPath: '/root/snapshot'}, {state: 'queued'}, {errorCode: 'root key: secret'}, {createdAt: 0.1}, {updatedAt: now - 1}]) {
      const {app} = await fixture({}, socket => socket.end(`${JSON.stringify({ok: true, operation: {...operation, ...wrong}})}\n`));
      const response = await app.inject({method: 'POST', url: '/api/v1/installation-backups', headers, payload: input});
      expect(response.statusCode).toBe(503); expect(response.body).not.toContain('/root'); expect(response.body).not.toContain('secret');
    }
    const {app} = await fixture({}, socket => socket.end(`${JSON.stringify({ok: true, operation: {...operation, operationId: actorId}})}\n`));
    expect((await app.inject({url: `/api/v1/installation-backups/${id}`, headers})).statusCode).toBe(503);
  });

  it('rechecks administrator liveness before returning an awaited host response', async () => {
    let revoke: () => void;
    const instance = await fixture({}, socket => {revoke(); success(socket);}); revoke = instance.revoke;
    expect((await instance.app.inject({method: 'POST', url: '/api/v1/installation-backups', headers, payload: input})).statusCode).toBe(401);
    const statusFixture = await fixture({}, socket => {statusFixture.revoke(); success(socket);});
    expect((await statusFixture.app.inject({url: `/api/v1/installation-backups/${id}`, headers})).statusCode).toBe(401);
  });

  it('returns safe conflict, missing and uncertain errors, and redacts signer failures', async () => {
    for (const [error, status] of [['not_found', 404], ['idempotency_conflict', 409], ['operation_in_progress', 409], ['unavailable', 503]] as const) {
      const {app} = await fixture({}, socket => socket.end(`${JSON.stringify({ok: false, error})}\n`));
      expect((await app.inject({method: 'POST', url: '/api/v1/installation-backups', headers, payload: input})).statusCode).toBe(status);
    }
    const {app, requests} = await fixture({signApproval: () => {throw new Error('raw-secret /root/private-key');}}, success);
    const response = await app.inject({method: 'POST', url: '/api/v1/installation-backups', headers, payload: input});
    expect(response.statusCode).toBe(503); expect(response.body).not.toContain('raw-secret'); expect(response.body).not.toContain('/root'); expect(requests).toEqual([]);
  });

  it('bounds operation polling and submissions per caller', async () => {
    const {app} = await fixture({}, success, true);
    for (let index = 0; index < 5; index++) expect((await app.inject({method: 'POST', url: '/api/v1/installation-backups', headers, payload: input})).statusCode).toBe(202);
    expect((await app.inject({method: 'POST', url: '/api/v1/installation-backups', headers, payload: input})).statusCode).toBe(429);
  });
});
