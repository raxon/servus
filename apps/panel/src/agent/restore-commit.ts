import type Docker from 'dockerode';
import type { RestoreJournal } from './restore-journal.js';
import type { SecretVault } from '../shared/secrets.js';
import { prepareRestoreSwitchIntent, type RestoreSwitchPlan } from './restore-switch-intent.js';
import { applyRestoreSwitch } from './restore-switch-apply.js';
import { rollbackRestoreSwitch } from './restore-switch-rollback.js';
import { finalizeRestoreSwitch } from './restore-switch-finalize.js';
import { finalizeRestoreRollback } from './restore-rollback-finalize.js';
import { verifyRestoreDatabase } from './restore-switch-verify.js';
import { loadRestoreSource } from './restore-source.js';

export class RestoreCommitUncertainError extends Error {}
export type RestoreCommitResult={operationId:string;phase:'completed'|'cancelled';rolledBack:boolean};

/** Resume the durable switch or restore the source when a switch cannot be verified. */
export async function commitPreparedRestore(options:{docker:Docker;journal:RestoreJournal;vault:SecretVault;dataDir:string;serviceId:string;operationId:string}):Promise<RestoreCommitResult> {
  let record=options.journal.get(options.operationId);
  if(!record||record.service_id!==options.serviceId||!['postgres','mariadb','redis','mysql','mongodb'].includes(record.kind))throw new Error('Database restore operation not found.');
  if(record.phase==='completed')return {operationId:record.id,phase:'completed',rolledBack:false};
  if(record.phase==='cancelled')return {operationId:record.id,phase:'cancelled',rolledBack:options.journal.retainedVolume(record.id)?.reason==='rollback_candidate'};
  const kind=record.kind;
  if(record.phase==='prepared'){
    loadRestoreSource({dataDir:options.dataDir,serviceId:options.serviceId,kind,vault:options.vault});
    await prepareRestoreSwitchIntent(options);
    record=options.journal.get(options.operationId);
  }
  if(record?.phase!=='switching')throw new Error('Database restore is not ready to switch.');
  const verifyTarget=(plan:RestoreSwitchPlan)=>verifyRestoreDatabase({docker:options.docker,plan,side:'target',kind});
  const verifySource=(plan:RestoreSwitchPlan)=>verifyRestoreDatabase({docker:options.docker,plan,side:'source',kind});
  const rollback=async()=>{
    await rollbackRestoreSwitch({...options,verifySource});
    const result=await finalizeRestoreRollback({...options,verifySource});
    return {operationId:result.id,phase:'cancelled' as const,rolledBack:true};
  };
  try {
    const stage=options.journal.switchIntent(options.operationId)?.stage;
    if(stage==='rolling_back'||stage==='rolled_back')return await rollback();
    await applyRestoreSwitch({...options,verifyTarget});
    const result=await finalizeRestoreSwitch({...options,verifyTarget});
    return {operationId:result.id,phase:'completed',rolledBack:false};
  } catch (error) {
    const current=options.journal.get(options.operationId);
    if(current?.phase==='completed')return {operationId:current.id,phase:'completed',rolledBack:false};
    if(current?.phase==='cancelled')return {operationId:current.id,phase:'cancelled',rolledBack:true};
    try {return await rollback();}
    catch(rollbackError){throw new RestoreCommitUncertainError('Database restore requires recovery before further changes.',{cause:rollbackError ?? error});}
  }
}
