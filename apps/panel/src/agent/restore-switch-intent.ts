import type Docker from 'dockerode';
import { z } from 'zod';
import type { SecretVault } from '../shared/secrets.js';
import type { RestoreJournal } from './restore-journal.js';
import { inspectRestoreSwitch, type RestoreSwitchInspection } from './restore-switch-inspect.js';

export type RestoreSwitchPlan = {version:1; inspection:RestoreSwitchInspection; previousSpec:Docker.ServiceSpec; targetSpec:Docker.ServiceSpec};

/** Persist both specifications and the fencing transition atomically before any switch. */
export async function prepareRestoreSwitchIntent(options:{docker:Docker;journal:RestoreJournal;vault:SecretVault;serviceId:string;operationId:string}):Promise<RestoreSwitchInspection> {
  const inspection=await inspectRestoreSwitch(options);
  const service=await options.docker.getService(`panel-app-${options.serviceId}`).inspect();
  if(service.ID!==inspection.serviceDockerId||service.Version?.Index!==inspection.serviceVersion)throw new Error('Database service changed before recording the switch.');
  const previousSpec=structuredClone(service.Spec),targetSpec=structuredClone(previousSpec);
  const mount=targetSpec.TaskTemplate?.ContainerSpec?.Mounts?.[0];
  if(!mount||targetSpec.TaskTemplate?.ContainerSpec?.Mounts?.length!==1||mount.Source!==inspection.sourceVolume)throw new Error('Database source specification changed.');
  mount.Source=inspection.candidateVolume;
  targetSpec.Labels={...targetSpec.Labels,'panel.restore.operation':options.operationId};
  const plan:RestoreSwitchPlan={version:1,inspection,previousSpec,targetSpec};
  options.journal.beginSwitch({id:options.operationId,serviceId:options.serviceId,serviceVersion:inspection.serviceVersion,sealedPlan:options.vault.seal(JSON.stringify(plan))});
  return inspection;
}

/** Read an authenticated plan only for the currently fenced operation. */
export function readRestoreSwitchIntent(options:{journal:RestoreJournal;vault:SecretVault;serviceId:string;operationId:string}):RestoreSwitchPlan {
  const record=options.journal.get(options.operationId),intent=options.journal.switchIntent(options.operationId);
  if(!record||record.service_id!==options.serviceId||record.phase!=='switching'||!intent||intent.service_id!==options.serviceId)throw new Error('Restore switch intent is unavailable.');
  if(!['postgres','mariadb','redis','mysql','mongodb'].includes(record.kind))throw new Error('Unsupported restore database.');
  const binding=options.journal.validatedVolumeBinding(options.serviceId,record.kind);
  const inspectionSchema=z.object({serviceId:z.literal(options.serviceId),operationId:z.literal(options.operationId),serviceDockerId:z.string().min(1),serviceVersion:z.literal(intent.service_version),sourceContainerId:z.string().regex(/^[a-f0-9]{64}$/),sourceVolume:z.literal(binding?.volume_name??`panel-data-${options.serviceId}-database`),candidateContainerId:z.string().regex(/^[a-f0-9]{64}$/),candidateVolume:z.literal(`panel-restore-${options.operationId}`),imageId:z.string().regex(/^sha256:[a-f0-9]{64}$/),nodeId:z.string().min(1)}).strict();
  const raw=z.object({version:z.literal(1),inspection:inspectionSchema,previousSpec:z.record(z.string(),z.unknown()),targetSpec:z.record(z.string(),z.unknown())}).strict().parse(JSON.parse(options.vault.open(intent.sealed_plan)));
  const previous=raw.previousSpec as Docker.ServiceSpec,target=raw.targetSpec as Docker.ServiceSpec;
  const previousMounts=previous.TaskTemplate&&'ContainerSpec' in previous.TaskTemplate?previous.TaskTemplate.ContainerSpec?.Mounts:undefined;
  const targetMounts=target.TaskTemplate&&'ContainerSpec' in target.TaskTemplate?target.TaskTemplate.ContainerSpec?.Mounts:undefined;
  if(previous.Name!==`panel-app-${options.serviceId}`||target.Name!==previous.Name||previousMounts?.length!==1||targetMounts?.length!==1||previousMounts[0]?.Source!==raw.inspection.sourceVolume||targetMounts[0]?.Source!==raw.inspection.candidateVolume||target.Labels?.['panel.restore.operation']!==options.operationId)throw new Error('Restore switch intent is invalid.');
  return {version:1,inspection:raw.inspection,previousSpec:previous,targetSpec:target};
}
