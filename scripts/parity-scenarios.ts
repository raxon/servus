import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ServiceInput, ServicePatch } from '../src/shared/types.js';
import { assert, containerId, dataRoot, docker, eventually, healthy, PanelApi, ReferenceApi, Report, route, runId } from './parity-lib.js';

export interface Target {
  name: string; context: string; ingress: number; project: string; report: Report;
  createProject(): Promise<void>;
  create(name: string, config: ServiceInput): Promise<void>;
  patch(name: string, patch: Omit<ServicePatch, 'expectedRevision'>): Promise<void>;
  action(name: string, type: 'deploy' | 'stop' | 'start' | 'restart'): Promise<void>;
  serviceName(name: string): string;
  inspect(name: string): Promise<any>;
  api?: PanelApi;
}
const credentialFile = resolve(dataRoot, `${runId}.json`);
export const credentials: { postgres: string; redis: string; mariadb: string; wordpress: string } = existsSync(credentialFile)
  ? JSON.parse(readFileSync(credentialFile, 'utf8'))
  : Object.fromEntries(['postgres', 'redis', 'mariadb', 'wordpress'].map(key => [key, randomBytes(24).toString('hex')])) as any;
if (!existsSync(credentialFile)) writeFileSync(credentialFile, JSON.stringify(credentials), { mode: 0o600 });
const engineImages = { postgres: 'postgres:17-alpine', redis: 'redis:7-alpine', mariadb: 'mariadb:11.4' };

export async function panelTarget(): Promise<Target> {
  const api = new PanelApi(); await api.login();
  let projectId = '';
  const ids = new Map<string, string>();
  const project = `parity-${runId}`;
  const identityPath = resolve(dataRoot, `${runId}-panel-identity.json`);
  if (process.env.PARITY_RESUME === '1' && existsSync(identityPath)) {
    const previous = JSON.parse(readFileSync(identityPath, 'utf8')); projectId = previous.projectId;
    for (const [name, id] of Object.entries(previous.services)) ids.set(name, String(id));
  }
  const target: Target = {
    name: 'panel', context: 'colima-panel-dev', ingress: 18080, project, api,
    report: new Report('panel', { version: '0.1.0', context: 'colima-panel-dev' }),
    async createProject() {
      const existing = process.env.PARITY_RESUME === '1' ? (await api.call('/projects')).find((item: any) => item.name === project) : undefined;
      projectId = existing?.id || (await api.call('/projects', { name: project, description: 'Disposable parity verification fixtures' })).id;
    },
    async create(name, config) {
      const existing = process.env.PARITY_RESUME === '1' ? (await api.call(`/projects/${projectId}/services`)).find((item: any) => item.name === name) : undefined;
      if (existing) {
        ids.set(name, existing.id);
        if (process.env.PARITY_REPLAY === '1' && (config.kind || 'app') === 'app') {
          const { name: unused, ...configuration } = config;
          await api.call(`/services/${existing.id}`, { ...configuration, expectedRevision: existing.revision }, 'PATCH');
          await api.wait(await api.call(`/services/${existing.id}/deploy`, {}, 'POST', randomBytes(16).toString('hex')));
        } else if (!existing.deployedRevision) await api.wait(await api.call(`/services/${existing.id}/deploy`, {}, 'POST', randomBytes(16).toString('hex')));
        return;
      }
      const created = await api.call(`/projects/${projectId}/services`, { ...config, name }, 'POST', `${runId}-${name}`); ids.set(name, created.service.id); await api.wait(created.action);
    },
    async patch(name, patch) { const service = await target.inspect(name); await api.call(`/services/${ids.get(name)}`, { ...patch, expectedRevision: service.revision }, 'PATCH'); },
    async action(name, type) { await api.wait(await api.call(`/services/${ids.get(name)}/${type}`, {}, 'POST', `${runId}-${name}-${type}-${randomBytes(4).toString('hex')}`)); },
    serviceName(name) { assert(ids.has(name)); return `panel-app-${ids.get(name)}`; },
    inspect(name) { return api.call(`/services/${ids.get(name)}`); },
  };
  const originalCreate = target.create.bind(target);
  target.create = async (name, config) => { await originalCreate(name, config); writeFileSync(resolve(dataRoot, `${runId}-panel-identity.json`), JSON.stringify({ project, projectId, services: Object.fromEntries(ids) })); };
  return target;
}

