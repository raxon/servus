import type Docker from 'dockerode';
import { discardPublishedRestoreArchive } from './restore-archive.js';
import type { RestoreJournal, RestoreRecord } from './restore-journal.js';

/** Remove only the operation-owned candidate while retaining the source database. */
export async function cancelPreparedRestore(options:{journal:RestoreJournal;docker:Docker;dataDir:string;operationId:string;serviceId:string}):Promise<RestoreRecord> {
  let record=options.journal.get(options.operationId);
  if(!record || record.service_id!==options.serviceId)throw new Error('Restore operation does not belong to this service.');
  if(record.phase==='cancelled')return record;
  if(record.phase==='prepared')record=options.journal.advance(record.id,'prepared','discarding_candidate');
  if(record.phase!=='discarding_candidate')throw new Error('Restore candidate cannot be cancelled in this phase.');
  const name=`panel-restore-${record.id}`,dataPath=record.kind==='postgres'?'/var/lib/postgresql/data':record.kind==='mariadb'?'/var/lib/mysql':'';
  if(!dataPath)throw new Error('Unsupported restore candidate.');
  const labels={'panel.restore.operation':record.id,'panel.restore.purpose':'candidate','panel.restore.service':record.service_id};
  const matches=(value:Record<string,string>|undefined)=>Object.entries(labels).every(([key,expected])=>value?.[key]===expected);
  const volume=options.docker.getVolume(name);
  const inspectVolume=async()=>{try{return await volume.inspect();}catch(error){if((error as {statusCode?:number}).statusCode===404)return undefined;throw error;}};
  const original=await inspectVolume();
  if(original && (original.Name!==name || !matches(original.Labels)))throw new Error('Restore volume ownership cannot be verified.');
  const container=options.docker.getContainer(name);
  let info:Awaited<ReturnType<typeof container.inspect>>|undefined;
  try{info=await container.inspect();}catch(error){if((error as {statusCode?:number}).statusCode!==404)throw error;}
  if(info){
    if(!/^[a-f0-9]{64}$/.test(info.Id)||!matches(info.Config.Labels)||info.Config.Labels?.['panel.owner']!=='self-hosted-panel'||info.HostConfig.NetworkMode!=='none'||info.Mounts.length!==1||!info.Mounts.some(m=>m.Type==='volume'&&m.Name===name&&m.Destination===dataPath&&m.RW))throw new Error('Restore candidate ownership cannot be verified.');
  }
  const attachments=await options.docker.listContainers({all:true,filters:{volume:[name]}});
  if(attachments.some(item=>!info || item.Id!==info.Id))throw new Error('Restore volume is used by another container.');
  if(info){
    const owned=options.docker.getContainer(info.Id);
    if(info.State.Running)await owned.stop({t:10});
    const stopped=await owned.inspect();
    if(stopped.Id!==info.Id||stopped.State.Running||!matches(stopped.Config.Labels))throw new Error('Restore candidate did not stop safely.');
    await owned.remove();
  }
  const remaining=await options.docker.listContainers({all:true,filters:{volume:[name]}});
  if(remaining.length)throw new Error('Restore volume is still attached.');
  const verified=await inspectVolume();
  if(verified){if(!matches(verified.Labels)||verified.Name!==name)throw new Error('Restore volume ownership cannot be verified.');await volume.remove();}
  discardPublishedRestoreArchive(options.dataDir,record.id);
  try{return options.journal.advance(record.id,'discarding_candidate','cancelled');}
  catch(error){const current=options.journal.get(record.id);if(current?.phase==='cancelled')return current;throw error;}
}
