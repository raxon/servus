import { createServer, type Server, type Socket } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { submitUpdate, updateStatus, retryUpdate, prepareUpdate, applyUpdate, applyStatus, discoverUpdate, updaterBackupFileSchema, UpdaterClientError, type UpdateSubmission } from '../../src/server/updater-client.js';

const input: UpdateSubmission = { operationId: '12345678-1234-4123-8123-123456789abc', commit: 'a'.repeat(40), digest: `sha256:${'b'.repeat(64)}`, tag: 'v1.2.3' };
const operation = { ...input, status: 'accepted', createdAt: '2026-11-14 10:00:00' };
const success = JSON.stringify({ ok: true, operation }) + '\n';
const directories: string[] = [];
const servers: Server[] = [];
const sockets = new Set<Socket>();

async function fixture(handler: (socket: Socket, request: string) => void) {
  const directory = mkdtempSync('/tmp/suc-'); directories.push(directory);
  const socketPath = join(directory, 's');
  const server = createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    let request = '';
    socket.on('data', (chunk: Buffer) => { request += chunk.toString(); if (request.includes('\n')) handler(socket, request); });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  return { socketPath, timeoutMs: 500 };
}
afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function failure(promise: Promise<unknown>, code: string, certainty: string) {
  try { await promise; throw new Error('Unexpected success'); }
  catch (error) { expect(error).toBeInstanceOf(UpdaterClientError); expect(error).toMatchObject({ code, certainty }); return error as UpdaterClientError; }
}

