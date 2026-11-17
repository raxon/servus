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

test('supervisor provisioning keeps distinct root-owned credentials and requires a live socket', async () => {
  const id = randomUUID(), volume = `servus-supervisor-fixture-${id}`, holder = `servus-supervisor-listener-${id}`;
  const mount = `type=volume,source=${volume},target=/fixture`;
  const root = command => docker('run', '--rm', '--network', 'none', '--mount', mount, '--entrypoint', 'bash', image, '-c', command);
  const check = fn => attempt('run', '--rm', '--network', 'none', '--mount', mount, '--mount', `type=bind,source=${installer},target=/installer.sh,readonly`, '--entrypoint', 'bash', image, '-c', `export SERVUS_INSTALLER_LIBRARY=1; source /installer.sh; config_dir=/fixture/config; install_dir=/fixture/install; ${fn}`);
  docker('volume', 'create', '--label', `servus.fixture=${id}`, volume);
  try {
    root('mkdir -m 700 /fixture/config /fixture/install');
    let result = check('prepare_supervisor_credentials'); assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, '');
    assert.equal(root('stat -c "%u:%g:%a" /fixture/config/supervisor-secrets'), '0:0:700');
    assert.equal(root('stat -c "%u:%g:%a" /fixture/config/supervisor-control'), '0:1000:750');
    for (const role of ['api', 'worker', 'agent']) assert.equal(root(`stat -c "%u:%g:%a:%h" /fixture/config/supervisor-secrets/${role}`), '0:1000:640:1');
    root('! cmp -s /fixture/config/supervisor-secrets/api /fixture/config/supervisor-secrets/worker && ! cmp -s /fixture/config/supervisor-secrets/api /fixture/config/supervisor-secrets/agent && ! cmp -s /fixture/config/supervisor-secrets/worker /fixture/config/supervisor-secrets/agent');
    const original = root('sha256sum /fixture/config/supervisor-secrets/*');
    result = check('prepare_supervisor_credentials'); assert.equal(result.status, 0, result.stderr);
    assert.equal(root('sha256sum /fixture/config/supervisor-secrets/*'), original, 'Rerun must not rotate role credentials');
    result = check('require_supervisor_socket'); assert.notEqual(result.status, 0); assert.match(result.stderr, /supervisor socket is required/);

    const listen = 'import os,socket,time; p="/fixture/config/supervisor-control/socket"; s=socket.socket(socket.AF_UNIX); s.bind(p); os.chown(p,0,1000); os.chmod(p,0o660); s.listen(16); print("READY",flush=True); time.sleep(60)';
    docker('run', '-d', '--name', holder, '--network', 'none', '--mount', mount, '--entrypoint', 'python3', image, '-c', listen);
    for (let i=0; i<100 && !docker('logs', holder).includes('READY'); i++) await sleep(100);
    assert(docker('logs', holder).includes('READY'));
    result = check('require_supervisor_socket'); assert.equal(result.status, 0, result.stderr);
    const volumeInfo = JSON.parse(docker('volume', 'inspect', volume))[0];
    assert.equal(volumeInfo.Labels?.['servus.fixture'], id);
    const base = volumeInfo.Mountpoint;
    assert.match(base, /^\/var\/lib\/docker\/volumes\/servus-supervisor-fixture-[a-f0-9-]+\/_data$/);
    const probe = `const fs=require('node:fs'),net=require('node:net'),cp=require('node:child_process');
      const file='/run/servus-control/token', endpoint='/run/servus-supervisor/socket';
      const st=fs.lstatSync(file), text=fs.readFileSync(file,'utf8');
      if(st.uid!==0||st.gid!==1000||(st.mode&0o777)!==0o640||!/^[a-f0-9]{64}\\n$/.test(text))process.exit(3);
      for(const path of ['/run/servus-control/worker','/run/servus-control/agent','/run/servus-control/api'])if(fs.existsSync(path))process.exit(4);
      for(const path of [file,'/run/servus-supervisor'])if(!cp.execFileSync('/usr/bin/findmnt',['-rn','-o','OPTIONS','--mountpoint',path],{encoding:'utf8'}).trim().split(',').includes('ro'))process.exit(5);
      try{fs.writeFileSync(file,'unsafe');process.exit(6)}catch(e){if(!['EROFS','EACCES'].includes(e.code))process.exit(7)}
      const s=net.createConnection(endpoint);s.on('connect',()=>{s.destroy();console.log('ROLE_OK')});s.on('error',()=>process.exit(8));setTimeout(()=>process.exit(9),3000).unref();`;
    for (const role of ['api', 'worker', 'agent']) {
      const response = attempt('run', '--rm', '--network', 'none', '--user', '1000:1000',
        '--mount', `type=bind,source=${base}/config/supervisor-control,target=/run/servus-supervisor,readonly`,
        '--mount', `type=bind,source=${base}/config/supervisor-secrets/${role},target=/run/servus-control/token,readonly`,
        '--entrypoint', 'node', 'node:24-bookworm-slim', '-e', probe);
      assert.equal(response.status, 0, response.stderr); assert.equal(response.stdout.trim(), 'ROLE_OK');
    }
    docker('rm', '-f', holder);
    result = check('require_supervisor_socket'); assert.notEqual(result.status, 0, 'A stale socket must not satisfy readiness');

    root('cp /fixture/config/supervisor-secrets/api /fixture/saved-api; chown 0:1000 /fixture/saved-api; chmod 640 /fixture/saved-api; cp /fixture/config/supervisor-secrets/worker /fixture/config/supervisor-secrets/api');
    result = check('prepare_supervisor_credentials'); assert.notEqual(result.status, 0); assert.match(result.stderr, /credential is unsafe/);
    root('cp /fixture/saved-api /fixture/config/supervisor-secrets/api');
    result = check('prepare_supervisor_credentials'); assert.equal(result.status, 0, result.stderr);
    root('rm /fixture/config/supervisor-secrets/api; ln -s worker /fixture/config/supervisor-secrets/api');
    result = check('prepare_supervisor_credentials'); assert.notEqual(result.status, 0);
    root('rm /fixture/config/supervisor-secrets/api; cp /fixture/saved-api /fixture/config/supervisor-secrets/api; chown 0:1000 /fixture/config/supervisor-secrets/api; chmod 640 /fixture/config/supervisor-secrets/api');
    result = check('prepare_supervisor_credentials'); assert.equal(result.status, 0, result.stderr);

    root('rm /fixture/config/.supervisor-enabled-v1');
    result = check('prepare_supervisor_credentials'); assert.notEqual(result.status, 0); assert.match(result.stderr, /Incomplete supervisor provisioning/);
    assert.equal(root('sha256sum /fixture/config/supervisor-secrets/*'), original);
  } finally {
    attempt('rm', '-f', holder);
    const labels = JSON.parse(docker('volume', 'inspect', volume))[0].Labels;
    if (labels?.['servus.fixture'] !== id) throw new Error('Refusing to remove an unowned fixture');
    docker('volume', 'rm', volume);
  }
});

