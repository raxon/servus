import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { assert, dataRoot, delay, docker, eventually, ReferenceApi, Report, route, runId } from './parity-lib.js';

const context = 'colima-panel-local';
const projectName = `parity-${runId}`;
const hostname = `reference-${runId}.localhost`;
const base = { projectName, serviceName: 'control' };
const repository = 'http://192.168.5.2:32180/control.git';
const credentials = JSON.parse(readFileSync(resolve(dataRoot, `${runId}.json`), 'utf8'));
const api = new ReferenceApi();
await api.login();
const original = await api.call('inspectAppService', base, true);
const originalEnv = String(original.env);
const secretValues = Object.values(credentials).filter((value): value is string => typeof value === 'string');
function safeError(error: unknown) {
  let text = error instanceof Error ? error.message : String(error);
  for (const value of secretValues) text = text.replaceAll(value, '[REDACTED]');
  return text.slice(0, 1200);
}
const report = new Report('reference-advanced', {
  version: '2.38.0', modifiedReference: true, context,
  comparisonScope: 'Observed behavior of the locally modified reference image. These results do not establish behavior of an unmodified commercial release.',
  checkMeaning: 'Passed means the failure was exercised, observations collected, and shared control configuration and persistent data restored.',
  oldRuntimePreservedDefinition: 'The original runtime specification matches the final specification and the final HTTP health response is 200. This does not assert uninterrupted availability or preservation of the same container; those observations are recorded separately.',
});

async function http(host = hostname, path = '/health') {
  try { const response = await route(80, host, path); return { status: response.status, json: response.json }; }
  catch { return { status: 0, json: undefined }; }
}
function runtime(serviceName = 'control') {
  try {
    const name = `${projectName}_${serviceName}`;
    const service = JSON.parse(docker(context, ['service', 'inspect', name]))[0];
    const spec = service.Spec;
    let containers: string[] = [];
    try { containers = docker(context, ['ps', '--filter', `label=com.docker.swarm.service.name=${name}`, '--format', '{{.ID}}']).split('\n').filter(Boolean); } catch {}
    return { exists: true, fingerprint: createHash('sha256').update(JSON.stringify({ task: spec.TaskTemplate, mode: spec.Mode, endpoint: spec.EndpointSpec })).digest('hex'), image: spec.TaskTemplate.ContainerSpec.Image, containers };
  } catch { return { exists: false, fingerprint: null, image: null, containers: [] as string[] }; }
}
async function actions(serviceName = 'control') {
  return await api.call('listActions', { projectName, serviceName }, true) as Array<{ id: string; type: string; status: string }>;
}
async function observeDeployment(mutate: () => Promise<unknown>, serviceName = 'control', host = hostname, settleMs = 20000) {
  const before = runtime(serviceName);
  const existing = new Set((await actions(serviceName)).map(action => action.id));
  const statuses: Record<string, number> = {};
  const sample = async () => { const response = await http(host); statuses[String(response.status)] = (statuses[String(response.status)] || 0) + 1; return response; };
  let requestError: string | null = null;
  let requestStatus: number | null = null;
  try { await mutate(); } catch (error) { requestError = safeError(error); requestStatus = (error as {status?:number}).status ?? null; }
  let action: any;
  try {
    const findAction = async () => (await actions(serviceName)).find(item => !existing.has(item.id) && item.type === 'deployment');
    action = requestError ? await findAction() : await eventually('new reference deployment action', findAction, Boolean, 15000);
  } catch (error) {
    if (!requestError) throw error;
  }
  let timedOut = false;
  if (action) {
    const deadline = Date.now() + 360000;
    while (Date.now() < deadline) {
      action = await api.call('getAction', { id: action.id }, true);
      await sample();
      if (!['running', 'queued', 'pending', 'initializing', 'processing'].includes(action.status)) break;
      await delay(500);
    }
    timedOut = ['running', 'queued', 'pending', 'initializing', 'processing'].includes(action.status);
  }
  const settledUntil = Date.now() + settleMs;
  while (Date.now() < settledUntil) { await sample(); await delay(1000); }
  const health = await sample();
  const version = await http(host, '/version');
  const after = runtime(serviceName);
  return {
    actionId: action?.id ?? null, actionStatus: action?.status ?? null, timedOut, requestError, requestStatus,
    actionReportedSuccess: action?.status === 'done', httpHealthStatus: health.status,
    versionStatus: version.status, version: version.json?.version ?? null,
    healthStatusSamples: statuses,
    oldRuntimePreserved: before.exists && before.fingerprint === after.fingerprint && health.status === 200,
    continuousHttpAvailability: Object.keys(statuses).every(status => status === '200'),
    oldRuntimeSpecificationPreserved: before.fingerprint !== null && before.fingerprint === after.fingerprint,
    oldContainerPreserved: before.containers.some(id => after.containers.includes(id)),
    runtimeExists: after.exists,
  };
}
async function assertRestored() {
  await eventually('restored control HTTP health', () => http(), value => value.status === 200, 360000);
  await eventually('restored Git v2', () => http(hostname, '/version'), value => value.status === 200 && value.json?.version === 'v2', 360000);
  let stableSince = 0;
  let stableContainer = '';
  await eventually('stable restored control container', async () => {
    const state = runtime();
    const id = state.containers.length === 1 ? state.containers[0]! : '';
    const health = await http();
    let containerHealthy = false;
    try { containerHealthy = !!id && docker(context, ['inspect', id, '--format', '{{.State.Health.Status}}']) === 'healthy'; } catch {}
    if (!containerHealthy || health.status !== 200 || id !== stableContainer) {
      stableSince = 0;
      stableContainer = id;
      return false;
    }
    stableSince ||= Date.now();
    return Date.now() - stableSince >= 5000;
  }, Boolean, 360000);
  const file = await http(hostname, '/file');
  assert.equal(file.status, 200); assert.equal(file.json?.value, 'persistent-marker');
  const rows = await http(hostname, '/record');
  assert.equal(rows.status, 200); assert(rows.json?.records?.some((row: any) => row.id === runId && row.value === 'persisted'));
  const counter = await http(hostname, '/counter');
  const counterFile=resolve(dataRoot,`${runId}-reference-counter.json`);
  const expectedCounter=existsSync(counterFile)?JSON.parse(readFileSync(counterFile,'utf8')).value:1;
  assert.equal(counter.status, 200); assert.equal(counter.json?.counter, expectedCounter);
  return { healthy: true, stableHealthyContainer: true, version: 'v2', postgresRecordPreserved: true, redisCounterPreserved: true, volumeFilePreserved: true };
}
async function restore() {
  await api.call('updateAppSourceGit', { ...base, repo: repository, ref: 'v2', path: '/' });
  const current = await api.call('inspectAppService', base, true);
  if (current.env !== originalEnv) await api.call('updateAppEnv', { ...base, env: originalEnv });
  const observation = await observeDeployment(() => api.call('deployAppService', base), 'control', hostname, 0);
  assert.equal(observation.actionStatus, 'done', 'Reference restoration deployment did not finish successfully');
  return await assertRestored();
}
async function scenario(id: string, change: () => Promise<unknown>) {
  await report.check(id, async () => {
    let observation: unknown;
    let failure: unknown;
    try {
      observation = await observeDeployment(async () => { await change(); await api.call('deployAppService', base); });
    } catch (error) { failure = error; }
    const restoration = await restore();
    if (failure) throw new Error(safeError(failure));
    return { observation, restoration };
  });
}

