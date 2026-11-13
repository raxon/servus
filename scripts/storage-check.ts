import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { assert, containerId, dataRoot, docker, eventually, PanelApi, projectRoot, ReferenceApi, Report, route, runId } from './parity-lib.js';

const referenceContext = 'colima-panel-local';
const panelContext = 'colima-panel-dev';
const projectName = `parity-${runId}`;
const directory = `parity-${runId}`;
const source = `/var/lib/panel/mounts/${directory}`;
const marker = `storage-marker-${runId}`;
const report = new Report('storage', {
  executedAfterVmRestart: true,
  contexts: { reference: referenceContext, panel: panelContext },
  comparisonScope: 'Disposable storage fixtures in the locally modified reference image and the independent panel. Read-only behavior is measured from the actual Docker specification.',
});
const panel = new PanelApi();
const reference = new ReferenceApi();
const panelFixtures: Array<{ id: string; hostname: string }> = [];
const referenceBase = { projectName, serviceName: 'storage-bind' };
const referenceName = `${projectName}_storage-bind`;
const referenceHost = `storage-reference-${runId}.localhost`;
let referenceCreationAttempted = false;
let projectId: string;

function inspect(context: string, name: string) {
  return JSON.parse(docker(context, ['service', 'inspect', name]))[0];
}
function running(context: string, name: string): string[] {
  return docker(context, ['ps', '--filter', `label=com.docker.swarm.service.name=${name}`, '--format', '{{.ID}}']).split('\n').filter(Boolean);
}
function absent(context: string, name: string) {
  try { inspect(context, name); return false; }
  catch (error) {
    const message = String((error as { stderr?: unknown }).stderr || '');
    if (/no such service|service .* not found/i.test(message)) return true;
    throw new Error('Docker could not verify whether the disposable service was removed.');
  }
}
function prepareDirectory(context: string, symlink: boolean) {
  docker(context, ['run', '--rm', '--network', 'none', '-v', '/var/lib/panel/mounts:/approved', 'alpine:3.21', '/bin/sh', '-eu', '-c',
    'target="/approved/$1"; [ ! -L "$target" ]; mkdir -p "$target"; printf "%s\\n" "$2" > "$target/marker.txt"; if [ "$3" = yes ]; then if [ -e "$target/escape" ] || [ -L "$target/escape" ]; then [ "$(readlink "$target/escape")" = / ]; else ln -s / "$target/escape"; fi; fi',
    'storage-fixture', directory, marker, symlink ? 'yes' : 'no']);
}
function markerInContainer(context: string, name: string) {
  return docker(context, ['exec', containerId(context, name), 'cat', '/data/marker.txt']);
}
function markerOnHost(context: string) {
  return docker(context, ['run', '--rm', '--network', 'none', '--mount', 'type=bind,source=/var/lib/panel/mounts,target=/approved,readonly', 'alpine:3.21', 'cat', `/approved/${directory}/marker.txt`]);
}
async function httpReady(port: number, hostname: string) {
  return eventually(`HTTP ready ${hostname}`, () => route(port, hostname), response => response.status === 200);
}
async function check(id: string, execute: () => Promise<unknown>) {
  try { await report.check(id, execute); }
  catch { /* Continue to the dedicated cleanup checks and preserve the failure in the report. */ }
}
async function createPanel(name: string, configuration: Record<string, unknown>) {
  const existing = await panel.call(`/projects/${projectId}/services`);
  assert(!existing.some((service: any) => service.name === name), `Refusing to replace an existing ${name} service`);
  const hostname = `${name}-panel-${runId}.localhost`;
  const created = await panel.call(`/projects/${projectId}/services`, {
    name, kind: 'app', image: 'nginx:alpine', port: 80, hostname,
    resources: { cpu: 0.2, memoryMb: 64 }, ...configuration,
  }, 'POST', randomUUID());
  panelFixtures.push({ id: created.service.id, hostname });
  return { ...created, hostname, runtime: `panel-app-${created.service.id}` };
}

