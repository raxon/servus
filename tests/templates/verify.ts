import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { ComposeRuntime } from '../../apps/panel/src/agent/compose.js';
import { templateConfiguration } from '../../apps/panel/src/server/templates.js';
import type { ComposeApplyRequest } from '../../apps/panel/src/shared/compose.js';

const context='colima-panel-dev',runId=`templates-${Date.now()}-${randomUUID().slice(0,8)}`;
const socket=execFileSync('docker',['context','inspect',context,'--format','{{.Endpoints.docker.Host}}'],{encoding:'utf8'}).trim().replace('unix://','');
assert.match(socket,/\/\.colima\/panel-dev\/docker\.sock$/);
const root=mkdtempSync(join(tmpdir(),'servus-templates-runtime-')),dataDir=join(root,'data'),dockerConfig=join(root,'docker-config');mkdirSync(dataDir,{mode:0o700});mkdirSync(dockerConfig,{mode:0o700});
if(existsSync('/opt/homebrew/lib/docker/cli-plugins/docker-compose'))writeFileSync(join(dockerConfig,'config.json'),JSON.stringify({cliPluginsExtraDirs:['/opt/homebrew/lib/docker/cli-plugins']}),{mode:0o600});
const oldConfig=process.env.DOCKER_CONFIG;process.env.DOCKER_CONFIG=dockerConfig;
const runtime=new ComposeRuntime({dataDir,token:'fixture',socketPath:join(root,'agent.sock'),dockerSocket:socket,ingressPort:18080,ingressImage:'traefik:3.7.13'}),docker=runtime.docker;
const workloads:string[]=[],checks:string[]=[];
const run=(args:string[])=>execFileSync('docker',['--host',`unix://${socket}`,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:20_000}).trim();
try {
  for(const id of ['grafana','uptime-kuma'] as const) {
    const workloadId=randomUUID(),projectId=randomUUID(),configuration=templateConfiguration(id,{name:`fixture-${id}`});workloads.push(workloadId);
    const request:ComposeApplyRequest={operationId:randomUUID(),workloadId,projectId,revision:1,type:'deploy',configuration};
    assert.equal((await runtime.apply(request)).state,'running');
    const containers=await docker.listContainers({all:true,filters:{label:[`panel.workload=${workloadId}`]}});assert.equal(containers.length,1);
    const container=containers[0]!,network=`servus-compose-${workloadId.replaceAll('-','')}_default`,port=id==='grafana'?3000:3001,path=id==='grafana'?'/api/health':'/';
    const probe=()=>run(['run','--rm','--network',network,'--label',`servus.template.test=${runId}`,'nginx:alpine','wget','-qO-',`http://app:${port}${path}`]);
    const deadline=Date.now()+60_000;let healthy=false;
    while(Date.now()<deadline){try{const content=probe();if(id==='grafana')assert.equal(JSON.parse(content).database,'ok');else assert(content.includes('Uptime Kuma'));healthy=true;break;}catch{await new Promise(resolve=>setTimeout(resolve,500));}}
    assert(healthy,`${id}: real HTTP endpoint responds`);
    const proof=id==='grafana'?'/var/lib/grafana/servus-proof':'/app/data/servus-proof';run(['exec',container.Id,'sh','-c',`printf persistence-proof > ${proof}`]);
    assert.equal((await runtime.apply({...request,operationId:randomUUID(),type:'restart'})).state,'running');
    assert.equal(run(['exec',container.Id,'cat',proof]),'persistence-proof');
    assert.equal((await runtime.apply({...request,operationId:randomUUID(),revision:2})).state,'running');
    const current=(await docker.listContainers({filters:{label:[`panel.workload=${workloadId}`]}}))[0]!;assert.equal(run(['exec',current.Id,'cat',proof]),'persistence-proof');
    assert.equal((await runtime.apply({...request,operationId:randomUUID(),type:'destroy'})).state,'deleted');
    assert.equal((await docker.listContainers({all:true,filters:{label:[`panel.workload=${workloadId}`]}})).length,0);
    assert.equal((await docker.listVolumes({filters:{label:[`panel.workload=${workloadId}`]}})).Volumes?.length,1);
    checks.push(`${id}:real-http-deploy-restart-redeploy-retained-volume`);
  }
  const artifact=resolve('artifacts/templates',`${runId}.json`);mkdirSync(dirname(artifact),{recursive:true});writeFileSync(artifact,JSON.stringify({runId,context,checkedAt:new Date().toISOString(),status:'passed',checks,limits:'Grafana and Uptime Kuma runtime tested. WordPress, n8n and MinIO pass generation/API tests and require their own runtime acceptance.'},null,2)+'\n');
  console.log(`PASS actual template workloads: ${checks.join(', ')}; evidence ${artifact}`);
} finally {
  for(const workloadId of workloads) {
    for(const container of await docker.listContainers({all:true,filters:{label:[`panel.workload=${workloadId}`]}})){assert.equal(container.Labels['panel.owner'],'self-hosted-panel');await docker.getContainer(container.Id).remove({force:true});}
    for(const network of await docker.listNetworks({filters:{label:[`panel.workload=${workloadId}`]}})){assert.equal(network.Labels?.['panel.owner'],'self-hosted-panel');await docker.getNetwork(network.Id).remove();}
    for(const volume of (await docker.listVolumes({filters:{label:[`panel.workload=${workloadId}`]}})).Volumes??[]){assert.equal(volume.Labels?.['panel.owner'],'self-hosted-panel');await docker.getVolume(volume.Name).remove();}
  }
  runtime.close();rmSync(root,{recursive:true,force:true});if(oldConfig===undefined)delete process.env.DOCKER_CONFIG;else process.env.DOCKER_CONFIG=oldConfig;
}
