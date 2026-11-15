import type Docker from 'dockerode';
import { isDeepStrictEqual } from 'node:util';
import type { RestoreJournal } from './restore-journal.js';
import type { SecretVault } from '../shared/secrets.js';
import { readRestoreSwitchIntent, type RestoreSwitchPlan } from './restore-switch-intent.js';

/** Restore the saved source service and keep the operation fenced for cleanup. */
export async function rollbackRestoreSwitch(options:{docker:Docker;journal:RestoreJournal;vault:SecretVault;serviceId:string;operationId:string;verifySource:(plan:RestoreSwitchPlan)=>Promise<void>}):Promise<void> {
  const plan=readRestoreSwitchIntent(options),inspection=plan.inspection,service=options.docker.getService(`panel-app-${options.serviceId}`);
  const stage=()=>options.journal.switchIntent(options.operationId)?.stage;
  const currentStage=stage();
  if(!currentStage)throw new Error('Restore switch stage is unavailable.');
  if(currentStage!=='rolling_back'&&currentStage!=='rolled_back')options.journal.advanceSwitchStage(options.operationId,currentStage,'rolling_back');
  const source=await options.docker.getVolume(inspection.sourceVolume).inspect();
  if(source.Name!==inspection.sourceVolume||source.Driver!=='local'||source.Labels?.['panel.owner']!=='self-hosted-panel'||source.Labels?.['panel.service']!==options.serviceId)throw new Error('Original database volume cannot be verified.');
  if(plan.previousSpec.Labels?.['panel.postgres-auth']){
    const reservation=plan.previousSpec.Labels['panel.volume-reservation'];
    if(!reservation||source.Labels?.['panel.volume-reservation']!==reservation)throw new Error('Original database volume reservation changed.');
  }
  const node=(await options.docker.info()).Swarm?.NodeID;
  const current=await service.inspect();
  if(node!==inspection.nodeId||current.ID!==inspection.serviceDockerId||!Number.isSafeInteger(current.Version?.Index)||current.Version.Index<inspection.serviceVersion||(!isDeepStrictEqual(current.Spec,plan.previousSpec)&&!isDeepStrictEqual(current.Spec,plan.targetSpec)))throw new Error('Database service cannot be safely rolled back.');
  if(stage()==='rolling_back'){
    // Updating even an unchanged spec fences an earlier in-flight update using its stale version.
    await service.update({...plan.previousSpec,version:current.Version.Index});
  } else if(!isDeepStrictEqual(current.Spec,plan.previousSpec))throw new Error('Rolled-back service configuration changed.');
  await options.verifySource(plan);
  const verified=await service.inspect();
  if(verified.ID!==inspection.serviceDockerId||!isDeepStrictEqual(verified.Spec,plan.previousSpec))throw new Error('Original database configuration changed during verification.');
  const attachments=await options.docker.listContainers({all:true,filters:{volume:[inspection.candidateVolume]}});
  for(const item of attachments){
    const container=await options.docker.getContainer(item.Id).inspect();
    if(container.State.Running&&(container.Id!==inspection.candidateContainerId||container.HostConfig.NetworkMode!=='none'||container.Config.Labels?.['panel.restore.operation']!==options.operationId))throw new Error('Restored database is still running on the candidate volume.');
  }
  if(stage()==='rolling_back')options.journal.advanceSwitchStage(options.operationId,'rolling_back','rolled_back');
  if(stage()!=='rolled_back')throw new Error('Restore rollback stage is invalid.');
}
