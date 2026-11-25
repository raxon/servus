import {mkdtempSync, rmSync} from 'node:fs';
import {createServer, type Server, type Socket} from 'node:net';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {installationBackupHistory,cancelInstallationBackup,installationBackupStatus, submitInstallationBackup} from '../../src/server/updater-client.js';

const operationId = '12345678-1234-4123-8123-123456789abc';
const actorId = '22345678-1234-4123-8123-123456789abc';
const approval = {version: 1 as const, operationId, actorId, name: 'Installation backup', issuedAt: 1794916800123, proof: 'a'.repeat(64)};
const operation = {operationId, actorId, name: approval.name, state: 'completed', createdAt: approval.issuedAt, updatedAt: approval.issuedAt + 1, errorCode: null};
const servers: Server[] = [], directories: string[] = [], sockets = new Set<Socket>();
async function fixture(reply: (socket: Socket, input: any) => void) {
  const directory = mkdtempSync('/tmp/sibc-'); directories.push(directory);
  const socketPath = join(directory, 's');
  const server = createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    let pending = '';
    socket.on('data', chunk => {pending += chunk.toString(); if (pending.includes('\n')) reply(socket, JSON.parse(pending));});
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {server.once('error', reject); server.listen(socketPath, resolve);});
  return {socketPath, timeoutMs: 200};
}
afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()));
  for (const directory of directories.splice(0)) rmSync(directory, {recursive: true, force: true});
});

describe('installation backup updater transport', () => {
  it('validates history envelopes, order, unique records, cursors and redaction', async () => {
    const older = {...operation, operationId: actorId, createdAt: operation.createdAt - 1};
    const page = {operations: [operation, older], nextCursor: actorId};
    const valid = await fixture((socket, input) => {
      expect(input).toEqual({version: 1, action: 'installation_backup_history', cursor: null});
      socket.end(`${JSON.stringify({ok: true, operation: page})}\n`);
    });
    await expect(installationBackupHistory(null, valid)).resolves.toEqual(page);
    for (const bad of [
      {operations: [older, operation], nextCursor: null}, {operations: [operation, operation], nextCursor: null},
      {operations: [], nextCursor: operationId}, {...page, nextCursor: operationId},
      {operations: [{...operation, snapshotPath: '/root/private'}], nextCursor: null},
      {operations: [{...operation, updatedAt: 1}], nextCursor: null},
    ]) {
      const endpoint = await fixture(socket => socket.end(`${JSON.stringify({ok: true, operation: bad})}\n`));
      await expect(installationBackupHistory(null, endpoint)).rejects.toMatchObject({code: 'invalid_response'});
    }
    const repeated = await fixture(socket => socket.end(`${JSON.stringify({ok: true, operation: page})}\n`));
    await expect(installationBackupHistory(operationId, repeated)).rejects.toMatchObject({code: 'invalid_response'});
  });
  it('correlates cancellation with the operation and name while preserving its original creator',async()=>{
    const endpoint=await fixture((socket,input)=>{expect(input).toEqual({version:1,action:'installation_backup_cancel',approval});socket.end(`${JSON.stringify({ok:true,operation:{...operation,actorId:operationId,state:'cancelled'}})}\n`);});
    await expect(cancelInstallationBackup(approval,endpoint)).resolves.toMatchObject({state:'cancelled',actorId:operationId});
  });
  it.each(['recovering','cancelled'] as const)('accepts the explicit root recovery/cancellation state: %s',async state=>{
    const endpoint=await fixture(socket=>socket.end(`${JSON.stringify({ok:true,operation:{...operation,state}})}\n`));await expect(installationBackupStatus(operationId,endpoint)).resolves.toMatchObject({state});
  });
  it('sends exact public actions and accepts a safe operation only', async () => {
    for (const action of ['installation_backup_submit', 'installation_backup_status'] as const) {
      const endpoint = await fixture((socket, input) => {
        expect(input).toEqual({version: 1, action, ...(action.endsWith('submit') ? {approval} : {operationId})});
        socket.end(`${JSON.stringify({ok: true, operation})}\n`);
      });
      await expect(action.endsWith('submit') ? submitInstallationBackup(approval, endpoint) : installationBackupStatus(operationId, endpoint)).resolves.toEqual(operation);
    }
  });

  it('rejects duplicate keys, extra fields, invalid UTF-8 and multiple response frames', async () => {
    const valid = JSON.stringify({ok: true, operation});
    const replies = [
      valid.replace('"ok":true', '"ok":true,"ok":true') + '\n',
      JSON.stringify({ok: true, operation: {...operation, snapshotPath: '/root/private'}}) + '\n',
      JSON.stringify({ok: true, operation, private: 'raw-secret'}) + '\n',
      valid + '\n' + valid + '\n', valid,
      Buffer.concat([Buffer.from(valid.slice(0, -1)), Buffer.from([0xff]), Buffer.from('}\n')]),
    ];
    for (const response of replies) {
      const endpoint = await fixture(socket => socket.end(response));
      await expect(installationBackupStatus(operationId, endpoint)).rejects.toMatchObject({code: 'invalid_response', certainty: 'uncertain'});
    }
  });

  it('keeps a dispatched timeout uncertain and refuses malformed approval before dispatch', async () => {
    let called = false;
    const endpoint = await fixture(() => {called = true;});
    await expect(submitInstallationBackup({...approval, proof: 'bad'}, endpoint)).rejects.toMatchObject({code: 'invalid_input', certainty: 'definitive'});
    expect(called).toBe(false);
    await expect(submitInstallationBackup(approval, {...endpoint, timeoutMs: 20})).rejects.toMatchObject({code: 'timeout', certainty: 'uncertain'});
    expect(called).toBe(true);
  });
});
