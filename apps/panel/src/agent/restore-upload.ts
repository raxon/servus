import type { Readable } from 'node:stream';
import { discardUnpublishedRestoreArchive, RestoreArchiveCommitUncertainError, stageRestoreArchive } from './restore-archive.js';
import type { RestoreJournal, RestoreRecord } from './restore-journal.js';
import { acquireRestoreUploadLock } from './restore-upload-lock.js';

/** Fence the service before consuming a stream and publish only its verified digest. */
export async function uploadRestoreArchive(options: {
  journal: RestoreJournal; operationId: string; serviceId: string; kind: 'postgres' | 'mariadb';
  dataDir: string; key: Buffer; input: () => Readable; signal?: AbortSignal; sizeLimit?: number; expectedSize?: number;
}): Promise<{ record: RestoreRecord; size: number }> {
  options.signal?.throwIfAborted();
  options.journal.beginUpload({ id: options.operationId, serviceId: options.serviceId, kind: options.kind });
  let release:()=>void;
  try { release=acquireRestoreUploadLock(options.dataDir,options.operationId,true); }
  catch(error) {
    try { if(options.journal.get(options.operationId)?.phase==='uploading')options.journal.advance(options.operationId,'uploading','needs_review'); } catch { /* Preserve the unresolved upload. */ }
    throw error;
  }
  try {
    if(options.journal.get(options.operationId)?.phase!=='uploading')throw new Error('Restore upload was cancelled before writing.');
    let published = false;
    try {
      const archive = await stageRestoreArchive(options);
      published = true;
      if (options.expectedSize !== undefined && archive.size !== options.expectedSize) throw new Error('Restore archive length did not match.');
      return { record: options.journal.finishUpload(options.operationId, archive.sha256), size: archive.size };
    } catch (error) {
      if (!published && !(error instanceof RestoreArchiveCommitUncertainError)) {
        let cancelled = false;
        try {
          await discardUnpublishedRestoreArchive(options.dataDir, options.operationId);
          options.journal.advance(options.operationId, 'uploading', 'cancelled');
          cancelled = true;
        } catch { /* Cleanup uncertainty leaves the service fenced. */ }
        if (cancelled) throw error;
      }
      try { options.journal.advance(options.operationId, 'uploading', 'needs_review'); } catch { /* An unresolved upload remains fenced. */ }
      throw error;
    }
  } finally { release(); }
}