await reference.login();
const referenceProject = await reference.call('inspectProject', { projectName }, true);
assert.equal(referenceProject.project.name, projectName);

await check('reference-bind-marker-persists-through-api-restart', async () => {
  assert(!referenceProject.services.some((service: any) => service.name === referenceBase.serviceName), 'Refusing to replace an existing reference bind fixture');
  prepareDirectory(referenceContext, false);
  referenceCreationAttempted = true;
  await reference.call('createAppService', {
    ...referenceBase, source: { type: 'image', image: 'nginx:alpine' },
    build: { type: 'dockerfile', file: 'Dockerfile' }, env: '',
    domains: [{ host: referenceHost, port: 80, https: false }],
    mounts: [{ type: 'bind', hostPath: source, mountPath: '/data', readOnly: true }],
    deploy: { replicas: 1, zeroDowntime: false },
    resources: { cpuLimit: 0.2, cpuReservation: 0, memoryLimit: 64, memoryReservation: 0 },
  });
  await eventually('reference bind task', () => running(referenceContext, referenceName), ids => ids.length === 1);
  await httpReady(80, referenceHost);
  assert.equal(markerInContainer(referenceContext, referenceName), marker);
  const mount = inspect(referenceContext, referenceName).Spec.TaskTemplate.ContainerSpec.Mounts.find((item: any) => item.Type === 'bind' && item.Target === '/data');
  assert.equal(mount.Source, source);
  const before = containerId(referenceContext, referenceName);
  await reference.call('restartAppService', referenceBase);
  await eventually('new reference bind container after restart', () => running(referenceContext, referenceName), ids => ids.length === 1 && ids[0] !== before);
  await httpReady(80, referenceHost);
  assert.equal(markerInContainer(referenceContext, referenceName), marker);
  return { markerPreserved: true, containerReplaced: true, mountSource: source, readOnlyObserved: mount.ReadOnly === true };
});

await check('reference-bind-fixture-removed-through-api', async () => {
  if (!referenceCreationAttempted) throw new Error('No new reference fixture was created; an existing service was left untouched.');
  const project = await reference.call('inspectProject', { projectName }, true);
  if (project.services.some((service: any) => service.name === referenceBase.serviceName)) await reference.call('destroyAppService', referenceBase);
  await eventually('reference bind fixture removed', () => absent(referenceContext, referenceName), Boolean);
  const response = await eventually('reference bind route removed', () => route(80, referenceHost), response => response.status === 404 || response.status === 301 && response.headers.location === `https://${referenceHost}/`);
  assert.equal(markerOnHost(referenceContext), marker);
  return { runtimeRemoved: true, routeStatus: response.status, defaultHttpsRedirectObserved: response.status === 301, syntheticHostDirectoryRetained: true };
});

await panel.login();
const identity = JSON.parse(readFileSync(resolve(dataRoot, `${runId}-panel-identity.json`), 'utf8'));
projectId = identity.projectId;
assert.equal((await panel.call(`/projects/${projectId}`)).name, projectName);

await check('panel-readonly-bind-marker-persists-through-api-restart', async () => {
  prepareDirectory(panelContext, true);
  const created = await createPanel('storage-bind', { mounts: [{ type: 'bind', name: 'data', source, target: '/data', readOnly: true }] });
  await panel.wait(created.action);
  await httpReady(18080, created.hostname);
  assert.equal(markerInContainer(panelContext, created.runtime), marker);
  const mount = inspect(panelContext, created.runtime).Spec.TaskTemplate.ContainerSpec.Mounts.find((item: any) => item.Type === 'bind' && item.Target === '/data');
  assert.equal(mount.Source, source); assert.equal(mount.ReadOnly, true);
  const before = containerId(panelContext, created.runtime);
  await panel.wait(await panel.call(`/services/${created.service.id}/restart`, {}, 'POST', randomUUID()));
  await eventually('new panel bind container after restart', () => running(panelContext, created.runtime), ids => ids.length === 1 && ids[0] !== before);
  await httpReady(18080, created.hostname);
  assert.equal(markerInContainer(panelContext, created.runtime), marker);
  return { markerPreserved: true, containerReplaced: true, readOnlyObserved: true, mountSource: source };
});

