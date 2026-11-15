import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
const mocks=vi.hoisted(()=>({execOutput:vi.fn()}));
vi.mock('../../src/agent/observability.js',()=>({execOutput:mocks.execOutput}));
import { verifyRestoreDatabase } from '../../src/agent/restore-switch-verify.js';

function fixture(){
  const serviceId=randomUUID(),operationId='a'.repeat(32),nodeId='node',targetVolume=`panel-restore-${operationId}`,sourceVolume=`panel-data-${serviceId}-database`,containerId='b'.repeat(64),imageId=`sha256:${'c'.repeat(64)}`;
  const inspection={serviceId,operationId,serviceDockerId:'service-id',serviceVersion:1,sourceContainerId:'d'.repeat(64),sourceVolume,candidateContainerId:'e'.repeat(64),candidateVolume:targetVolume,imageId,nodeId};
  const targetSpec={Name:`panel-app-${serviceId}`,TaskTemplate:{ContainerSpec:{Image:'image',Mounts:[{Type:'volume',Source:targetVolume,Target:'/var/lib/postgresql/data'}]}}};
  const previousSpec={Name:targetSpec.Name,TaskTemplate:{ContainerSpec:{Image:'image',Mounts:[{Type:'volume',Source:sourceVolume,Target:'/var/lib/postgresql/data'}]}}};
  const plan={version:1,inspection,previousSpec,targetSpec};
  const task={NodeID:nodeId,Status:{State:'running',ContainerStatus:{ContainerID:containerId}},Spec:targetSpec.TaskTemplate};
  const info={Id:containerId,Image:imageId,State:{Running:true},HostConfig:{NetworkMode:'bridge'},Config:{Labels:{'panel.owner':'self-hosted-panel','panel.service':serviceId,'com.docker.swarm.service.name':targetSpec.Name}},Mounts:[{Type:'volume',Name:targetVolume,Destination:'/var/lib/postgresql/data',RW:true}]};
  let other:typeof info|undefined;
  const docker={getService:()=>({inspect:async()=>({ID:'service-id',Version:{Index:2},Spec:targetSpec,UpdateStatus:{State:'completed'}})}),info:async()=>({Swarm:{NodeID:nodeId}}),listTasks:async()=>[task],listContainers:async({filters}:{filters:{volume:string[]}})=>filters.volume[0]===targetVolume?[{Id:containerId}]:other?[{Id:other.Id}]:[],getContainer:(id:string)=>({inspect:async()=>id===containerId?info:other})};
  mocks.execOutput.mockResolvedValue({code:0,output:'1\n'});
  return {plan,docker,task,info,setOther:(value:typeof info)=>{other=value;},options:{docker:docker as never,plan:plan as never,side:'target' as const,kind:'postgres' as const,attempts:1,delayMs:0}};
}

it('verifies the exact running task and authenticated database query',async()=>{
  const f=fixture();await verifyRestoreDatabase(f.options);
  expect(mocks.execOutput).toHaveBeenCalledWith(f.docker,f.info.Id,expect.arrayContaining(['/bin/sh','-c']));
});

it('rejects an unexpected task mount or foreign running database',async()=>{
  const f=fixture();f.task.Spec.ContainerSpec.Mounts[0]!.Source='unexpected';
  await expect(verifyRestoreDatabase(f.options)).rejects.toThrow('task does not match');
  f.task.Spec.ContainerSpec.Mounts[0]!.Source=f.plan.inspection.candidateVolume;
  f.setOther({...structuredClone(f.info),Id:'f'.repeat(64)});
  await expect(verifyRestoreDatabase(f.options)).rejects.toThrow('other volume');
});

it('does not accept an unsuccessful database authentication check',async()=>{
  const f=fixture();mocks.execOutput.mockResolvedValue({code:1,output:''});
  await expect(verifyRestoreDatabase(f.options)).rejects.toThrow('readiness could not be verified');
});

it('does not accept a database container with an unhealthy health check',async()=>{
  const f=fixture();(f.info.State as {Running:boolean;Health?:{Status:string}}).Health={Status:'unhealthy'};
  await expect(verifyRestoreDatabase(f.options)).rejects.toThrow('readiness could not be verified');
});
