import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { buildSource, buildLogPath } from '../../apps/panel/src/agent/build.js';
import { SecretVault } from '../../apps/panel/src/shared/secrets.js';
import type { Service } from '../../apps/panel/src/shared/types.js';

const context = 'colima-panel-dev';
const socketUrl = execFileSync('docker', ['context', 'inspect', context, '--format', '{{.Endpoints.docker.Host}}'], { encoding: 'utf8' }).trim();
assert.match(socketUrl, /^unix:\/\//);
const runId = process.env.SERVUS_SOURCE_RUN_ID ?? `source-${Date.now()}-${randomUUID().slice(0, 8)}`;
assert.match(runId, /^[A-Za-z0-9_-]{1,100}$/);
const root = mkdtempSync(join(tmpdir(), 'servus-source-options-'));
const source = join(root, 'source'), httpRoot = join(root, 'http'), bare = join(httpRoot, 'control.git'), dataDir = join(root, 'data'), dockerConfig = join(root, 'docker-config');
for (const directory of [source, httpRoot, dataDir, dockerConfig]) mkdirSync(directory, { mode: 0o700 });
if (existsSync('/opt/homebrew/lib/docker/cli-plugins/docker-buildx')) writeFileSync(join(dockerConfig, 'config.json'), JSON.stringify({ cliPluginsExtraDirs: ['/opt/homebrew/lib/docker/cli-plugins'] }), { mode: 0o600 });
const previousEnv = { DOCKER_CONFIG: process.env.DOCKER_CONFIG, DOCKER_CONTEXT: process.env.DOCKER_CONTEXT, PANEL_GIT_HTTP_HOSTS: process.env.PANEL_GIT_HTTP_HOSTS };
process.env.DOCKER_CONFIG = dockerConfig; delete process.env.DOCKER_CONTEXT; process.env.PANEL_GIT_HTTP_HOSTS = '127.0.0.1';
const git = (args: string[], cwd = source) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const docker = (args: string[]) => execFileSync('docker', ['--host', socketUrl, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const serviceId = randomUUID(), images: string[] = [], containers: string[] = [];
const server = createServer((req, res) => {
  const path = resolve(httpRoot, '.' + new URL(req.url ?? '/', 'http://fixture').pathname);
  if (!path.startsWith(httpRoot + sep)) { res.writeHead(404).end(); return; }
  try { const data = readFileSync(path); res.writeHead(200, { 'content-length': data.length }); res.end(data); }
  catch { res.writeHead(404).end(); }
});
try {
  git(['init', '-b', 'main']);
  writeFileSync(join(source, 'Dockerfile'), 'FROM scratch\nCOPY config/.env.production /proof.env\n');
  git(['add', '.']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'build options fixture']);
  const commit = git(['rev-parse', 'HEAD']); git(['clone', '--bare', source, bare], root); git(['--git-dir', bare, 'update-server-info'], root);
  await new Promise<void>(resolvePromise => server.listen(0, '127.0.0.1', resolvePromise));
  const port = (server.address() as { port: number }).port;
  const service: Service = { id: serviceId, projectId: randomUUID(), name: 'source-options', image: 'unused', hostname: 'fixture.localhost', port: 80, replicas: 1,
    revision: 1, deployedRevision: null, state: 'pending', createdAt: 'now', updatedAt: 'now', lastError: null,
    source: { type: 'git', repository: `http://127.0.0.1:${port}/control.git`, branch: 'main', context: '.', dockerfile: 'Dockerfile', envFile: 'config/.env.production' },
    environment: [{ name: 'FIXTURE_VALUE', value: 'build-options-proof' }] };
  const vault = new SecretVault(dataDir);
  for (const forceRebuild of [false, true]) {
    const operationId = randomUUID(), image = `panel-build:${operationId}`; images.push(image);
    const result = await buildSource(service, operationId, dataDir, socketUrl.slice('unix://'.length), vault, { forceRebuild });
    assert.equal(result.sourceCommit, commit);
    const inspect = JSON.parse(docker(['image', 'inspect', image]))[0];
    assert.equal(inspect.Config.Labels['panel.service'], serviceId); assert.equal(inspect.Config.Labels['panel.source.commit'], commit);
    const container = docker(['create', '--label', `servus.test.run=${runId}`, '--entrypoint', '/not-executed', image]); containers.push(container);
    const output = join(root, `proof-${forceRebuild}.env`); docker(['cp', `${container}:/proof.env`, output]);
    assert.equal(readFileSync(output, 'utf8'), 'FIXTURE_VALUE="build-options-proof"\n');
    assert.match(readFileSync(buildLogPath(dataDir, serviceId, operationId), 'utf8'), /Build completed/);
  }
  const artifact = resolve('artifacts/source-features', `${runId}.json`); mkdirSync(dirname(artifact), { recursive: true });
  writeFileSync(artifact, JSON.stringify({ runId, checkedAt: new Date().toISOString(), context, status: 'passed', checks: ['git-clone', 'generated-env-in-real-image', 'normal-build', 'force-rebuild', 'image-source-labels'], limits: 'BuildKit image validation only. No workload deployment or production changes.' }, null, 2) + '\n');
  console.log(`PASS real BuildKit normal/forced build and generated env file on ${context}; evidence ${artifact}`);
} finally {
  if (server.listening) await new Promise<void>((resolvePromise, reject) => server.close(error => error ? reject(error) : resolvePromise()));
  for (const container of containers) {
    const inspect = JSON.parse(docker(['container', 'inspect', container]))[0]; assert.equal(inspect.Config.Labels['servus.test.run'], runId);
    docker(['rm', container]);
  }
  for (const image of images) {
    let inspect;
    try { inspect = JSON.parse(docker(['image', 'inspect', image]))[0]; } catch { continue; }
    assert.equal(inspect.Config.Labels['panel.service'], serviceId); docker(['image', 'rm', image]);
  }
  rmSync(root, { recursive: true, force: true });
  for (const [key, value] of Object.entries(previousEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
}
