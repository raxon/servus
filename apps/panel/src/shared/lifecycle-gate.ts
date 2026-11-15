import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { dirname } from 'node:path';

// The path is a root-owned, read-only bind mount established by the installer.
// Any unreadable, replaced or unfamiliar state keeps new work blocked.
export function lifecycleAllowsWork(path = '/run/servus-lifecycle/state'): boolean {
  try {
    const directory = lstatSync(dirname(path));
    if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== 0 || (directory.mode & 0o777) !== 0o755) return false;
    const before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink() || before.uid !== 0 || before.gid !== 0 || before.nlink !== 1 || (before.mode & 0o777) !== 0o644 || typeof constants.O_NOFOLLOW !== 'number') return false;
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.uid !== 0 || opened.gid !== 0 || opened.nlink !== 1 || (opened.mode & 0o777) !== 0o644 || opened.dev !== before.dev || opened.ino !== before.ino) return false;
      const buffer = Buffer.alloc(65);
      const count = readSync(fd, buffer, 0, buffer.length, 0);
      return buffer.subarray(0, count).equals(Buffer.from('servus-lifecycle-v1 normal\n'));
    } finally { closeSync(fd); }
  } catch { return false; }
}
