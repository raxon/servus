import type Docker from 'dockerode';
import type { RestoreJournal } from './restore-journal.js';

export type RestoreSwitchInspection = {serviceId:string;operationId:string;serviceDockerId:string;serviceVersion:number;sourceContainerId:string;sourceVolume:string;candidateContainerId:string;candidateVolume:string;imageId:string;nodeId:string};

/** Inspect the exact source and isolated candidate before attempting a switch. */
export async function inspectRestoreSwitch(options:{docker:Docker;journal:RestoreJournal;serviceId:string;operationId:string}):Promise<RestoreSwitchInspection> {
  const record=options.journal.get(options.operationId);
  if(!record || record.service_id!==options.serviceId || record.phase!=='prepared' || !['postgres','mariadb'].includes(record.kind))throw new Error('Restore is not ready for switch inspection.');
  const serviceName=`panel-app-${record.service_id}`,sourceVolume=`panel-data-${record.service_id}-database`,candidateVolume=`panel-restore-${record.id}`;
  const dataPath=record.kind==='postgres'?'/var/lib/postgresql/data':'/var/lib/mysql';
  const service=await options.docker.getService(serviceName).inspect(),spec=service.Spec,labels=spec.Labels ?? {},task=spec.TaskTemplate,containerSpec=task?.ContainerSpec;
  const version=service.Version?.Index, info=await options.docker.info(),nodeId=info.Swarm?.NodeID;
  if(!service.ID||!Number.isSafeInteger(version)||!nodeId||labels['panel.owner']!=='self-hosted-panel'||labels['panel.service']!==record.service_id||labels['panel.kind']!==record.kind||spec.Name!==serviceName||spec.Mode?.Replicated?.Replicas!==1||spec.UpdateConfig?.Order!=='stop-first'||task?.Placement?.Constraints?.length!==1||task.Placement.Constraints[0]!==`node.id==${nodeId}`)throw new Error('Database service configuration cannot be safely switched.');
  const mounts=containerSpec?.Mounts;
  if(!containerSpec?.Image||!mounts||mounts.length!==1||mounts[0]?.Type!=='volume'||mounts[0].Source!==sourceVolume||mounts[0].Target!==dataPath||mounts[0].ReadOnly)throw new Error('Database source volume cannot be verified.');
  const sourceVol=await options.docker.getVolume(sourceVolume).inspect();
  if(sourceVol.Name!==sourceVolume||sourceVol.Driver!=='local'||sourceVol.Labels?.['panel.owner']!=='self-hosted-panel'||sourceVol.Labels?.['panel.service']!==record.service_id)throw new Error('Database source volume ownership cannot be verified.');
  if(record.kind==='postgres'&&labels['panel.postgres-auth']){
    const reservation=labels['panel.volume-reservation'];
    if(!reservation||! /^[a-f0-9]{64}$/.test(reservation)||sourceVol.Labels?.['panel.volume-reservation']!==reservation)throw new Error('Database source volume reservation does not match.');
  }
  const candidateVol=await options.docker.getVolume(candidateVolume).inspect();
  const candidateLabels={'panel.restore.operation':record.id,'panel.restore.purpose':'candidate','panel.restore.service':record.service_id};
  const match=(actual:Record<string,string>|undefined,expected:Record<string,string>)=>Object.entries(expected).every(([key,value])=>actual?.[key]===value);
  if(candidateVol.Name!==candidateVolume||candidateVol.Driver!=='local'||!match(candidateVol.Labels,candidateLabels))throw new Error('Restore candidate volume ownership cannot be verified.');
  const candidate=await options.docker.getContainer(candidateVolume).inspect();
  const tmpfs=candidate.HostConfig.Tmpfs??{};
  if(!/^[a-f0-9]{64}$/.test(candidate.Id)||!candidate.State.Running||candidate.HostConfig.NetworkMode!=='none'||candidate.HostConfig.Privileged!==false||candidate.HostConfig.PidMode==='host'||candidate.HostConfig.IpcMode==='host'||(candidate.HostConfig.CapAdd?.length??0)>0||Object.keys(tmpfs).length!==1||tmpfs['/run/secrets']!=='rw,noexec,nosuid,nodev,size=1m,mode=0700'||candidate.Config.Labels?.['panel.owner']!=='self-hosted-panel'||!match(candidate.Config.Labels,candidateLabels)||candidate.Mounts.length!==1||!candidate.Mounts.some(m=>m.Type==='volume'&&m.Name===candidateVolume&&m.Destination===dataPath&&m.RW))throw new Error('Restore candidate container cannot be verified.');
  const sourceAttachments=await options.docker.listContainers({all:true,filters:{volume:[sourceVolume]}});
  const candidateAttachments=await options.docker.listContainers({all:true,filters:{volume:[candidateVolume]}});
  if(sourceAttachments.length!==1||candidateAttachments.length!==1||candidateAttachments[0]?.Id!==candidate.Id)throw new Error('Database volume attachments cannot be safely switched.');
  const source=await options.docker.getContainer(sourceAttachments[0]!.Id).inspect();
  if(!/^[a-f0-9]{64}$/.test(source.Id)||!source.State.Running||source.Config.Labels?.['panel.owner']!=='self-hosted-panel'||source.Config.Labels?.['panel.service']!==record.service_id||source.Config.Labels?.['com.docker.swarm.service.name']!==serviceName||source.Mounts.length!==1||!source.Mounts.some(m=>m.Type==='volume'&&m.Name===sourceVolume&&m.Destination===dataPath&&m.RW))throw new Error('Running source database cannot be verified.');
  const image=await options.docker.getImage(containerSpec.Image).inspect();
  if(!/^sha256:[a-f0-9]{64}$/.test(image.Id)||source.Image!==image.Id||candidate.Image!==image.Id)throw new Error('Database image identity does not match.');
  const current=await options.docker.getService(serviceName).inspect();
  if(current.ID!==service.ID||current.Version?.Index!==version||options.journal.get(record.id)?.phase!=='prepared')throw new Error('Database configuration changed during inspection.');
  return {serviceId:record.service_id,operationId:record.id,serviceDockerId:service.ID,serviceVersion:version!,sourceContainerId:source.Id,sourceVolume,candidateContainerId:candidate.Id,candidateVolume,imageId:image.Id,nodeId};
}
