import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { WebSocket } from 'ws';
import Database from 'better-sqlite3';
import { assert, containerId, dataRoot, delay, docker, eventually, healthy, PanelApi, projectRoot, Report, route, runId } from './parity-lib.js';
import { credentials } from './parity-scenarios.js';

const api = new PanelApi(); await api.login();
const identity = JSON.parse(readFileSync(resolve(dataRoot, `${runId}-panel-identity.json`), 'utf8'));
const id: string = identity.services.control;
assert(id, 'Run the common integration scenarios first.');
const hostname = `panel-${runId}.localhost`;
const runtimeName = `panel-app-${id}`;
const context = 'colima-panel-dev';
const report = new Report('advanced', { context });
async function service() { return api.call(`/services/${id}`); }
async function patch(config: Record<string, unknown>) { const current = await service(); return api.call(`/services/${id}`, { ...config, expectedRevision: current.revision }, 'PATCH'); }
async function action(type = 'deploy') { return api.call(`/services/${id}/${type}`, {}, 'POST', randomUUID()); }
const git = (branch: string, repository = 'http://127.0.0.1:32180/control.git') => ({ type: 'git', branch, repository, context: '.', dockerfile: 'Dockerfile' });

await report.check('idempotency-and-revision-conflicts', async () => {
  const key = randomUUID();
  const first = await api.call(`/services/${id}/restart`, {}, 'POST', key);
  const duplicate = await api.call(`/services/${id}/restart`, {}, 'POST', key);
  assert.equal(first.id, duplicate.id); await api.wait(first);
  const before = await service(); await patch({ resources: { cpu: 0.5, memoryMb: 384 } });
  await assert.rejects(api.call(`/services/${id}`, { expectedRevision: before.revision, port: 8080 }, 'PATCH'), (error: any) => error.status === 409);
  await assert.rejects(api.call(`/services/${id}/stop`, {}, 'POST', key), (error: any) => error.status === 409);
});

await report.check('real-console-command-and-resize', async () => {
  const containers = await api.call(`/services/${id}/containers`);
  const current = containers.find((container: any) => container.state === 'running'); assert(current);
  const { ticket } = await api.call(`/services/${id}/console-ticket`, { containerId: current.id, shell: '/bin/sh' });
  const output = await new Promise<string>((resolvePromise, reject) => {
    const socket = new WebSocket(`ws://localhost:4180/api/v1/services/${id}/console`, { headers: { Cookie: api.cookie, Origin: 'http://localhost:4180' } });
    let received = ''; let ready = false; const timer = setTimeout(() => { socket.terminate(); reject(new Error('Console output was not received')); }, 15000);
    socket.on('open', () => socket.send(JSON.stringify({ type: 'authenticate', ticket })));
    socket.on('message', data => {
      if (!ready) {
        let message: unknown;
        try { message = JSON.parse(data.toString()); } catch { socket.terminate(); reject(new Error('Invalid console readiness message')); return; }
        if (!message || typeof message !== 'object' || !('type' in message) || message.type !== 'ready') { socket.terminate(); reject(new Error('Console was not ready')); return; }
        ready = true;
        socket.send(JSON.stringify({ type: 'resize', cols: 97, rows: 31 }));
        socket.send(JSON.stringify({ type: 'input', data: `printf 'PARITY_%s\\n' 'CONSOLE_${runId}'; stty size; exit\n` }));
        return;
      }
      received += data.toString();
    });
    socket.on('close', () => { clearTimeout(timer); if (ready) resolvePromise(received); else reject(new Error('Console closed before authentication')); });
    socket.on('error', error => { clearTimeout(timer); reject(error); });
  });
  assert(output.includes(`PARITY_CONSOLE_${runId}`), 'The shell did not execute the marker command');
  assert(/31\s+97/.test(output), 'The PTY did not accept the resize');
  const replay = new WebSocket(`ws://localhost:4180/api/v1/services/${id}/console`, { headers: { Cookie: api.cookie, Origin: 'http://localhost:4180' } });
  await new Promise<void>((resolvePromise, reject) => {
    const timer = setTimeout(() => { replay.terminate(); reject(new Error('Console replay was not rejected')); }, 10000);
    replay.once('open', () => replay.send(JSON.stringify({ type: 'authenticate', ticket })));
    replay.once('message', () => { clearTimeout(timer); replay.terminate(); reject(new Error('Console ticket was reusable')); });
    replay.once('close', code => { clearTimeout(timer); if (code === 1008) resolvePromise(); else reject(new Error(`Unexpected console replay close code: ${code}`)); });
    replay.once('error', () => { clearTimeout(timer); reject(new Error('Console replay connection failed')); });
  });
});

await report.check('live-log-stream', async () => {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(`http://localhost:4180/api/v1/services/${id}/logs/stream`, { headers: { cookie: api.cookie }, signal: controller.signal });
    assert.equal(response.status, 200); assert(response.headers.get('content-type')?.includes('text/event-stream'));
    const reader = response.body!.getReader(); const decoder = new TextDecoder(); let text = '';
    await route(18080, hostname, '/log', { marker: `sse-${runId}` });
    while (!text.includes(`sse-${runId}`)) { const chunk = await reader.read(); if (chunk.done) break; text += decoder.decode(chunk.value); }
    assert(text.includes(`sse-${runId}`)); await reader.cancel();
  } finally { clearTimeout(timer); controller.abort(); }
});

