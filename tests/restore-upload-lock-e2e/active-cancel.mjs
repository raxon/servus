import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '/app/dist/server/store.js';
import { createApp } from '/app/dist/server/app.js';
import { createAgent } from '/app/dist/agent/app.js';

const dataDir = mkdtempSync(join(tmpdir(), 'servus-active-upload-'));
const store = new Store(dataDir), serviceId = randomUUID(), operationId = randomBytes(16).toString('hex');
const kind = process.env.TEST_KIND || 'postgres';
if (!['postgres', 'mariadb'].includes(kind)) throw new Error('Unsupported fixture database');
const agentToken = 'synthetic-agent-token', socketPath = join(dataDir, 'agent.sock');
const runtime = { status: async () => ({ online: true }), inspectService: async () => ({ state: 'running' }), apply: async () => { throw new Error('Unexpected runtime operation'); } };
let agent, panel, upload;
try {
  const actor = store.setup('fixture@example.test', 'fixture-hash'), project = store.createProject('fixture');
  const now = new Date().toISOString(), actionId = randomUUID(), jobId = randomUUID();
  const passwordRef = store.vault.put('synthetic-database-password');
  const snapshot = { id: serviceId, projectId: project.id, kind, database: { database: 'fixture', user: 'fixture', passwordSecretRef: passwordRef } };
  store.db.prepare('INSERT INTO services(id,project_id,name,image,port,hostname,replicas,revision,deployed_revision,state,last_error,created_at,updated_at,config) VALUES(?,?,?,?,?,?,1,1,1,?,NULL,?,?,?)')
    .run(serviceId, project.id, 'fixture', kind === 'postgres' ? 'postgres:17-alpine' : 'mariadb:11.4', kind === 'postgres' ? 5432 : 3306, 'fixture.internal', 'running', now, now, JSON.stringify(snapshot));
  store.db.prepare("INSERT INTO service_secret_refs(reference,service_id,purpose) VALUES(?,?,'database')").run(passwordRef, serviceId);
  store.db.prepare("INSERT INTO actions VALUES(?,?,?,?,?,'succeeded','complete',NULL,?,?,?)").run(actionId, project.id, serviceId, actor.id, 'deploy', now, now, now);
  store.db.prepare("INSERT INTO jobs(id,action_id,service_id,snapshot,status,created_at) VALUES(?,?,?,?,'succeeded',?)").run(jobId, actionId, serviceId, JSON.stringify(snapshot), now);
  agent = await createAgent({ dataDir, token: agentToken, socketPath, dockerSocket: '/unused', ingressPort: 18080, ingressImage: 'unused' }, runtime);
  await agent.listen({ path: socketPath });
  panel = await createApp({ dataDir, store, agentConnection: { socketPath, token: agentToken } });
  const address = new URL(await panel.listen({ host: '127.0.0.1', port: 0 }));
  const session = store.createSession(actor.id), headers = { cookie: `panel_session=${session.token}`, 'x-csrf-token': session.csrfToken };
  const path = `/api/v1/services/${serviceId}/database-restore/${operationId}`;
  upload = request({ hostname: '127.0.0.1', port: address.port, path: `${path}/upload`, method: 'POST', headers: { ...headers, 'content-type': 'application/octet-stream', 'content-length': '1000000' } });
  upload.on('error', () => {});
  upload.on('response', response => response.resume());
  upload.write('partial synthetic archive');
  const url = `http://127.0.0.1:${address.port}`;
  const call = (route, method = 'GET', body) => fetch(`${url}${route}`, { method, signal: AbortSignal.timeout(15_000), headers: { ...headers, ...(body ? { 'content-type': 'application/octet-stream' } : {}) }, ...(body ? { body } : {}) });
  let phase;
  for (let attempt = 0; attempt < 200; attempt++) {
    const response = await call(path); if (response.ok) phase = (await response.json()).phase;
    if (phase === 'uploading') break;
    await delay(25);
  }
  if (phase !== 'uploading') throw new Error(`Active upload was not observed: ${phase}`);
  const denied = await fetch(`${url}${path}/cancel`, { method: 'POST', signal: AbortSignal.timeout(15_000), headers: { cookie: headers.cookie } });
  if (denied.status !== 403) throw new Error(`Cancellation without CSRF was not denied: ${denied.status}`);
  if ((await (await call(path)).json()).phase !== 'uploading') throw new Error('Unauthorized cancellation changed the operation');
  const cancellation = await call(`${path}/cancel`, 'POST');
  if (cancellation.status !== 200 || (await cancellation.json()).phase !== 'cancelled') throw new Error(`Active cancellation failed: ${cancellation.status}`);
  if ((await (await call(path)).json()).phase !== 'cancelled') throw new Error('Cancellation was not recorded');
  if (readdirSync(join(dataDir, 'restore-archives')).length) throw new Error('Cancelled upload retained an archive');
  const nextId = randomBytes(16).toString('hex'), nextPath = `/api/v1/services/${serviceId}/database-restore/${nextId}`;
  const next = await call(`${nextPath}/upload`, 'POST', Buffer.from('subsequent synthetic archive'));
  if (next.status !== 200 || (await next.json()).phase !== 'reserved') throw new Error(`Subsequent upload failed: ${next.status}`);
  const cleanup = await call(`${nextPath}/cancel`, 'POST');
  if (cleanup.status !== 200 || (await cleanup.json()).phase !== 'cancelled') throw new Error('Subsequent upload cleanup failed');
  console.log(`PASS ${kind} active upload cancellation through panel and agent, CSRF protection and retry`);
} finally {
  upload?.destroy();
  await panel?.close();
  await agent?.close();
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
}
