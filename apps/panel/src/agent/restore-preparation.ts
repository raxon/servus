import { DatabaseImportError, type importDatabaseCandidate } from './database-import.js';
import type { RestoreJournal, RestoreRecord } from './restore-journal.js';

type CandidateInput = Parameters<typeof importDatabaseCandidate>[0];
type CandidateTarget = Omit<CandidateInput, 'operationId' | 'kind' | 'archiveSha256'>;

/** Record intent before import. Prepared candidates still require independent cutover verification. */
export async function prepareRestoreCandidate(options: {
  journal: RestoreJournal; operationId: string; serviceId: string;
  importCandidate: typeof importDatabaseCandidate;
} & ({ target: CandidateTarget; allocateTarget?: never } | { target?: never; allocateTarget: () => Promise<CandidateTarget> })): Promise<RestoreRecord> {
  const record = options.journal.get(options.operationId);
  if (!record || record.service_id !== options.serviceId || record.phase !== 'reserved' || !['postgres', 'mariadb'].includes(record.kind)) {
    throw new Error('Restore preparation does not match a reserved database operation.');
  }
  options.journal.advance(record.id, 'reserved', 'importing');
  try {
    const target = options.target ?? await options.allocateTarget!();
    try {
      await options.importCandidate({ ...target, operationId: record.id, kind: record.kind as 'postgres' | 'mariadb', archiveSha256: record.archive_sha256 });
    } catch(error) {
      if(error instanceof DatabaseImportError)options.journal.advance(record.id,'importing','discarding_candidate');
      throw error;
    }
    return options.journal.advance(record.id, 'importing', 'prepared');
  } catch (error) {
    try { if(options.journal.get(record.id)?.phase==='importing')options.journal.advance(record.id, 'importing', 'needs_review'); } catch { /* The unresolved journal still fences this service. */ }
    throw error;
  }
}
