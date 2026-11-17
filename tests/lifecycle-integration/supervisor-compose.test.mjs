import { strict as assert } from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';

const context = 'colima-panel-dev';
const root = resolve(import.meta.dirname, '../..');
const installer = join(root, 'scripts/install.sh'), compose = join(root, 'deployment/compose.yaml'), wrapper = join(root, 'deployment/lifecycle-gate.sh');
const docker = (...args) => execFileSync('docker', ['--context', context, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const attempt = (...args) => spawnSync('docker', ['--context', context, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });

test('Compose mounts each role credential read-only and reaches the root-owned socket', async () => {
  const id = randomUUID(), volume = `servus-control-compose-${id}`, holder = `servus-control-holder-${id}`, project = `servuscontrol${id.replaceAll('-', '')}`;
  const dir = mkdtempSync(join(tmpdir(), 'servus-control-compose-')), envFile = join(dir, 'fixture.env'), override = join(dir, 'override.yaml');
  const volumeMount = `type=volume,source=${volume},target=/fixture`;
  let args;
  docker('volume', 'create', '--label', `servus.fixture=${id}`, volume);
  try {
    const provision = 'mkdir -m 700 /fixture/config /fixture/install; mkdir /fixture/data /fixture/updater; chmod 755 /fixture/updater; chown 1000:1000 /fixture/data; export SERVUS_INSTALLER_LIBRARY=1; source /installer.sh; config_dir=/fixture/config; install_dir=/fixture/install; prepare_lifecycle_gate; prepare_supervisor_credentials';
    docker('run', '--rm', '--network', 'none', '--mount', volumeMount, '--mount', `type=bind,source=${installer},target=/installer.sh,readonly`, '--entrypoint', 'bash', 'python:3.12-slim', '-c', provision);
    const base = JSON.parse(docker('volume', 'inspect', volume))[0].Mountpoint;
    assert.match(base, /^\/var\/lib\/docker\/volumes\/servus-control-compose-[a-f0-9-]+\/_data$/);
    const socket = 'import os,socket; p="/fixture/config/supervisor-control/socket"; s=socket.socket(socket.AF_UNIX); s.bind(p); os.chown(p,0,1000); os.chmod(p,0o660); s.listen(16); print("READY",flush=True);\nwhile True:\n c,_=s.accept(); c.close()';
    docker('run', '-d', '--name', holder, '--network', 'none', '--mount', volumeMount, '--entrypoint', 'python3', 'python:3.12-slim', '-u', '-c', socket);
    let listenerReady = false;
    for (let i=0; i<100; i++) { if (docker('logs', holder).includes('READY')) { listenerReady = true; break; } await sleep(100); }
    assert(listenerReady, 'Fixture listener did not start');
    const env = { SERVUS_IMAGE:'node:24-bookworm-slim', SERVUS_DATA_DIR:`${base}/data`, SERVUS_LIFECYCLE_DIR:`${base}/config/lifecycle`, SERVUS_SUPERVISOR_CONTROL_DIR:`${base}/config/supervisor-control`, SERVUS_SUPERVISOR_SECRET_DIR:`${base}/config/supervisor-secrets`, SERVUS_UPDATER_SOCKET_DIR:`${base}/updater`, SERVUS_ALLOWED_ORIGINS:'http://localhost:4180', SERVUS_DOCKER_GID:'0' };
    writeFileSync(envFile, Object.entries(env).map(([key,value]) => `${key}=${value}`).join('\n') + '\n');
    const probe = `const fs=require('node:fs'),net=require('node:net'),cp=require('node:child_process');const f=process.env.PANEL_SUPERVISOR_SECRET_FILE,p=process.env.PANEL_SUPERVISOR_SOCKET;const st=fs.lstatSync(f);if(st.uid!==0||st.gid!==1000||(st.mode&0o777)!==0o640||!/^[a-f0-9]{64}\\n$/.test(fs.readFileSync(f,'utf8')))process.exit(3);for(const x of [f,'/run/servus-supervisor'])if(!cp.execFileSync('/usr/bin/findmnt',['-rn','-o','OPTIONS','--mountpoint',x],{encoding:'utf8'}).trim().split(',').includes('ro'))process.exit(4);for(const x of ['api','worker','agent'])if(fs.existsSync('/run/servus-control/'+x))process.exit(5);const s=net.createConnection(p);s.on('connect',()=>{s.destroy();console.log('READY');setInterval(()=>{},1000)});s.on('error',()=>process.exit(6));`;
    const extra = `\n    user: '1000:1000'\n    command: ['-e', ${JSON.stringify(probe)}]\n    healthcheck: {disable: true}\n    depends_on: !override {}\n    ports: !override []\n    volumes:\n      - type: bind\n        source: ${wrapper}\n        target: /app/lifecycle-gate.sh\n        read_only: true\n`;
    writeFileSync(override, `services:\n  api:${extra}  worker:${extra}  agent:${extra}`);
    args = ['compose', '--env-file', envFile, '-f', compose, '-f', override, '-p', project];
    const config = JSON.parse(docker(...args, 'config', '--format', 'json'));
    for (const role of ['api','worker','agent']) {
      const mounts = config.services[role].volumes;
      const token = mounts.find(entry => entry.target === '/run/servus-control/token');
      assert.equal(token?.source, `${env.SERVUS_SUPERVISOR_SECRET_DIR}/${role}`); assert.equal(token?.read_only, true); assert.equal(token?.bind?.create_host_path, false);
      const control = mounts.find(entry => entry.target === '/run/servus-supervisor');
      assert.equal(control?.source, env.SERVUS_SUPERVISOR_CONTROL_DIR); assert.equal(control?.read_only, true); assert.equal(control?.bind?.create_host_path, false);
    }
    docker(...args, 'up', '-d');
    for (const role of ['api','worker','agent']) {
      let ready = false;
      for (let i=0; i<100; i++) { if (docker(...args, 'logs', '--no-color', role).includes('READY')) { ready = true; break; } await sleep(100); }
      assert(ready, `${role} did not read its role credential and connect to the socket`);
    }
  } finally {
    if (args) attempt(...args, 'down', '--remove-orphans');
    attempt('rm', '-f', holder);
    const labels = JSON.parse(docker('volume', 'inspect', volume))[0].Labels;
    if (labels?.['servus.fixture'] !== id) throw new Error('Refusing to remove an unowned fixture');
    docker('volume', 'rm', volume);
    rmSync(dir, { recursive: true, force: true });
  }
});
