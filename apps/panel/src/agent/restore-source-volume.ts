import type Docker from 'dockerode';
import type { RestoreJournal } from './restore-journal.js';

/** Verify the committed source volume, whether original or from a previous restore. */
export async function verifyRestoreSourceVolume(options:{docker:Docker;journal:RestoreJournal;serviceId:string;kind:'postgres'|'mariadb';volumeName:string;spec:Docker.ServiceSpec}):Promise<void> {
  const binding=options.journal.validatedVolumeBinding(options.serviceId,options.kind);
  if(options.volumeName!==(binding?.volume_name??`panel-data-${options.serviceId}-database`))throw new Error('Database source volume binding changed.');
  const volume=await options.docker.getVolume(options.volumeName).inspect();
  if(volume.Name!==options.volumeName||volume.Driver!=='local')throw new Error('Database source volume ownership cannot be verified.');
  if(binding){
    if(options.spec.Labels?.['panel.restore.operation']!==binding.operation_id||volume.Labels?.['panel.restore.operation']!==binding.operation_id||volume.Labels?.['panel.restore.service']!==options.serviceId||volume.Labels?.['panel.restore.purpose']!=='candidate')throw new Error('Database source volume ownership cannot be verified.');
  } else {
    if(options.spec.Labels?.['panel.restore.operation']||volume.Labels?.['panel.owner']!=='self-hosted-panel'||volume.Labels?.['panel.service']!==options.serviceId)throw new Error('Database source volume ownership cannot be verified.');
    if(options.kind==='postgres'&&options.spec.Labels?.['panel.postgres-auth']){
      const reservation=options.spec.Labels['panel.volume-reservation'];
      if(!reservation||!/^[a-f0-9]{64}$/.test(reservation)||volume.Labels?.['panel.volume-reservation']!==reservation)throw new Error('Database source volume reservation does not match.');
    }
  }
}

/** Accept stopped historical tasks only when every attachment belongs to the same Swarm service. */
export async function inspectRestoreSourceAttachments(options:{docker:Docker;serviceId:string;volumeName:string;dataPath:string;expectedRunningId?:string}):Promise<Awaited<ReturnType<ReturnType<Docker['getContainer']>['inspect']>>> {
  const serviceName=`panel-app-${options.serviceId}`,items=await options.docker.listContainers({all:true,filters:{volume:[options.volumeName]}});
  let running:Awaited<ReturnType<ReturnType<Docker['getContainer']>['inspect']>>|undefined;
  for(const item of items){
    const info=await options.docker.getContainer(item.Id).inspect();
    if(info.Id!==item.Id||info.Config.Labels?.['panel.owner']!=='self-hosted-panel'||info.Config.Labels?.['panel.service']!==options.serviceId||info.Config.Labels?.['com.docker.swarm.service.name']!==serviceName||info.Mounts.length!==1||!info.Mounts.some(m=>m.Type==='volume'&&m.Name===options.volumeName&&m.Destination===options.dataPath&&m.RW))throw new Error('Database source volume attachments cannot be verified.');
    if(info.State.Running){if(running)throw new Error('More than one source database is running.');running=info;}
  }
  if(!running||(options.expectedRunningId&&running.Id!==options.expectedRunningId))throw new Error('Running source database cannot be verified.');
  return running;
}
