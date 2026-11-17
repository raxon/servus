import Database from 'better-sqlite3';
import type Docker from 'dockerode';
import { join } from 'node:path';
import type { VolumeRestoreBinding } from '../shared/volume-backups.js';
import type { Service } from '../shared/types.js';

const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

/** A restored mount must keep selecting the committed data after a redeploy. */
export function readVolumeBindings(dataDir:string,serviceId:string):VolumeRestoreBinding[] {
  const db=new Database(join(dataDir,'agent.sqlite'),{readonly:true,fileMustExist:true});
  try {
    if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='volume_restore_bindings'").get())return [];
    const bindings=db.prepare('SELECT * FROM volume_restore_bindings WHERE service_id=?').all(serviceId) as VolumeRestoreBinding[];
    for(const binding of bindings) {
      if(binding.service_id!==serviceId||!uuid.test(binding.operation_id)||binding.volume_name!==`panel-volume-restore-${binding.operation_id}`||
        !db.prepare("SELECT 1 FROM volume_restore_operations WHERE id=? AND service_id=? AND mount_target=? AND mount_name=? AND candidate_volume=? AND phase='completed'").get(binding.operation_id,serviceId,binding.mount_target,binding.mount_name,binding.volume_name))throw new Error('Restored application volume metadata is invalid.');
    }
    return bindings;
  } finally {db.close();}
}

export function validateBoundMounts(service:Service,bindings:VolumeRestoreBinding[]):void {
  for(const binding of bindings) {
    const configured=service.mounts?.find(mount=>mount.target===binding.mount_target);
    if((service.kind??'app')!=='app'||!configured||configured.type!=='volume'||configured.name!==binding.mount_name||configured.readOnly)throw new Error('A restored application mount cannot be removed, renamed, moved or made read-only. Restore its committed configuration before continuing.');
  }
}

export async function verifyApplicationVolume(docker:Docker,binding:VolumeRestoreBinding):Promise<void> {
  if(!uuid.test(binding.operation_id)||binding.volume_name!==`panel-volume-restore-${binding.operation_id}`)throw new Error('Restored application volume metadata is invalid.');
  const volume=await docker.getVolume(binding.volume_name).inspect(),labels=volume.Labels??{};
  if(volume.Name!==binding.volume_name||volume.Driver!=='local'||labels['panel.owner']!=='self-hosted-panel'||labels['panel.service']!==binding.service_id||labels['panel.volume.restore.operation']!==binding.operation_id||labels['panel.volume.restore.purpose']!=='candidate')throw new Error('Restored application volume ownership cannot be verified.');
}

export async function verifyBoundRuntime(docker:Docker,spec:Docker.ServiceSpec|undefined|null,bindings:VolumeRestoreBinding[]):Promise<void> {
  if(!spec)return;
  const task=spec.TaskTemplate;
  const mounts=task&&'ContainerSpec' in task?task.ContainerSpec?.Mounts??[]:[];
  for(const binding of bindings) {
    const mount=mounts.find(item=>item.Target===binding.mount_target);
    if(spec.Labels?.['panel.owner']!=='self-hosted-panel'||spec.Labels?.['panel.service']!==binding.service_id||mount?.Type!=='volume'||mount.Source!==binding.volume_name||mount.ReadOnly)throw new Error('The runtime does not match its committed application volume.');
    await verifyApplicationVolume(docker,binding);
  }
  for(const mount of mounts)if(mount.Source?.startsWith('panel-volume-restore-')&&!bindings.some(binding=>binding.volume_name===mount.Source&&binding.mount_target===mount.Target))throw new Error('A restored application volume binding is missing.');
}
