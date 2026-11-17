// Disposable workloads on panel-dev only. Does not restart or clean shared services.
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {ComposeRuntime} from '../../apps/panel/src/agent/compose.js';
import {parseComposeDefinition} from '../../apps/panel/src/agent/compose-configuration.js';
import type {ComposeApplyRequest} from '../../apps/panel/src/shared/compose.js';

if(process.env.SERVUS_DISPOSABLE_COMPOSE_BUILD_TEST!=='1')throw Error('Explicitly select the disposable Compose build fixture.');
const context='colima-panel-dev',socket=execFileSync('docker',['context','inspect',context,'--format','{{.Endpoints.docker.Host}}'],{encoding:'utf8'}).trim().replace('unix://','');
const root=mkdtempSync(join(tmpdir(),'servus-compose-build-e2e-')),dataDir=join(root,'data'),source=join(root,'source'),publicRoot=join(root,'http'),bare=join(publicRoot,'application.git');
for(const path of [dataDir,source,publicRoot,join(source,'app'),join(source,'deployment')])mkdirSync(path,{recursive:true,mode:0o700});
const originalConfig=process.env.DOCKER_CONFIG,originalHosts=process.env.PANEL_GIT_HTTP_HOSTS;process.env.PANEL_GIT_HTTP_HOSTS='127.0.0.1';
const dockerConfig=join(root,'docker-config');mkdirSync(dockerConfig,{mode:0o700});writeFileSync(join(dockerConfig,'config.json'),JSON.stringify({cliPluginsExtraDirs:['/opt/homebrew/lib/docker/cli-plugins']}));process.env.DOCKER_CONFIG=dockerConfig;
const runtime=new ComposeRuntime({dataDir,token:'fixture',socketPath:join(root,'agent.sock'),dockerSocket:socket,ingressPort:18080,ingressImage:'unused'}),docker=runtime.docker;
assert.equal((await docker.info()).Name,'colima-panel-dev');
const workloadId=randomUUID(),inlineId=randomUUID(),projectId=randomUUID(),runId=`compose-build-${Date.now()}-${workloadId.slice(0,8)}`,proof=`data-${randomUUID()}`,ids=[workloadId,inlineId],checks:string[]=[];
const git=(args:string[],cwd=source)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const cli=(args:string[])=>execFileSync('docker',['--host',`unix://${socket}`,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const server=createServer((request,response)=>{const path=resolve(publicRoot,'.'+new URL(request.url??'/','http://fixture').pathname);if(!path.startsWith(publicRoot+sep)){response.writeHead(404).end();return;}try{response.end(readFileSync(path));}catch{response.writeHead(404).end();}});
const yaml=(fail=false)=>`services:\n  web:\n    build:\n      context: ../app\n      dockerfile: Dockerfile\n      args: {BUILD_MESSAGE: 'literal-$HOST'}\n    volumes: ["files:/data"]\n    restart: "no"\n${fail?'    command: ["/bin/sh", "-c", "exit 7"]\n':''}volumes: {files: {}}\n`;
const dockerfile='FROM nginx:alpine\nARG BUILD_MESSAGE\nCOPY version /usr/share/nginx/html/version\nRUN printf "%s" "$BUILD_MESSAGE" > /usr/share/nginx/html/argument\n';
function commit(version:string,fail=false,invalidBuild=false){writeFileSync(join(source,'app','version'),version);writeFileSync(join(source,'app','Dockerfile'),invalidBuild?'FROM nginx:alpine\nRUN exit 13\n':dockerfile);writeFileSync(join(source,'deployment','compose.yaml'),yaml(fail));git(['add','.']);git(['-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-m',version]);const sha=git(['rev-parse','HEAD']);if(!initialClone){git(['clone','--bare',source,bare],root);initialClone=true;}else git(['--git-dir',bare,'fetch',source,'main:main'],root);git(['--git-dir',bare,'update-server-info'],root);return sha;}
let initialClone=false,request:ComposeApplyRequest|undefined;
async function running(id=workloadId){const list=await docker.listContainers({filters:{label:[`panel.workload=${id}`]}});const container=list.find(item=>item.Labels['com.docker.compose.service']==='web');assert.ok(container,'Built Compose service is running');return container;}
async function content(path:string,id=workloadId){return cli(['exec',(await running(id)).Id,'cat',path]);}
try{
  git(['init','-b','main']);writeFileSync(join(source,'host-proof'),'must-not-enter-build-context');const firstCommit=commit('version-one');
  await new Promise<void>(yes=>server.listen(0,'127.0.0.1',yes));
  request={operationId:randomUUID(),workloadId,projectId,revision:1,type:'deploy',configuration:{source:{type:'git',repository:`http://127.0.0.1:${(server.address() as {port:number}).port}/application.git`,branch:'main',path:'deployment/compose.yaml'},domains:[]}};
  await runtime.apply(request);assert.equal(await content('/usr/share/nginx/html/version'),'version-one');assert.equal(await content('/usr/share/nginx/html/argument'),'literal-$HOST');
  const firstImage=(await running()).ImageID;cli(['exec',(await running()).Id,'sh','-c',`printf '%s' '${proof}' >/data/proof`]);checks.push('real-git-dockerfile-build','relative-compose-context','explicit-literal-build-args');
  const secondCommit=commit('version-two');request={...request,operationId:randomUUID(),revision:2};await runtime.apply(request);assert.equal(await content('/usr/share/nginx/html/version'),'version-two');assert.equal(await content('/data/proof'),proof);assert.notEqual((await running()).ImageID,firstImage);checks.push('immutable-image-update','named-volume-persistence');
  const secondSnapshot=JSON.parse(runtime.vault.open((runtime.journal.prepare('SELECT snapshot FROM compose_operations WHERE id=?').get(request.operationId) as {snapshot:string}).snapshot));assert.equal(secondSnapshot.commit,secondCommit);assert.ok((await docker.getImage(secondSnapshot.images.web.tag).inspect()).RepoTags.includes(secondSnapshot.images.web.tag));
  commit('version-three',true);const failing={...request,operationId:randomUUID(),revision:3};await assert.rejects(runtime.apply(failing));assert.equal(await content('/usr/share/nginx/html/version'),'version-two');assert.equal((await running()).ImageID,secondSnapshot.images.web.id);assert.equal(await content('/data/proof'),proof);checks.push('failed-deploy-restores-prior-built-image');
  commit('version-four',false,true);await assert.rejects(runtime.apply({...request,operationId:randomUUID(),revision:4}));assert.equal(await content('/usr/share/nginx/html/version'),'version-two');checks.push('failed-build-leaves-runtime-unchanged');
  const recovered={...request,operationId:randomUUID(),revision:5};runtime.journal.prepare("INSERT INTO compose_operations(id,workload_id,project_id,type,request_hash,state,snapshot,updated_at)VALUES(?,?,?,?,?,'running',?,?)").run(recovered.operationId,workloadId,projectId,'deploy',createHash('sha256').update(JSON.stringify(recovered)).digest('hex'),runtime.vault.seal(JSON.stringify({request:recovered,definition:parseComposeDefinition(yaml(),'git'),commit:secondCommit,stage:'prepared'})),new Date().toISOString());
  await runtime.apply(recovered);assert.equal(await content('/usr/share/nginx/html/version'),'version-two');assert.equal(await content('/data/proof'),proof);checks.push('interrupted-build-fetches-recorded-commit-not-moving-head');request=recovered;
  await new Promise<void>(yes=>server.close(()=>yes()));
  for(const type of ['stop','start','restart'] as const)await runtime.apply({...request,operationId:randomUUID(),type});assert.equal(await content('/usr/share/nginx/html/version'),'version-two');assert.equal(await content('/data/proof'),proof);checks.push('lifecycle-offline-without-rebuild');
  const inlineRequest:ComposeApplyRequest={...request,operationId:randomUUID(),workloadId:inlineId,revision:1,configuration:{source:{type:'inline',yaml:'services:\n  web:\n    build:\n      dockerfile_inline: |\n        FROM nginx:alpine\n        RUN printf inline-proof > /usr/share/nginx/html/version\n'},domains:[]}};
  await runtime.apply(inlineRequest);assert.equal(await content('/usr/share/nginx/html/version',inlineId),'inline-proof');checks.push('inline-dockerfile-with-empty-private-context');
  await runtime.apply({...request,operationId:randomUUID(),type:'destroy'});await runtime.apply({...inlineRequest,operationId:randomUUID(),type:'destroy'});assert.equal((await docker.listVolumes({filters:{label:[`panel.workload=${workloadId}`]}})).Volumes?.length,1);checks.push('removal-retains-data');
  const artifact=resolve('artifacts/compose',`${runId}.json`);mkdirSync(resolve('artifacts/compose'),{recursive:true});writeFileSync(artifact,JSON.stringify({runId,context,checkedAt:new Date().toISOString(),checks,status:'passed',firstCommit,secondCommit,limits:'Public Git; relative local contexts; Dockerfile, inline Dockerfile, explicit build args and target. No private Git, additional contexts, build secrets, SSH forwarding or privileged build options.'},null,2)+'\n');console.log(`PASS Compose builds: ${checks.join(', ')}; ${artifact}`);
}finally{
  if(server.listening)await new Promise<void>(yes=>server.close(()=>yes()));
  for(const id of ids){for(const container of await docker.listContainers({all:true,filters:{label:[`panel.workload=${id}`]}})){assert.equal(container.Labels['panel.owner'],'self-hosted-panel');await docker.getContainer(container.Id).remove({force:true});}
    for(const network of await docker.listNetworks({filters:{label:[`panel.workload=${id}`]}}))await docker.getNetwork(network.Id).remove();
    for(const volume of (await docker.listVolumes({filters:{label:[`panel.workload=${id}`]}})).Volumes??[])await docker.getVolume(volume.Name).remove();
    for(const image of await docker.listImages({filters:{label:[`panel.workload=${id}`,'panel.compose-build=true']}}))await docker.getImage(image.Id).remove();}
  runtime.close();rmSync(root,{recursive:true,force:true});if(originalConfig===undefined)delete process.env.DOCKER_CONFIG;else process.env.DOCKER_CONFIG=originalConfig;if(originalHosts===undefined)delete process.env.PANEL_GIT_HTTP_HOSTS;else process.env.PANEL_GIT_HTTP_HOSTS=originalHosts;
}
