import { discardInterruptedRestoreArchive } from './restore-archive.js';
import type { RestoreJournal, RestoreRecord } from './restore-journal.js';

/**
 * Remove a legacy upload only inside a host-enforced offline maintenance
 * window. The caller must prevent new writers and independently prove that
 * every old writer and data handle has stopped. This function does not prove
 * that condition and must not be exposed through the running agent API.
 */
export function cancelLegacyUploadOffline(options:{journal:RestoreJournal;dataDir:string;operationId:string;serviceId:string}):RestoreRecord {
  const {journal,operationId,serviceId,dataDir}=options;
  if(typeof operationId!=='string'||!/^[a-f0-9]{32}$/.test(operationId)||typeof serviceId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(serviceId))throw new Error('Invalid legacy restore identity.');
  const record=journal.get(operationId);
  if(!record||record.service_id!==serviceId||!['postgres','mariadb'].includes(record.kind)||record.archive_sha256!=='0'.repeat(64))throw new Error('Legacy restore identity does not match.');
  if(record.phase==='cancelled')return record;
  if(!journal.onlyUnresolvedLegacyUpload(operationId))throw new Error('Legacy restore is not the only unresolved operation.');
  discardInterruptedRestoreArchive(dataDir,operationId);
  return journal.advance(operationId,'uploading','cancelled');
}
