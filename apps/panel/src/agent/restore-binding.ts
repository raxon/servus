import Database from 'better-sqlite3';
import { join } from 'node:path';
import type { RestoreVolumeBinding } from './restore-journal.js';

/** Read the committed volume binding; missing or inconsistent metadata must not select an older volume. */
export function readRestoreBinding(dataDir:string,serviceId:string,kind:'postgres'|'mariadb'):RestoreVolumeBinding|undefined {
  const db=new Database(join(dataDir,'agent.sqlite'),{readonly:true,fileMustExist:true});
  try {
    const table=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='restore_volume_bindings'").get();
    if(!table)return undefined;
    const binding=db.prepare('SELECT * FROM restore_volume_bindings WHERE service_id=?').get(serviceId) as RestoreVolumeBinding|undefined;
    if(!binding)return undefined;
    const retained=db.prepare("SELECT volume_name FROM restore_retained_volumes WHERE operation_id=? AND service_id=? AND reason='pre_restore_source'").get(binding.operation_id,serviceId) as {volume_name:string}|undefined;
    const prior=typeof retained?.volume_name==='string'?/^panel-restore-([a-f0-9]{32})$/.exec(retained.volume_name):null;
    const originalValid=retained?.volume_name===`panel-data-${serviceId}-database` || Boolean(prior && prior[1]!==binding.operation_id && db.prepare("SELECT 1 FROM restore_operations WHERE id=? AND service_id=? AND kind=? AND phase='completed'").get(prior[1],serviceId,kind));
    if(binding.service_id!==serviceId||binding.kind!==kind||! /^[a-f0-9]{32}$/.test(binding.operation_id)||binding.volume_name!==`panel-restore-${binding.operation_id}`||
      !db.prepare("SELECT 1 FROM restore_operations WHERE id=? AND service_id=? AND kind=? AND phase='completed'").get(binding.operation_id,serviceId,kind)||
      !originalValid)throw new Error('Restored database volume binding is invalid.');
    return binding;
  } finally {db.close();}
}
