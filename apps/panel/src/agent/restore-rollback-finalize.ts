import type Docker from 'dockerode';
import { isDeepStrictEqual } from 'node:util';
import type { RestoreJournal, RestoreRecord } from './restore-journal.js';
import type { SecretVault } from '../shared/secrets.js';
import { discardPublishedRestoreArchive } from './restore-archive.js';
import { readRestoreSwitchIntent, type RestoreSwitchPlan } from './restore-switch-intent.js';

/** Preserve the candidate volume before releasing a successfully rolled-back service. */
export async function finalizeRestoreRollback(options:{docker:Docker;journal:RestoreJournal;vault:SecretVault;dataDir:string;serviceId:string;operationId:string;verifySource:(plan:RestoreSwitchPlan)=>Promise<void>}):Promise<RestoreRecord> {
  const previous=options.journal.get(options.operationId),retained=options.journal.retainedVolume(options.operationId);
  if(previous?.phase==='cancelled'&&previous.service_id===options.serviceId&&retained?.service_id===options.serviceId&&retained.volume_name===`panel-restore-${options.operationId}`)return previous;
  const plan=readRestoreSwitchIntent(options),inspection=plan.inspection;
  if(options.journal.switchIntent(options.operationId)?.stage!=='rolled_back')throw new Error('Restore rollback is not ready for finalization.');
  const name=`panel-app-${options.serviceId}`,service=options.docker.getService(name);
  const verifyService=async()=>{const current=await service.inspect(),node=(await options.docker.info()).Swarm?.NodeID;if(current.ID!==inspection.serviceDockerId||node!==inspection.nodeId||!isDeepStrictEqual(current.Spec,plan.previousSpec))throw new Error('Original database service changed after rollback.');};
  const source=await options.docker.getVolume(inspection.sourceVolume).inspect();
  if(source.Name!==inspection.sourceVolume||source.Driver!=='local'||source.Labels?.['panel.owner']!=='self-hosted-panel'||source.Labels?.['panel.service']!==options.serviceId)throw new Error('Original database volume cannot be verified.');
  if(plan.previousSpec.Labels?.['panel.postgres-auth']){const reservation=plan.previousSpec.Labels['panel.volume-reservation'];if(!reservation||source.Labels?.['panel.volume-reservation']!==reservation)throw new Error('Original database volume reservation changed.');}
  const candidateVolume=options.docker.getVolume(inspection.candidateVolume);
  const verifyCandidateVolume=async()=>{const volume=await candidateVolume.inspect();if(volume.Name!==inspection.candidateVolume||volume.Driver!=='local'||volume.Labels?.['panel.restore.operation']!==options.operationId||volume.Labels?.['panel.restore.purpose']!=='candidate'||volume.Labels?.['panel.restore.service']!==options.serviceId)throw new Error('Retained database volume cannot be verified.');};
  await verifyService();await verifyCandidateVolume();await options.verifySource(plan);
  const attachments=await options.docker.listContainers({all:true,filters:{volume:[inspection.candidateVolume]}});
  for(const item of attachments){
    const container=options.docker.getContainer(item.Id),info=await container.inspect();
    if(info.Id===inspection.candidateContainerId){
      if(info.Config.Labels?.['panel.owner']!=='self-hosted-panel'||info.Config.Labels?.['panel.restore.operation']!==options.operationId||info.Config.Labels?.['panel.restore.service']!==options.serviceId||info.HostConfig.NetworkMode!=='none')throw new Error('Restore candidate cannot be verified.');
      if(info.State.Running)await container.stop({t:10});
      const stopped=await container.inspect();if(stopped.Id!==info.Id||stopped.State.Running)throw new Error('Restore candidate did not stop.');
      await container.remove();
    } else if(info.State.Running||info.Config.Labels?.['panel.owner']!=='self-hosted-panel'||info.Config.Labels?.['panel.service']!==options.serviceId||info.Config.Labels?.['com.docker.swarm.service.name']!==name)throw new Error('Retained database volume has an unexpected attachment.');
  }
  await verifyService();await verifyCandidateVolume();
  discardPublishedRestoreArchive(options.dataDir,options.operationId);
  return options.journal.finalizeRollback(options.operationId,options.serviceId);
}
