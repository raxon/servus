/** Actual template API, signed S3 routing and persistent storage on an exclusive VM. */
import assert from 'node:assert/strict';
import {execFile, execFileSync} from 'node:child_process';
import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {Agent, request as httpRequest} from 'node:http';
import {existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {promisify} from 'node:util';
import Docker from 'dockerode';
import {parse, stringify} from 'yaml';
import {CreateBucketCommand, DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client} from '@aws-sdk/client-s3';
import {createAgent} from '../../apps/panel/src/agent/app.js';
import {createApp} from '../../apps/panel/src/server/app.js';
import {Store} from '../../apps/panel/src/server/store.js';
import {APPLICATION_TEMPLATES} from '../../apps/panel/src/shared/templates.js';
import type {ComposeAction, ComposeConfiguration} from '../../apps/panel/src/shared/compose.js';

if (process.env.SERVUS_DISPOSABLE_MINIO_TEMPLATE_TEST !== '1') throw new Error('Explicitly opt in to the exclusive MinIO template fixture.');
const context = 'colima-servus-wordpress-e2e', profile = 'servus-wordpress-e2e', ingressPort = 19480;
const cli = (args: string[]) => execFileSync('docker', ['--context', context, ...args], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000}).trim();
const socket = cli(['context', 'inspect', context, '--format', '{{.Endpoints.docker.Host}}']).replace(/^unix:\/\//, '');
assert.match(socket, /\/\.colima\/servus-wordpress-e2e\/docker\.sock$/);
const docker = new Docker({socketPath: socket});
const daemon = await docker.info();
assert.equal(daemon.Name, 'colima-servus-wordpress-e2e');
await until(async () => (await docker.listContainers({all: true})).length === 0 ? true : undefined, 'exclusive daemon must be empty', 30_000);
assert.equal((await docker.listVolumes()).Volumes?.length ?? 0, 0);
if (daemon.Swarm?.LocalNodeState !== 'inactive') {
  assert.equal(daemon.Swarm?.ControlAvailable, true, 'The exclusive daemon must be an inactive node or a Swarm manager.');
  assert.equal((await docker.listServices()).length, 0, 'The exclusive daemon must contain no preexisting Swarm services.');
}
assert(!(await docker.listNetworks()).some(network => network.Name === 'panel-ingress'), 'The exclusive daemon must contain no preexisting ingress network.');
const template = APPLICATION_TEMPLATES.find(item => item.id === 'minio')!, imageReference = template.images[0]!;
const image = await docker.getImage(imageReference).inspect(); await docker.getImage('traefik:3.7.13').inspect();
const runId = `minio-${Date.now()}-${randomBytes(4).toString('hex')}`, hostname = `${runId}.localhost`, apiHostname = `api-${hostname}`;
const root = mkdtempSync('/tmp/smt-'), dataDir = join(root, 'data'), dockerConfig = join(root, 'docker-config');
mkdirSync(dataDir, {mode: 0o700}); mkdirSync(dockerConfig, {mode: 0o700});
assert(existsSync('/opt/homebrew/lib/docker/cli-plugins/docker-compose'));
writeFileSync(join(dockerConfig, 'config.json'), JSON.stringify({cliPluginsExtraDirs: ['/opt/homebrew/lib/docker/cli-plugins']}), {mode: 0o600});
const oldConfig = process.env.DOCKER_CONFIG, oldLocal = process.env.PANEL_ALLOW_LOCAL_IMAGES, oldHttps = process.env.PANEL_HTTPS_ENABLED;
process.env.DOCKER_CONFIG = dockerConfig; process.env.PANEL_ALLOW_LOCAL_IMAGES = '1'; process.env.PANEL_HTTPS_ENABLED = 'false';
let store = new Store(dataDir);
const actor = store.setup('fixture@example.test', 'session-only-fixture'), project = store.createProject(runId), session = store.createSession(actor.id);
const headers = {cookie: `panel_session=${session.token}`, 'x-csrf-token': session.csrfToken};
const config = {dataDir, token: randomBytes(32).toString('hex'), socketPath: join(root, 'agent.sock'), dockerSocket: socket, ingressPort, ingressImage: 'traefik:3.7.13'};
let agent: Awaited<ReturnType<typeof createAgent>> | undefined, app: Awaited<ReturnType<typeof createApp>> | undefined, apiUrl = '', workloadId = '', phase = 'setup', passed = false;
let client: S3Client | undefined, wrong: S3Client | undefined, retainedClient: S3Client | undefined;
let ingressServiceId: string | undefined, ingressNetworkId: string | undefined;
const clients: S3Client[] = [], agents: Agent[] = [], helpers: string[] = [], networks: string[] = [], checks: string[] = [];
const bucket = `servus-${runId}`, key = 'Zażółć/fixture.bin', discardedKey = 'temporary/deleted.bin', bytes = Buffer.concat([Buffer.from(`Servus MinIO ${runId} - zażółć gęślą jaźń\n`), randomBytes(256)]), hash = createHash('sha256').update(bytes).digest('hex');
const artifact = resolve('artifacts/templates', `${runId}.json`);
const mark = (check: string) => {checks.push(check); console.log(`PASS ${check}`);};
async function until<T>(read: () => Promise<T | undefined>, label: string, milliseconds = 120_000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {const result = await read(); if (result !== undefined) return result; await new Promise(resolve => setTimeout(resolve, 500));}
  throw new Error(`Timed out during ${label}`);
}
async function open() {
  agent = await createAgent(config); await agent.listen({path: config.socketPath});
  app = await createApp({dataDir, store, agentConnection: {socketPath: config.socketPath, token: config.token}});
  apiUrl = await app.listen({host: '127.0.0.1', port: 0});
}
async function close() {await app?.close(); app = undefined; await agent?.close(); agent = undefined;}
async function api(path: string, method = 'GET', body?: unknown) {
  const response = await fetch(apiUrl + '/api/v1' + path, {method, headers: {...headers, 'idempotency-key': randomUUID(), ...(body === undefined ? {} : {'content-type': 'application/json'})}, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(310_000)});
  const value = await response.json() as any;
  assert(response.ok, `API ${method} ${path} returned ${response.status}: ${store.vault.redact(value.error?.message ?? 'request failed')}`);
  return value;
}
async function action(value: {action?: ComposeAction} | ComposeAction) {
  const queued = 'action' in value ? value.action! : value as ComposeAction;
  await until(async () => {
    const current = (await api(`/compose/${workloadId}/actions`) as ComposeAction[]).find(item => item.id === queued.id);
    assert(current, 'The Compose action is durable.');
    if (current.status === 'failed') throw new Error(`Compose action failed: ${store.vault.redact(current.error ?? 'unknown failure')}`);
    return current.status === 'succeeded' ? current : undefined;
  }, 'Compose action', 300_000);
}
function s3(endpoint: string, credentials: {accessKeyId: string; secretAccessKey: string}, routed = false) {
  const httpAgent = new Agent({keepAlive: true, maxSockets: 4, ...(routed ? {lookup: (_name: string, options: any, callback: any) => {
    assert.equal(_name, apiHostname);
    if (options?.all) callback(null, [{address: '127.0.0.1', family: 4}]); else callback(null, '127.0.0.1', 4);
  }} : {})});
  agents.push(httpAgent);
  const value = new S3Client({endpoint, credentials, region: 'us-east-1', forcePathStyle: true, maxAttempts: 1,
    requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED',
    requestHandler: {httpAgent, connectionTimeout: 3_000, requestTimeout: 10_000, throwOnRequestTimeout: true}});
  clients.push(value); return value;
}
async function http(host: string, path: string) {
  return new Promise<{status: number; body: Buffer}>((resolvePromise, reject) => {
    const request = httpRequest({host: '127.0.0.1', port: ingressPort, path, headers: {host}}, response => {
      const chunks: Buffer[] = []; let size = 0;
      response.on('data', (chunk: Buffer) => {size += chunk.length; if (size > 2 * 1024 * 1024) request.destroy(new Error('Fixture response exceeds its bound')); else chunks.push(chunk);});
      response.on('error', reject); response.on('end', () => resolvePromise({status: response.statusCode!, body: Buffer.concat(chunks)}));
    });
    request.on('error', reject); request.setTimeout(10_000, () => request.destroy(new Error('HTTP fixture deadline exceeded'))); request.end();
  });
}
async function verifyObjects(selected = client!) {
  await until(async () => {
    try {const result = await selected.send(new GetObjectCommand({Bucket: bucket, Key: key})); const content = Buffer.from(await result.Body!.transformToByteArray()); assert.equal(createHash('sha256').update(content).digest('hex'), hash); return true;} catch (error) {if (error instanceof assert.AssertionError) throw error; return undefined;}
  }, 'retained object readability');
  const listed = await selected.send(new ListObjectsV2Command({Bucket: bucket})); assert.deepEqual(listed.Contents?.map(item => item.Key), [key]);
}
try {
  await open(); phase = 'template-api-deployment';
  const created = await api(`/projects/${project.id}/templates/minio`, 'POST', {name: 'object-store', hostname, apiHostname});
  workloadId = created.workload.id; assert.deepEqual(created.workload.domains.map((item: {port: number}) => item.port).sort(), [9000, 9001]);
  await action(created);
  const ingress = await docker.getService('panel-ingress').inspect(), ingressNetwork = await docker.getNetwork('panel-ingress').inspect();
  assert.equal(ingress.Spec.Labels?.['panel.owner'], 'self-hosted-panel'); assert.equal(ingressNetwork.Labels?.['panel.owner'], 'self-hosted-panel');
  ingressServiceId = ingress.ID; ingressNetworkId = ingressNetwork.Id;
  assert(ingressServiceId && ingressNetworkId); mark('real-template-api-compose-deployment-with-separate-console-and-s3-domains');
  const configuration = await api(`/compose/${workloadId}/configuration`) as ComposeConfiguration; assert(configuration.source.type === 'inline');
  const document = parse(configuration.source.yaml), environment = document.services.app.environment as Record<string, string>;
  const credentials = {accessKeyId: environment.MINIO_ROOT_USER!, secretAccessKey: environment.MINIO_ROOT_PASSWORD!};
  const metadata = JSON.stringify(await api(`/compose/${workloadId}`)); assert(!metadata.includes(credentials.accessKeyId)); assert(!metadata.includes(credentials.secretAccessKey));
  const first = (await docker.listContainers({filters: {label: [`panel.workload=${workloadId}`]}}))[0]!;
  assert(first); assert(Object.values((await docker.getContainer(first.Id).inspect()).NetworkSettings.Ports).every(value => value === null || value.length === 0));
  await until(async () => {try {return (await http(apiHostname, '/minio/health/ready')).status === 200 ? true : undefined;} catch {return undefined;}}, 'MinIO health');
  const console = await http(hostname, '/'); assert.equal(console.status, 200); assert.match(console.body.toString(), /MinIO|<html/i);
  mark('real-health-console-http-and-no-direct-host-ports');
  client = s3(`http://${apiHostname}:${ingressPort}`, credentials, true);
  wrong = s3(`http://${apiHostname}:${ingressPort}`, {...credentials, secretAccessKey: randomBytes(32).toString('hex')}, true);
  phase = 'signed-s3';
  await client.send(new CreateBucketCommand({Bucket: bucket}));
  await client.send(new PutObjectCommand({Bucket: bucket, Key: key, Body: bytes, ContentType: 'application/octet-stream'}));
  await verifyObjects(); mark('signed-s3-create-bucket-put-get-list-with-unicode-key-and-sha256');
  const unsigned = await http(apiHostname, `/${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`); assert.equal(unsigned.status, 403);
  await assert.rejects(wrong.send(new GetObjectCommand({Bucket: bucket, Key: key})), (error: any) => error.$metadata?.httpStatusCode === 403);
  mark('unsigned-and-wrong-signature-object-reads-denied');
  await client.send(new PutObjectCommand({Bucket: bucket, Key: discardedKey, Body: 'temporary fixture'}));
  await client.send(new DeleteObjectCommand({Bucket: bucket, Key: discardedKey}));
  await assert.rejects(client.send(new GetObjectCommand({Bucket: bucket, Key: discardedKey})), (error: any) => error.$metadata?.httpStatusCode === 404);
  await verifyObjects(); mark('signed-delete-removes-only-selected-object');
  phase = 'redeploy-update-restart';
  await action(await api(`/compose/${workloadId}/deploy`, 'POST', {})); await verifyObjects(); mark('repeat-deploy-preserves-s3-data');
  document.services.app.environment.SERVUS_FIXTURE_REVISION = runId;
  const updated = await api(`/compose/${workloadId}`, 'PATCH', {...configuration, expectedRevision: 1, source: {type: 'inline', yaml: stringify(document)}}); assert.equal(updated.revision, 2);
  await action(await api(`/compose/${workloadId}/deploy`, 'POST', {}));
  const replacement = (await docker.listContainers({filters: {label: [`panel.workload=${workloadId}`]}}))[0]!; assert.notEqual(replacement.Id, first.Id);
  await verifyObjects(); mark('configuration-update-replaces-container-and-retains-data');
  await action(await api(`/compose/${workloadId}/restart`, 'POST', {})); await verifyObjects(); mark('minio-restart-preserves-signed-object-access');
  phase = 'vm-control-plane-restart'; await close(); store.close(); store = new Store(dataDir);
  await promisify(execFile)('colima', ['stop', '--profile', profile], {timeout: 180_000, maxBuffer: 1024 * 1024});
  await promisify(execFile)('colima', ['start', '--profile', profile, '--activate=false'], {timeout: 180_000, maxBuffer: 1024 * 1024});
  await open(); await verifyObjects(); assert.equal((await api(`/compose/${workloadId}`)).deployedRevision, 2);
  mark('isolated-vm-and-fresh-api-agent-store-reopen-preserve-data-and-panel-session');
  phase = 'destroy-retain'; await action(await api(`/compose/${workloadId}/destroy`, 'POST', {confirm: true}));
  assert.equal((await docker.listContainers({all: true, filters: {label: [`panel.workload=${workloadId}`]}})).length, 0);
  const volumes = (await docker.listVolumes({filters: {label: [`panel.workload=${workloadId}`]}})).Volumes ?? []; assert.equal(volumes.length, 1);
  assert.equal(volumes[0]!.Labels?.['panel.owner'], 'self-hosted-panel'); assert.equal(volumes[0]!.Labels?.['panel.project'], project.id);
  const envFile = join(root, 'retained-minio.env'); writeFileSync(envFile, Object.entries(environment).map(([key, value]) => `${key}=${value}`).join('\n') + '\n', {mode: 0o600});
  const networkName = `${runId}-retained`, helperName = `${runId}-retained`; networks.push(networkName); helpers.push(helperName);
  await docker.createNetwork({Name: networkName, Driver: 'bridge', Labels: {'servus.minio.test': runId}});
  cli(['run', '-d', '--name', helperName, '--network', networkName, '--memory', '512m', '--label', `servus.minio.test=${runId}`, '--publish', '127.0.0.1::9000', '--env-file', envFile, '--volume', `${volumes[0]!.Name}:/data`, imageReference, 'server', '/data', '--console-address', ':9001']);
  const inspection = await docker.getContainer(helperName).inspect(), binding = inspection.NetworkSettings.Ports['9000/tcp']![0]!; assert.equal(binding.HostIp, '127.0.0.1');
  retainedClient = s3(`http://127.0.0.1:${binding.HostPort}`, credentials); await verifyObjects(retainedClient);
  mark('api-observed-destroy-retains-volume-and-fresh-minio-container-reopens-object-bytes');
  passed = true;
} finally {
  let cleanupStatus: 'passed' | 'failed' = 'passed';
  try {
    await close(); for (const value of clients) value.destroy(); for (const value of agents) value.destroy();
    for (const name of helpers) {try {const container = docker.getContainer(name), value = await container.inspect(); assert.equal(value.Config.Labels?.['servus.minio.test'], runId); await container.remove({force: true});} catch (error) {if ((error as {statusCode?: number}).statusCode !== 404) throw error;}}
    for (const name of networks) {try {const network = docker.getNetwork(name), value = await network.inspect(); assert.equal(value.Labels?.['servus.minio.test'], runId); await network.remove();} catch (error) {if ((error as {statusCode?: number}).statusCode !== 404) throw error;}}
    if (workloadId) {
      for (const container of await docker.listContainers({all: true, filters: {label: [`panel.workload=${workloadId}`]}})) {assert.equal(container.Labels['panel.owner'], 'self-hosted-panel'); await docker.getContainer(container.Id).remove({force: true});}
      for (const network of await docker.listNetworks({filters: {label: [`panel.workload=${workloadId}`]}})) {assert.equal(network.Labels?.['panel.owner'], 'self-hosted-panel'); await docker.getNetwork(network.Id).remove();}
      for (const volume of (await docker.listVolumes({filters: {label: [`panel.workload=${workloadId}`]}})).Volumes ?? []) {assert.equal(volume.Labels?.['panel.owner'], 'self-hosted-panel'); await docker.getVolume(volume.Name).remove();}
    }
    if (ingressServiceId) {
      const service = docker.getService(ingressServiceId), value = await service.inspect();
      assert.equal(value.ID, ingressServiceId); assert.equal(value.Spec.Name, 'panel-ingress'); assert.equal(value.Spec.Labels?.['panel.owner'], 'self-hosted-panel'); await service.remove();
      await until(async () => (await docker.listContainers({all: true, filters: {label: [`com.docker.swarm.service.id=${ingressServiceId}`]}})).length === 0 ? true : undefined, 'owned ingress task cleanup');
    } else assert(!(await docker.listServices()).some(service => service.Spec.Name === 'panel-ingress'), 'Unclaimed ingress requires fixture reconciliation.');
    if (ingressNetworkId) {
      const network = docker.getNetwork(ingressNetworkId), value = await network.inspect();
      assert.equal(value.Id, ingressNetworkId); assert.equal(value.Name, 'panel-ingress'); assert.equal(value.Labels?.['panel.owner'], 'self-hosted-panel');
      await until(async () => {try {await network.remove(); return true;} catch {return undefined;}}, 'exclusive ingress cleanup');
    } else assert(!(await docker.listNetworks()).some(network => network.Name === 'panel-ingress'), 'Unclaimed ingress network requires fixture reconciliation.');
    store.close(); rmSync(root, {recursive: true, force: true});
  } catch (error) {
    cleanupStatus = 'failed'; throw error;
  } finally {
    if (oldConfig === undefined) delete process.env.DOCKER_CONFIG; else process.env.DOCKER_CONFIG = oldConfig;
    if (oldLocal === undefined) delete process.env.PANEL_ALLOW_LOCAL_IMAGES; else process.env.PANEL_ALLOW_LOCAL_IMAGES = oldLocal;
    if (oldHttps === undefined) delete process.env.PANEL_HTTPS_ENABLED; else process.env.PANEL_HTTPS_ENABLED = oldHttps;
    mkdirSync(resolve('artifacts/templates'), {recursive: true});
    writeFileSync(artifact, JSON.stringify({runId, context, checkedAt: new Date().toISOString(), status: passed && cleanupStatus === 'passed' ? 'passed' : 'failed', runtimeStatus: passed ? 'passed' : 'failed', cleanupStatus, phase, templateVersion: template.version,
      image: {reference: imageReference, id: image.Id, digests: image.RepoDigests}, checks, objectSha256: hash,
      limits: 'Community MinIO image with no activation/license modifications. Exclusive local VM and HTTP S3 SigV4 routing; no production DNS, public TLS, multi-node replication, IAM policy coverage or MinIO version migration tested.'}, null, 2) + '\n');
    console.log(`${passed && cleanupStatus === 'passed' ? 'PASS' : 'FAIL'} MinIO template evidence: ${artifact}`);
  }
}
