import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import ssh2 from '/app/node_modules/ssh2/lib/index.js';
import { Store } from '/app/dist/server/store.js';
import { createApp } from '/app/dist/server/app.js';
import { createAgent } from '/app/dist/agent/app.js';
import { hashPassword } from '/app/dist/server/auth.js';

const dataDir=mkdtempSync(join(tmpdir(),'servus-package-parity-'));
let store,app,agent;
try{
  store=new Store(dataDir);assert.equal(store.db.pragma('user_version',{simple:true}),9);
  const actor=store.setup('fixture@example.test',await hashPassword('synthetic-package-password'));
  const session=store.createSession(actor.id),project=store.createProject('package-parity');
  app=await createApp({dataDir,store,allowedOrigins:['http://localhost:4180'],runtimeStatus:async()=>({online:false})});await app.ready();
  const headers={cookie:`panel_session=${session.token}`,'x-csrf-token':session.csrfToken,origin:'http://localhost:4180','idempotency-key':randomUUID()};
  const response=await app.inject({method:'POST',url:`/api/v1/projects/${project.id}/services`,headers,payload:{name:'private-image',image:'registry.example.com/team/app:1',port:80,domains:[],mounts:[{type:'volume',name:'data',target:'/data'}],registry:{server:'registry.example.com',username:'fixture',password:'synthetic-registry-password'}}});
  assert.equal(response.statusCode,202,response.body);const service=response.json().service;
  assert.ok(service.registry.secretRef);assert.equal(service.registry.password,undefined);assert.equal(response.body.includes('synthetic-registry-password'),false);
  const settings=await app.inject({url:`/api/v1/services/${service.id}/volume-backup-settings`,headers});assert.equal(settings.statusCode,200,settings.body);assert.equal(settings.json().settings[0].mountTarget,'/data');
  const hostKey=ssh2.utils.generateKeyPairSync('ed25519',{comment:'disposable-host'}).public;
  const source=store.createService(project.id,{name:'ssh-source',image:'panel-build:pending',hostname:'ssh.internal',port:80,domains:[],source:{type:'git',repository:'ssh://git@git.example.com/team/app.git',branch:'main',context:'.',dockerfile:'Dockerfile',ssh:{knownHosts:`git.example.com ssh-ed25519 ${hostKey.split(' ')[1]}\n`}}},actor.id).service;
  assert.match(source.source.ssh.publicKey,/^ssh-ed25519 /);assert.ok(source.source.ssh.secretRef);assert.equal(JSON.stringify(source).includes('PRIVATE KEY'),false);
  agent=await createAgent({dataDir,token:'synthetic-agent-token',socketPath:join(dataDir,'agent.sock'),dockerSocket:'/never-connect',ingressPort:18080,ingressImage:'unused'},{});await agent.ready();
  assert.equal((await agent.inject({url:'/status'})).statusCode,401);
  // Engine inspection is deliberately unavailable; readiness and schema loading are the smoke scope.
  const ssh=spawnSync('ssh',['-V'],{encoding:'utf8'});assert.equal(ssh.status,0);assert.match(ssh.stderr,/OpenSSH/);
  const compose=spawnSync('docker',['compose','version','--short'],{encoding:'utf8'});assert.equal(compose.status,0);assert.match(compose.stdout.trim(),/^v?\d+\./);
  const cli=spawnSync(process.execPath,['/app/scripts/servus.mjs','help'],{encoding:'utf8'});assert.equal(cli.status,0);
  console.log(JSON.stringify({status:'passed',schema:9,checks:['native-sqlite','packaged-esm','registry-secret-ref','ssh-key-generation','volume-api','agent-schema','openssh-client','compose-plugin','cli']}));
}finally{
  if(agent)await agent.close();if(app)await app.close();if(store?.db.open)store.close();rmSync(dataDir,{recursive:true,force:true});
}
