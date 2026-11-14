import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { request } from 'node:http';
import type { Action, ActionDetail, Project, Service, SessionResponse } from '../apps/panel/src/shared/types.js';

const base = process.env.PANEL_URL || 'http://localhost:4180';
const dataDir = resolve(process.env.PANEL_DATA_DIR || '.data');
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const credentialsPath = resolve(dataDir, 'local-credentials.json');
let credentials: { email: string; password: string };
let cookie = '';
let csrf = '';

function routeProbe(): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ hostname:'127.0.0.1', port:Number(process.env.PANEL_INGRESS_PORT||18080), path:'/', headers:{host:'welcome.localhost'}, timeout:5000 }, res => {
      let text='';res.setEncoding('utf8');res.on('data',part=>text+=part);
      res.on('end',()=>resolve({status:res.statusCode||0,text}));
    });
    req.on('error',reject);req.on('timeout',()=>req.destroy(new Error('Route probe timed out.')));req.end();
  });
}

async function api<T>(path: string, body?: unknown, method = 'POST', extra: Record<string,string> = {}): Promise<T> {
  const response = await fetch(`${base}/api/v1${path}`, { method: body === undefined ? 'GET' : method,
    headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf, ...extra },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json() as T & {error?:{message:string}};
  const newCookie = response.headers.get('set-cookie');
  if (newCookie) cookie = newCookie.split(';')[0]!;
  if (!response.ok) throw Object.assign(new Error(data.error?.message || `HTTP ${response.status}`), {status: response.status});
  return data;
}

const setup = await api<{required:boolean}>('/setup');
if (setup.required) {
  credentials = { email: 'admin@localhost.test', password: randomBytes(24).toString('base64url') };
  const session = await api<SessionResponse>('/setup', credentials);
  csrf = session.csrfToken;
  writeFileSync(credentialsPath, JSON.stringify({ url: base, ...credentials },null,2)+'\n', {mode:0o600});
} else {
  assert(existsSync(credentialsPath), 'Complete setup credentials are required for the local smoke test.');
  credentials = JSON.parse(readFileSync(credentialsPath,'utf8')) as typeof credentials;
  const session = await api<SessionResponse>('/auth/login', credentials);
  csrf = session.csrfToken;
}

const projects = await api<Project[]>('/projects');
let project = projects.find(item => item.name === 'getting-started');
if (!project) project = await api<Project>('/projects', {name:'getting-started',description:'A real web service deployed on the local Docker Engine.'});
const services = await api<Service[]>(`/projects/${project.id}/services`);
let service = services.find(item=>item.name==='welcome');
let initialAction: Action | undefined;
if (!service) {
  const key = randomUUID();
  const input = {name:'welcome',image:'nginx:alpine',port:80,hostname:'welcome.localhost',replicas:1};
  const created = await api<{service:Service;action:Action}>(`/projects/${project.id}/services`,input,'POST',{'idempotency-key':key});
  const repeated = await api<{service:Service;action:Action}>(`/projects/${project.id}/services`,input,'POST',{'idempotency-key':key});
  assert.equal(created.service.id,repeated.service.id);
  assert.equal(created.action.id,repeated.action.id);
  service=created.service;initialAction=created.action;
}
async function waitAction(action: Action, expected: 'succeeded'|'failed'='succeeded') {
  for (let i=0;i<240;i++) {
    const detail=await api<ActionDetail>(`/actions/${action.id}`);
    if(['succeeded','failed','cancelled'].includes(detail.action.status)) {
      assert.equal(detail.action.status,expected,detail.action.error || detail.events.at(-1)?.message || 'Unexpected action outcome');
      return detail;
    }
    await delay(1000);
  }
  throw new Error(`Action ${action.id} did not finish.`);
}
async function action(type:string) {
  return api<Action>(`/services/${service!.id}/${type}`,{},'POST',{'idempotency-key':randomUUID()});
}
if(initialAction)await waitAction(initialAction);
else {
  const pending=(await api<Action[]>(`/services/${service.id}/actions`)).find(item=>['queued','running'].includes(item.status));
  if(pending)await waitAction(pending);
}
service=await api<Service>(`/services/${service.id}`);
if(service.state!=='running')await waitAction(await action('deploy'));
const firstProbe = await routeProbe();
assert.equal(firstProbe.status,200);
assert.match(firstProbe.text,/Welcome to nginx/);
console.log('PASS: setup/login, durable project, idempotent create and real routed Nginx.');

await waitAction(await action('stop'));
assert.equal((await api<Service>(`/services/${service.id}`)).state,'stopped');
await waitAction(await action('start'));
await waitAction(await action('restart'));
console.log('PASS: stop, start and restart.');

service=await api<Service>(`/services/${service.id}`);
const originalRevision=service.deployedRevision;
const changed=await api<Service>(`/services/${service.id}`,{expectedRevision:service.revision,port:9},'PATCH');
assert.equal(changed.deployedRevision,originalRevision);
try {
  await api(`/services/${service.id}`,{expectedRevision:service.revision,port:80},'PATCH');
  throw new Error('Stale revision accepted.');
} catch(error) { assert.equal((error as {status:number}).status,409); }
const failed=await waitAction(await action('deploy'),'failed');
const preserved=await api<Service>(`/services/${service.id}`);
assert.equal(preserved.deployedRevision,originalRevision);
const fallback=await routeProbe();
assert.equal(fallback.status,200);
const fixed=await api<Service>(`/services/${service.id}`,{expectedRevision:preserved.revision,port:80},'PATCH');
await waitAction(await action('deploy'));
assert.equal((await api<Service>(`/services/${service.id}`)).deployedRevision,fixed.revision);
console.log('PASS: saved vs deployed revision, stale edit rejected, failed routing and previous deployment recovery.');
const report={checkedAt:new Date().toISOString(),projectId:project.id,serviceId:service.id,checks:['setup/login','idempotent-create','real-nginx-http','stop','start','restart','revision-conflict','failed-update','previous-runtime-restored','redeploy'],failedActionId:failed.action.id};
writeFileSync(resolve(dataDir,'smoke-result.json'),JSON.stringify(report,null,2)+'\n');
console.log('Local runtime verification recorded. Credentials remain in .data/local-credentials.json.');
