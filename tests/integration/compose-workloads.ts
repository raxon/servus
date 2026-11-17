import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { ComposeRuntime } from '../../apps/panel/src/agent/compose.js';
import { DockerRuntime } from '../../apps/panel/src/agent/runtime.js';
import type { ComposeApplyRequest } from '../../apps/panel/src/shared/compose.js';

const context='colima-panel-dev',socket=execFileSync('docker',['context','inspect',context,'--format','{{.Endpoints.docker.Host}}'],{encoding:'utf8'}).trim().replace('unix://','');
const root=mkdtempSync(join(tmpdir(),'servus-compose-test-')),dataDir=join(root,'data'),dockerConfig=join(root,'docker-config');mkdirSync(dataDir,{mode:0o700});mkdirSync(dockerConfig,{mode:0o700});
if(existsSync('/opt/homebrew/lib/docker/cli-plugins/docker-compose'))writeFileSync(join(dockerConfig,'config.json'),JSON.stringify({cliPluginsExtraDirs:['/opt/homebrew/lib/docker/cli-plugins']}),{mode:0o600});
const previousConfig=process.env.DOCKER_CONFIG,previousHosts=process.env.PANEL_GIT_HTTP_HOSTS;process.env.DOCKER_CONFIG=dockerConfig;process.env.PANEL_GIT_HTTP_HOSTS='127.0.0.1';
const workloadId=randomUUID(),projectId=randomUUID(),runId=`compose-${Date.now()}-${workloadId.slice(0,8)}`,hostname=`${runId}.localhost`;
const config={dataDir,token:'fixture',socketPath:join(root,'agent.sock'),dockerSocket:socket,ingressPort:18080,ingressImage:'traefik:3.7.13'};
const runtime=new ComposeRuntime(config),docker=runtime.docker,checks:string[]=[];
const yaml='services:\n  web:\n    image: nginx:alpine\n    volumes: ["content:/usr/share/nginx/html"]\n    environment: {MODE: "v1", LITERAL: "$HOME"}\n  worker:\n    image: alpine:3.21\n    command: ["sleep", "3600"]\nvolumes: {content: {}}\n';
let request:ComposeApplyRequest={operationId:randomUUID(),workloadId,projectId,type:'deploy',revision:1,configuration:{source:{type:'inline',yaml},domains:[{hostname,service:'web',port:80,https:false}]}};
const run=(args:string[])=>execFileSync('docker',['--host',`unix://${socket}`,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const probe=()=>new Promise<{status:number;text:string}>((resolvePromise,reject)=>{const req=httpRequest({hostname:'127.0.0.1',port:18080,path:'/proof',headers:{host:hostname},timeout:2000},res=>{let text='';res.on('data',chunk=>text+=chunk);res.once('end',()=>resolvePromise({status:res.statusCode??0,text}));});req.once('error',reject);req.once('timeout',()=>req.destroy(new Error('Probe timed out')));req.end();});
const server=createServer((req,res)=>{const path=resolve(join(root,'http'),'.'+new URL(req.url??'/','http://fixture').pathname);if(!path.startsWith(join(root,'http')+sep)){res.writeHead(404).end();return;}try{res.end(readFileSync(path));}catch{res.writeHead(404).end();}});
try{
  await new DockerRuntime(socket,18080,'traefik:3.7.13',dataDir).ensureInfrastructure();
  assert.equal((await runtime.apply(request)).state,'running');checks.push('inline-two-service-deploy');
  const containers=await docker.listContainers({all:true,filters:{label:[`panel.workload=${workloadId}`]}});assert.equal(containers.length,2);
  const web=containers.find(item=>item.Labels['com.docker.compose.service']==='web')!;
  assert.equal(JSON.parse(run(['inspect',web.Id]))[0].Config.Env.includes('LITERAL=$HOME'),true);checks.push('literal-environment-no-host-expansion');
  run(['exec',web.Id,'sh','-c','printf compose-persistence-proof > /usr/share/nginx/html/proof']);
  let response='';for(let i=0;i<40;i++){try{const value=await probe();if(value.status===200){response=value.text;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,250));}
  assert.equal(response,'compose-persistence-proof');checks.push('real-http-domain-via-traefik');
  request={...request,operationId:randomUUID(),revision:2,configuration:{...request.configuration,source:{type:'inline',yaml:yaml.replace('"v1"','"v2"')}}};
  await runtime.apply(request);checks.push('update-preserves-named-volume');
  for(const type of ['stop','start','restart'] as const){assert.equal((await runtime.apply({...request,operationId:randomUUID(),type})).state,type==='stop'?'stopped':'running');checks.push(type);}
  const after=await docker.listContainers({filters:{label:[`panel.workload=${workloadId}`]}}),afterWeb=after.find(item=>item.Labels['com.docker.compose.service']==='web')!;
  assert.equal(run(['exec',afterWeb.Id,'cat','/usr/share/nginx/html/proof']),'compose-persistence-proof');
  await probe();assert.equal(typeof(await runtime.read(workloadId,projectId,'logs') as {logs:string}).logs,'string');checks.push('runtime-logs');
  for(const path of ['source','http'])mkdirSync(join(root,path));const source=join(root,'source'),bare=join(root,'http','app.git');
  const git=(args:string[],cwd=source)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();git(['init','-b','main']);writeFileSync(join(source,'compose.yaml'),yaml);git(['add','.']);git(['-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-m','fixture']);git(['clone','--bare',source,bare],root);git(['--git-dir',bare,'update-server-info'],root);await new Promise<void>(resolvePromise=>server.listen(0,'127.0.0.1',resolvePromise));
  request={...request,operationId:randomUUID(),revision:3,configuration:{...request.configuration,source:{type:'git',repository:`http://127.0.0.1:${(server.address() as {port:number}).port}/app.git`,branch:'main',path:'compose.yaml'}}};
  const deployed=await runtime.apply(request);assert.equal(deployed.revision,3);assert.deepEqual(await runtime.apply(request),deployed);checks.push('git-compose-deploy-and-idempotent-retry');
  const destroyed=await runtime.apply({...request,operationId:randomUUID(),type:'destroy'});assert.equal(destroyed.state,'deleted');assert.equal((await docker.listContainers({all:true,filters:{label:[`panel.workload=${workloadId}`]}})).length,0);assert.equal((await docker.listVolumes({filters:{label:[`panel.workload=${workloadId}`]}})).Volumes?.length,1);checks.push('destroy-retains-volume');
  const artifact=resolve('artifacts/compose',`${runId}.json`);mkdirSync(dirname(artifact),{recursive:true});writeFileSync(artifact,JSON.stringify({runId,context,checkedAt:new Date().toISOString(),status:'passed',checks,limits:'Image-only Compose; public Git (local HTTP fixture explicitly allowed); HTTP domains. No builds, host binds, published ports, private Git or HTTPS.'},null,2)+'\n');
  console.log(`PASS Compose real runtime: ${checks.join(', ')}; evidence ${artifact}`);
}finally{
  if(server.listening)await new Promise<void>(resolvePromise=>server.close(()=>resolvePromise()));
  for(const container of await docker.listContainers({all:true,filters:{label:[`panel.workload=${workloadId}`]}})){assert.equal(container.Labels['panel.owner'],'self-hosted-panel');await docker.getContainer(container.Id).remove({force:true});}
  for(const network of await docker.listNetworks({filters:{label:[`panel.workload=${workloadId}`]}})){assert.equal(network.Labels?.['panel.owner'],'self-hosted-panel');await docker.getNetwork(network.Id).remove();}
  for(const volume of (await docker.listVolumes({filters:{label:[`panel.workload=${workloadId}`]}})).Volumes??[]){assert.equal(volume.Labels?.['panel.owner'],'self-hosted-panel');await docker.getVolume(volume.Name).remove();}
  runtime.close();rmSync(root,{recursive:true,force:true});if(previousConfig===undefined)delete process.env.DOCKER_CONFIG;else process.env.DOCKER_CONFIG=previousConfig;if(previousHosts===undefined)delete process.env.PANEL_GIT_HTTP_HOSTS;else process.env.PANEL_GIT_HTTP_HOSTS=previousHosts;
}
