import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import Database from 'better-sqlite3';

// The caller owns and later deletes this dedicated, disposable Colima profile.
const profile = process.env.SERVUS_PG_E2E_PROFILE;
if (!profile || !/^servus-pg-e2e-[a-f0-9]{16}$/.test(profile)) {
  throw new Error('SERVUS_PG_E2E_PROFILE must be a disposable profile named servus-pg-e2e- followed by 16 lowercase hex digits');
}
const context = `colima-${profile}`;
const socket = join(homedir(), '.colima', profile, 'docker.sock');
const root = resolve(import.meta.dirname, '../..');
const data = mkdtempSync(join(tmpdir(), 'servus-pg-e2e-'));
const email = 'fixture@example.test';
const password = `fixture-${randomBytes(24).toString('hex')}`;
const dbPassword = `fixture-${randomBytes(24).toString('hex')}`;
const deadline = Date.now() + 600_000;
const children = new Set<ChildProcess>();
const cli = (args: string[]) => execFileSync('docker', ['--context', context, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 });
const freePort = () => new Promise<number>((resolvePort, reject) => {
  const server = createServer().listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (!address || typeof address === 'string') return reject(new Error('No loopback port'));
    server.close(() => resolvePort(address.port));
  });
  server.on('error', reject);
});
const waitUntil = async <T>(check: () => Promise<T | undefined>, description: string, interval = 100): Promise<T> => {
  while (Date.now() < deadline) {
    const value = await check();
    if (value !== undefined) return value;
    await sleep(interval);
  }
  throw new Error(`Timed out waiting for ${description}`);
};
let cookie = '', csrf = '';
let origin = '';
async function api(path: string, method = 'GET', body?: unknown, key?: string): Promise<any> {
  const headers: Record<string,string> = { origin, accept: 'application/json' };
  if (cookie) headers.cookie = cookie;
  if (csrf) headers['x-csrf-token'] = csrf;
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (key) headers['idempotency-key'] = key;
  const response = await fetch(`${origin}/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0]!;
  if (!response.ok) throw new Error(`API ${method} ${path} returned ${response.status}`);
  return response.json();
}
async function terminate(child: ChildProcess, signal: NodeJS.Signals) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>(resolveExit => child.once('exit', () => resolveExit()));
  child.kill(signal);
  await Promise.race([exited, sleep(10_000).then(() => { throw new Error('Child did not exit'); })]);
}
function launch(component: 'agent' | 'server' | 'worker', port: number, ingress: number) {
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: homedir(), PANEL_DATA_DIR: data, PANEL_DOCKER_SOCKET: socket, PANEL_PORT: String(port), PANEL_INGRESS_PORT: String(ingress), PANEL_ALLOWED_ORIGINS: origin, PANEL_HOST: '127.0.0.1' };
  const child = spawn(process.execPath, ['--import', 'tsx', join(root, 'apps/panel/src', component, 'index.ts')], { cwd: root, env, stdio: 'ignore' });
  children.add(child); child.once('exit', () => children.delete(child));
  return child;
}
const checkChild = (child: ChildProcess, name: string) => { if (child.exitCode !== null || child.signalCode !== null) throw new Error(`${name} exited unexpectedly`); };
async function waitAction(id: string) {
  return waitUntil(async () => {
    const result = (await api(`/actions/${id}`)).action;
    if (result.status === 'failed' || result.status === 'cancelled') throw new Error(`Fixture action ${id} failed`);
    return result.status === 'succeeded' ? result : undefined;
  }, 'action completion', 300);
}

try {
  const contextInfo = JSON.parse(cli(['context', 'inspect', context]))[0];
  assert.equal(contextInfo.Endpoints?.docker?.Host, `unix://${socket}`);
  const info = JSON.parse(cli(['info', '--format', '{{json .}}']));
  assert.equal(info.Name, context);
  assert.equal(info.Swarm.LocalNodeState, 'active');
  assert.equal(info.Swarm.Nodes, 1);
  assert.equal(info.Swarm.ControlAvailable, true);
  for (const args of [['service', 'ls', '-q'], ['ps', '-aq'], ['volume', 'ls', '-q'], ['secret', 'ls', '-q'], ['config', 'ls', '-q']]) {
    assert.equal(cli(args).trim(), '', 'The disposable Swarm must be empty');
  }
  const networks = cli(['network', 'ls', '--format', '{{.Name}}']).trim().split('\n').sort();
  assert.deepEqual(networks, ['bridge', 'docker_gwbridge', 'host', 'ingress', 'none']);
  const port = await freePort(), ingress = await freePort();
  origin = `http://127.0.0.1:${port}`;
  let agent = launch('agent', port, ingress);
  const server = launch('server', port, ingress);
  const worker = launch('worker', port, ingress);
  await waitUntil(async () => {
    checkChild(agent, 'agent'); checkChild(server, 'server'); checkChild(worker, 'worker');
    try { return (await fetch(`${origin}/health`, { signal: AbortSignal.timeout(1000) })).ok ? true : undefined; } catch { return undefined; }
  }, 'API startup');
  await api('/setup', 'POST', { email, password });
  cookie = ''; csrf = '';
  const login = await api('/auth/login', 'POST', { email, password });
  csrf = login.csrfToken; assert(cookie && csrf && login.user.role === 'admin');
  console.log('PASS local administrator setup and login');
  const project = await api('/projects', 'POST', { name: `fixture-${randomBytes(6).toString('hex')}` });
  const created = await api(`/projects/${project.id}/services`, 'POST', { name: 'database', kind: 'postgres', replicas: 1, database: { database: 'app', user: 'app', password: dbPassword }, resources: { cpu: 0.5, memoryMb: 256 } }, randomUUID());
  const serviceId: string = created.service.id, operationId: string = created.action.id;
  assert.match(serviceId, /^[a-f0-9-]{36}$/); assert.match(operationId, /^[a-f0-9-]{36}$/);
  const journal = new Database(join(data, 'agent.sqlite'), { readonly: true, fileMustExist: true });
  try {
    await waitUntil(async () => {
      checkChild(agent, 'agent');
      const row = journal.prepare('SELECT state,target_spec FROM operations WHERE id=?').get(operationId) as {state:string;target_spec:string|null}|undefined;
      if (row?.state === 'succeeded') throw new Error('Operation finished before interruption could be exercised');
      if (row?.state === 'failed') throw new Error('Operation failed before interruption');
      return row?.state === 'running' && row.target_spec ? true : undefined;
    }, 'durable target before interruption', 20);
    await terminate(agent, 'SIGKILL');
    const row = journal.prepare('SELECT state,target_spec FROM operations WHERE id=?').get(operationId) as {state:string;target_spec:string|null};
    assert.equal(row.state, 'running'); assert(row.target_spec);
    agent = launch('agent', port, ingress);
    await waitAction(operationId);
    const recovered = journal.prepare('SELECT state,target_spec FROM operations WHERE id=?').get(operationId) as {state:string;target_spec:string|null};
    assert.equal(recovered.state, 'succeeded'); assert(recovered.target_spec);
  } finally { journal.close(); }
  console.log('PASS saved target recovered after SIGKILL of the real agent');
  const serviceName = `panel-app-${serviceId}`;
  async function runningContainer() {
    return waitUntil(async () => {
      const ids = cli(['ps', '-q', '--filter', `label=com.docker.swarm.service.name=${serviceName}`]).trim().split('\n').filter(Boolean);
      return ids.length === 1 && /^[a-f0-9]{12,64}$/.test(ids[0]!) ? ids[0] : undefined;
    }, 'PostgreSQL container', 500);
  }
  const run = (container:string, program:string) => cli(['exec', container, '/bin/sh', '-c', program]);
  let container = await runningContainer();
  const noAuth = (host:string) => `set +e; result=$(PGPASSWORD= psql -w ${host} -U app -d app -c 'SELECT 1' 2>&1); case "$result" in *'no password supplied'*|*'password authentication failed'*) exit 0;; *) exit 1;; esac`;
  const wrong = (host:string) => `set +e; result=$(PGPASSWORD=deliberately_wrong psql -w ${host} -U app -d app -c 'SELECT 1' 2>&1); case "$result" in *'password authentication failed'*) exit 0;; *) exit 1;; esac`;
  for (const host of ['-h 127.0.0.1', '']) { run(container, noAuth(host)); run(container, wrong(host)); }
  const valid = 'PGPASSWORD="$(cat /run/secrets/panel-db-password)" psql -w -h 127.0.0.1 -U app -d app -v ON_ERROR_STOP=1 -tA';
  const marker = `marker_${randomBytes(12).toString('hex')}`;
  assert.equal(run(container, `${valid} -c "CREATE TABLE marker(value text); INSERT INTO marker VALUES ('${marker}'); SELECT value FROM marker"`).trim().split('\n').at(-1), marker);
  const spec = JSON.parse(cli(['service', 'inspect', serviceName]))[0].Spec;
  assert.deepEqual(spec.EndpointSpec?.Ports ?? [], []);
  assert(!JSON.stringify(spec).includes(dbPassword));
  const restart = await api(`/services/${serviceId}/restart`, 'POST', {}, randomUUID());
  await waitAction(restart.id);
  container = await runningContainer();
  assert.equal(run(container, `${valid} -c 'SELECT value FROM marker'`).trim(), marker);
  console.log('PASS TCP/socket auth and persistent data after API restart');
} finally {
  for (const child of [...children]) await terminate(child, 'SIGTERM').catch(() => child.kill('SIGKILL'));
  rmSync(data, { recursive: true, force: true });
}
