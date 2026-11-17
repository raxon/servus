import type Docker from 'dockerode';
import { isDeepStrictEqual } from 'node:util';
import type { RestoreJournal, RestoreRecord } from './restore-journal.js';
import type { SecretVault } from '../shared/secrets.js';
import { discardPublishedRestoreArchive } from './restore-archive.js';
import { readRestoreSwitchIntent, type RestoreSwitchPlan } from './restore-switch-intent.js';
import { verifyRestoreSourceVolume } from './restore-source-volume.js';

/** Release the fence only after the restored service and both volumes are verified. */
export async function finalizeRestoreSwitch(options:{docker:Docker;journal:RestoreJournal;vault:SecretVault;dataDir:string;serviceId:string;operationId:string;verifyTarget:(plan:RestoreSwitchPlan)=>Promise<void>}):Promise<RestoreRecord> {
  const previous=options.journal.get(options.operationId),binding=options.journal.volumeBinding(options.serviceId),retained=options.journal.retainedVolume(options.operationId);
  if(previous?.phase==='completed'&&previous.service_id===options.serviceId&&binding?.operation_id===options.operationId&&retained?.reason==='pre_restore_source'&&(previous.kind==='postgres'||previous.kind==='mariadb'||previous.kind==='redis')&&options.journal.validatedVolumeBinding(options.serviceId,previous.kind)?.operation_id===options.operationId)return previous;
  const plan=readRestoreSwitchIntent(options),inspection=plan.inspection,record=options.journal.get(options.operationId);
  if(options.journal.switchIntent(options.operationId)?.stage!=='applied'||!record||!['postgres','mariadb','redis'].includes(record.kind))throw new Error('Restore switch is not ready for finalization.');
  const service=options.docker.getService(`panel-app-${options.serviceId}`),kind=record.kind as 'postgres'|'mariadb'|'redis';
  const verifyVolume=async()=>{
    await verifyRestoreSourceVolume({docker:options.docker,journal:options.journal,serviceId:options.serviceId,kind,volumeName:inspection.sourceVolume,spec:plan.previousSpec});
    const candidate=await options.docker.getVolume(inspection.candidateVolume).inspect();
    if(candidate.Name!==inspection.candidateVolume||candidate.Driver!=='local'||candidate.Labels?.['panel.restore.operation']!==options.operationId||candidate.Labels?.['panel.restore.service']!==options.serviceId||candidate.Labels?.['panel.restore.purpose']!=='candidate')throw new Error('Restored database volume cannot be verified.');
  };
  await verifyVolume();await options.verifyTarget(plan);
  const current=await service.inspect(),node=(await options.docker.info()).Swarm?.NodeID;
  if(current.ID!==inspection.serviceDockerId||node!==inspection.nodeId||!isDeepStrictEqual(current.Spec,plan.targetSpec))throw new Error('Restored database service changed before finalization.');
  await verifyVolume();
  discardPublishedRestoreArchive(options.dataDir,options.operationId);
  return options.journal.completeSwitch(options.operationId,options.serviceId,inspection.sourceVolume);
}