await report.check('baseline-healthy-and-persistent', assertRestored);
await scenario('missing-image', () => api.call('updateAppSourceImage', { ...base, image: `panel-fixture-does-not-exist:${runId}` }));
await scenario('invalid-repository', () => api.call('updateAppSourceGit', { ...base, repo: 'http://192.168.5.2:32180/missing.git', ref: 'v2', path: '/' }));
await scenario('broken-git-build', () => api.call('updateAppSourceGit', { ...base, repo: repository, ref: 'broken', path: '/' }));
await scenario('unhealthy-release', () => api.call('updateAppSourceGit', { ...base, repo: repository, ref: 'unhealthy', path: '/' }));
await scenario('wrong-database-password', () => api.call('updateAppEnv', { ...base, env: originalEnv.replace(/^PGPASSWORD=.*$/m, 'PGPASSWORD=intentionally-invalid-test-password') }));

await report.check('wrong-http-port', async () => {
  const serviceName = 'fail-port';
  const host = `fail-port-${hostname}`;
  let observation: unknown;
  try {
    observation = await observeDeployment(() => api.call('createAppService', {
      projectName, serviceName, source: { type: 'image', image: 'nginx:alpine' }, build: { type: 'dockerfile', file: 'Dockerfile' },
      domains: [{ host, port: 9, https: false }], env: '', deploy: { replicas: 1, zeroDowntime: true },
      resources: { cpuLimit: 0.25, cpuReservation: 0, memoryLimit: 64, memoryReservation: 0 },
    }), serviceName, host);
  } finally {
    await api.call('destroyAppService', { projectName, serviceName });
    await eventually('failure fixture removed', () => runtime(serviceName), value => !value.exists);
  }
  return { observation, isolatedFixture: true, fixtureRemoved: true, restoration: await assertRestored() };
});
report.save();
console.log(`Reference failure observations saved for ${runId}.`);
