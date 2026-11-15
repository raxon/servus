import type Docker from 'dockerode';
import { isDeepStrictEqual } from 'node:util';
import type { RestoreJournal } from './restore-journal.js';
import type { SecretVault } from '../shared/secrets.js';
import { readRestoreSwitchIntent, type RestoreSwitchPlan } from './restore-switch-intent.js';
import { inspectRestoreSourceAttachments, verifyRestoreSourceVolume } from './restore-source-volume.js';

/** Apply a recorded switch. Completion stays fenced until volume binding and recovery are committed. */
export async function applyRestoreSwitch(options:{docker:Docker;journal:RestoreJournal;vault:SecretVault;serviceId:string;operationId:string;verifyTarget:(plan:RestoreSwitchPlan)=>Promise<void>}):Promise<void> {
  const plan=readRestoreSwitchIntent(options),inspection=plan.inspection,name=`panel-app-${options.serviceId}`;
  const record=options.journal.get(options.operationId)!,dataPath=record.kind==='postgres'?'/var/lib/postgresql/data':record.kind==='mariadb'?'/var/lib/mysql':'';
  if(!dataPath)throw new Error('Unsupported restore database.');
  const stage=()=>options.journal.switchIntent(options.operationId)?.stage;
  const next=(from:NonNullable<ReturnType<typeof stage>>,to:NonNullable<ReturnType<typeof stage>>)=>options.journal.advanceSwitchStage(options.operationId,from,to);
  const service=options.docker.getService(name),candidate=options.docker.getContainer(inspection.candidateContainerId),volume=options.docker.getVolume(inspection.candidateVolume);
  const labels={'panel.restore.operation':options.operationId,'panel.restore.purpose':'candidate','panel.restore.service':options.serviceId};
  const match=(actual:Record<string,string>|undefined)=>Object.entries(labels).every(([key,value])=>actual?.[key]===value);
  const readCandidate=async()=>{try{return await candidate.inspect();}catch(error){if((error as {statusCode?:number}).statusCode===404)return undefined;throw error;}};
  const assertVolume=async()=>{const found=await volume.inspect();if(found.Name!==inspection.candidateVolume||found.Driver!=='local'||!match(found.Labels))throw new Error('Restore candidate volume cannot be verified.');};
  const assertSource=async()=>{
    const current=await service.inspect(),node=(await options.docker.info()).Swarm?.NodeID;
    if(current.ID!==inspection.serviceDockerId||current.Version?.Index!==inspection.serviceVersion||node!==inspection.nodeId||!isDeepStrictEqual(current.Spec,plan.previousSpec))throw new Error('Original database service changed before the switch.');
    const source=await options.docker.getContainer(inspection.sourceContainerId).inspect();
    if(!source.State.Running||source.Id!==inspection.sourceContainerId||source.Image!==inspection.imageId||source.Config.Labels?.['panel.owner']!=='self-hosted-panel'||source.Config.Labels?.['panel.service']!==options.serviceId||source.Config.Labels?.['com.docker.swarm.service.name']!==name||source.Mounts.length!==1||!source.Mounts.some(m=>m.Type==='volume'&&m.Name===inspection.sourceVolume&&m.Destination===dataPath&&m.RW))throw new Error('Original database container changed before the switch.');
    await verifyRestoreSourceVolume({docker:options.docker,journal:options.journal,serviceId:options.serviceId,kind:record.kind as 'postgres'|'mariadb',volumeName:inspection.sourceVolume,spec:plan.previousSpec});
    await inspectRestoreSourceAttachments({docker:options.docker,serviceId:options.serviceId,volumeName:inspection.sourceVolume,dataPath,expectedRunningId:inspection.sourceContainerId});
    return current;
  };
  const assertCandidate=(info:Awaited<ReturnType<typeof candidate.inspect>>)=>{
    const tmpfs=info.HostConfig.Tmpfs??{};
    if(info.Id!==inspection.candidateContainerId||info.Image!==inspection.imageId||!match(info.Config.Labels)||info.Config.Labels?.['panel.owner']!=='self-hosted-panel'||info.HostConfig.NetworkMode!=='none'||info.HostConfig.Privileged!==false||info.HostConfig.PidMode==='host'||info.HostConfig.IpcMode==='host'||(info.HostConfig.CapAdd?.length??0)>0||Object.keys(tmpfs).length!==1||tmpfs['/run/secrets']!=='rw,noexec,nosuid,nodev,size=1m,mode=0700'||info.Mounts.length!==1||!info.Mounts.some(m=>m.Type==='volume'&&m.Name===inspection.candidateVolume&&m.Destination===dataPath&&m.RW))throw new Error('Restore candidate changed before the switch.');
  };
  await assertVolume();
  if(stage()==='pending'){
    await assertSource();const info=await readCandidate();
    if(!info||!info.State.Running)throw new Error('Restore candidate is unavailable.');
    assertCandidate(info);
    const attached=await options.docker.listContainers({all:true,filters:{volume:[inspection.candidateVolume]}});
    if(attached.length!==1||attached[0]?.Id!==inspection.candidateContainerId)throw new Error('Restore candidate volume attachments changed.');
    next('pending','candidate_stop');
  }
  if(stage()==='candidate_stop'){
    await assertSource();const info=await readCandidate();
    if(info){assertCandidate(info);if(info.State.Running)await candidate.stop({t:10});const stopped=await readCandidate();if(stopped){assertCandidate(stopped);if(stopped.State.Running)throw new Error('Restore candidate did not stop.');await candidate.remove();}}
    if((await options.docker.listContainers({all:true,filters:{volume:[inspection.candidateVolume]}})).length)throw new Error('Restore candidate volume is still attached.');
    await assertVolume();next('candidate_stop','candidate_detached');
  }
  if(stage()==='candidate_detached'){
    await assertSource();await assertVolume();
    if(await readCandidate()||(await options.docker.listContainers({all:true,filters:{volume:[inspection.candidateVolume]}})).length)throw new Error('Restore candidate volume is still attached.');
    next('candidate_detached','applying');
  }
  if(stage()==='applying'||stage()==='applied'){
    const current=await service.inspect();
    if(current.ID!==inspection.serviceDockerId)throw new Error('Database service identity changed.');
    if(isDeepStrictEqual(current.Spec,plan.previousSpec)){
      if(stage()!=='applying')throw new Error('The restored database service changed.');
      const source=await assertSource();await assertVolume();
      if((await options.docker.listContainers({all:true,filters:{volume:[inspection.candidateVolume]}})).length)throw new Error('Restore candidate volume is still attached.');
      await service.update({...plan.targetSpec,version:source.Version.Index});
    } else if(!isDeepStrictEqual(current.Spec,plan.targetSpec))throw new Error('Database service configuration is not a recorded switch target.');
    await options.verifyTarget(plan);
    const verified=await service.inspect();
    if(verified.ID!==inspection.serviceDockerId||!isDeepStrictEqual(verified.Spec,plan.targetSpec))throw new Error('Database switch target changed during verification.');
    if(stage()==='applying')next('applying','applied');
  }
  if(stage()!=='applied')throw new Error('Restore switch stage is invalid.');
}
