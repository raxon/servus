import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { inspectRestoreSwitch } from '../../src/agent/restore-switch-inspect.js';

function fixture(kind:'postgres'|'mariadb'='postgres') {
  const serviceId=randomUUID(),operationId='a'.repeat(32),sourceVolume=`panel-data-${serviceId}-database`,candidateVolume=`panel-restore-${operationId}`;
  const sourceId='b'.repeat(64),candidateId='c'.repeat(64),imageId=`sha256:${'d'.repeat(64)}`,nodeId='node123',path=kind==='postgres'?'/var/lib/postgresql/data':'/var/lib/mysql';
  const reservation='e'.repeat(64),candidateLabels={'panel.restore.operation':operationId,'panel.restore.purpose':'candidate','panel.restore.service':serviceId};
  const sourceLabels={'panel.owner':'self-hosted-panel','panel.service':serviceId,'com.docker.swarm.service.name':`panel-app-${serviceId}`};
  const candidate={Id:candidateId,Image:imageId,State:{Running:true},HostConfig:{NetworkMode:'none',Privileged:false,Tmpfs:{'/run/secrets':'rw,noexec,nosuid,nodev,size=1m,mode=0700'}},Config:{Labels:{...candidateLabels,'panel.owner':'self-hosted-panel'}},Mounts:[{Type:'volume',Name:candidateVolume,Destination:path,RW:true}]};
  const source={Id:sourceId,Image:imageId,State:{Running:true},Config:{Labels:sourceLabels},Mounts:[{Type:'volume',Name:sourceVolume,Destination:path,RW:true}]};
  const service={ID:'service123',Version:{Index:12},Spec:{Name:`panel-app-${serviceId}`,Labels:{'panel.owner':'self-hosted-panel','panel.service':serviceId,'panel.kind':kind,...(kind==='postgres'?{'panel.postgres-auth':'scram','panel.volume-reservation':reservation}:{})},Mode:{Replicated:{Replicas:1}},UpdateConfig:{Order:'stop-first'},TaskTemplate:{Placement:{Constraints:[`node.id==${nodeId}`]},ContainerSpec:{Image:'fixture@sha256:test',Mounts:[{Type:'volume',Source:sourceVolume,Target:path,ReadOnly:false}]}}}};
  const volumes:Record<string,unknown>={[sourceVolume]:{Name:sourceVolume,Driver:'local',Labels:{'panel.owner':'self-hosted-panel','panel.service':serviceId,'panel.volume-reservation':reservation}},[candidateVolume]:{Name:candidateVolume,Driver:'local',Labels:candidateLabels}};
  const attachments:Record<string,{Id:string}[]>={[sourceVolume]:[{Id:sourceId}],[candidateVolume]:[{Id:candidateId}]};
  const docker={getService:vi.fn(()=>({inspect:async()=>service})),info:async()=>({Swarm:{NodeID:nodeId}}),getVolume:(name:string)=>({inspect:async()=>volumes[name]}),getContainer:(name:string)=>({inspect:async()=>name===candidateVolume?candidate:source}),listContainers:async(opts:{filters:{volume:string[]}})=>attachments[opts.filters.volume[0]!],getImage:()=>({inspect:async()=>({Id:imageId})})};
  const journal={get:vi.fn(()=>({id:operationId,service_id:serviceId,kind,phase:'prepared'}))};
  return {options:{docker:docker as never,journal:journal as never,serviceId,operationId},docker,journal,service,source,candidate,attachments,sourceVolume,candidateVolume,sourceId,candidateId,imageId,nodeId};
}

for(const kind of ['postgres','mariadb'] as const)it(`inspects exact ${kind} resources without modifying them`,async()=>{
  const f=fixture(kind);expect(await inspectRestoreSwitch(f.options)).toEqual({serviceId:f.options.serviceId,operationId:f.options.operationId,serviceDockerId:'service123',serviceVersion:12,sourceContainerId:f.sourceId,sourceVolume:f.sourceVolume,candidateContainerId:f.candidateId,candidateVolume:f.candidateVolume,imageId:f.imageId,nodeId:f.nodeId});
});

it('rejects unowned, shared or mismatched volumes and candidates',async()=>{
  const f=fixture();f.attachments[f.sourceVolume]!.push({Id:'f'.repeat(64)});
  await expect(inspectRestoreSwitch(f.options)).rejects.toThrow('attachments');
  f.attachments[f.sourceVolume]!.pop();f.candidate.Config.Labels['panel.restore.service']=randomUUID();
  await expect(inspectRestoreSwitch(f.options)).rejects.toThrow('candidate container');
  f.candidate.Config.Labels['panel.restore.service']=f.options.serviceId;f.candidate.Image=`sha256:${'f'.repeat(64)}`;
  await expect(inspectRestoreSwitch(f.options)).rejects.toThrow('image identity');
});

it('rejects multi-replica or externally placed databases',async()=>{
  const f=fixture();f.service.Spec.Mode.Replicated.Replicas=2;
  await expect(inspectRestoreSwitch(f.options)).rejects.toThrow('configuration');
  f.service.Spec.Mode.Replicated.Replicas=1;f.service.Spec.TaskTemplate.Placement.Constraints=['node.id==different'];
  await expect(inspectRestoreSwitch(f.options)).rejects.toThrow('configuration');
});

it('rejects a service changed during inspection',async()=>{
  const f=fixture();let calls=0;
  f.docker.getService.mockReturnValue({inspect:async()=>{calls++;return calls===1?f.service:{...f.service,Version:{Index:13}};}});
  await expect(inspectRestoreSwitch(f.options)).rejects.toThrow('changed during inspection');
});
