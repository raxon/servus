import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { constants, createReadStream, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, statfsSync, closeSync, unlinkSync, write, writeSync } from 'node:fs';
import { link, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const magic = Buffer.from('SVRSTR01');
const headerBytes = 20, tagBytes = 16, maxBytes = 2 * 1024 * 1024 * 1024, reservedBytes = 512 * 1024 * 1024;
const idPattern = /^[a-f0-9]{32}$/;
export class RestoreArchiveCommitUncertainError extends Error {}

function archiveDirectory(dataDir: string): string {
  const root = resolve(dataDir), parent = lstatSync(root);
  const uid = process.getuid?.();
  if (!parent.isDirectory() || parent.isSymbolicLink() || (uid !== undefined && parent.uid !== uid) || (parent.mode & 0o077) !== 0) throw new Error('Restore storage is not private.');
  const directory = join(root, 'restore-archives');
  if (!existsSync(directory)) { try { mkdirSync(directory, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; } }
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (uid !== undefined && info.uid !== uid) || (info.mode & 0o777) !== 0o700) throw new Error('Restore storage is not private.');
  return directory;
}
function validate(operationId: string, key: Buffer) {
  if (!idPattern.test(operationId) || !Buffer.isBuffer(key) || key.length !== 32) throw new Error('Invalid restore archive identity.');
}
function aad(operationId: string) { return Buffer.from(`servus-restore-archive-v1:${operationId}`); }

/** Remove a staged archive after the journal has fenced cancellation. */
export function discardPublishedRestoreArchive(dataDir: string, operationId: string): void {
  if (!idPattern.test(operationId)) throw new Error('Invalid restore archive identity.');
  const dir = archiveDirectory(dataDir), path = join(dir, `${operationId}.enc`), uid = process.getuid?.();
  if (readdirSync(dir).some(name => name.startsWith(`.pending-${operationId}-`))) throw new Error('Restore archive requires recovery.');
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (uid !== undefined && info.uid !== uid) || (info.mode & 0o777) !== 0o600) throw new Error('Restore archive requires recovery.');
    unlinkSync(path);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const dirFd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
}

/** Remove incomplete upload files only after the writer has stopped. */
export async function discardUnpublishedRestoreArchive(dataDir: string, operationId: string): Promise<void> {
  if (!idPattern.test(operationId)) throw new Error('Invalid restore archive identity.');
  const dir = archiveDirectory(dataDir), destination = join(dir, `${operationId}.enc`);
  try { lstatSync(destination); throw new Error('A published restore archive requires recovery.'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const pendingPattern = new RegExp(`^\\.pending-${operationId}-[a-f0-9]{32}$`), uid = process.getuid?.();
  for (const name of readdirSync(dir)) {
    if (!pendingPattern.test(name)) continue;
    const path = join(dir, name), info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (uid !== undefined && info.uid !== uid) || (info.mode & 0o777) !== 0o600) throw new Error('Incomplete restore archive requires recovery.');
    await unlink(path);
  }
  const dirFd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
}

/** Persist an authenticated encrypted archive without replacing an existing operation. */
export async function stageRestoreArchive(options: {
  dataDir: string; operationId: string; key: Buffer; input: () => Readable; signal?: AbortSignal; sizeLimit?: number;
}): Promise<{ sha256: string; size: number }> {
  validate(options.operationId, options.key); options.signal?.throwIfAborted();
  const limit = options.sizeLimit ?? maxBytes;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maxBytes) throw new Error('Invalid restore archive limit.');
  const dir = archiveDirectory(options.dataDir), available = () => { const stat = statfsSync(dir); return stat.bavail * stat.bsize; };
  if (available() <= reservedBytes) throw new Error('Not enough free space for a restore archive.');
  const name = `${options.operationId}.enc`, temporary = join(dir, `.pending-${options.operationId}-${randomBytes(16).toString('hex')}`), destination = join(dir, name);
  let fd: number | undefined = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  let size = 0, spaceCheck = 8 * 1024 * 1024, linked = false;
  try {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', options.key, iv), hash = createHash('sha256'); cipher.setAAD(aad(options.operationId));
    if (writeSync(fd, Buffer.concat([magic, iv]), 0, headerBytes, 0) !== headerBytes) throw new Error('Restore archive write failed.');
    const count = new Transform({ transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      try {
        if (size > limit) return callback(new Error('Restore archive exceeds the supported size.'));
        if (size >= spaceCheck) { spaceCheck = size + 8 * 1024 * 1024; if (available() <= reservedBytes) return callback(new Error('Not enough free space for a restore archive.')); }
        hash.update(chunk); callback(null, chunk);
      } catch (error) { callback(error as Error); }
    } });
    let position = headerBytes, pending = false, finishDestroy: (() => void) | undefined;
    const sink = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        pending = true;
        const finish = (error?: Error) => { pending = false; callback(error); finishDestroy?.(); };
        const writePart = (offset: number) => write(fd!, chunk, offset, chunk.length - offset, position, (error, written) => {
          if (error) return finish(error);
          if (!written) return finish(new Error('Restore archive write failed.'));
          position += written;
          if (offset + written < chunk.length) writePart(offset + written); else finish();
        });
        writePart(0);
      },
      destroy(error, callback) { if (pending) finishDestroy = () => callback(error); else callback(error); },
    });
    await pipeline(options.input(), count, cipher, sink, { signal: options.signal });
    if (!size) throw new Error('Restore archive is empty.');
    if (writeSync(fd, cipher.getAuthTag(), 0, tagBytes, headerBytes + size) !== tagBytes) throw new Error('Restore archive write failed.');
    fsyncSync(fd); closeSync(fd); fd = undefined;
    options.signal?.throwIfAborted();
    await link(temporary, destination); linked = true; await unlink(temporary);
    const dirFd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
    return { sha256: hash.digest('hex'), size };
  } catch (error) {
    if (linked) throw new RestoreArchiveCommitUncertainError('Restore archive publication requires recovery.', { cause: error });
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (!linked) await unlink(temporary).catch(() => {});
  }
}

/** Stream a staged archive; authentication errors must invalidate the candidate. */
export function readRestoreArchive(options: { dataDir: string; operationId: string; key: Buffer }): Readable {
  validate(options.operationId, options.key);
  const dir = archiveDirectory(options.dataDir), path = join(dir, `${options.operationId}.enc`);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd), uid = process.getuid?.();
    if (!info.isFile() || info.nlink !== 1 || (uid !== undefined && info.uid !== uid) || (info.mode & 0o777) !== 0o600 || info.size <= headerBytes + tagBytes || info.size > maxBytes + headerBytes + tagBytes) throw new Error('Restore archive is invalid.');
    const header = Buffer.alloc(headerBytes), tag = Buffer.alloc(tagBytes);
    if (readSync(fd, header, 0, headerBytes, 0) !== headerBytes || !header.subarray(0, 8).equals(magic) || readSync(fd, tag, 0, tagBytes, info.size - tagBytes) !== tagBytes) throw new Error('Restore archive is invalid.');
    const decipher = createDecipheriv('aes-256-gcm', options.key, header.subarray(8)); decipher.setAAD(aad(options.operationId)); decipher.setAuthTag(tag);
    const input = createReadStream('', { fd, autoClose: true, start: headerBytes, end: info.size - tagBytes - 1 });
    input.once('error', error => decipher.destroy(error)); decipher.once('close', () => input.destroy()); input.pipe(decipher);
    return decipher;
  } catch (error) { closeSync(fd); throw error; }
}
