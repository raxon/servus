import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';

const profile = process.env.SERVUS_BACKUP_E2E_PROFILE;
const image = process.env.SERVUS_BACKUP_E2E_IMAGE;
const utility = process.env.SERVUS_BACKUP_E2E_UTILITY;
if (!profile || !/^servus-backup-e2e-[a-f0-9]{16}$/.test(profile) ||
    !image || !/^servus-backup-e2e:[a-f0-9]{16}$/.test(image) || utility !== `${image}-utility`) {
  throw new Error('An explicitly named disposable fixture profile and images are required');
}
const context = `colima-${profile}`;
const socket = join(homedir(), '.colima', profile, 'docker.sock');
const suffix = profile.slice(-16);
const source = `servus-backup-source-${suffix}`, staging = `servus-backup-staging-${suffix}`, restored = `servus-backup-restored-${suffix}`;
const names = { agent: `servus-backup-agent-${suffix}`, api: `servus-backup-api-${suffix}`, worker: `servus-backup-worker-${suffix}` };
const password = `fixture-${randomBytes(24).toString('hex')}`, dbPassword = `fixture-${randomBytes(24).toString('hex')}`;
const email = 'fixture@example.test', marker = `marker_${randomBytes(12).toString('hex')}`;
function assertSecretMatches(actual:unknown, expected:string) {
  if (typeof actual !== 'string' || actual !== expected) throw new Error('Database credential does not match');
}
try {
  assertSecretMatches('synthetic-mismatch-a', 'synthetic-mismatch-b');
  throw new Error('Credential mismatch was accepted');
} catch (error) {
  assert(error instanceof Error && error.message === 'Database credential does not match');
  assert(!error.stack?.includes('synthetic-mismatch-a') && !error.stack?.includes('synthetic-mismatch-b'));
}
const cli = (...args:string[]) => execFileSync('docker', ['--context', context, ...args], { encoding:'utf8', stdio:['ignore','pipe','pipe'], timeout:120_000 }).trim();
const deadline = Date.now() + 600_000;
const wait = async <T>(description:string, fn:()=>Promise<T|undefined>):Promise<T> => {
  while(Date.now()<deadline) { const value=await fn(); if(value!==undefined)return value; await sleep(500); }
  throw new Error(`Timed out waiting for ${description}`);
};
const freePort = () => new Promise<number>((resolve,reject)=>{
  const server=createServer().listen(0,'127.0.0.1',()=>{const address=server.address();if(!address||typeof address==='string')return reject(new Error('No port'));server.close(()=>resolve(address.port));});
  server.on('error',reject);
});
let origin='', cookie='', csrf='';
async function api(path:string, method='GET', body?:unknown, key?:string):Promise<any> {
  const headers:Record<string,string>={origin,accept:'application/json'};
  if(cookie)headers.cookie=cookie;if(csrf)headers['x-csrf-token']=csrf;
  if(body!==undefined)headers['content-type']='application/json';if(key)headers['idempotency-key']=key;
  const response=await fetch(`${origin}/api/v1${path}`,{method,headers,body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(10_000)});
  const setCookie=response.headers.get('set-cookie');if(setCookie)cookie=setCookie.split(';')[0]!;
  if(!response.ok)throw new Error(`API ${method} ${path} returned ${response.status}`);
  return response.json();
}
async function action(id:string) {
  return wait('action',async()=>{const item=(await api(`/actions/${id}`)).action;if(item.status==='failed'||item.status==='cancelled')throw new Error('Fixture deployment failed');return item.status==='succeeded'?item:undefined;});
}
function start(kind:'agent'|'api'|'worker', volume:string, port:number, group:string) {
  const args=['run','-d','--name',names[kind],'--label',`servus.fixture=${suffix}`,'--mount',`type=volume,source=${volume},target=/var/lib/servus`,'-e','PANEL_DATA_DIR=/var/lib/servus','-e',`PANEL_ALLOWED_ORIGINS=${origin}`,'-e','PANEL_HOST=0.0.0.0','-e','PANEL_PORT=4180'];
  if(kind==='api')args.push('-p',`127.0.0.1:${port}:4180`);
  if(kind==='agent')args.push('--group-add',group,'--mount','type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock');
  args.push('--entrypoint','node',image,kind==='api'?'dist/server/index.js':`dist/${kind}/index.js`);
  const id=cli(...args);assert.match(id,/^[a-f0-9]{64}$/);return id;
}
function stopFixture() {for(const kind of ['worker','api','agent'] as const){const item=JSON.parse(cli('inspect',names[kind]))[0];assert.equal(item.Config?.Labels?.['servus.fixture'],suffix);cli('stop','--time','30',item.Id);cli('rm',item.Id);}}
async function ready() {return wait('API',async()=>{for(const name of Object.values(names)){const state=JSON.parse(cli('inspect',name))[0].State;if(!state.Running)throw new Error(`Fixture container ${name} stopped with exit code ${state.ExitCode}`);}try{return (await fetch(`${origin}/health`,{signal:AbortSignal.timeout(1000)})).ok?true:undefined;}catch{return undefined;}});}
async function container(service:string) {return wait('MariaDB container',async()=>{const ids=cli('ps','-q','--filter',`label=com.docker.swarm.service.name=${service}`).split('\n').filter(Boolean);return ids.length===1?ids[0]:undefined;});}
function db(containerId:string, user:'app'|'root', sql:string) {
  const secret=user==='app'?'panel-db-password':'panel-db-root-password';
  return cli('exec',containerId,'/bin/sh','-c',`MYSQL_PWD="$(cat /run/secrets/${secret})" mariadb --no-defaults --protocol=tcp --host=127.0.0.1 --user=${user} --batch --skip-column-names -e "${sql}"`);
}

