import { strict as assert } from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const installer = join(root, 'scripts/install.sh');
const context = 'colima-panel-dev';
const localDocker = execFileSync('which', ['docker'], { encoding: 'utf8' }).trim();
const docker = (...args) => execFileSync('docker', ['--context', context, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const runCheck = (fn, args, env = {}) => spawnSync('bash', ['-c', 'export SERVUS_INSTALLER_LIBRARY=1; source "$1"; source=$SERVUS_VALIDATOR_ROOT; trusted_docker() { env -i PATH="$SERVUS_FIXTURE_PATH" HOME="$SERVUS_FIXTURE_HOME" DOCKER_CONTEXT=colima-panel-dev SERVUS_TEST_COMPOSE_JSON="${SERVUS_TEST_COMPOSE_JSON-}" SERVUS_REAL_DOCKER="${SERVUS_REAL_DOCKER-}" SERVUS_FORBIDDEN="${SERVUS_FORBIDDEN-}" "$SERVUS_FIXTURE_DOCKER" "$@"; }; shift; function_name=$1; shift; "$function_name" "$@"', 'fixture', installer, fn, ...args], { env: { ...process.env, SERVUS_VALIDATOR_ROOT: root, SERVUS_FIXTURE_PATH: process.env.PATH, SERVUS_FIXTURE_HOME: process.env.HOME, SERVUS_FIXTURE_DOCKER: env.SERVUS_FIXTURE_DOCKER ?? localDocker, ...env }, encoding: 'utf8', timeout: 60000 });

test('Compose semantic validation rejects comments, missing mounts and changed commands', () => {
  const dir = mkdtempSync(join(tmpdir(), 'servus-gate-check-'));
  try {
    const source = readFileSync(join(root, 'deployment/compose.yaml'), 'utf8');
    const env = join(dir, 'servus.env'), actual = join(dir, 'compose.yaml'), imageEnv = join(dir, 'image-env.json');
    const image = 'node:24-bookworm-slim', gate = '/etc/servus-test/lifecycle', data = '/var/lib/servus-test-data', control = '/etc/servus-test/supervisor-control', secrets = '/etc/servus-test/supervisor-secrets';
    const secret = 'f'.repeat(64);
    const envText = `SERVUS_IMAGE=${image}\nSERVUS_DATA_DIR=${data}\nSERVUS_LIFECYCLE_DIR=${gate}\nSERVUS_SUPERVISOR_CONTROL_DIR=${control}\nSERVUS_SUPERVISOR_SECRET_DIR=${secrets}\nSERVUS_UPDATER_SOCKET_DIR=/run/servus-updater/control\nSERVUS_DOCKER_GID=0\nSERVUS_BIND_ADDRESS=127.0.0.1\nSERVUS_PORT=4180\nSERVUS_ALLOWED_ORIGINS=http://localhost:4180\nSERVUS_TRUSTED_PROXY_SECRET=${secret}\n`;
    writeFileSync(env, envText, { mode: 0o600 });
    const baseEnv = JSON.parse(docker('image', 'inspect', image, '--format', '{{json .Config.Env}}'));
    writeFileSync(imageEnv, JSON.stringify([...baseEnv, 'NODE_ENV=production', 'PANEL_DATA_DIR=/var/lib/panel', 'PANEL_HOST=0.0.0.0', 'PANEL_PORT=4180']), { mode: 0o600 });
    const args = composePath => [env, composePath, gate, image, data, imageEnv, control, secrets, join(dir, `canonical-${randomUUID()}.json`)];
    const check = text => { writeFileSync(actual, text); return runCheck('verify_lifecycle_compose', args(actual)); };
    let result = check(source); assert.equal(result.status, 0, result.stderr);
    result = runCheck('verify_lifecycle_compose', args(actual), { SERVUS_BIND_ADDRESS:'0.0.0.0', SERVUS_PORT:'9876', SERVUS_DATA_DIR:'/app', DOCKER_HOST:'tcp://127.0.0.1:6666', DOCKER_CONTEXT:'foreign', COMPOSE_FILE:'/tmp/hostile.yaml' });
    assert.equal(result.status, 0, 'Untrusted caller environment must not alter canonical Compose');
    result = check('# /run/servus-lifecycle\nservices:\n  api: {image: node:24-bookworm-slim}\n  worker: {image: node:24-bookworm-slim}\n  agent: {image: node:24-bookworm-slim}\n');
    assert.notEqual(result.status, 0); assert.match(result.stderr, /lifecycle wiring is invalid/);
    for (const [index, altered] of [
      source.replaceAll('target: /run/servus-lifecycle', 'target: /run/not-lifecycle'),
      source.replaceAll('create_host_path: false', 'create_host_path: true'),
      source.replace('command: [dist/server/index.js]', 'command: [dist/worker/index.js]'),
      source.replace('entrypoint: [/bin/sh, /app/lifecycle-gate.sh]', 'entrypoint: [/bin/sh, -c]'),
      source.replace('image: ${SERVUS_IMAGE:?Run scripts/install.sh to prepare the image}', 'image: node:other-tag'),
      source.replaceAll('target: /run/servus-lifecycle', 'target: /app/lifecycle-gate.sh'),
      source.replaceAll('target: /run/servus-lifecycle', 'target: /usr/bin/flock'),
      source.replaceAll('target: /run/servus-lifecycle', 'target: /proc'),
      source.replace('    environment:\n      <<: *runtime-env', '      - /tmp/evil:/app/lifecycle-gate.sh:ro\n    environment:\n      <<: *runtime-env'),
      source.replace('    environment:\n      <<: *runtime-env', '      - /tmp/evil:/app:ro\n    environment:\n      <<: *runtime-env'),
      source.replace('    environment:\n      <<: *runtime-env', '      - /tmp/evil:/usr/bin/flock:ro\n    environment:\n      <<: *runtime-env'),
      source.replace('    environment:\n      <<: *runtime-env', '      - /tmp/evil:/proc:ro\n    environment:\n      <<: *runtime-env'),
      source.replace('  entrypoint: [/bin/sh, /app/lifecycle-gate.sh]', '  secrets: [evil]\n  entrypoint: [/bin/sh, /app/lifecycle-gate.sh]') + '\nsecrets:\n  evil:\n    file: /tmp/unused-secret\n',
      source.replace('  entrypoint: [/bin/sh, /app/lifecycle-gate.sh]', '  tmpfs: [/app]\n  entrypoint: [/bin/sh, /app/lifecycle-gate.sh]'),
      source.replace('PANEL_DATA_DIR: ${SERVUS_DATA_DIR:-/var/lib/servus}', 'LD_PRELOAD: /tmp/evil.so\n    PANEL_DATA_DIR: ${SERVUS_DATA_DIR:-/var/lib/servus}'),
      source.replace('PANEL_DATA_DIR: ${SERVUS_DATA_DIR:-/var/lib/servus}', 'LD_LIBRARY_PATH: /tmp\n    PANEL_DATA_DIR: ${SERVUS_DATA_DIR:-/var/lib/servus}'),
      source.replace('PANEL_DATA_DIR: ${SERVUS_DATA_DIR:-/var/lib/servus}', 'NODE_OPTIONS: --require=/tmp/evil.js\n    PANEL_DATA_DIR: ${SERVUS_DATA_DIR:-/var/lib/servus}'),
      source.replace('PANEL_HOST: 0.0.0.0', 'PANEL_HOST: 127.0.0.1'),
      source.replace('PANEL_SUPERVISOR_SOCKET: /run/servus-supervisor/socket', 'PANEL_SUPERVISOR_SOCKET: /tmp/forged'),
      source.replace('PANEL_UPDATER_SOCKET: /run/servus-updater/updater.sock', 'PANEL_UPDATER_SOCKET: /tmp/forged'),
      source.replace('source: ${SERVUS_UPDATER_SOCKET_DIR:?Missing updater socket directory}', 'source: /etc'),
      source.replace('target: /run/servus-updater', 'target: /run/forged-updater'),
      source.replace('PANEL_UPDATER_APPLY_ENABLED: "true"', 'PANEL_UPDATER_APPLY_ENABLED: "false"'),
      source.replaceAll('target: /run/servus-supervisor', 'target: /run/forged-supervisor'),
      source.replace('source: ${SERVUS_SUPERVISOR_SECRET_DIR:?Missing supervisor secret directory}/worker', 'source: ${SERVUS_SUPERVISOR_SECRET_DIR:?Missing supervisor secret directory}/api'),
      source.replace('target: /run/servus-control/token', 'target: /run/servus-control/forged-token'),
      source.replace('  api:\n    <<: *runtime', '  api:\n    <<: *runtime\n    pid: host'),
      source.replace('  api:\n    <<: *runtime', '  api:\n    <<: *runtime\n    ipc: host'),
      source.replace('  api:\n    <<: *runtime', '  api:\n    <<: *runtime\n    network_mode: host'),
      source.replace('  api:\n    <<: *runtime', '  api:\n    <<: *runtime\n    privileged: true'),
      source.replace('  api:\n    <<: *runtime', '  api:\n    <<: *runtime\n    security_opt: [seccomp=unconfined]'),
      source.replace('  api:\n    <<: *runtime', '  api:\n    <<: *runtime\n    user: root'),
      source.replace('  api:\n    <<: *runtime', '  api:\n    <<: *runtime\n    working_dir: /tmp'),
      source.replace('${SERVUS_BIND_ADDRESS:-0.0.0.0}:${SERVUS_PORT:-4180}:4180', '0.0.0.0:4180:4180'),
      source.replace('${SERVUS_BIND_ADDRESS:-0.0.0.0}:${SERVUS_PORT:-4180}:4180', '127.0.0.1:9999:4180'),
      source.replace('  restart: unless-stopped', '  restart: always'),
      source.replace('  init: true', '  init: false'),
      source.replace('      interval: 10s', '      interval: 1s'),
      source.replace("      - ${SERVUS_DOCKER_GID:?Missing Docker socket group}", '      - 12345'),
    ].entries()) {
      result = check(altered); assert.notEqual(result.status, 0, `malformed Compose variant ${index} was accepted`); assert(!result.stderr.includes(secret));
    }
    writeFileSync(actual, source);
    for (const unsafe of ['/app', '/app/lifecycle-gate.sh', '/usr', '/usr/bin/flock', '/run', '/run/servus-lifecycle', '/proc', '/var/run', '/var/run/docker.sock', '/tmp', '/var', '/home/node']) {
      writeFileSync(env, envText.replace(`SERVUS_DATA_DIR=${data}`, `SERVUS_DATA_DIR=${unsafe}`));
      const response = runCheck('verify_lifecycle_compose', [env, actual, gate, image, unsafe, imageEnv, control, secrets, join(dir, `canonical-${randomUUID()}.json`)]);
      assert.notEqual(response.status, 0, `unsafe data path ${unsafe} accepted`);
      assert(!response.stderr.includes(secret));
    }
    writeFileSync(env, envText);
    for (const invalidEnv of [`${envText}SERVUS_DATA_DIR=${data}\n`, `${envText}NODE_OPTIONS=--require=/tmp/evil.js\n`, envText.replace(secret, 'not-a-proxy-secret')]) {
      writeFileSync(env, invalidEnv);
      const response = runCheck('verify_lifecycle_compose', args(actual));
      assert.notEqual(response.status, 0); assert(!response.stderr.includes(secret));
    }
    writeFileSync(env, envText);
    const valid = JSON.parse(docker('compose', '--env-file', env, '-f', actual, '-p', 'servusgatejsonfixture', 'config', '--format', 'json'));
    const bin = join(dir, 'bin'), fixture = join(dir, 'json'); mkdirSync(bin);
    writeFileSync(join(bin, 'docker'), '#!/bin/sh\ncat "$SERVUS_TEST_COMPOSE_JSON"\n', { mode: 0o755 });
    const corrupt = variants => {
      for (const mutate of variants) {
        const doc = structuredClone(valid); mutate(doc); writeFileSync(fixture, JSON.stringify(doc));
        const response = runCheck('verify_lifecycle_compose', args(actual), { SERVUS_FIXTURE_DOCKER: join(bin, 'docker'), SERVUS_TEST_COMPOSE_JSON: fixture });
        assert.notEqual(response.status, 0); assert(!response.stderr.includes(secret));
      }
    };
    corrupt([
      doc => doc.services.api.volumes.push('not-a-mount-object'),
      doc => doc.services.api.volumes.push({ ...doc.services.api.volumes[0] }),
      doc => { delete doc.services.api.volumes[0].source; },
      doc => { doc.services.api.volumes[0].bind = { propagation: 'shared' }; },
      doc => { doc.services.api.pid = 'host'; },
      doc => { doc.services.api.ports[0].host_ip = '0.0.0.0'; },
      doc => { doc.services.api.ports[0].published = '9876'; },
      doc => { doc.services.agent.devices = ['/dev/sda:/dev/sda']; },
      doc => { doc.services.agent.group_add.push('1'); },
      doc => { doc.services.api.healthcheck.test = ['CMD', 'true']; },
      doc => { doc.networks.default.driver = 'host'; },
    ]);
    const dynamic = join(dir, 'dynamic.env'), frozen = join(dir, 'frozen.json'), second = join(dir, 'frozen-check.json');
    writeFileSync(dynamic, `PANEL_DATA_DIR=${data}\n`);
    writeFileSync(actual, source.replace('  api:\n    <<: *runtime', `  api:\n    <<: *runtime\n    env_file: [${dynamic}]`));
    result = runCheck('verify_lifecycle_compose', [env, actual, gate, image, data, imageEnv, control, secrets, frozen]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(readFileSync(frozen, 'utf8')).services.api.env_file, undefined);
    assert.equal(statSync(frozen).mode & 0o777, 0o600);
    writeFileSync(dynamic, 'LD_PRELOAD=/tmp/attacker.so\n');
    result = runCheck('verify_lifecycle_compose', [env, frozen, gate, image, data, imageEnv, control, secrets, second]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(second, 'utf8'), readFileSync(frozen, 'utf8'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('image gate content is copied out of an unstarted fixture and compared to release bytes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'servus-gate-image-')), id = randomUUID();
  const tag = `servus-gate-check:${id}`, malicious = [`servus-gate-check:node-${id}`, `servus-gate-check:ld-${id}`], expected = join(root, 'deployment/lifecycle-gate.sh'), wrong = join(dir, 'wrong.sh');
  copyFileSync(expected, join(dir, 'lifecycle-gate.sh')); writeFileSync(wrong, '# different fixture\n');
  const realDocker = execFileSync('which', ['docker'], { encoding: 'utf8' }).trim(), bin = join(dir, 'bin'), forbidden = join(dir, 'unexpected-docker-operation');
  mkdirSync(bin);
  writeFileSync(join(bin, 'docker'), '#!/bin/sh\nif [ "$1" != image ]; then : > "$SERVUS_FORBIDDEN"; exit 70; fi\nexec "$SERVUS_REAL_DOCKER" "$@"\n', { mode: 0o755 });
  writeFileSync(join(dir, 'supervisor-entrypoint.js'), '// synthetic fixture\n');
  const base = 'FROM node:24-bookworm-slim\nWORKDIR /app\nENV NODE_ENV=production PANEL_DATA_DIR=/var/lib/panel PANEL_HOST=0.0.0.0 PANEL_PORT=4180\nCOPY lifecycle-gate.sh /app/lifecycle-gate.sh\nCOPY supervisor-entrypoint.js /app/dist/shared/supervisor-entrypoint.js\nUSER node\n';
  writeFileSync(join(dir, 'Dockerfile'), base);
  try {
    docker('build', '--network', 'none', '--label', `servus.fixture=${id}`, '-t', tag, dir);
    let result = runCheck('verify_lifecycle_image', [tag, expected, dir]); assert.equal(result.status, 0, result.stderr);
    result = runCheck('verify_lifecycle_image', [tag, wrong, dir]); assert.notEqual(result.status, 0); assert.match(result.stderr, /does not match/);
    result = runCheck('verify_lifecycle_image', ['node:24-bookworm-slim', expected, dir]); assert.notEqual(result.status, 0); assert.match(result.stderr, /image (user|environment) is invalid/);
    for (const [index, entry] of ['NODE_OPTIONS=--require=/tmp/evil.js', 'LD_PRELOAD=/tmp/evil.so'].entries()) {
      writeFileSync(join(dir, 'Dockerfile'), `${base}ENV ${entry}\n`);
      docker('build', '--network', 'none', '--label', `servus.fixture=${id}`, '-t', malicious[index], dir);
      result = runCheck('verify_lifecycle_image', [malicious[index], expected, dir], { SERVUS_FIXTURE_DOCKER: join(bin, 'docker'), SERVUS_REAL_DOCKER: realDocker, SERVUS_FORBIDDEN: forbidden });
      assert.notEqual(result.status, 0); assert.match(result.stderr, /image environment is invalid/); assert(!result.stderr.includes(entry));
      assert.equal(spawnSync('test', ['-e', forbidden]).status, 1, 'Unsafe image must be rejected before container creation or execution');
      const env = join(dir, 'compose.env'), gate = '/etc/servus-test/lifecycle', data = '/var/lib/servus-test-data', control = '/etc/servus-test/supervisor-control', secrets = '/etc/servus-test/supervisor-secrets';
      writeFileSync(env, `SERVUS_IMAGE=${malicious[index]}\nSERVUS_DATA_DIR=${data}\nSERVUS_LIFECYCLE_DIR=${gate}\nSERVUS_SUPERVISOR_CONTROL_DIR=${control}\nSERVUS_SUPERVISOR_SECRET_DIR=${secrets}\nSERVUS_UPDATER_SOCKET_DIR=/run/servus-updater/control\nSERVUS_DOCKER_GID=0\nSERVUS_ALLOWED_ORIGINS=http://localhost:4180\n`);
      result = runCheck('verify_lifecycle_compose', [env, join(root, 'deployment/compose.yaml'), gate, malicious[index], data, join(dir, 'lifecycle-image-env.json'), control, secrets, join(dir, `canonical-${randomUUID()}.json`)]);
      assert.notEqual(result.status, 0); assert(!result.stderr.includes(entry));
    }
  } finally {
    for (const name of [tag, ...malicious]) {
      const inspect = spawnSync('docker', ['--context', context, 'image', 'inspect', name, '--format', '{{index .Config.Labels "servus.fixture"}}'], { encoding: 'utf8' });
      if (inspect.status === 0 && inspect.stdout.trim() === id) docker('image', 'rm', name);
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
