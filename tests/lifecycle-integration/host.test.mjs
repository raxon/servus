import { strict as assert } from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';

const context = 'colima-panel-dev';
const image = 'python:3.12-slim';
const installer = resolve(import.meta.dirname, '../../scripts/install.sh');
const docker = (...args) => execFileSync('docker', ['--context', context, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const attempt = (...args) => spawnSync('docker', ['--context', context, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });

test('installer lifecycle preparation fails closed and keeps the lock inode', async () => {
  const id = randomUUID(), volume = `servus-gate-integration-${id}`, holder = `servus-gate-lock-${id}`;
  const mount = `type=volume,source=${volume},target=/fixture`;
  const root = command => docker('run', '--rm', '--network', 'none', '--mount', mount, '--entrypoint', 'bash', image, '-c', command);
  const prepare = (config = 'config', install = 'install') => attempt('run', '--rm', '--network', 'none', '--mount', mount, '--mount', `type=bind,source=${installer},target=/installer.sh,readonly`, '--entrypoint', 'bash', image, '-c', `export SERVUS_INSTALLER_LIBRARY=1; source /installer.sh; config_dir=/fixture/${config}; install_dir=/fixture/${install}; prepare_lifecycle_gate`);
  docker('volume', 'create', '--label', `servus.fixture=${id}`, volume);
  try {
    root('mkdir -m 700 /fixture/config /fixture/install');
    let result = prepare(); assert.equal(result.status, 0, result.stderr);
    const first = root('stat -c %i /fixture/config/lifecycle/lock');
    result = prepare(); assert.equal(result.status, 0, result.stderr);
    assert.equal(root('stat -c %i /fixture/config/lifecycle/lock'), first);
    assert.equal(root('cat /fixture/config/lifecycle/state'), 'servus-lifecycle-v1 normal');

    root('mkdir -m 700 /fixture/legacy-config /fixture/legacy-install; mkdir -p /fixture/legacy-install/releases/old/deployment; printf "services: {}\\n" > /fixture/legacy-install/releases/old/deployment/compose.yaml; ln -s releases/old /fixture/legacy-install/current; printf "SERVUS_IMAGE=legacy\\n" > /fixture/legacy-config/servus.env; chmod 600 /fixture/legacy-config/servus.env');
    result = prepare('legacy-config', 'legacy-install'); assert.equal(result.status, 0, result.stderr);
    assert.equal(root('cat /fixture/legacy-config/servus.env'), 'SERVUS_IMAGE=legacy');
    const legacyInode = root('stat -c %i /fixture/legacy-config/lifecycle/lock');
    result = prepare('legacy-config', 'legacy-install'); assert.equal(result.status, 0, result.stderr);
    assert.equal(root('stat -c %i /fixture/legacy-config/lifecycle/lock'), legacyInode);

    root("printf 'SERVUS_LIFECYCLE_DIR=/wrong\\n' > /fixture/legacy-config/servus.env");
    result = prepare('legacy-config', 'legacy-install'); assert.notEqual(result.status, 0); assert.match(result.stderr, /Invalid existing lifecycle configuration/);
    assert.equal(root('stat -c %i /fixture/legacy-config/lifecycle/lock'), legacyInode);

    root("printf 'servus-lifecycle-v1 maintenance\\n' > /fixture/config/lifecycle/state");
    result = prepare(); assert.notEqual(result.status, 0); assert.match(result.stderr, /not in normal state/);
    assert.equal(root('cat /fixture/config/lifecycle/state'), 'servus-lifecycle-v1 maintenance');
    root("printf 'servus-lifecycle-v1 normal\\n' > /fixture/config/lifecycle/state");

    docker('run', '-d', '--name', holder, '--network', 'none', '--mount', mount, '--entrypoint', 'python3', image, '-c', 'import fcntl,time; f=open("/fixture/config/lifecycle/lock"); fcntl.flock(f,fcntl.LOCK_EX); print("READY",flush=True); time.sleep(60)');
    for (let i=0; i<100 && !docker('logs', holder).includes('READY'); i++) await sleep(100);
    assert(docker('logs', holder).includes('READY'));
    result = prepare(); assert.notEqual(result.status, 0); assert.match(result.stderr, /locked for maintenance/);
    docker('rm', '-f', holder);
    result = prepare(); assert.equal(result.status, 0, result.stderr);

    root('mv /fixture/config/lifecycle/state /fixture/config/lifecycle/real-state; ln -s real-state /fixture/config/lifecycle/state');
    result = prepare(); assert.notEqual(result.status, 0);
    root('rm /fixture/config/lifecycle/state; mv /fixture/config/lifecycle/real-state /fixture/config/lifecycle/state');
    result = prepare(); assert.equal(result.status, 0, result.stderr);

    root('rm /fixture/install/.lifecycle-enabled-v1');
    result = prepare(); assert.notEqual(result.status, 0); assert.match(result.stderr, /Incomplete lifecycle gate/);
    assert.equal(root('stat -c %i /fixture/config/lifecycle/lock'), first);
  } finally {
    attempt('rm', '-f', holder);
    const labels = JSON.parse(docker('volume', 'inspect', volume))[0].Labels;
    if (labels?.['servus.fixture'] !== id) throw new Error('Refusing to remove an unowned fixture');
    docker('volume', 'rm', volume);
  }
});