export async function referenceTarget(): Promise<Target> {
  const api = new ReferenceApi(); await api.login();
  const project = `parity-${runId}`;
  const source: Record<string, any> = {};
  const target: Target = {
    name: 'reference', context: 'colima-panel-local', ingress: 80, project,
    report: new Report('reference', { version: '2.38.0', modifiedReference: true, image: docker('colima-panel-local', ['service', 'inspect', 'easypanel', '--format', '{{.Spec.TaskTemplate.ContainerSpec.Image}}']), referenceImageId: docker('colima-panel-local', ['image', 'inspect', docker('colima-panel-local', ['service', 'inspect', 'easypanel', '--format', '{{.Spec.TaskTemplate.ContainerSpec.Image}}']), '--format', '{{.Id}}']) }),
    async createProject() {
      if (process.env.PARITY_RESUME === '1' && (await api.call('listProjects')).some((item: any) => item.name === project)) return;
      await api.call('createProject', { name: project });
    },
    async create(name, config) {
      const base = { projectName: project, serviceName: name };
      if (process.env.PARITY_RESUME === '1') {
        const existing = await api.call('inspectProject', { projectName: project }, true);
        if (existing.services.some((service: any) => service.name === name)) {
          if (process.env.PARITY_REPLAY === '1' && (config.kind || 'app') === 'app') {
            await target.patch(name, { source: config.source || { type: 'image' }, ...(config.source?.type === 'git' ? {} : { image: config.image }), environment: config.environment });
            await target.action(name, 'deploy');
          }
          return;
        }
      }
      if (config.kind && config.kind !== 'app') {
        const type = { postgres: 'Postgres', redis: 'Redis', mariadb: 'MariaDB' }[config.kind];
        await api.call(`create${type}Service`, { ...base, image: config.image, password: config.database?.password, rootPassword: config.database?.password, user: config.database?.user, databaseName: config.database?.database, resources: { cpuLimit: 1, cpuReservation: 0, memoryLimit: 512, memoryReservation: 0 } });
      } else {
        source[name] = config.source?.type === 'git' ? { type: 'git', repo: 'http://192.168.5.2:32180/control.git', ref: config.source.branch, path: '/' } : { type: 'image', image: config.image };
        await api.call('createAppService', { ...base, source: source[name], build: { type: 'dockerfile', file: config.source?.type === 'git' ? config.source.dockerfile : 'Dockerfile' },
          env: config.environment?.map(item => `${item.name}=${item.value}`).join('\n') || '',
          domains: (config.domains || [{ hostname: config.hostname, port: config.port }]).map(domain => ({ host: domain.hostname, port: domain.port, https: false })),
          mounts: config.mounts?.map(mount => mount.type === 'volume' ? { type: 'volume', name: mount.name, mountPath: mount.target } : mount.type === 'file' ? { type: 'file', content: mount.content, mountPath: mount.target } : { type: 'bind', hostPath: mount.source, mountPath: mount.target }),
          deploy: { replicas: config.replicas || 1, zeroDowntime: !(config.mounts || []).length },
          resources: { cpuLimit: config.resources?.cpu || 1, cpuReservation: 0, memoryLimit: config.resources?.memoryMb || 384, memoryReservation: 0 },
        });
      }
      await eventually(`reference running ${name}`, () => docker(target.context, ['service', 'ps', target.serviceName(name), '--filter', 'desired-state=running', '--format', '{{.CurrentState}}']), text => text.startsWith('Running'), 360000);
    },
    async patch(name, patch) {
      const base = { projectName: project, serviceName: name };
      if (patch.environment) await api.call('updateAppEnv', { ...base, env: patch.environment.map(item => `${item.name}=${item.value}`).join('\n') });
      if (patch.source?.type === 'git') { source[name] = { type: 'git', repo: 'http://192.168.5.2:32180/control.git', ref: patch.source.branch, path: '/' }; await api.call('updateAppSourceGit', { ...base, repo: source[name].repo, ref: source[name].ref, path: '/' }); }
      if (patch.source?.type === 'image' || patch.image) await api.call('updateAppSourceImage', { ...base, image: patch.image });
      if (patch.resources) await api.call('updateAppResources', { ...base, resources: { cpuLimit: patch.resources.cpu, cpuReservation: 0, memoryLimit: patch.resources.memoryMb, memoryReservation: 0 } });
    },
    async action(name, type) {
      const before = docker(target.context, ['service', 'inspect', target.serviceName(name), '--format', '{{.Version.Index}}']);
      await api.call(`${type}AppService`, { projectName: project, serviceName: name });
      await eventually(`reference ${type} applied`, () => docker(target.context, ['service', 'inspect', target.serviceName(name), '--format', '{{.Version.Index}}']), index => index !== before, 360000);
      if (type !== 'stop') await eventually(`reference ${type} running`, () => docker(target.context, ['service', 'ps', target.serviceName(name), '--filter', 'desired-state=running', '--format', '{{.CurrentState}}']), text => text.startsWith('Running'), 360000);
    },
    serviceName(name) { return `${project}_${name}`; },
    inspect(name) { return api.call('inspectAppService', { projectName: project, serviceName: name }, true); },
  };
  return target;
}

