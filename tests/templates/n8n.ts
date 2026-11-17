/** Real HTTP n8n template acceptance on its exclusive disposable Docker daemon. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomBytes, randomUUID} from 'node:crypto';
import {existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {request as httpRequest} from 'node:http';
import Docker from 'dockerode';
import {parse, stringify} from 'yaml';
import {createAgent} from '../../apps/panel/src/agent/app.js';
import {createApp} from '../../apps/panel/src/server/app.js';
import {Store} from '../../apps/panel/src/server/store.js';
import {APPLICATION_TEMPLATES} from '../../apps/panel/src/shared/templates.js';
import type {ComposeAction, ComposeConfiguration} from '../../apps/panel/src/shared/compose.js';

if (process.env.SERVUS_DISPOSABLE_N8N_TEST !== '1') throw new Error('Explicitly opt in to the exclusive n8n test daemon.');
const context = 'colima-servus-n8n-e2e', ingressPort = 19580;
// Keep context discovery independent of the temporary Compose CLI configuration.
const cliEnvironment={...process.env};
const cli = (args: string[]) => execFileSync('docker', ['--context', context, ...args], {env:cliEnvironment,encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000}).trim();
const socket = cli(['context', 'inspect', context, '--format', '{{.Endpoints.docker.Host}}']).replace(/^unix:\/\//, '');
assert.match(socket, /\/\.colima\/servus-n8n-e2e\/docker\.sock$/);
const docker = new Docker({socketPath: socket});
assert.equal((await docker.info()).Name, 'colima-servus-n8n-e2e');
await until(async () => (await docker.listContainers({all: true})).length === 0 ? true : undefined, 'exclusive daemon is empty after prior task cleanup', 30_000);
assert.equal((await docker.listVolumes()).Volumes?.length ?? 0, 0, 'The exclusive daemon must contain no preexisting data.');
if((await docker.info()).Swarm.LocalNodeState==='active')assert.equal((await docker.listServices()).length,0,'The exclusive daemon must contain no preexisting Swarm services.');
assert.equal((await docker.listNetworks()).filter(network=>network.Name==='panel-ingress').length,0,'The exclusive daemon must contain no preexisting managed ingress network.');
const template = APPLICATION_TEMPLATES.find(item => item.id === 'n8n')!;
for (const image of [...template.images, 'traefik:3.7.13']) await docker.getImage(image).inspect();
const nativeVersion=cli(['run','--rm','--network','none','--entrypoint','n8n',template.images[0]!,'--version']);
assert.equal(nativeVersion,'2.48.4');
const runId = `n8n-${Date.now()}-${randomBytes(4).toString('hex')}`, hostname = `${runId}.localhost`;
const root = mkdtempSync('/tmp/sn8-'), dataDir = join(root, 'data'), dockerConfig = join(root, 'docker-config');
mkdirSync(dataDir, {mode: 0o700}); mkdirSync(dockerConfig, {mode: 0o700});
assert(existsSync('/opt/homebrew/lib/docker/cli-plugins/docker-compose'));
writeFileSync(join(dockerConfig, 'config.json'), JSON.stringify({cliPluginsExtraDirs: ['/opt/homebrew/lib/docker/cli-plugins']}), {mode: 0o600});
const oldConfig = process.env.DOCKER_CONFIG, oldLocal = process.env.PANEL_ALLOW_LOCAL_IMAGES, oldHttps = process.env.PANEL_HTTPS_ENABLED;
process.env.DOCKER_CONFIG = dockerConfig; process.env.PANEL_ALLOW_LOCAL_IMAGES = '1'; process.env.PANEL_HTTPS_ENABLED = 'false';
let store = new Store(dataDir);
const actor = store.setup('fixture@example.test', 'fixture-session-only'), project = store.createProject(runId);
const auth = store.createSession(actor.id), headers = {cookie: `panel_session=${auth.token}`, 'x-csrf-token': auth.csrfToken};
const config = {dataDir, token: randomBytes(32).toString('hex'), socketPath: join(root, 'agent.sock'), dockerSocket: socket, ingressPort, ingressImage: 'traefik:3.7.13'};
let agent: Awaited<ReturnType<typeof createAgent>> | undefined, app: Awaited<ReturnType<typeof createApp>> | undefined, apiUrl = '', workloadId = '', phase = 'setup', succeeded = false;
const checks: string[] = [], artifacts = resolve('artifacts/templates'), artifact = join(artifacts, `${runId}.json`), cookieJar = new Map<string, string>();
const adminPassword = `Servus!${randomBytes(24).toString('base64url')}a9`, ownerEmail='owner@example.test';
const credentialSecret=randomBytes(32).toString('hex'), workflowName=`Servus local inactive ${runId}`;
let workflowId='',credentialId='';
let ownedIngressId='',ownedIngressNetworkId='';
const volumes: string[] = [];
const mark = (check: string) => {checks.push(check); console.log(`PASS ${check}`);};
async function until<T>(read: () => Promise<T | undefined>, label: string, milliseconds = 120_000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {const result = await read(); if (result !== undefined) return result; await new Promise(resolve => setTimeout(resolve, 500));}
  throw new Error(`Timed out during ${label}`);
}
async function open() {
  agent = await createAgent(config); await agent.listen({path: config.socketPath});
  app = await createApp({dataDir, store, agentConnection: {socketPath: config.socketPath, token: config.token}});
  apiUrl = await app.listen({host: '127.0.0.1', port: 0});
}
async function close() {await app?.close(); app = undefined; await agent?.close(); agent = undefined;}
async function api(path: string, method = 'GET', body?: unknown) {
  const response = await fetch(apiUrl + '/api/v1' + path, {method, headers: {...headers, 'idempotency-key': randomUUID(), ...(body === undefined ? {} : {'content-type': 'application/json'})}, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(310_000)});
  const value = await response.json() as any;
  assert(response.ok, `API ${method} ${path} returned ${response.status}: ${store.vault.redact(value.error?.message ?? 'request failed')}`);
  return value;
}
async function action(value: {action?: ComposeAction} | ComposeAction) {
  const queued = 'action' in value ? value.action! : value as ComposeAction;
  await until(async () => {
    const current = (await api(`/compose/${workloadId}/actions`) as ComposeAction[]).find(item => item.id === queued.id);
    assert(current, 'The queued Compose action is durable.');
    if (current.status === 'failed') throw new Error(`Compose action failed: ${store.vault.redact(current.error ?? 'unknown failure')}`);
    return current.status === 'succeeded' ? current : undefined;
  }, 'Compose action', 300_000);
}
async function website(path: string, options: RequestInit = {}, authenticated = false) {
  assert(path.startsWith('/') && !path.startsWith('//'));
  // Node's fetch filters the Host override. Use a bounded HTTP request to test
  // the real hostname route without changing local or public DNS.
  const response = await new Promise<Response>((resolvePromise, reject) => {
    const request = httpRequest({host: '127.0.0.1', port: ingressPort, path, method: options.method ?? 'GET', headers: {host: hostname,'accept-encoding':'identity',
      ...(authenticated ? {cookie: [...cookieJar].map(([key, value]) => `${key}=${value}`).join('; ')} : {}), ...options.headers}}, incoming => {
      const chunks: Buffer[] = []; let size = 0;
      incoming.on('data', (chunk: Buffer) => {size += chunk.length; if (size > 2 * 1024 * 1024) request.destroy(new Error('Fixture response exceeds its bound')); else chunks.push(chunk);});
      incoming.on('error', reject);
      incoming.on('end', () => {
        const responseHeaders = new Headers();
        for (let index = 0; index < incoming.rawHeaders.length; index += 2) responseHeaders.append(incoming.rawHeaders[index]!, incoming.rawHeaders[index + 1]!);
        resolvePromise(new Response(Buffer.concat(chunks), {status: incoming.statusCode, headers: responseHeaders}));
      });
    });
    request.on('error', reject); request.setTimeout(20_000, () => request.destroy(new Error('Fixture HTTP deadline exceeded')));
    const body = options.body;
    assert(body === undefined || typeof body === 'string' || Buffer.isBuffer(body) || body instanceof URLSearchParams);
    request.end(body instanceof URLSearchParams ? body.toString() : body);
  });
  for (const cookie of response.headers.getSetCookie()) {const pair = cookie.split(';', 1)[0]!, separator = pair.indexOf('='); cookieJar.set(pair.slice(0, separator), pair.slice(separator + 1));}
  return response;
}
async function native(path:string,method='GET',body?:unknown,authenticated=true) {
  const response=await website('/rest'+path,{method,headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)},authenticated);
  assert(response.ok,`Native n8n ${method} ${path} returned ${response.status}`);
  return (await response.json() as any).data;
}
async function verifyData() {
  await until(async()=>{try {return await native('/settings','GET',undefined,false)?true:undefined;}catch{return undefined;}},'n8n REST readiness');
  const workflow=await native(`/workflows/${workflowId}`);
  assert.equal(workflow.name,workflowName);assert.equal(workflow.active,false);
  assert.equal(workflow.nodes[0].type,'n8n-nodes-base.manualTrigger');
  const credentials=await native('/credentials');
  assert(credentials.some((item:any)=>item.id===credentialId&&item.type==='httpHeaderAuth'));
}
try {
  await open();phase='template-api-create';
  const catalog=await api('/templates');assert.deepEqual(catalog.templates.find((item:any)=>item.id==='n8n').images,template.images);
  const created=await api(`/projects/${project.id}/templates/n8n`,'POST',{name:'n8n-local',hostname});
  workloadId=created.workload.id;await action(created);mark('real-template-http-api-to-agent-compose-deployment');
  const ingress=await docker.getService('panel-ingress').inspect(),ingressNetwork=await docker.getNetwork('panel-ingress').inspect();
  assert.equal(ingress.Spec.Labels?.['panel.owner'],'self-hosted-panel');assert.equal(ingressNetwork.Labels?.['panel.owner'],'self-hosted-panel');ownedIngressId=ingress.ID;ownedIngressNetworkId=ingressNetwork.Id;
  const initial=(await docker.listContainers({filters:{label:[`panel.workload=${workloadId}`]}}))[0]!;
  assert(initial);const initialInspection=await docker.getContainer(initial.Id).inspect();assert.equal(initialInspection.HostConfig.Memory,1024**3);assert(Object.values(initialInspection.NetworkSettings.Ports).every(value=>value===null||value.length===0));
  for(const volume of (await docker.listVolumes({filters:{label:[`panel.workload=${workloadId}`]}})).Volumes??[]){assert.equal(volume.Labels?.['panel.owner'],'self-hosted-panel');volumes.push(volume.Name);}
  assert.equal(volumes.length,1);mark('owned-data-volume-and-no-direct-host-ports');
  phase='native-owner-setup';
  await until(async()=>{try{return await native('/settings','GET',undefined,false)?true:undefined;}catch{return undefined;}},'n8n initial REST readiness');
  const setupPage=await website('/setup');assert.equal(setupPage.status,200);assert.match(setupPage.headers.get('content-type')??'',/text\/html/);
  const owner=await native('/owner/setup','POST',{email:ownerEmail,firstName:'Servus',lastName:'Fixture',password:adminPassword},false);assert.equal(owner.email,ownerEmail);assert(cookieJar.size>0);
  cookieJar.clear();const login=await native('/login','POST',{emailOrLdapLoginId:ownerEmail,password:adminPassword},false);assert.equal(login.email,ownerEmail);mark('native-owner-setup-and-password-cookie-login');
  const denied=await website('/rest/workflows',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'Denied'})},false);assert.equal(denied.status,401);mark('unauthenticated-workflow-write-denied');
  phase='native-local-content';
  const workflow=await native('/workflows','POST',{name:workflowName,nodes:[{id:randomUUID(),name:'Manual local trigger',type:'n8n-nodes-base.manualTrigger',typeVersion:1,position:[0,0],parameters:{}}],connections:{},settings:{executionOrder:'v1'},active:false});workflowId=workflow.id;assert(workflowId);
  const credential=await native('/credentials','POST',{name:`Local fake ${runId}`,type:'httpHeaderAuth',data:{name:'X-Servus-Local-Proof',value:credentialSecret}});credentialId=credential.id;assert(credentialId);
  await verifyData();mark('inactive-manual-workflow-and-fake-header-credential-created-through-native-api');
  phase='redeploy-update-restart';
  await action(await api(`/compose/${workloadId}/deploy`,'POST',{}));await verifyData();mark('repeat-deploy-preserves-native-content');
  const configuration=await api(`/compose/${workloadId}/configuration`) as ComposeConfiguration;assert(configuration.source.type==='inline');
  const document=parse(configuration.source.yaml);assert(document.services.app.environment.N8N_ENCRYPTION_KEY);
  Object.assign(document.services.app.environment,{SERVUS_FIXTURE_REVISION:runId,N8N_DIAGNOSTICS_ENABLED:'false',N8N_VERSION_NOTIFICATIONS_ENABLED:'false',N8N_TEMPLATES_ENABLED:'false'});
  const updated=await api(`/compose/${workloadId}`,'PATCH',{...configuration,expectedRevision:1,source:{type:'inline',yaml:stringify(document)}});assert.equal(updated.revision,2);
  await action(await api(`/compose/${workloadId}/deploy`,'POST',{}));await verifyData();
  const replacement=(await docker.listContainers({filters:{label:[`panel.workload=${workloadId}`]}}))[0]!;assert.notEqual(replacement.Id,initial.Id);mark('configuration-update-replaces-container-and-preserves-content');
  await action(await api(`/compose/${workloadId}/restart`,'POST',{}));await verifyData();mark('application-restart-preserves-login-workflow-and-credential');
  phase='control-plane-restart';await close();store.close();store=new Store(dataDir);await open();await verifyData();assert.equal((await api(`/compose/${workloadId}`)).deployedRevision,2);mark('control-plane-restart-preserves-session-and-native-content');
  // Inspect a quiescent, retained database without exporting plaintext credentials.
  phase='destroy-retain';await action(await api(`/compose/${workloadId}/destroy`,'POST',{confirm:true}));
  assert.equal((await docker.listContainers({all:true,filters:{label:[`panel.workload=${workloadId}`]}})).length,0);
  assert.equal((await docker.getVolume(volumes[0]!).inspect()).Labels?.['panel.workload'],workloadId);
  const inspected=cli(['run','--rm','--network','none','--read-only','--label',`servus.n8n.test=${runId}`,'--volume',`${volumes[0]}:/retained:ro`,'--entrypoint','node',template.images[0]!,'--input-type=module','-e',`import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync('/retained/database.sqlite',{readOnly:true});const workflow=db.prepare('SELECT name,active,nodes FROM workflow_entity WHERE id=?').get(${JSON.stringify(workflowId)});const credential=db.prepare('SELECT data FROM credentials_entity WHERE id=?').get(${JSON.stringify(credentialId)});console.log(JSON.stringify({workflow,encrypted:credential?.data}));db.close();`]);
  const retained=JSON.parse(inspected);assert.equal(retained.workflow.name,workflowName);assert.equal(retained.workflow.active,0);assert(JSON.parse(retained.workflow.nodes).some((node:any)=>node.type==='n8n-nodes-base.manualTrigger'));assert.equal(typeof retained.encrypted,'string');assert(retained.encrypted.length>50);assert(!retained.encrypted.includes(credentialSecret));
  mark('api-destroy-retains-real-workflow-and-encrypted-credential-in-offline-database');
  // The supported offline CLI decrypts only the generated fake credential. Plaintext
  // stays in the disposable container's tmpfs and never enters evidence or stdout.
  const proofEnvironment=join(root,'offline-proof.env');
  writeFileSync(proofEnvironment,`N8N_ENCRYPTION_KEY=${document.services.app.environment.N8N_ENCRYPTION_KEY}\nN8N_DIAGNOSTICS_ENABLED=false\nN8N_VERSION_NOTIFICATIONS_ENABLED=false\nN8N_TEMPLATES_ENABLED=false\nSERVUS_CREDENTIAL_ID=${credentialId}\nSERVUS_FIXTURE_SECRET=${credentialSecret}\n`,{mode:0o600});
  const recovered=cli(['run','--rm','--network','none','--read-only','--tmpfs','/tmp:rw,nosuid,nodev,size=32m,mode=1777','--label',`servus.n8n.test=${runId}`,'--env-file',proofEnvironment,'--volume',`${volumes[0]}:/home/node/.n8n`,'--entrypoint','sh',template.images[0]!,'-c',`n8n export:credentials --id="$SERVUS_CREDENTIAL_ID" --decrypted --output=/tmp/fake-credential.json >/tmp/export.log 2>&1 && node -e 'const fs=require("node:fs");const values=JSON.parse(fs.readFileSync("/tmp/fake-credential.json","utf8"));if(values.length!==1||values[0].data.value!==process.env.SERVUS_FIXTURE_SECRET)process.exit(1);console.log("credential-decryption-verified");'`]);
  assert.equal(recovered,'credential-decryption-verified');mark('fresh-offline-container-decrypts-retained-fake-credential-with-original-encryption-key');succeeded=true;
 } finally {
  let cleanupError:unknown;
  let images: {reference:string;id:string;digests:string[]}[]=[];
  try {
    await close();
    images=await Promise.all(template.images.map(async reference=>{const image=await docker.getImage(reference).inspect();return {reference,id:image.Id,digests:image.RepoDigests??[]};}));
    if(workloadId) {
      for(const container of await docker.listContainers({all:true,filters:{label:[`panel.workload=${workloadId}`]}})){assert.equal(container.Labels['panel.owner'],'self-hosted-panel');await docker.getContainer(container.Id).remove({force:true});}
      for(const network of await docker.listNetworks({filters:{label:[`panel.workload=${workloadId}`]}})){assert.equal(network.Labels?.['panel.owner'],'self-hosted-panel');await docker.getNetwork(network.Id).remove();}
      for(const volume of (await docker.listVolumes({filters:{label:[`panel.workload=${workloadId}`]}})).Volumes??[]){assert.equal(volume.Labels?.['panel.owner'],'self-hosted-panel');await docker.getVolume(volume.Name).remove();}
    }
    if(ownedIngressId){const service=await docker.getService(ownedIngressId).inspect();assert.equal(service.Spec.Name,'panel-ingress');assert.equal(service.Spec.Labels?.['panel.owner'],'self-hosted-panel');await docker.getService(ownedIngressId).remove();}
    if(ownedIngressNetworkId)await until(async()=>{try{const network=await docker.getNetwork(ownedIngressNetworkId).inspect();assert.equal(network.Name,'panel-ingress');assert.equal(network.Labels?.['panel.owner'],'self-hosted-panel');await docker.getNetwork(ownedIngressNetworkId).remove();return true;}catch(error){if((error as {statusCode?:number}).statusCode===404)return true;return undefined;}},'exclusive ingress cleanup');
    await until(async()=>(await docker.listContainers({all:true})).length===0?true:undefined,'exclusive daemon asynchronous task cleanup',30_000);
    assert.equal((await docker.listVolumes()).Volumes?.length??0,0,'Exclusive daemon volume cleanup');
    assert.equal((await docker.listServices()).length,0,'Exclusive daemon service cleanup');
    assert.equal((await docker.listNetworks()).filter(network=>network.Name==='panel-ingress').length,0,'Exclusive ingress network cleanup');
  } catch(error) { cleanupError=error; }
  finally {
    try{store.close();rmSync(root,{recursive:true,force:true});}catch(error){cleanupError??=error;}
    if(oldConfig===undefined)delete process.env.DOCKER_CONFIG;else process.env.DOCKER_CONFIG=oldConfig;
    if(oldLocal===undefined)delete process.env.PANEL_ALLOW_LOCAL_IMAGES;else process.env.PANEL_ALLOW_LOCAL_IMAGES=oldLocal;
    if(oldHttps===undefined)delete process.env.PANEL_HTTPS_ENABLED;else process.env.PANEL_HTTPS_ENABLED=oldHttps;
    mkdirSync(artifacts,{recursive:true});writeFileSync(artifact,JSON.stringify({runId,context,checkedAt:new Date().toISOString(),status:succeeded&&!cleanupError?'passed':'failed',phase,runtimeStatus:succeeded?'passed':'failed',cleanupStatus:cleanupError?'failed':'passed',templateVersion:template.version,nativeVersion,images,checks,workflowId,credentialId,limits:'Exclusive local Docker VM; HTTP native owner/password session. Workflow stayed inactive and credentials used only fake local data. No external integration execution, email, license activation, version upgrade or VM reboot tested. Initial stock template settings apply; diagnostics disabled in configuration update. Supported offline CLI verifies decryption only for the fake test credential.'},null,2)+'\n');
  }
  console.log(`${succeeded&&!cleanupError?'PASS':'FAIL'} n8n template evidence: ${artifact}`);
  if(cleanupError)throw new Error('The exclusive n8n fixture cleanup failed; inspect owned resources before rerunning.');
}
