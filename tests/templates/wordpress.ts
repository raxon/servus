/** Real HTTP WordPress template acceptance on its exclusive disposable Docker daemon. */
import assert from 'node:assert/strict';
import {execFile, execFileSync} from 'node:child_process';
import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {request as httpRequest} from 'node:http';
import {promisify} from 'node:util';
import Docker from 'dockerode';
import {parse, stringify} from 'yaml';
import {createAgent} from '../../apps/panel/src/agent/app.js';
import {createApp} from '../../apps/panel/src/server/app.js';
import {Store} from '../../apps/panel/src/server/store.js';
import {APPLICATION_TEMPLATES} from '../../apps/panel/src/shared/templates.js';
import type {ComposeAction, ComposeConfiguration} from '../../apps/panel/src/shared/compose.js';

if (process.env.SERVUS_DISPOSABLE_WORDPRESS_TEST !== '1') throw new Error('Explicitly opt in to the exclusive WordPress test daemon.');
const context = 'colima-servus-wordpress-e2e', profile = 'servus-wordpress-e2e', ingressPort = 19480;
const cli = (args: string[]) => execFileSync('docker', ['--context', context, ...args], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000}).trim();
const socket = cli(['context', 'inspect', context, '--format', '{{.Endpoints.docker.Host}}']).replace(/^unix:\/\//, '');
assert.match(socket, /\/\.colima\/servus-wordpress-e2e\/docker\.sock$/);
const docker = new Docker({socketPath: socket});
const daemon = await docker.info();
assert.equal(daemon.Name, 'colima-servus-wordpress-e2e');
await until(async () => (await docker.listContainers({all: true})).length === 0 ? true : undefined, 'exclusive daemon is empty after prior task cleanup', 30_000);
assert.equal((await docker.listVolumes()).Volumes?.length ?? 0, 0, 'The exclusive daemon must contain no preexisting data.');
if (daemon.Swarm?.LocalNodeState !== 'inactive') {
  assert.equal(daemon.Swarm?.ControlAvailable, true, 'The exclusive daemon must be an inactive node or a Swarm manager.');
  assert.equal((await docker.listServices()).length, 0, 'The exclusive daemon must contain no preexisting Swarm services.');
}
assert(!(await docker.listNetworks()).some(network => network.Name === 'panel-ingress'), 'The exclusive daemon must contain no preexisting ingress network.');
const template = APPLICATION_TEMPLATES.find(item => item.id === 'wordpress')!;
const images = await Promise.all(template.images.map(async reference => {const image = await docker.getImage(reference).inspect(); return {reference, id: image.Id, digests: image.RepoDigests};}));
await docker.getImage('traefik:3.7.13').inspect();
const runId = `wordpress-${Date.now()}-${randomBytes(4).toString('hex')}`, hostname = `${runId}.localhost`;
const root = mkdtempSync('/tmp/swp-'), dataDir = join(root, 'data'), dockerConfig = join(root, 'docker-config');
mkdirSync(dataDir, {mode: 0o700}); mkdirSync(dockerConfig, {mode: 0o700});
assert(existsSync('/opt/homebrew/lib/docker/cli-plugins/docker-compose'));
writeFileSync(join(dockerConfig, 'config.json'), JSON.stringify({cliPluginsExtraDirs: ['/opt/homebrew/lib/docker/cli-plugins']}), {mode: 0o600});
const oldConfig = process.env.DOCKER_CONFIG, oldLocal = process.env.PANEL_ALLOW_LOCAL_IMAGES, oldHttps = process.env.PANEL_HTTPS_ENABLED;
process.env.DOCKER_CONFIG = dockerConfig; process.env.PANEL_ALLOW_LOCAL_IMAGES = '1'; process.env.PANEL_HTTPS_ENABLED = 'false';
let store = new Store(dataDir);
const actor = store.setup('fixture@example.test', 'fixture-session-only'), project = store.createProject(runId);
const auth = store.createSession(actor.id), headers = {cookie: `panel_session=${auth.token}`, 'x-csrf-token': auth.csrfToken};
const config = {dataDir, token: randomBytes(32).toString('hex'), socketPath: join(root, 'agent.sock'), dockerSocket: socket, ingressPort, ingressImage: 'traefik:3.7.13'};
let agent: Awaited<ReturnType<typeof createAgent>> | undefined, app: Awaited<ReturnType<typeof createApp>> | undefined, apiUrl = '', workloadId = '', phase = 'setup', succeeded = false;
const checks: string[] = [], artifacts = resolve('artifacts/templates'), artifact = join(artifacts, `${runId}.json`), cookieJar = new Map<string, string>();
const adminPassword = randomBytes(24).toString('base64url'), title = `Servus ${runId}`, postProof = `Zażółć gęślą jaźń ${randomUUID()}`;
const mediaBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB1sAAAAASUVORK5CYII=', 'base64');
const mediaHash = createHash('sha256').update(mediaBytes).digest('hex');
let postId = 0, mediaId = 0, mediaPath = '', nonce = '';
let ingressServiceId: string | undefined, ingressNetworkId: string | undefined;
const volumes: string[] = [];
const helpers: string[] = [];
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
    assert(current, 'The queued Compose action is durable.');
    if (current.status === 'failed') throw new Error(`Compose action failed: ${store.vault.redact(current.error ?? 'unknown failure')}`);
    return current.status === 'succeeded' ? current : undefined;
  }, 'Compose action', 300_000);
}
async function website(path: string, options: RequestInit = {}, authenticated = false) {
  assert(path.startsWith('/') && !path.startsWith('//'));
  // Node's fetch filters the Host override. Use a bounded HTTP request to test
  // the real hostname route without changing local or public DNS.
  const response = await new Promise<Response>((resolvePromise, reject) => {
    const request = httpRequest({host: '127.0.0.1', port: ingressPort, path, method: options.method ?? 'GET', headers: {host: hostname,
      ...(authenticated ? {cookie: [...cookieJar].map(([key, value]) => `${key}=${value}`).join('; ')} : {}), ...options.headers}}, incoming => {
      const chunks: Buffer[] = []; let size = 0;
      incoming.on('data', (chunk: Buffer) => {size += chunk.length; if (size > 2 * 1024 * 1024) request.destroy(new Error('Fixture response exceeds its bound')); else chunks.push(chunk);});
      incoming.on('error', reject);
      incoming.on('end', () => {
        const responseHeaders = new Headers();
        for (let index = 0; index < incoming.rawHeaders.length; index += 2) responseHeaders.append(incoming.rawHeaders[index]!, incoming.rawHeaders[index + 1]!);
        resolvePromise(new Response(Buffer.concat(chunks), {status: incoming.statusCode, headers: responseHeaders}));
      });
    });
    request.on('error', reject); request.setTimeout(20_000, () => request.destroy(new Error('Fixture HTTP deadline exceeded')));
    const body = options.body;
    assert(body === undefined || typeof body === 'string' || Buffer.isBuffer(body) || body instanceof URLSearchParams);
    request.end(body instanceof URLSearchParams ? body.toString() : body);
  });
  for (const cookie of response.headers.getSetCookie()) {const pair = cookie.split(';', 1)[0]!, separator = pair.indexOf('='); cookieJar.set(pair.slice(0, separator), pair.slice(separator + 1));}
  return response;
}
async function verifyData() {
  await until(async () => {try {const response = await website(`/?rest_route=/wp/v2/posts/${postId}`); if (!response.ok) return undefined; const post = await response.json() as {content: {rendered: string}}; return post.content.rendered.includes(postProof) ? true : undefined;} catch {return undefined;}}, 'published post after lifecycle operation');
  const media = await website(mediaPath); assert.equal(media.status, 200); assert.equal(createHash('sha256').update(Buffer.from(await media.arrayBuffer())).digest('hex'), mediaHash);
  const profile = await website('/?rest_route=/wp/v2/users/me&context=edit', {headers: {'x-wp-nonce': nonce}}, true);
  assert.equal(profile.status, 200); assert.equal((await profile.json() as {slug: string}).slug, 'fixtureadmin');
}
try {
  await open(); phase = 'template-api-create';
  const catalog = await api('/templates'); assert.deepEqual(catalog.templates.find((item: {id: string}) => item.id === 'wordpress').images, template.images);
  const created = await api(`/projects/${project.id}/templates/wordpress`, 'POST', {name: 'wordpress-site', hostname});
  workloadId = created.workload.id; await action(created);
  const ingress = await docker.getService('panel-ingress').inspect(), ingressNetwork = await docker.getNetwork('panel-ingress').inspect();
  assert.equal(ingress.Spec.Labels?.['panel.owner'], 'self-hosted-panel'); assert.equal(ingressNetwork.Labels?.['panel.owner'], 'self-hosted-panel');
  ingressServiceId = ingress.ID; ingressNetworkId = ingressNetwork.Id;
  assert(ingressServiceId && ingressNetworkId); mark('real-template-api-to-agent-compose-deployment');
  const initial = await docker.listContainers({filters: {label: [`panel.workload=${workloadId}`]}}); assert.equal(initial.length, 2);
  const firstApp = initial.find(item => item.Labels['com.docker.compose.service'] === 'app')!, database = initial.find(item => item.Labels['com.docker.compose.service'] === 'database')!;
  assert(firstApp && database); assert(Object.values((await docker.getContainer(database.Id).inspect()).NetworkSettings.Ports).every(value => value === null || value.length === 0), 'MariaDB publishes no host ports.');
  for (const volume of (await docker.listVolumes({filters: {label: [`panel.workload=${workloadId}`]}})).Volumes ?? []) {assert.equal(volume.Labels?.['panel.owner'], 'self-hosted-panel'); volumes.push(volume.Name);}
  assert.equal(volumes.length, 2); mark('private-mariadb-and-two-owned-persistent-volumes');
  phase = 'wordpress-http-install';
  await until(async () => {try {const response = await website('/wp-admin/install.php'); return response.status === 200 && (await response.text()).includes('weblog_title') ? true : undefined;} catch {return undefined;}}, 'WordPress installer');
  const installed = await website('/wp-admin/install.php?step=2', {method: 'POST', headers: {'content-type': 'application/x-www-form-urlencoded'}, body: new URLSearchParams({weblog_title: title, user_name: 'fixtureadmin', admin_password: adminPassword, admin_password2: adminPassword, admin_email: 'fixture@example.test', blog_public: '0', Submit: 'Install WordPress'})});
  assert.equal(installed.status, 200); assert((await installed.text()).includes('WordPress has been installed')); mark('native-wordpress-installation-through-http');
  await website('/wp-login.php');
  const login = await website('/wp-login.php', {method: 'POST', headers: {'content-type': 'application/x-www-form-urlencoded'}, body: new URLSearchParams({log: 'fixtureadmin', pwd: adminPassword, 'wp-submit': 'Log In', testcookie: '1', redirect_to: `http://${hostname}/wp-admin/`})}, true);
  assert.equal(login.status, 302); assert([...cookieJar.keys()].some(key => key.startsWith('wordpress_logged_in_')));
  const nonceResponse = await website('/wp-admin/admin-ajax.php?action=rest-nonce', {}, true); nonce = (await nonceResponse.text()).trim(); assert.match(nonce, /^[a-z0-9]{10}$/i);
  const denied = await website('/?rest_route=/wp/v2/posts', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({title: 'Denied', status: 'publish'})}); assert.equal(denied.status, 401);
  mark('native-cookie-login-rest-nonce-and-unauthenticated-write-denial');
  phase = 'wordpress-content';
  const post = await website('/?rest_route=/wp/v2/posts', {method: 'POST', headers: {'content-type': 'application/json', 'x-wp-nonce': nonce}, body: JSON.stringify({title, content: `<p>${postProof}</p>`, status: 'publish'})}, true);
  assert.equal(post.status, 201); postId = (await post.json() as {id: number}).id;
  const upload = await website('/?rest_route=/wp/v2/media', {method: 'POST', headers: {'content-type': 'image/png', 'content-disposition': `attachment; filename="${runId}.png"`, 'x-wp-nonce': nonce}, body: mediaBytes}, true);
  assert.equal(upload.status, 201); const uploaded = await upload.json() as {id: number; source_url: string}; mediaId = uploaded.id;
  const mediaUrl = new URL(uploaded.source_url); assert.equal(mediaUrl.hostname, hostname); mediaPath = mediaUrl.pathname;
  await verifyData(); mark('authenticated-post-media-upload-and-byte-exact-public-download');
  phase = 'redeploy-update-restart';
  await action(await api(`/compose/${workloadId}/deploy`, 'POST', {})); await verifyData(); mark('repeat-deploy-retains-post-media-and-authentication');
  const configuration = await api(`/compose/${workloadId}/configuration`) as ComposeConfiguration; assert(configuration.source.type === 'inline');
  const document = parse(configuration.source.yaml); document.services.app.environment.SERVUS_FIXTURE_REVISION = runId;
  const updated = await api(`/compose/${workloadId}`, 'PATCH', {...configuration, expectedRevision: 1, source: {type: 'inline', yaml: stringify(document)}}); assert.equal(updated.revision, 2);
  await action(await api(`/compose/${workloadId}/deploy`, 'POST', {}));
  const replacement = (await docker.listContainers({filters: {label: [`panel.workload=${workloadId}`]}})).find(item => item.Labels['com.docker.compose.service'] === 'app')!; assert.notEqual(replacement.Id, firstApp.Id);
  await verifyData(); mark('configuration-update-replaces-container-with-persistent-wordpress-data');
  await action(await api(`/compose/${workloadId}/restart`, 'POST', {})); await verifyData(); mark('application-and-mariadb-restart-preserve-post-media-and-login');
  phase = 'isolated-vm-restart'; await close(); store.close(); store = new Store(dataDir);
  await promisify(execFile)('colima', ['stop', '--profile', profile], {timeout: 180_000, maxBuffer: 1024 * 1024});
  await promisify(execFile)('colima', ['start', '--profile', profile, '--activate=false'], {timeout: 180_000, maxBuffer: 1024 * 1024});
  await open(); await verifyData(); assert.equal((await api(`/compose/${workloadId}`)).deployedRevision, 2); mark('isolated-docker-vm-and-control-plane-restart-preserve-data-and-panel-session');
  phase = 'destroy-retain'; await action(await api(`/compose/${workloadId}/destroy`, 'POST', {confirm: true}));
  assert.equal((await docker.listContainers({all: true, filters: {label: [`panel.workload=${workloadId}`]}})).length, 0);
  for (const name of volumes) {const volume = await docker.getVolume(name).inspect(); assert.equal(volume.Labels?.['panel.workload'], workloadId);}
  const siteVolume = volumes.find(name => name.endsWith('_site'))!, databaseVolume = volumes.find(name => name.endsWith('_database'))!;
  assert(siteVolume && databaseVolume);
  const retainedMedia = cli(['run', '--rm', '--network', 'none', '--read-only', '--label', `servus.wordpress.test=${runId}`, '--volume', `${siteVolume}:/retained:ro`, '--entrypoint', 'php', template.images[0]!, '-r', `echo hash_file('sha256', '/retained${mediaPath.replace(/^\/wp-content/, '/wp-content')}');`]);
  assert.equal(retainedMedia, mediaHash);
  cli(['run', '--rm', '--network', 'none', '--read-only', '--label', `servus.wordpress.test=${runId}`, '--volume', `${databaseVolume}:/retained:ro`, '--entrypoint', 'sh', template.images[1]!, '-c', 'test -s /retained/ibdata1']);
  const databaseEnv = document.services.database.environment as Record<string, string>, envFile = join(root, 'retained-database.env'), retainedName = `${runId}-retained-db`;
  writeFileSync(envFile, Object.entries(databaseEnv).map(([key, value]) => `${key}=${value}`).join('\n') + '\n', {mode: 0o600});
  helpers.push(retainedName);
  cli(['run', '-d', '--name', retainedName, '--network', 'none', '--memory', '512m', '--label', `servus.wordpress.test=${runId}`, '--env-file', envFile, '--volume', `${databaseVolume}:/var/lib/mysql`, template.images[1]!]);
  await until(async () => {
    try {const content = cli(['exec', retainedName, 'sh', '-c', `MYSQL_PWD="$MARIADB_PASSWORD" exec mariadb -uwordpress wordpress -Nse 'SELECT post_content FROM wp_posts WHERE ID=${postId}'`]); return content.includes(postProof) ? true : undefined;} catch {return undefined;}
  }, 'retained database reopened in a fresh isolated container');
  mark('destroy-removes-runtime-retains-media-bytes-and-reopens-database-in-fresh-container');
  succeeded = true;
} finally {
  let cleanupStatus: 'passed' | 'failed' = 'passed';
  try {
    await close();
    for (const name of helpers) {try {const container = docker.getContainer(name), inspection = await container.inspect(); assert.equal(inspection.Config.Labels?.['servus.wordpress.test'], runId); await container.remove({force: true});} catch (error) {if ((error as {statusCode?: number}).statusCode !== 404) throw error;}}
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
    mkdirSync(artifacts, {recursive: true});
    writeFileSync(artifact, JSON.stringify({runId, context, checkedAt: new Date().toISOString(), status: succeeded && cleanupStatus === 'passed' ? 'passed' : 'failed', runtimeStatus: succeeded ? 'passed' : 'failed', cleanupStatus, phase, templateVersion: template.version, images, checks, postId, mediaId, mediaSha256: mediaHash,
      limits: 'Exclusive local Docker VM; HTTP cookie authentication and native REST nonce. All workload actions including destroy are observed through the real HTTP API. No production DNS, public ACME, WordPress version migration or external mail delivery tested.'}, null, 2) + '\n');
    console.log(`${succeeded && cleanupStatus === 'passed' ? 'PASS' : 'FAIL'} WordPress template evidence: ${artifact}`);
  }
}
