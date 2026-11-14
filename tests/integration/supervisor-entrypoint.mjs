import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, chownSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

if (process.platform !== 'linux' || process.getuid?.() !== 0 || !process.env.SERVUS_SUPERVISOR_INTEGRATION_FIXTURE) throw new Error('An isolated root Linux fixture is required');
const require = createRequire('/app/package.json');
const Database = require('better-sqlite3');
const root = mkdtempSync('/srv/servus-entrypoint-fixture-'); chmodSync(root, 0o755);
const data = join(root, 'data');
const token = randomBytes(32).toString('hex');
const secretPath = join(root, 'secret'); writeFileSync(secretPath, token, { mode: 0o640 }); chownSync(secretPath, 0, 1000);
const socketPath = join(root, 'supervisor.sock');
const children = new Set();
const channels = new Map();
const waiters = new Map();
const deadline = Date.now() + 90000;
let apiPort;
const pauseUntil = async (fn, label) => {
  while (Date.now() < deadline) { const value = await fn(); if (value) return value; await sleep(50); }
  throw new Error(`Timed out waiting for ${label}`);
};
const proof = (direction, role, client, server) => createHmac('sha256', Buffer.from(token, 'hex')).update(`servus-supervisor-${direction}-v1\0${role}\0${client}\0${server}`).digest('hex');
const peer = createServer(socket => {
  let phase = 0, buffer = '', role, client, challenge;
  socket.on('data', chunk => {
    buffer += chunk.toString();
    let boundary;
    while ((boundary = buffer.indexOf('\n')) !== -1) {
      const frame = JSON.parse(buffer.slice(0, boundary)); buffer = buffer.slice(boundary + 1);
      if (phase === 0) {
        role = frame.role; client = frame.challenge; challenge = randomBytes(32).toString('hex');
        assert(['api', 'worker', 'agent'].includes(role));
        socket.write(JSON.stringify({version:1,type:'hello_ack',role,challenge,proof:proof('server',role,client,challenge)})+'\n'); phase = 1;
      } else if (phase === 1) {
        assert.equal(frame.proof, proof('client',role,client,challenge));
        channels.set(role, socket); socket.write(JSON.stringify({version:1,type:'ready',role})+'\n'); phase = 2;
      } else {
        const wait = waiters.get(frame.requestId); if (wait) { waiters.delete(frame.requestId); wait(frame); }
      }
    }
  });
  socket.on('error', () => {});
  socket.on('close', () => { if (channels.get(role) === socket) channels.delete(role); });
});
const drain = async (role, id = randomUUID()) => {
  const socket = await pauseUntil(() => channels.get(role), `${role} control connection`);
  channels.delete(role);
  const result = new Promise(resolve => waiters.set(id, resolve));
  socket.write(JSON.stringify({version:1,type:'drain',requestId:id,timeoutMs:5000})+'\n');
  return Promise.race([result, sleep(7000).then(() => { throw new Error(`${role} drain timed out`); })]);
};
const launch = component => {
  const env = { PATH:'/usr/local/bin:/usr/bin:/bin', HOME:'/tmp', PANEL_DATA_DIR:data, PANEL_HOST:'127.0.0.1', PANEL_PORT:String(apiPort), PANEL_ALLOWED_ORIGINS:`http://127.0.0.1:${apiPort}`, PANEL_DOCKER_SOCKET:'/missing-docker.sock', PANEL_SUPERVISOR_SOCKET:socketPath, PANEL_SUPERVISOR_SECRET_FILE:secretPath };
  const child = spawn('/usr/local/bin/node', [`/app/dist/${component}/index.js`], { uid:1000, gid:1000, env, stdio:'inherit' });
  children.add(child); child.once('exit', () => children.delete(child)); return child;
};
const stop = async child => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const done = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGKILL');
  await Promise.race([done, sleep(5000).then(() => {throw new Error('Fixture child did not exit');})]);
};
try {
  await new Promise((resolve, reject) => {peer.once('error',reject);peer.listen(socketPath,resolve);}); chmodSync(socketPath,0o660);chownSync(socketPath,0,1000);
  const fs = await import('node:fs'); fs.mkdirSync(data,{mode:0o700});chownSync(data,1000,1000);
  const reservation = createServer(); await new Promise(resolve => reservation.listen(0,'127.0.0.1',resolve)); apiPort = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  let agent = launch('agent'); const api = launch('server'); let worker = launch('worker');
  await pauseUntil(async () => { try { return (await fetch(`http://127.0.0.1:${apiPort}/health`)).ok; } catch { return false; } }, 'API startup');
  await pauseUntil(() => ['api','worker','agent'].every(role => channels.has(role)), 'all authenticated control channels');
  const origin=`http://127.0.0.1:${apiPort}`;
  const setup=await fetch(`${origin}/api/v1/setup`,{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({email:'fixture@example.test',password:'fixture-password-123'})});
  assert.equal(setup.status,200);const cookie=setup.headers.get('set-cookie').split(';')[0];const csrf=(await setup.json()).csrfToken;
  const requestId = randomUUID(); const first = await drain('worker',requestId); assert.equal(first.status,'drained');
  const repeated = await drain('worker',requestId); assert.equal(repeated.status,'drained');
  const headers={origin,cookie,'x-csrf-token':csrf,'content-type':'application/json'};
  const projectResponse=await fetch(`${origin}/api/v1/projects`,{method:'POST',headers,body:JSON.stringify({name:'fixture-project'})}); assert.equal(projectResponse.status,201);
  const project=await projectResponse.json();
  const serviceResponse=await fetch(`${origin}/api/v1/projects/${project.id}/services`,{method:'POST',headers:{...headers,'idempotency-key':randomUUID()},body:JSON.stringify({name:'queued',image:'nginx:alpine',port:80,hostname:'fixture.localhost'})});
  assert.equal(serviceResponse.status,202);const created=await serviceResponse.json();
  await sleep(800);
  let action=await (await fetch(`${origin}/api/v1/actions/${created.action.id}`,{headers:{cookie}})).json(); assert.equal(action.action.status,'queued');
  await stop(worker); worker=launch('worker');
  await pauseUntil(async()=>{try {action=await (await fetch(`${origin}/api/v1/actions/${created.action.id}`,{headers:{cookie}})).json();return action.action.status!=='queued';}catch{return false;}},'worker recovery after SIGKILL');
  await pauseUntil(()=>channels.has('worker'),'restarted worker control connection');
  await stop(worker);
  const db = new Database(join(data,'agent.sqlite')); db.prepare("INSERT INTO operations(id,request_hash,state,updated_at) VALUES(?,?,'running',?)").run(randomUUID(),'x',new Date().toISOString()); db.close();
  assert.equal((await drain('agent')).status,'uncertain');
  assert.equal((await drain('api')).status,'drained');
  assert.equal((await fetch(`${origin}/api/v1/auth/session`,{headers:{cookie}})).status,503);
  const blockedWrite = await fetch(`${origin}/api/v1/projects`, {method:'POST',headers,body:JSON.stringify({name:'blocked-project'})});
  assert.equal(blockedWrite.status,503);
  assert.equal((await fetch(`${origin}/health`)).status,200);
  console.log('PASS real entrypoints, authenticated drain, reconnect, no new claims, SIGKILL recovery and agent uncertainty');
} finally {
  for (const child of [...children]) await stop(child);
  for (const socket of channels.values()) socket.destroy();
  await new Promise(resolve => peer.close(resolve));
  rmSync(root,{recursive:true,force:true});
}