try {
  const info=JSON.parse(cli('context','inspect',context))[0];assert.equal(info.Endpoints?.docker?.Host,`unix://${socket}`);
  const daemon=JSON.parse(cli('info','--format','{{json .}}'));assert.equal(daemon.Name,context);assert.equal(daemon.Swarm.LocalNodeState,'active');assert.equal(daemon.Swarm.Nodes,1);assert.equal(daemon.Swarm.ControlAvailable,true);
  for(const args of [['service','ls','-q'],['ps','-aq'],['volume','ls','-q'],['secret','ls','-q'],['config','ls','-q']])assert.equal(cli(...args),'','The disposable Swarm must be empty');
  assert.deepEqual(cli('network','ls','--format','{{.Name}}').split('\n').sort(),['bridge','docker_gwbridge','host','ingress','none']);
  for(const volume of [source,staging,restored])cli('volume','create','--label',`servus.fixture=${suffix}`,volume);
  cli('run','--rm','--user','0','--network','none','--mount',`type=volume,source=${source},target=/data`,'--entrypoint','sh',image,'-c','chown 1000:1000 /data && chmod 700 /data');
  cli('run','--rm','--user','0','--network','none','--mount',`type=volume,source=${staging},target=/data`,'--entrypoint','sh',image,'-c','chown 0:0 /data && chmod 700 /data');
  const group=cli('run','--rm','--user','0','--mount','type=bind,source=/var/run/docker.sock,target=/sock','--entrypoint','stat',image,'-c','%g','/sock');assert.match(group,/^\d+$/);
  const port=await freePort();origin=`http://127.0.0.1:${port}`;
  start('agent',source,port,group);start('api',source,port,group);start('worker',source,port,group);await ready();
  await api('/setup','POST',{email,password});cookie='';csrf='';const login=await api('/auth/login','POST',{email,password});csrf=login.csrfToken;assert(cookie&&csrf);
  const project=await api('/projects','POST',{name:`fixture-${suffix}`});
  const created=await api(`/projects/${project.id}/services`,'POST',{name:'database',kind:'mariadb',replicas:1,database:{database:'app',user:'app',password:dbPassword},resources:{cpu:0.5,memoryMb:256}},randomUUID());
  const serviceId:string=created.service.id;await action(created.action.id);const serviceName=`panel-app-${serviceId}`;
  let dbContainer=await container(serviceName);
  assert.equal(db(dbContainer,'app',`CREATE TABLE app.marker(value text); INSERT INTO app.marker VALUES ('${marker}'); SELECT value FROM app.marker;`).split('\n').at(-1),marker);
  assert.equal(db(dbContainer,'root','SELECT 1;'),'1');
  const before=JSON.parse(cli('service','inspect',serviceName))[0].Spec.TaskTemplate.ContainerSpec.Secrets;
  const rootSecret=before.find((item:any)=>item.File?.Name==='panel-db-root-password')?.SecretID;assert(rootSecret);
  stopFixture();assert.equal(cli('ps','-q','--filter',`volume=${source}`),'','Control-plane source still has a running writer');
  console.log('PASS isolated MariaDB deployment and synthetic data');
  cli('run','--rm','--user','0','--network','none','--cgroupns=host','--memory','1200m','--mount',`type=volume,source=${source},target=/fixture-source`,'--mount',`type=volume,source=${staging},target=/fixture-staging`,'--entrypoint','/usr/local/bin/python3.12',utility,'-I','/fixture/capture.py');
  cli('run','--rm','--user','0','--network','none','--mount',`type=volume,source=${staging},target=/from,readonly`,'--mount',`type=volume,source=${restored},target=/to`,'--entrypoint','sh',image,'-c','cp -a /from/. /to/ && chown -R 1000:1000 /to && chmod 700 /to');
  start('agent',restored,port,group);start('api',restored,port,group);start('worker',restored,port,group);cookie='';csrf='';await ready();
  const restoredLogin=await api('/auth/login','POST',{email,password});csrf=restoredLogin.csrfToken;assert(cookie&&csrf);
  const reveal=await api(`/services/${serviceId}/connection/reveal`,'POST',{});assertSecretMatches(reveal.password,dbPassword);
  const deployed=await api(`/services/${serviceId}/deploy`,'POST',{},randomUUID());await action(deployed.id);
  dbContainer=await container(serviceName);assert.equal(db(dbContainer,'app','SELECT value FROM app.marker;'),marker);assert.equal(db(dbContainer,'root','SELECT 1;'),'1');
  const after=JSON.parse(cli('service','inspect',serviceName))[0].Spec.TaskTemplate.ContainerSpec.Secrets;
  assert.equal(after.find((item:any)=>item.File?.Name==='panel-db-root-password')?.SecretID,rootSecret);
  console.log('PASS restored login, secret reference, MariaDB root auth and retained data after redeploy');
} finally {
  for(const name of Object.values(names)) {try {const item=JSON.parse(cli('inspect',name))[0];if(item.Config?.Labels?.['servus.fixture']===suffix)cli('rm','-f',item.Id);}catch {}}
}
