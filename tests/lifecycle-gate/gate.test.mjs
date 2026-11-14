import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';

const context = process.env.SERVUS_LIFECYCLE_TEST_CONTEXT ?? 'colima-panel-dev';
if (context !== 'colima-panel-dev' && !(context === 'default' && process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted')) {
  throw new Error('Lifecycle tests require colima-panel-dev or a GitHub-hosted runner');
}
const image = 'node:24-bookworm-slim';
const wrapper = resolve(import.meta.dirname, '../../deployment/lifecycle-gate.sh');
const raceFlock = resolve(import.meta.dirname, 'race-flock.sh');
const docker = (...args) => execFileSync('docker', ['--context', context, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const run = (...args) => spawnSync('docker', ['--context', context, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
const mount = (volume, readOnly = false) => `type=volume,source=${volume},target=/run/servus-lifecycle${readOnly ? ',readonly' : ''}`;
const mountScript = `type=bind,source=${wrapper},target=/gate.sh,readonly`;

test('lifecycle gate excludes unsafe starts and holds its lock across exec', async () => {
  const contextInfo = JSON.parse(docker('context', 'inspect', context));
  if (context === 'default') assert.equal(contextInfo[0]?.Endpoints?.docker?.Host, 'unix:///var/run/docker.sock');
  const suffix = randomUUID();
  const volume = `servus-lifecycle-fixture-${suffix}`;
  const container = `servus-lifecycle-fixture-${suffix}`;
  const coordinator = `servus-lifecycle-coordinator-${suffix}`;
  const racing = `servus-lifecycle-race-${suffix}`;
  const createdContainers = [];
  const root = command => docker('run', '--rm', '--network', 'none', '--mount', mount(volume), '--entrypoint', 'sh', image, '-c', command);
  const attempt = (readonly = true) => run('run', '--rm', '--network', 'none', '--user', '1000:1000', '--mount', mount(volume, readonly), '--mount', mountScript, '--entrypoint', 'sh', image, '/gate.sh', '-e', 'process.stdout.write("STARTED")');
  const normal = () => root("rm -f /run/servus-lifecycle/*; chmod 755 /run/servus-lifecycle; : > /run/servus-lifecycle/lock; printf 'servus-lifecycle-v1 normal\\n' > /run/servus-lifecycle/state; chmod 644 /run/servus-lifecycle/lock /run/servus-lifecycle/state");
  docker('volume', 'create', '--label', `servus.fixture=${suffix}`, volume);
  try {
    const labels = JSON.parse(docker('volume', 'inspect', volume))[0].Labels;
    assert.equal(labels?.['servus.fixture'], suffix, 'Refusing to use an unowned volume');
    normal();
    let result = attempt();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'STARTED');
    assert.notEqual(attempt(false).status, 0, 'A writable gate mount must fail');

    for (const alteration of [
      'rm /run/servus-lifecycle/state',
      "printf 'servus-lifecycle-v1 maintenance\\n' > /run/servus-lifecycle/state",
      "printf 'servus-lifecycle-v1 normal\\nextra' > /run/servus-lifecycle/state",
      'chmod 666 /run/servus-lifecycle/state',
      'rm /run/servus-lifecycle/state; ln -s lock /run/servus-lifecycle/state',
      'rm /run/servus-lifecycle/lock; ln -s state /run/servus-lifecycle/lock',
      'ln /run/servus-lifecycle/state /run/servus-lifecycle/another',
      'chown 1000:1000 /run/servus-lifecycle/state',
      'chmod 777 /run/servus-lifecycle',
    ]) {
      normal(); root(alteration);
      result = attempt();
      assert.notEqual(result.status, 0, `Unsafe fixture accepted: ${alteration}`);
      assert(!result.stdout.includes('STARTED'));
    }

    normal();
    root('cp /usr/bin/flock /run/servus-lifecycle/flock-real; chmod 755 /run/servus-lifecycle/flock-real');
    createdContainers.push(docker('run', '-d', '--label', `servus.fixture=${suffix}`, '--name', racing, '--network', 'none', '--user', '1000:1000', '--mount', mount(volume, true), '--mount', mountScript, '--mount', `type=bind,source=${raceFlock},target=/usr/bin/flock,readonly`, '--entrypoint', 'sh', image, '/gate.sh', '-e', 'process.stdout.write("STARTED")'));
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (run('exec', racing, 'test', '-e', '/tmp/servus-flock-ready').status === 0) { ready = true; break; }
      await sleep(100);
    }
    assert(ready, 'Expected the deterministic lock acquisition barrier');
    root('rm /run/servus-lifecycle/lock; : > /run/servus-lifecycle/lock; chmod 644 /run/servus-lifecycle/lock');
    docker('exec', racing, 'sh', '-c', ': > /tmp/servus-flock-continue');
    assert.notEqual(docker('wait', racing), '0', 'Replacing the lock inode before flock must block startup');
    assert(!docker('logs', racing).includes('STARTED'));

    normal();
    createdContainers.push(docker('run', '-d', '--label', `servus.fixture=${suffix}`, '--name', coordinator, '--network', 'none', '--mount', mount(volume), '--entrypoint', 'sh', image, '-c', 'exec 8</run/servus-lifecycle/lock; flock -x 8; echo READY; sleep 60'));
    for (let i = 0; i < 100 && !docker('logs', coordinator).includes('READY'); i++) await sleep(100);
    assert(docker('logs', coordinator).includes('READY'));
    assert.notEqual(attempt().status, 0, 'An exclusive coordinator lock must block start');
    docker('kill', '--signal', 'KILL', coordinator);
    assert.equal(attempt().status, 0, 'Normal state permits start once the exclusive lock is released');

    createdContainers.push(docker('run', '-d', '--label', `servus.fixture=${suffix}`, '--name', container, '--network', 'none', '--user', '1000:1000', '--mount', mount(volume, true), '--mount', mountScript, '--entrypoint', 'sh', image, '/gate.sh', '-e', 'console.log("READY");setInterval(()=>{},1000)'));
    for (let i = 0; i < 100 && !docker('logs', container).includes('READY'); i++) await sleep(100);
    assert(docker('logs', container).includes('READY'));
    const exclusive = () => run('run', '--rm', '--network', 'none', '--mount', mount(volume), '--entrypoint', 'sh', image, '-c', 'exec 8</run/servus-lifecycle/lock; flock -x -n 8');
    assert.notEqual(exclusive().status, 0, 'Running Node must retain its shared lock');
    root("printf 'servus-lifecycle-v1 maintenance\\n' > /run/servus-lifecycle/.new; chmod 644 /run/servus-lifecycle/.new; mv /run/servus-lifecycle/.new /run/servus-lifecycle/state");
    assert.notEqual(attempt().status, 0, 'Maintenance must block new starts');
    docker('kill', '--signal', 'KILL', container);
    assert.equal(exclusive().status, 0, 'SIGKILL must release the shared lock');
    assert.notEqual(attempt().status, 0, 'Maintenance must survive process death');
  } finally {
    for (const id of createdContainers) {
      assert.match(id, /^[a-f0-9]{64}$/);
      const item = JSON.parse(docker('inspect', id))[0];
      if (item.Id !== id || item.Config?.Labels?.['servus.fixture'] !== suffix) throw new Error('Refusing to remove an unowned fixture container');
      docker('rm', '-f', id);
    }
    const labels = JSON.parse(docker('volume', 'inspect', volume))[0].Labels;
    if (labels?.['servus.fixture'] !== suffix) throw new Error('Refusing to remove an unowned fixture');
    docker('volume', 'rm', volume);
  }
});
