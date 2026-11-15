import { afterEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RestoreJournal } from '../../src/agent/restore-journal.js';
import { SecretVault } from '../../src/shared/secrets.js';
import { applyRestoreSwitch } from '../../src/agent/restore-switch-apply.js';
import { rollbackRestoreSwitch } from '../../src/agent/restore-switch-rollback.js';

const cleanup:(()=>void)[]=[];
afterEach(()=>{for(const remove of cleanup.splice(0).reverse())remove();});
function fixture(){
  const dataDir=mkdtempSync(join(tmpdir(),'restore-switch-apply-'));cleanup.push(()=>rmSync(dataDir,{recursive:true,force:true}));
  const db=new Database(join(dataDir,'agent.sqlite'));db.exec('CREATE TABLE operations(id TEXT PRIMARY KEY,service_id TEXT,state TEXT)');cleanup.push(()=>db.close());
  const journal=new RestoreJournal(db,()=>false),vault=new SecretVault(dataDir),serviceId=randomUUID(),operationId='a'.repeat(32);
  journal.reserve({id:operationId,serviceId,kind:'postgres',archiveSha256:'b'.repeat(64)});journal.advance(operationId,'reserved','importing');journal.advance(operationId,'importing','prepared');
  const inspection={serviceId,operationId,serviceDockerId:'swarm-id',serviceVersion:12,sourceContainerId:'c'.repeat(64),sourceVolume:`panel-data-${serviceId}-database`,candidateContainerId:'d'.repeat(64),candidateVolume:`panel-restore-${operationId}`,imageId:`sha256:${'e'.repeat(64)}`,nodeId:'node'};
  const previousSpec={Name:`panel-app-${serviceId}`,Labels:{'panel.owner':'self-hosted-panel'},TaskTemplate:{ContainerSpec:{Mounts:[{Type:'volume',Source:inspection.sourceVolume,Target:'/var/lib/postgresql/data'}]}}};
  const targetSpec=structuredClone(previousSpec);targetSpec.Labels={'panel.owner':'self-hosted-panel','panel.restore.operation':operationId} as typeof targetSpec.Labels;targetSpec.TaskTemplate.ContainerSpec.Mounts[0]!.Source=inspection.candidateVolume;
  journal.beginSwitch({id:operationId,serviceId,serviceVersion:12,sealedPlan:vault.seal(JSON.stringify({version:1,inspection,previousSpec,targetSpec}))});
  const labels={'panel.restore.operation':operationId,'panel.restore.purpose':'candidate','panel.restore.service':serviceId,'panel.owner':'self-hosted-panel'};
  const candidateInfo={Id:inspection.candidateContainerId,Image:inspection.imageId,State:{Running:true},Config:{Labels:labels},HostConfig:{NetworkMode:'none',Privileged:false,Tmpfs:{'/run/secrets':'rw,noexec,nosuid,nodev,size=1m,mode=0700'}},Mounts:[{Type:'volume',Name:inspection.candidateVolume,Destination:'/var/lib/postgresql/data',RW:true}]};
  const sourceInfo={Id:inspection.sourceContainerId,Image:inspection.imageId,State:{Running:true},Config:{Labels:{'panel.owner':'self-hosted-panel','panel.service':serviceId,'com.docker.swarm.service.name':previousSpec.Name}},Mounts:[{Type:'volume',Name:inspection.sourceVolume,Destination:'/var/lib/postgresql/data',RW:true}]};
  let candidatePresent=true,serviceSpec=previousSpec,version=12,extraAttachment=false;
  const candidate={inspect:vi.fn(async()=>{if(!candidatePresent)throw {statusCode:404};return candidateInfo;}),stop:vi.fn(async()=>{candidateInfo.State.Running=false;}),remove:vi.fn(async()=>{candidatePresent=false;})};
  const service={inspect:vi.fn(async()=>({ID:'swarm-id',Version:{Index:version},Spec:serviceSpec})),update:vi.fn(async(input:typeof previousSpec & {version:number})=>{const {version:_version,...spec}=input;serviceSpec=spec;version++;})};
  const docker={getService:()=>service,getContainer:(id:string)=>id===inspection.candidateContainerId?candidate:{inspect:async()=>sourceInfo},info:async()=>({Swarm:{NodeID:'node'}}),getVolume:(name:string)=>({inspect:async()=>name===inspection.candidateVolume?{Name:name,Driver:'local',Labels:labels}:{Name:name,Driver:'local',Labels:{'panel.owner':'self-hosted-panel','panel.service':serviceId}}}),listContainers:async({filters}:{filters:{volume:string[]}})=>filters.volume[0]===inspection.sourceVolume?[{Id:inspection.sourceContainerId}]:[...(candidatePresent?[{Id:inspection.candidateContainerId}]:[]),...(extraAttachment?[{Id:'f'.repeat(64)}]:[])]};
  const verifyTarget=vi.fn(async()=>{});
  return {journal,inspection,candidate,service,verifyTarget,setExtra:(value:boolean)=>{extraAttachment=value;},options:{docker:docker as never,journal,vault,serviceId,operationId,verifyTarget}};
}

