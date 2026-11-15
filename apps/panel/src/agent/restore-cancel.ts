import { discardPublishedRestoreArchive } from './restore-archive.js';
import type { RestoreJournal, RestoreRecord } from './restore-journal.js';

/** Cancellation is repeatable after interruption, and never touches an active import. */
export function cancelStagedRestore(options: { journal:RestoreJournal; dataDir:string; operationId:string; serviceId:string }): RestoreRecord {
  let record = options.journal.get(options.operationId);
  if (!record || record.service_id !== options.serviceId) throw new Error('Restore operation does not belong to this service.');
  if (record.phase === 'cancelled') return record;
  if (record.phase === 'reserved') record = options.journal.advance(record.id,'reserved','discarding');
  if (record.phase !== 'discarding') throw new Error('Restore operation cannot be cancelled in this phase.');
  try {
    discardPublishedRestoreArchive(options.dataDir, record.id);
    try { return options.journal.advance(record.id,'discarding','cancelled'); }
    catch (error) { const current = options.journal.get(record.id); if (current?.phase === 'cancelled') return current; throw error; }
  } catch (error) {
    try { options.journal.advance(record.id,'discarding','needs_review'); } catch { /* A concurrent terminal state or unresolved intent is retained. */ }
    throw error;
  }
}