await check('panel-bind-symlink-escape-rejected-before-runtime-creation', async () => {
  prepareDirectory(panelContext, true);
  const created = await createPanel('storage-escape', { mounts: [{ type: 'bind', name: 'escape', source: `${source}/escape`, target: '/data', readOnly: true }] });
  const failed = await panel.wait(created.action, 'failed');
  assert.match(failed.action.error || '', /symlink|approved directory|escapes/i);
  const journal = new Database(resolve(projectRoot, '.data/agent.sqlite'), { readonly: true });
  try {
    const operation = journal.prepare('SELECT target_spec FROM operations WHERE id=?').get(created.action.id) as { target_spec: string | null };
    assert.equal(operation.target_spec, null, 'The unsafe configuration reached target-spec persistence');
  } finally { journal.close(); }
  assert(absent(panelContext, created.runtime), 'An unsafe runtime service was created');
  assert.equal((await route(18080, created.hostname)).status, 404);
  return { actionStatus: 'failed', runtimeNeverCreated: true, routeStatus: 404 };
});

await check('panel-two-real-replicas-retained-across-stop-start', async () => {
  const created = await createPanel('storage-scale', { replicas: 2 });
  await panel.wait(created.action);
  await eventually('two running replicas', () => running(panelContext, created.runtime), ids => ids.length === 2);
  const spec = inspect(panelContext, created.runtime).Spec;
  assert.equal(spec.Mode.Replicated.Replicas, 2);
  assert.equal(spec.TaskTemplate.Resources.Limits.NanoCPUs, 200000000);
  assert.equal(spec.TaskTemplate.Resources.Limits.MemoryBytes, 64 * 1024 * 1024);
  await httpReady(18080, created.hostname);
  await panel.wait(await panel.call(`/services/${created.service.id}/stop`, {}, 'POST', randomUUID()));
  assert.equal(running(panelContext, created.runtime).length, 0);
  assert.equal(inspect(panelContext, created.runtime).Spec.Mode.Replicated.Replicas, 0);
  await panel.wait(await panel.call(`/services/${created.service.id}/start`, {}, 'POST', randomUUID()));
  await eventually('two restarted replicas', () => running(panelContext, created.runtime), ids => ids.length === 2);
  assert.equal(inspect(panelContext, created.runtime).Spec.Mode.Replicated.Replicas, 2);
  await httpReady(18080, created.hostname);
  return { initialRunningReplicas: 2, stoppedReplicas: 0, restoredRunningReplicas: 2, cpu: 0.2, memoryMb: 64 };
});

await check('panel-disposable-storage-fixtures-removed-through-api', async () => {
  const failures: string[] = [];
  for (const fixture of panelFixtures) {
    try {
      await panel.wait(await panel.call(`/services/${fixture.id}`, {}, 'DELETE', randomUUID()));
      assert(absent(panelContext, `panel-app-${fixture.id}`));
      assert.equal((await route(18080, fixture.hostname)).status, 404);
      await assert.rejects(panel.call(`/services/${fixture.id}`), (error: any) => error.status === 404);
    } catch (error) { failures.push(`${fixture.id}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  assert.equal(failures.length, 0, failures.join('; '));
  assert.equal(panelFixtures.length, 3, 'Not all three disposable panel fixtures were created');
  assert.equal(markerOnHost(panelContext), marker);
  return { removedServices: panelFixtures.length, routesStatus: 404, syntheticHostDirectoryRetained: true };
});

report.save();
if (report.checks.some(check => check.status === 'failed')) process.exitCode = 1;
console.log(`Storage verification complete: ${report.checks.filter(check => check.status === 'passed').length}/${report.checks.length} passed.`);