export async function commonScenarios(target: Target) {
  const { report, ingress, context } = target;
  const hostname = `${target.name}-${runId}.localhost`;
  const alias = `alias-${hostname}`;
  await report.check('project-create', () => target.createProject());
  for (const kind of ['postgres', 'redis', 'mariadb'] as const) await report.check(`${kind}-create`, async () => {
    await target.create(kind, { name: kind, kind, image: engineImages[kind], hostname: `${kind}-${hostname}`, port: kind === 'postgres' ? 5432 : kind === 'redis' ? 6379 : 3306, replicas: 1, database: { database: 'app', user: 'app', password: credentials[kind] }, resources: { cpu: 1, memoryMb: 512 } });
    const spec = JSON.parse(docker(context, ['service', 'inspect', target.serviceName(kind)]))[0].Spec;
    assert(!(spec.EndpointSpec?.Ports || []).length, 'Database must not publish host ports');
    return { noPublishedPorts: true };
  });
  const env = [
    { name: 'PGHOST', value: target.name === 'panel' ? 'postgres' : target.serviceName('postgres') },
    { name: 'PGDATABASE', value: 'app' }, { name: 'PGUSER', value: 'app' }, { name: 'PGPASSWORD', value: credentials.postgres, secret: true },
    { name: 'REDIS_HOST', value: target.name === 'panel' ? 'redis' : target.serviceName('redis') }, { name: 'REDIS_PASSWORD', value: credentials.redis, secret: true }, { name: 'FIXTURE_MESSAGE', value: 'before-save' },
  ];
  await report.check('git-build-and-http', async () => {
    await target.create('control', { name: 'control', kind: 'app', image: 'panel-control:v1', source: { type: 'git', repository: 'http://127.0.0.1:32180/control.git', branch: 'v1', context: '.', dockerfile: 'Dockerfile' }, hostname, port: 8080, domains: [{ hostname, port: 8080, primary: true }, { hostname: alias, port: 8080 }], environment: env, mounts: [{ type: 'volume', name: 'data', target: '/data' }, { type: 'file', name: 'config', target: '/app/config.txt', content: 'managed-file-value', readOnly: true }], resources: { cpu: 0.5, memoryMb: 384 } });
    await healthy(ingress, hostname);
    assert.equal((await route(ingress, hostname, '/version')).json.version, 'v1');
    if (process.env.PARITY_REPLAY === '1') assert.equal((await route(ingress, hostname, '/version')).json.commit, JSON.parse(readFileSync(resolve(dataRoot, 'git/commits.json'), 'utf8')).v1);
    assert.equal((await route(ingress, alias, '/version')).json.version, 'v1');
  });
  await report.check('postgres-redis-and-volume-write', async () => {
    assert.equal((await route(ingress, hostname, '/record', { id: runId, value: 'persisted' })).status, 200);
    const before = (await route(ingress, hostname, '/counter')).json.counter;
    const expectedCounter = before + 1;
    assert.equal((await route(ingress, hostname, '/counter', {})).json.counter, expectedCounter);
    writeFileSync(resolve(dataRoot, `${runId}-${target.name}-counter.json`), JSON.stringify({ value: expectedCounter }));
    assert.equal((await route(ingress, hostname, '/file', { value: 'persistent-marker' })).json.value, 'persistent-marker');
  });
  await report.check('configured-resources-and-file-mount', async () => {
    const spec = JSON.parse(docker(context, ['service', 'inspect', target.serviceName('control')]))[0].Spec;
    assert.equal(spec.TaskTemplate.Resources.Limits.MemoryBytes, 384 * 1024 * 1024);
    assert.equal(spec.TaskTemplate.Resources.Limits.NanoCPUs, 500000000);
    assert.equal(docker(context, ['exec', containerId(context, target.serviceName('control')), 'cat', '/app/config.txt']), 'managed-file-value');
  });
  await report.check('runtime-log-marker', async () => {
    await route(ingress, hostname, '/log', { marker: `marker-${runId}` });
    assert(docker(context, ['service', 'logs', '--raw', '--tail', '30', target.serviceName('control')]).includes(`marker-${runId}`));
    if (target.api) {
      const service = await target.inspect('control');
      const logs = await target.api.call(`/services/${service.id}/logs`);
      assert(logs.lines.join('\n').includes(`marker-${runId}`));
      const metrics = await target.api.call(`/services/${service.id}/metrics`);
      assert(metrics.memoryBytes > 0); assert(metrics.containers === 1);
    }
  });
  await report.check('stop-start-restart-and-persistence', async () => {
    const oldContainer = containerId(context, target.serviceName('control'));
    await target.action('control', 'stop');
    await eventually('zero replicas', () => docker(context, ['service', 'inspect', target.serviceName('control'), '--format', '{{.Spec.Mode.Replicated.Replicas}}']), replicas => replicas === '0');
    await target.action('control', 'start'); await healthy(ingress, hostname);
    await target.action('control', 'restart'); await healthy(ingress, hostname);
    assert.notEqual(containerId(context, target.serviceName('control')), oldContainer);
    assert.equal((await route(ingress, hostname, '/file')).json.value, 'persistent-marker');
    assert.equal((await route(ingress, hostname, '/record')).json.records[0].value, 'persisted');
    const expectedCounter = JSON.parse(readFileSync(resolve(dataRoot, `${runId}-${target.name}-counter.json`), 'utf8')).value;
    assert.equal((await route(ingress, hostname, '/counter')).json.counter, expectedCounter);
  });
  await report.check('saved-env-and-deployed-env', async () => {
    await target.patch('control', { environment: env.map(item => item.name === 'FIXTURE_MESSAGE' ? { ...item, value: 'after-deploy' } : item) });
    const before = (await route(ingress, hostname, '/version')).json.message;
    if (target.name === 'panel') assert.equal(before, 'before-save');
    await target.action('control', 'deploy'); await healthy(ingress, hostname);
    await eventually('changed environment', () => route(ingress, hostname, '/version'), response => response.json?.message === 'after-deploy');
    return { valueImmediatelyAfterSave: before, valueAfterDeploy: 'after-deploy' };
  });
  await report.check('git-v2-and-data-preserved', async () => {
    await target.patch('control', { source: { type: 'git', repository: 'http://127.0.0.1:32180/control.git', branch: 'v2', context: '.', dockerfile: 'Dockerfile' } });
    await target.action('control', 'deploy');
    await eventually('v2 response', () => route(ingress, hostname, '/version'), response => response.json?.version === 'v2', 360000);
    if (process.env.PARITY_REPLAY === '1') assert.equal((await route(ingress, hostname, '/version')).json.commit, JSON.parse(readFileSync(resolve(dataRoot, 'git/commits.json'), 'utf8')).v2);
    assert.equal((await route(ingress, hostname, '/file')).json.value, 'persistent-marker');
    assert.equal((await route(ingress, hostname, '/record')).json.records[0].value, 'persisted');
    if (target.name === 'panel') { const saved = await target.inspect('control'); assert(saved.sourceCommit); assert(saved.imageDigest); }
  });
  await wordpress(target, hostname);
  writeFileSync(resolve(dataRoot, `${runId}-${target.name}-routes.json`), JSON.stringify({ hostname, alias, wordpress: `wp-${hostname}`, project: target.project }));
}