it('records each step, switches once, and keeps the operation fenced',async()=>{
  const f=fixture();await applyRestoreSwitch(f.options);
  expect(f.candidate.stop).toHaveBeenCalledOnce();expect(f.candidate.remove).toHaveBeenCalledOnce();expect(f.service.update).toHaveBeenCalledOnce();expect(f.verifyTarget).toHaveBeenCalledOnce();
  expect(f.journal.switchIntent(f.options.operationId)?.stage).toBe('applied');expect(f.journal.hasUnresolved(f.options.serviceId)).toBe(true);
  await applyRestoreSwitch(f.options);expect(f.service.update).toHaveBeenCalledOnce();
});

it('keeps the source unchanged when another container uses the candidate volume',async()=>{
  const f=fixture();f.setExtra(true);await expect(applyRestoreSwitch(f.options)).rejects.toThrow('attachments');
  expect(f.candidate.stop).not.toHaveBeenCalled();expect(f.service.update).not.toHaveBeenCalled();expect(f.journal.switchIntent(f.options.operationId)?.stage).toBe('pending');
});

it('recovers after a lost update response without applying the service twice',async()=>{
  const f=fixture(),update=f.service.update.getMockImplementation()!;
  f.service.update.mockImplementationOnce(async(input)=>{await update(input);throw new Error('synthetic connection lost');});
  await expect(applyRestoreSwitch(f.options)).rejects.toThrow('connection lost');expect(f.journal.switchIntent(f.options.operationId)?.stage).toBe('applying');
  await applyRestoreSwitch(f.options);expect(f.service.update).toHaveBeenCalledOnce();expect(f.journal.switchIntent(f.options.operationId)?.stage).toBe('applied');
});

it('does not mark a switch applied until target verification succeeds',async()=>{
  const f=fixture();f.verifyTarget.mockRejectedValueOnce(new Error('target not ready'));
  await expect(applyRestoreSwitch(f.options)).rejects.toThrow('not ready');expect(f.journal.switchIntent(f.options.operationId)?.stage).toBe('applying');
  await applyRestoreSwitch(f.options);expect(f.service.update).toHaveBeenCalledOnce();expect(f.journal.switchIntent(f.options.operationId)?.stage).toBe('applied');
});

it('recovers when the candidate stopped but its response was lost',async()=>{
  const f=fixture(),stop=f.candidate.stop.getMockImplementation()!;
  f.candidate.stop.mockImplementationOnce(async()=>{await stop();throw new Error('stop response lost');});
  await expect(applyRestoreSwitch(f.options)).rejects.toThrow('stop response lost');
  expect(f.journal.switchIntent(f.options.operationId)?.stage).toBe('candidate_stop');
  await applyRestoreSwitch(f.options);expect(f.candidate.stop).toHaveBeenCalledOnce();expect(f.service.update).toHaveBeenCalledOnce();
});

it('rolls back a verified target and keeps the source fenced until cleanup',async()=>{
  const f=fixture();await applyRestoreSwitch(f.options);
  const verifySource=vi.fn(async()=>{});await rollbackRestoreSwitch({...f.options,verifySource});
  expect(f.service.update).toHaveBeenCalledTimes(2);expect(verifySource).toHaveBeenCalledOnce();
  expect(f.journal.switchIntent(f.options.operationId)?.stage).toBe('rolled_back');expect(f.journal.hasUnresolved(f.options.serviceId)).toBe(true);
  await rollbackRestoreSwitch({...f.options,verifySource});expect(f.service.update).toHaveBeenCalledTimes(2);
});

it('fences an in-flight switch even when the original service is still active',async()=>{
  const f=fixture(),verifySource=vi.fn(async()=>{});
  await rollbackRestoreSwitch({...f.options,verifySource});
  expect(f.service.update).toHaveBeenCalledOnce();expect(f.journal.switchIntent(f.options.operationId)?.stage).toBe('rolled_back');
  await expect(applyRestoreSwitch(f.options)).rejects.toThrow('stage is invalid');
});

it('retries rollback after the Docker response is lost',async()=>{
  const f=fixture();await applyRestoreSwitch(f.options);
  const update=f.service.update.getMockImplementation()!;
  f.service.update.mockImplementationOnce(async(input)=>{await update(input);throw new Error('rollback response lost');});
  const verifySource=vi.fn(async()=>{});
  await expect(rollbackRestoreSwitch({...f.options,verifySource})).rejects.toThrow('response lost');
  expect(f.journal.switchIntent(f.options.operationId)?.stage).toBe('rolling_back');
  await rollbackRestoreSwitch({...f.options,verifySource});expect(f.journal.switchIntent(f.options.operationId)?.stage).toBe('rolled_back');
});
