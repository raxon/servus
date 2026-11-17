import { strict as assert } from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const context = 'colima-panel-dev', root = resolve(import.meta.dirname, '../..');
const docker = (...args) => execFileSync('docker', ['--context', context, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const attempt = (...args) => spawnSync('docker', ['--context', context, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });

test('the production Docker wrapper strips inherited Compose and daemon settings', () => {
  const id = randomUUID(), tag = `servus-env-fixture:${id}`, dir = mkdtempSync(join(root, '.test-env-fixture-'));
  const image = 'node:24-bookworm-slim', gate = '/etc/servus-test/lifecycle', data = '/var/lib/servus-test-data', control = '/etc/servus-test/supervisor-control', secrets = '/etc/servus-test/supervisor-secrets';
  const env = join(dir, 'servus.env'), imageEnv = join(dir, 'image-env.json');
  writeFileSync(join(dir, 'Dockerfile'), 'FROM docker:29-cli AS cli\nFROM python:3.12-slim\nCOPY --from=cli /usr/local/bin/docker /usr/bin/docker\nCOPY --from=cli /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose\n');
  writeFileSync(env, `SERVUS_IMAGE=${image}\nSERVUS_DATA_DIR=${data}\nSERVUS_LIFECYCLE_DIR=${gate}\nSERVUS_SUPERVISOR_CONTROL_DIR=${control}\nSERVUS_SUPERVISOR_SECRET_DIR=${secrets}\nSERVUS_UPDATER_SOCKET_DIR=/run/servus-updater/control\nSERVUS_DOCKER_GID=0\nSERVUS_BIND_ADDRESS=127.0.0.1\nSERVUS_PORT=4180\nSERVUS_ALLOWED_ORIGINS=http://localhost:4180\n`);
  const base = JSON.parse(docker('image', 'inspect', image, '--format', '{{json .Config.Env}}'));
  writeFileSync(imageEnv, JSON.stringify([...base, 'NODE_ENV=production', 'PANEL_DATA_DIR=/var/lib/panel', 'PANEL_HOST=0.0.0.0', 'PANEL_PORT=4180']));
  try {
    docker('build', '--network', 'none', '--label', `servus.fixture=${id}`, '-t', tag, dir);
    const script = 'export SERVUS_INSTALLER_LIBRARY=1; source /installer.sh; source=/source; mkdir -m 700 /tmp/docker-client; servus_docker_config=/tmp/docker-client; verify_lifecycle_compose /fixture/servus.env /compose.yaml /etc/servus-test/lifecycle node:24-bookworm-slim /var/lib/servus-test-data /fixture/image-env.json /etc/servus-test/supervisor-control /etc/servus-test/supervisor-secrets /tmp/canonical.json';
    const result = attempt('run', '--rm', '--network', 'none',
      '--env', 'SERVUS_BIND_ADDRESS=0.0.0.0', '--env', 'SERVUS_PORT=9876', '--env', 'SERVUS_DATA_DIR=/app',
      '--env', 'DOCKER_HOST=tcp://127.0.0.1:9999', '--env', 'DOCKER_CONTEXT=foreign', '--env', 'COMPOSE_FILE=/tmp/hostile.yaml',
      '--mount', `type=bind,source=${join(root, 'scripts/install.sh')},target=/installer.sh,readonly`,
      '--mount', `type=bind,source=${join(root, 'apps/updater/validate-compose.py')},target=/source/apps/updater/validate-compose.py,readonly`,
      '--mount', `type=bind,source=${join(root, 'deployment/compose.yaml')},target=/compose.yaml,readonly`,
      '--mount', `type=bind,source=${dir},target=/fixture,readonly`, '--entrypoint', 'bash', tag, '-c', script);
    assert.equal(result.status, 0, result.stderr);
    writeFileSync(join(dir, 'proxy-compose.yaml'), 'services:\n  probe:\n    image: node:24-bookworm-slim\n    network_mode: none\n    entrypoint: [/bin/true]\n');
    const legacyProject = `servusproxyold${id.replaceAll('-', '')}`, cleanProject = `servusproxyclean${id.replaceAll('-', '')}`;
    const proxyScript = `export SERVUS_INSTALLER_LIBRARY=1; source /installer.sh
      mkdir -p /root/.docker /tmp/docker-client; chmod 700 /tmp/docker-client; servus_docker_config=/tmp/docker-client
      printf '%s' '{"proxies":{"default":{"httpProxy":"http://proxy.invalid:31337","httpsProxy":"http://proxy.invalid:31337","noProxy":"example.invalid"}}}' > /root/.docker/config.json
      legacy() { /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin HOME=/root DOCKER_CONTEXT=default DOCKER_HOST=unix:///var/run/docker.sock /usr/bin/docker "$@"; }
      cleanup() { legacy compose -p "$1" -f /fixture/proxy-compose.yaml down --remove-orphans >/dev/null 2>&1 || :; trusted_docker compose -p "$2" -f /fixture/proxy-compose.yaml down --remove-orphans >/dev/null 2>&1 || :; }
      trap 'cleanup "$1" "$2"' EXIT
      legacy compose -p "$1" -f /fixture/proxy-compose.yaml create >/dev/null
      old_id=$(legacy compose -p "$1" -f /fixture/proxy-compose.yaml ps -aq)
      legacy inspect --format '{{json .Config.Env}}' "$old_id" | python3 -c 'import json,sys; values=json.load(sys.stdin); assert any(v.startswith("HTTP_PROXY=") for v in values)'
      trusted_docker compose -p "$2" -f /fixture/proxy-compose.yaml create >/dev/null
      new_id=$(trusted_docker compose -p "$2" -f /fixture/proxy-compose.yaml ps -aq)
      trusted_docker inspect --format '{{json .Config.Env}}' "$new_id" | python3 -c 'import json,sys; values=json.load(sys.stdin); assert not any(v.split("=",1)[0].lower() in ("http_proxy","https_proxy","no_proxy","all_proxy") for v in values)'
    `;
    const proxy = attempt('run', '--rm', '--network', 'none',
      '--mount', 'type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock',
      '--mount', `type=bind,source=${join(root, 'scripts/install.sh')},target=/installer.sh,readonly`,
      '--mount', `type=bind,source=${dir},target=/fixture,readonly`, '--entrypoint', 'bash', tag, '-c', proxyScript, '_', legacyProject, cleanProject);
    assert.equal(proxy.status, 0, proxy.stderr);
  } finally {
    const inspected = attempt('image', 'inspect', tag, '--format', '{{index .Config.Labels "servus.fixture"}}');
    if (inspected.status === 0 && inspected.stdout.trim() === id) docker('image', 'rm', tag);
    rmSync(dir, { recursive: true, force: true });
  }
});