export async function wordpress(target: Target, controlHostname: string) {
  const hostname = `wp-${controlHostname}`;
  const host = `${hostname}:${target.ingress}`;
  const siteUrl = `http://${host}`;
  const environment = [
    { name: 'WORDPRESS_DB_HOST', value: target.name === 'panel' ? 'mariadb:3306' : `${target.serviceName('mariadb')}:3306` },
    { name: 'WORDPRESS_DB_USER', value: 'app' }, { name: 'WORDPRESS_DB_NAME', value: 'app' }, { name: 'WORDPRESS_DB_PASSWORD', value: credentials.mariadb, secret: true },
    { name: 'WORDPRESS_CONFIG_EXTRA', value: "define('WP_ENVIRONMENT_TYPE', 'local');" },
  ];
  await target.report.check('wordpress-deploy', async () => {
    await target.create('wordpress', { name: 'wordpress', image: 'wordpress:php8.3-apache', kind: 'app', hostname, port: 80, environment, mounts: [{ type: 'volume', name: 'wordpress', target: '/var/www/html' }], resources: { cpu: 1, memoryMb: 512 } });
    await eventually('WordPress install endpoint', () => route(target.ingress, host, '/wp-admin/install.php'), value => value.status === 200 && value.text.includes('WordPress'), 240000);
  });
  let appPassword = '';
  await target.report.check('wordpress-initialize-and-http-content', async () => {
    const code = `<?php define('WP_INSTALLING',true); require '/var/www/html/wp-load.php'; require '/var/www/html/wp-admin/includes/upgrade.php'; if (!is_blog_installed()) wp_install('Panel Parity', 'parityadmin', 'admin@localhost.test', true, '', ${JSON.stringify(credentials.wordpress)}); update_option('siteurl', ${JSON.stringify(siteUrl)}); update_option('home', ${JSON.stringify(siteUrl)}); $u=get_user_by('login','parityadmin'); $a=WP_Application_Passwords::create_new_application_password($u->ID,['name'=>'Parity HTTP']); echo json_encode(['password'=>$a[0]]);`;
    const output = docker(target.context, ['exec', '-i', containerId(target.context, target.serviceName('wordpress')), 'php', '/dev/stdin'], code);
    appPassword = JSON.parse(output.slice(output.lastIndexOf('{'))).password;
    writeFileSync(resolve(dataRoot, `${runId}-${target.name}-wp-auth.json`), JSON.stringify({ password: appPassword }), { mode: 0o600 });
    const auth = { authorization: `Basic ${Buffer.from(`parityadmin:${appPassword}`).toString('base64')}` };
    const post = await route(target.ingress, host, '/?rest_route=/wp/v2/posts', { title: `Parity ${runId}`, content: 'Persistent post from parity verification.', status: 'publish' }, auth);
    assert.equal(post.status, 201, post.text.slice(0, 300));
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4WQAAAAASUVORK5CYII=', 'base64');
    const media = await route(target.ingress, host, '/?rest_route=/wp/v2/media', png, { ...auth, 'content-type': 'image/png', 'content-disposition': `attachment; filename="parity-${runId}.png"` });
    assert.equal(media.status, 201, media.text.slice(0, 300));
    assert.equal((await route(target.ingress, host, `/?p=${post.json.id}`)).status, 200);
    writeFileSync(resolve(dataRoot, `${runId}-${target.name}-wordpress.json`), JSON.stringify({ post: post.json.id, media: new URL(media.json.source_url).pathname }));
  });
  await target.report.check('wordpress-container-replacement-retains-content', async () => {
    const old = containerId(target.context, target.serviceName('wordpress'));
    await target.action('wordpress', 'restart');
    docker(target.context, ['service', 'update', '--force', '--detach', target.serviceName('mariadb')]);
    await eventually('MariaDB restarted', () => route(target.ingress, host, '/'), response => response.status === 200 && response.text.includes(`Parity ${runId}`), 240000);
    assert.notEqual(containerId(target.context, target.serviceName('wordpress')), old);
    const content = JSON.parse(readFileSync(resolve(dataRoot, `${runId}-${target.name}-wordpress.json`), 'utf8'));
    assert.equal((await route(target.ingress, host, content.media)).status, 200);
    const auth = { authorization: `Basic ${Buffer.from(`parityadmin:${appPassword}`).toString('base64')}` };
    assert.equal((await route(target.ingress, host, '/?rest_route=/wp/v2/users/me', undefined, auth)).json.slug, 'parityadmin');
  });
}
