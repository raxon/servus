#!/usr/bin/env node
// Exercise Unix socket access through the same read-only directory mount as the panel.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const context = process.env.SERVUS_SOCKET_TEST_CONTEXT ?? 'colima-panel-dev';
if (context !== 'colima-panel-dev' && !(context === 'default' && process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted')) {
  throw new Error('Socket test requires colima-panel-dev or a GitHub-hosted runner');
}
const call = (...args) => execFileSync('docker', ['--context', context, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const attempt = (...args) => spawnSync('docker', ['--context', context, ...args], { encoding: 'utf8', timeout: 30000 });
const id = randomUUID(), volume = `servus-updater-socket-${id}`, holder = `servus-updater-holder-${id}`;
const mount = `type=volume,source=${volume},target=/socket`;
const readonly = `type=volume,source=${volume},target=/run/servus-updater,readonly`;
const server = `import os,socket,struct\nos.chown('/socket',0,1000);os.chmod('/socket',0o710)\ns=socket.socket(socket.AF_UNIX);s.bind('/socket/updater.sock');os.chown('/socket/updater.sock',0,1000);os.chmod('/socket/updater.sock',0o660);s.listen(4);print('READY',flush=True)\nwhile True:\n c,_=s.accept();pid,uid,gid=struct.unpack('3i',c.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12));c.sendall(str(uid).encode());c.close()`;
const client = `const net=require('node:net');const c=net.createConnection('/run/servus-updater/updater.sock');c.on('data',v=>{if(v.toString()!=='1000')process.exit(2);console.log('CONNECTED');c.end()});c.on('error',()=>process.exit(1));`;
let created = false;
try {
  call('volume', 'create', '--label', `servus.fixture=${id}`, volume);
  created = true;
  call('run', '-d', '--name', holder, '--label', `servus.fixture=${id}`, '--network', 'none', '--mount', mount, '--entrypoint', 'python3', 'python:3.12-slim', '-u', '-c', server);
  let ready = false;
  for (let i=0; i<100; i++) { if (call('logs', holder).includes('READY')) { ready = true; break; } await sleep(100); }
  assert(ready, 'Socket listener did not start');
  const run = user => attempt('run', '--rm', '--network', 'none', '--user', user, '--mount', readonly, '--entrypoint', 'node', 'node:24-bookworm-slim', '-e', client);
  const denied = run('1001:1001'); assert.notEqual(denied.status, 0, 'A different UID connected to the socket');
  const allowed = run('1000:1000'); assert.equal(allowed.status, 0, allowed.stderr); assert.match(allowed.stdout, /CONNECTED/);
  console.log('Updater socket: read-only mount, peer identity and access controls passed');
} finally {
  const container = attempt('inspect', holder, '--format', '{{index .Config.Labels "servus.fixture"}}');
  if (container.status === 0 && container.stdout.trim() === id) call('rm', '-f', holder);
  if (created) {
    const inspected = JSON.parse(call('volume', 'inspect', volume))[0];
    if (inspected.Labels?.['servus.fixture'] !== id) throw new Error('Refusing to remove an unowned volume');
    call('volume', 'rm', volume);
  }
}
