import type { Readable } from 'node:stream';
import { stageRestoreArchive } from './restore-archive.js';
import type { RestoreJournal, RestoreRecord } from './restore-journal.js';

/** Fence the service before consuming a stream and publish only its verified digest. */
export async function uploadRestoreArchive(options: {
  journal: RestoreJournal; operationId: string; serviceId: string; kind: 'postgres' | 'mariadb';
  dataDir: string; key: Buffer; input: () => Readable; signal?: AbortSignal; sizeLimit?: number;
}): Promise<{ record: RestoreRecord; size: number }> {
  options.signal?.throwIfAborted();
  options.journal.beginUpload({ id: options.operationId, serviceId: options.serviceId, kind: options.kind });
  try {
    const archive = await stageRestoreArchive(options);
    return { record: options.journal.finishUpload(options.operationId, archive.sha256), size: archive.size };
  } catch (error) {
    try { options.journal.advance(options.operationId, 'uploading', 'needs_review'); } catch { /* An unresolved upload remains fenced. */ }
    throw error;
  }
}