await report.check('secrets-excluded-from-config-jobs-journal-and-logs', async () => {
  const config = JSON.stringify(await service());
  const appDb = new Database(resolve(projectRoot, '.data/panel.sqlite'), { readonly: true });
  const agentDb = new Database(resolve(projectRoot, '.data/agent.sqlite'), { readonly: true });
  try {
    const jobs = JSON.stringify(appDb.prepare('SELECT snapshot FROM jobs').all());
    const journal = JSON.stringify(agentDb.prepare('SELECT * FROM operations').all());
    const logs = JSON.stringify(await api.call(`/services/${id}/logs`));
    for (const secret of [credentials.postgres, credentials.redis, credentials.mariadb]) {
      assert(!config.includes(secret)); assert(!jobs.includes(secret)); assert(!journal.includes(secret)); assert(!logs.includes(secret));
    }
    const connection = await api.call(`/services/${identity.services.postgres}/connection`); assert.equal(connection.password, undefined);
    const reveal = await api.call(`/services/${identity.services.postgres}/connection/reveal`, {}); assert.equal(reveal.password, credentials.postgres);
  } finally { appDb.close(); agentDb.close(); }
});

for (const scenario of [
  { name: 'missing-image', config: { source: { type: 'image' }, image: 'nginx:panel-tag-that-does-not-exist-20261113' } },
  { name: 'missing-repository', config: { source: git('v1', 'http://127.0.0.1:32180/missing.git') } },
  { name: 'broken-build', config: { source: git('broken') } },
  { name: 'unhealthy-release', config: { source: git('unhealthy') } },
  { name: 'wrong-http-port', config: { source: git('v2'), port: 9, domains: [{ hostname, port: 9, primary: true }] } },
]) await report.check(`${scenario.name}-preserves-previous-runtime`, async () => {
  await patch(scenario.config); await api.wait(await action(), 'failed');
  await healthy(18080, hostname);
  assert.equal((await route(18080, hostname, '/version')).json.version, 'v2');
  assert.equal((await route(18080, hostname, '/record')).json.records[0].value, 'persisted');
  await patch({ source: git('v2'), port: 8080, domains: [{ hostname, port: 8080, primary: true }, { hostname: `alias-${hostname}`, port: 8080 }] });
});

await report.check('wrong-database-password-rolls-back-application', async () => {
  const previous = await service();
  await patch({ environment: previous.environment.map((item: any) => item.name === 'PGPASSWORD' ? { name: item.name, secret: true, value: 'intentionally-wrong-password-12345' } : item) });
  await api.wait(await action(), 'failed'); await healthy(18080, hostname);
  assert.equal((await route(18080, hostname, '/record')).json.records[0].value, 'persisted');
  await patch({ environment: previous.environment });
  await api.wait(await action());
});

for (const component of ['worker', 'agent']) await report.check(`interrupted-${component}-recovers-same-deployment`, async () => {
  const previous = await service();
  await patch({ source: git('slow'), environment: [...previous.environment.filter((item: any) => item.name !== 'HEALTH_DELAY_MS'), { name: 'HEALTH_DELAY_MS', value: '10000' }] });
  const pending = await action();
  await eventually('target accepted by Docker before interruption', () => JSON.parse(docker(context, ['service', 'inspect', runtimeName]))[0].Spec, spec => spec.Labels['panel.operation'] === pending.id, 240000);
  const processes = JSON.parse(readFileSync(resolve(projectRoot, '.data/local-processes.json'), 'utf8'));
  const pid = processes.components[component]; assert(Number.isInteger(pid));
  process.kill(pid, 'SIGKILL');
  await eventually(`${component} restarted`, () => JSON.parse(readFileSync(resolve(projectRoot, '.data/local-processes.json'), 'utf8')).components[component], value => Number.isInteger(value) && value !== pid, 15000);
  await api.wait(pending); await healthy(18080, hostname);
  const current = JSON.parse(docker(context, ['service', 'inspect', runtimeName]))[0];
  assert.equal(current.Spec.Labels['panel.operation'], pending.id);
  assert.equal(current.Spec.Mode.Replicated.Replicas, 1);
  assert.equal((await route(18080, hostname, '/file')).json.value, 'persistent-marker');
  await patch({ source: git('v2'), environment: previous.environment }); await api.wait(await action());
});

await report.check('project-edit-keeps-runtime-and-nonempty-delete-is-rejected', async () => {
  await api.call(`/projects/${identity.projectId}`, { name: `${identity.project}-edited`, description: 'Edited while workloads are running' }, 'PATCH');
  assert.equal((await api.call(`/projects/${identity.projectId}`)).description, 'Edited while workloads are running');
  await healthy(18080, hostname);
  await assert.rejects(api.call(`/projects/${identity.projectId}`, {}, 'DELETE'), (error: any) => error.status === 409);
  await api.call(`/projects/${identity.projectId}`, { name: identity.project, description: 'Disposable parity verification fixtures' }, 'PATCH');
});

await report.check('delete-removes-service-routes-and-preserves-volume-and-audit', async () => {
  const created = await api.call(`/projects/${identity.projectId}/services`, { name: 'disposable', image: 'nginx:alpine', port: 80, hostname: `delete-${hostname}`, mounts: [{ type: 'volume', name: 'data', target: '/data' }] }, 'POST', randomUUID());
  await api.wait(created.action);
  const volume = `panel-data-${created.service.id}-data`;
  const removed = await api.call(`/services/${created.service.id}`, {}, 'DELETE', randomUUID());
  await api.wait(removed);
  await assert.rejects(api.call(`/services/${created.service.id}`), (error: any) => error.status === 404);
  assert.equal(JSON.parse(docker(context, ['volume', 'inspect', volume]))[0].Labels['panel.service'], created.service.id);
  assert.equal((await api.call(`/actions/${removed.id}`)).action.status, 'succeeded');
  assert((await route(18080, `delete-${hostname}`)).status >= 400);
});

console.log(`Advanced integration complete: ${report.checks.length} checks.`);
