import { strict as assert } from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';

const context = 'colima-panel-dev';
const root = resolve(import.meta.dirname, '../..');
const compose = join(root, 'deployment/compose.yaml');
const wrapper = join(root, 'deployment/lifecycle-gate.sh');
const docker = (...args) => execFileSync('docker', ['--context', context, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const attempt = (...args) => spawnSync('docker', ['--context', context, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });

test('actual compose wiring retains lifecycle lock across all three processes', async () => {
  const id = randomUUID(), volume = `servus-compose-gate-${id}`, project = `servusgate${id.replaceAll('-', '')}`;
  const dir = mkdtempSync(join(tmpdir(), 'servus-compose-gate-'));
  const override = join(dir, 'override.yaml'), envFile = join(dir, 'fixture.env');
  const env = { SERVUS_IMAGE: 'node:24-bookworm-slim', SERVUS_DATA_DIR: '/tmp/unused-servus-data', SERVUS_LIFECYCLE_DIR: '/tmp/unused-servus-gate', SERVUS_SUPERVISOR_CONTROL_DIR: '/tmp/unused-supervisor-control', SERVUS_SUPERVISOR_SECRET_DIR: '/tmp/unused-supervisor-secrets', SERVUS_UPDATER_SOCKET_DIR: '/run/servus-updater/control', SERVUS_ALLOWED_ORIGINS: 'http://localhost:4180', SERVUS_DOCKER_GID: '0' };
  writeFileSync(envFile, Object.entries(env).map(([k,v]) => `${k}=${v}`).join('\n') + '\n');
  const plain = JSON.parse(docker('compose', '--env-file', envFile, '-f', compose, '-p', project, 'config', '--format', 'json'));
  for (const name of ['api', 'worker', 'agent']) {
    const service = plain.services[name];
    assert.deepEqual(service.entrypoint, ['/bin/sh', '/app/lifecycle-gate.sh']);
    const gate = service.volumes.find(item => item.target === '/run/servus-lifecycle');
    assert.equal(gate?.type, 'bind'); assert.equal(gate?.read_only, true); assert.equal(gate?.bind?.create_host_path, false);
    const control = service.volumes.find(item => item.target === '/run/servus-supervisor');
    assert.equal(control?.source, env.SERVUS_SUPERVISOR_CONTROL_DIR); assert.equal(control?.read_only, true); assert.equal(control?.bind?.create_host_path, false);
    const secret = service.volumes.find(item => item.target === '/run/servus-control/token');
    assert.equal(secret?.source, `${env.SERVUS_SUPERVISOR_SECRET_DIR}/${name}`); assert.equal(secret?.read_only, true); assert.equal(secret?.bind?.create_host_path, false);
    assert.equal(service.environment.PANEL_SUPERVISOR_SOCKET, '/run/servus-supervisor/socket');
    assert.equal(service.environment.PANEL_SUPERVISOR_SECRET_FILE, '/run/servus-control/token');
    const updater = service.volumes.find(item => item.target === '/run/servus-updater');
    if (name === 'api') {
      assert.equal(updater?.source, env.SERVUS_UPDATER_SOCKET_DIR); assert.equal(updater?.read_only, true); assert.equal(updater?.bind?.create_host_path, false);
      assert.equal(service.environment.PANEL_UPDATER_SOCKET, '/run/servus-updater/updater.sock');
      assert.equal(service.environment.PANEL_UPDATER_APPLY_ENABLED, 'true');
    } else assert.equal(updater, undefined);
  }
  const extra = `\n    user: '1000:1000'\n    command: ['-e', 'console.log("READY");setInterval(()=>{},1000)']\n    healthcheck: {disable: true}\n    depends_on: !override {}\n    ports: !override []\n    volumes: !override\n      - type: volume\n        source: gate\n        target: /run/servus-lifecycle\n        read_only: true\n      - type: bind\n        source: ${wrapper}\n        target: /app/lifecycle-gate.sh\n        read_only: true\n`;
  writeFileSync(override, `services:\n  api:${extra}  worker:${extra}  agent:${extra}volumes:\n  gate:\n    external: true\n    name: ${volume}\n`);
  const args = ['compose', '--env-file', envFile, '-f', compose, '-f', override, '-p', project];
  const mount = `type=volume,source=${volume},target=/run/servus-lifecycle`;
  const rootRun = command => docker('run', '--rm', '--network', 'none', '--mount', mount, '--entrypoint', 'sh', env.SERVUS_IMAGE, '-c', command);
  docker('volume', 'create', '--label', `servus.fixture=${id}`, volume);
  try {
    rootRun("chmod 755 /run/servus-lifecycle; : > /run/servus-lifecycle/lock; printf 'servus-lifecycle-v1 normal\\n' > /run/servus-lifecycle/state; chmod 644 /run/servus-lifecycle/lock /run/servus-lifecycle/state");
    docker(...args, 'up', '-d');
    for (const name of ['api', 'worker', 'agent']) {
      let ready = false;
      for (let i=0; i<100; i++) { if (docker(...args, 'logs', '--no-color', name).includes('READY')) { ready = true; break; } await sleep(100); }
      assert(ready, `${name} did not start through the gate`);
    }
    const exclusive = () => attempt('run', '--rm', '--network', 'none', '--mount', mount, '--entrypoint', 'sh', env.SERVUS_IMAGE, '-c', 'exec 8</run/servus-lifecycle/lock; flock -x -n 8');
    assert.notEqual(exclusive().status, 0, 'Running services must hold shared lifecycle locks');
    rootRun("printf 'servus-lifecycle-v1 maintenance\\n' > /run/servus-lifecycle/.next; chmod 644 /run/servus-lifecycle/.next; mv /run/servus-lifecycle/.next /run/servus-lifecycle/state");
    docker(...args, 'kill', 'agent');
    docker(...args, 'up', '-d', '--force-recreate', 'agent');
    let rejected = false;
    for (let i=0; i<100; i++) { if (docker(...args, 'logs', '--no-color', 'agent').includes('Servus lifecycle gate rejected startup.')) { rejected = true; break; } await sleep(100); }
    assert(rejected, 'Maintenance must prevent restarted agent from entering Node');
  } finally {
    attempt(...args, 'down', '--remove-orphans');
    const labels = JSON.parse(docker('volume', 'inspect', volume))[0].Labels;
    if (labels?.['servus.fixture'] !== id) throw new Error('Refusing to remove an unowned fixture');
    docker('volume', 'rm', volume);
    rmSync(dir, { recursive: true, force: true });
  }
});