test('an upgrade without the supervisor socket leaves existing configuration untouched', () => {
  const id = randomUUID(), volume = `servus-supervisor-upgrade-${id}`;
  const mount = `type=volume,source=${volume},target=/fixture`;
  const root = command => docker('run', '--rm', '--network', 'none', '--mount', mount, '--entrypoint', 'bash', image, '-c', command);
  docker('volume', 'create', '--label', `servus.fixture=${id}`, volume);
  try {
    root(`mkdir -m 700 /fixture/config /fixture/install /fixture/data; chown 1000:1000 /fixture/data
      mkdir -p /fixture/install/releases/previous/deployment /fixture/checkout/apps/panel /fixture/checkout/deployment
      printf 'servus-installer-v1\\n' > /fixture/install/.servus-install
      printf 'services: {}\\n' > /fixture/install/releases/previous/deployment/compose.yaml
      ln -s releases/previous /fixture/install/current
      printf 'FROM scratch\\n' > /fixture/checkout/Dockerfile; printf '{}\\n' > /fixture/checkout/apps/panel/package.json
      printf 'services: {}\\n' > /fixture/checkout/deployment/compose.yaml; printf '# fixture\\n' > /fixture/checkout/deployment/lifecycle-gate.sh
      printf 'ID=ubuntu\\nVERSION_ID=24.04\\nVERSION_CODENAME=noble\\n' > /fixture/os-release
      printf 'SERVUS_IMAGE=old-image\\nSERVUS_DATA_DIR=/fixture/data\\nSERVUS_PORT=4180\\nSERVUS_INGRESS_PORT=80\\nSERVUS_BIND_ADDRESS=127.0.0.1\\nSERVUS_PUBLIC_URL=http://localhost:4180\\nSERVUS_ALLOWED_ORIGINS=http://localhost:4180\\n' > /fixture/config/servus.env
      chmod 600 /fixture/config/servus.env; printf 'keep-existing-data' > /fixture/data/keep`);
    const before = root('sha256sum /fixture/config/servus.env /fixture/data/keep');
    const script = `export SERVUS_INSTALLER_LIBRARY=1 SERVUS_INSTALL_DIR=/fixture/install SERVUS_CONFIG_DIR=/fixture/config SERVUS_DATA_DIR=/fixture/data SERVUS_OS_RELEASE=/fixture/os-release
      source /installer.sh
      trusted_docker() { docker "$@"; }
      install_dependencies() { :; }; check_port() { :; }; verify_lifecycle_image() { :; }; verify_lifecycle_compose() { printf '{}\\n' > "$9"; }
      stat() { if [[ $* == *'/var/run/docker.sock'* ]]; then printf '1000\\n'; else command stat "$@"; fi; }
      docker() { case "$1" in service) return 1;; info) if [[ $* == *LocalNodeState* ]]; then printf 'active\\n'; else printf 'true\\n'; fi;; ps|build) return 0;; compose) touch /fixture/unexpected-compose; return 0;; *) return 0;; esac; }
      main --source /fixture/checkout`;
    const result = attempt('run', '--rm', '--network', 'none', '--mount', mount, '--mount', `type=bind,source=${installer},target=/installer.sh,readonly`, '--entrypoint', 'bash', image, '-c', script);
    assert.notEqual(result.status, 0); assert.match(result.stderr, /supervisor socket is required/);
    assert.equal(root('sha256sum /fixture/config/servus.env /fixture/data/keep'), before);
    assert.equal(attempt('run', '--rm', '--network', 'none', '--mount', mount, '--entrypoint', 'test', image, '-e', '/fixture/unexpected-compose').status, 1);
    assert.equal(root('readlink /fixture/install/current'), 'releases/previous');
  } finally {
    const labels = JSON.parse(docker('volume', 'inspect', volume))[0].Labels;
    if (labels?.['servus.fixture'] !== id) throw new Error('Refusing to remove an unowned fixture');
    docker('volume', 'rm', volume);
  }
});