describe('updater Unix socket client', () => {
  it('accepts only a strict DNS journal compatibility observation',async()=>{
    for(const version of [0,1]){
      const endpoint=await fixture((socket,request)=>{
        expect(JSON.parse(request)).toEqual({version:1,action:'backup_schema'});
        socket.end(JSON.stringify({ok:true,operation:{backupFileDnsJournalVersion:version}})+'\n');
      });
      await expect(updaterBackupFileSchema(endpoint)).resolves.toEqual({backupFileDnsJournalVersion:version});
    }
    for(const operation of [{backupFileDnsJournalVersion:2},{backupFileDnsJournalVersion:true},{backupFileDnsJournalVersion:1,extra:true},{}]){
      const endpoint=await fixture(socket=>socket.end(JSON.stringify({ok:true,operation})+'\n'));
      await failure(updaterBackupFileSchema(endpoint),'invalid_response','uncertain');
    }
    const old=await fixture(socket=>socket.end(JSON.stringify({ok:false,error:'invalid_request'})+'\n'));
    await failure(updaterBackupFileSchema(old),'invalid_request','definitive');
  });
  it('accepts only a correctly shaped discovery result for the requested version', async () => {
    const options = await fixture((socket, request) => {
      expect(JSON.parse(request)).toEqual({version: 1, action: 'discover', current: 'v1.0.0'});
      socket.end(JSON.stringify({ok: true, operation: {status: 'no_newer_version', current: 'v1.0.0', latest: 'v1.0.0'}}) + '\n');
    });
    await expect(discoverUpdate('v1.0.0', options)).resolves.toMatchObject({status: 'no_newer_version'});
    const wrong = await fixture(socket => socket.end(JSON.stringify({ok: true, operation: {status: 'no_newer_version', current: 'v2.0.0', latest: 'v2.0.0'}}) + '\n'));
    await failure(discoverUpdate('v1.0.0', wrong), 'invalid_response', 'uncertain');
  });
  it('validates preparation and apply responses against their specific protocol', async () => {
    const prepared = { operationId: input.operationId, preparationId: '12345678-1234-4123-8123-123456789abd', status: 'prepared' };
    const options = await fixture((socket, request) => {
      expect(JSON.parse(request)).toEqual({version: 1, action: 'prepare', operationId: input.operationId});
      socket.end(JSON.stringify({ok: true, operation: prepared}) + '\n');
    });
    await expect(prepareUpdate(input.operationId, options)).resolves.toEqual(prepared);
    for (const action of ['apply', 'apply_status'] as const) {
      const result = {operationId: input.operationId, status: 'awaiting_completion'};
      const endpoint = await fixture((socket, request) => {
        expect(JSON.parse(request)).toEqual({version: 1, action, operationId: input.operationId});
        socket.end(JSON.stringify({ok: true, operation: result}) + '\n');
      });
      await expect(action === 'apply' ? applyUpdate(input.operationId, endpoint) : applyStatus(input.operationId, endpoint)).resolves.toEqual(result);
    }
    const wrong = await fixture(socket => socket.end(JSON.stringify({ok: true, operation: prepared}) + '\n'));
    await failure(applyStatus(input.operationId, wrong), 'invalid_response', 'uncertain');
  });
  it('sends the v1 submission and accepts a response split across packets', async () => {
    const options = await fixture((socket, request) => {
      expect(JSON.parse(request)).toEqual({ version: 1, action: 'submit', ...input });
      socket.write(success.slice(0, 17)); setTimeout(() => socket.end(success.slice(17)), 5);
    });
    await expect(submitUpdate(input, options)).resolves.toEqual(operation);
  });
  it('sends a status request and verifies the returned operation id', async () => {
    const options = await fixture((socket, request) => {
      expect(JSON.parse(request)).toEqual({ version: 1, action: 'status', operationId: input.operationId });
      socket.end(success);
    });
    await expect(updateStatus(input.operationId, options)).resolves.toEqual(operation);
  });
  it('accepts every journal state returned by the helper', async () => {
    for (const status of ['accepted', 'verifying', 'verified', 'verification_failed', 'recovery_required']) {
      const expected = { ...operation, status };
      const options = await fixture(socket => socket.end(JSON.stringify({ ok: true, operation: expected }) + '\n'));
      await expect(updateStatus(input.operationId, options)).resolves.toEqual(expected);
    }
  });
  it('sends retry with only its operation id and validates the response', async () => {
    const options = await fixture((socket, request) => {
      expect(JSON.parse(request)).toEqual({ version: 1, action: 'retry', operationId: input.operationId });
      socket.end(success);
    });
    await expect(retryUpdate(input.operationId, options)).resolves.toEqual(operation);
    const bad = await fixture(socket => socket.end(JSON.stringify({ ok: true, operation: { ...operation, operationId: '12345678-1234-4123-8123-123456789abd' } }) + '\n'));
    await failure(retryUpdate(input.operationId, bad), 'invalid_response', 'uncertain');
  });
  it('handles retry errors and rejects unknown or obsolete states', async () => {
    for (const code of ['not_found', 'operation_in_progress', 'recovery_required']) {
      const options = await fixture(socket => socket.end(JSON.stringify({ ok: false, error: code }) + '\n'));
      await failure(retryUpdate(input.operationId, options), code, 'definitive');
    }
    for (const status of ['awaiting_executor', 'succeeded', '']) {
      const options = await fixture(socket => socket.end(JSON.stringify({ ok: true, operation: { ...operation, status } }) + '\n'));
      await failure(updateStatus(input.operationId, options), 'invalid_response', 'uncertain');
    }
  });
  it('rejects invalid inputs before connecting', async () => {
    const options = { socketPath: '/tmp/nonexistent-updater-test.sock', timeoutMs: 100 };
    for (const invalid of [ { ...input, operationId: 'wrong' }, { ...input, commit: 'A'.repeat(40) }, { ...input, digest: 'https://bad' }, { ...input, tag: 'v01.2.3' }, { ...input, tag: 'v1.2.3-rc.1' } ])
      await failure(submitUpdate(invalid, options), 'invalid_input', 'definitive');
    await failure(submitUpdate(input, { socketPath: 'relative' }), 'invalid_input', 'definitive');
    await failure(updateStatus(input.operationId, { ...options, timeoutMs: 0 }), 'invalid_input', 'definitive');
  });
  it('marks a failed connection before dispatch definitive', async () => {
    await failure(submitUpdate(input, { socketPath: '/tmp/nonexistent-updater-test.sock', timeoutMs: 200 }), 'connection_failed', 'definitive');
  });
  it('returns a definitive idempotency conflict without echoing untrusted response data', async () => {
    const options = await fixture(socket => socket.end('{"ok":false,"error":"idempotency_conflict"}\n'));
    const error = await failure(submitUpdate(input, options), 'idempotency_conflict', 'definitive');
    expect(error.message).not.toContain(input.commit); expect(error.message).not.toContain(input.digest);
  });
  it('treats helper unavailable as uncertain after dispatch', async () => {
    const options = await fixture(socket => socket.end('{"ok":false,"error":"unavailable"}\n'));
    await failure(submitUpdate(input, options), 'unavailable', 'uncertain');
  });
  it('rejects wrong operation identity or release fields', async () => {
    for (const changed of [{ operationId: '12345678-1234-4123-8123-123456789abd' }, { commit: 'c'.repeat(40) }, { tag: 'v1.2.4' }]) {
      const options = await fixture(socket => socket.end(JSON.stringify({ ok: true, operation: { ...operation, ...changed } }) + '\n'));
      await failure(submitUpdate(input, options), 'invalid_response', 'uncertain');
    }
  });
  it('rejects malformed, duplicate, multiline, extra-field and non-UTF8 replies', async () => {
    const cases: (string | Buffer)[] = [
      'not-json\n', success + '{}\n', success.trimEnd(),
      '{"ok":false,"ok":true,"error":"not_found"}\n',
      JSON.stringify({ ok: true, operation: { ...operation, extra: 'injected-secret' } }) + '\n',
      Buffer.from([0xff, 0x0a]),
    ];
    for (const reply of cases) {
      const options = await fixture(socket => socket.end(reply));
      const error = await failure(submitUpdate(input, options), 'invalid_response', 'uncertain');
      expect(error.message).not.toContain('injected-secret');
    }
  });
  it('rejects a response over the byte limit', async () => {
    const options = await fixture(socket => socket.end(`${'x'.repeat(4096)}\n`));
    await failure(submitUpdate(input, options), 'invalid_response', 'uncertain');
  });
  it('enforces a total deadline even if the peer sends partial bytes', async () => {
    const options = await fixture(socket => {
      socket.write('{');
      const interval = setInterval(() => socket.write(' '), 5);
      socket.once('close', () => clearInterval(interval));
    });
    await failure(submitUpdate(input, { ...options, timeoutMs: 40 }), 'timeout', 'uncertain');
  });
  it('marks disconnect after sending as uncertain', async () => {
    const options = await fixture(socket => socket.destroy());
    await failure(submitUpdate(input, options), 'invalid_response', 'uncertain');
  });
});
