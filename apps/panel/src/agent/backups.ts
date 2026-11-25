import { createHash } from 'node:crypto';
import { closeSync, constants, createReadStream, createWriteStream, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, statfsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const maximumBytes = 2 * 1024 * 1024 * 1024;
const reserveBytes = 512 * 1024 * 1024;
const identity = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export type BackupExtension = 'dump' | 'sql' | 'rdb' | 'archive';
export type BackupArtifactExtension = BackupExtension | 'tar';

/** Local application-data dumps only. This does not capture the control plane. */
export class LocalDatabaseBackupStorage {
  private readonly root: string;
  constructor(dataDir: string, namespace:'database-backups'|'volume-backups'='database-backups') {
    if(!['database-backups','volume-backups'].includes(namespace))throw new Error('Invalid backup namespace.');
    this.root = join(dataDir, namespace);
    try { mkdirSync(this.root, {mode:0o700}); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    this.assertRoot();
  }

  private assertRoot() {
    const info = lstatSync(this.root);
    if (!info.isDirectory() || info.isSymbolicLink() || info.mode & 0o077 || info.uid !== process.getuid?.()) throw new Error('The local backup directory must be private and owned by the panel user.');
  }
  private path(id: string, extension: BackupArtifactExtension | 'partial') {
    this.assertRoot();
    if (!identity.test(id) || !['dump','sql','rdb','archive','tar','partial'].includes(extension)) throw new Error('Invalid backup artifact identity.');
    return join(this.root, `${id}.${extension}`);
  }
  private syncDirectory() {
    const fd = openSync(this.root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }

  async capture<Extension extends BackupArtifactExtension>(id: string, extension: Extension, input: Readable, expectedSize: number|undefined, options: {signal?:AbortSignal; publish?:()=>void; encryptionOverhead?:number} = {}) {
    const overhead=options.encryptionOverhead??0;
    if(!Number.isSafeInteger(overhead)||overhead<0||overhead>128)throw new Error('Invalid backup encryption overhead.');
    if (expectedSize!==undefined&&(!Number.isSafeInteger(expectedSize) || expectedSize < 1 || expectedSize > maximumBytes+overhead)) throw new Error('Backups support exports between 1 byte and 2 GiB.');
    const space = statfsSync(this.root);
    if (Number(space.bavail)*Number(space.bsize) < (expectedSize??0) + reserveBytes) throw new Error('Not enough free space for the backup.');
    const partial = this.path(id,'partial'), destination = this.path(id,extension);
    const fd = openSync(partial, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const output = createWriteStream('',{fd,autoClose:false});
    let size = 0,nextSpaceCheck=8*1024*1024;
    const backupRoot=this.root;
    const hash = createHash('sha256');
    const limit = new Transform({transform(chunk:Buffer,_encoding,done) {
      size += chunk.length;
      if (size > (expectedSize??maximumBytes)) return done(new Error('Backup exceeded its supported length.'));
      if(size>=nextSpaceCheck){nextSpaceCheck=size+8*1024*1024;try{const info=statfsSync(backupRoot);if(Number(info.bavail)*Number(info.bsize)<reserveBytes)return done(new Error('Not enough free space for the backup.'));}catch(error){return done(error as Error);}}
      hash.update(chunk);done(null,chunk);
    },flush(done) {done(size>0&&(expectedSize===undefined||size===expectedSize) ? undefined : new Error('Backup export was incomplete.'));}});
    try {
      await pipeline(input,limit,output,{signal:options.signal});
      options.signal?.throwIfAborted();
      fsyncSync(fd);
      options.publish?.();
      // A hard link publishes a complete file without replacing an existing artifact.
      linkSync(partial,destination);
      unlinkSync(partial);
      this.syncDirectory();
      return {size,sha256:hash.digest('hex'),extension};
    } finally {
      // pipeline destroys failed file streams and may already have closed the fd.
      if(!output.closed)closeSync(fd);
      try { unlinkSync(partial); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }

  read(id: string, extension: BackupArtifactExtension, expectedSize: number, expectedSha256?:string) {
    if(expectedSha256!==undefined&&!/^[a-f0-9]{64}$/.test(expectedSha256))throw new Error('Invalid backup checksum.');
    const fd = openSync(this.path(id,extension),constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = fstatSync(fd);
      if (!info.isFile() || info.nlink !== 1 || info.size !== expectedSize || info.mode & 0o077 || info.uid !== process.getuid?.()) throw new Error('The backup artifact is unavailable or its metadata changed.');
      const input=createReadStream('',{fd,autoClose:true});
      if(!expectedSha256)return input;
      const hash=createHash('sha256');
      const checked=new Transform({transform(chunk:Buffer,_encoding,done){hash.update(chunk);done(null,chunk);},flush(done){done(hash.digest('hex')===expectedSha256?undefined:new Error('Backup checksum verification failed.'));}});
      void pipeline(input,checked).catch(error=>checked.destroy(error));
      return checked;
    } catch (error) {closeSync(fd);throw error;}
  }

  remove(id: string, extension: BackupArtifactExtension | 'partial') {
    const path = this.path(id,extension);
    try {
      const info = lstatSync(path);
      if (!info.isFile() || info.nlink !== 1 || info.mode & 0o077 || info.uid !== process.getuid?.()) throw new Error('The backup artifact is not owned by this backup store.');
      unlinkSync(path);this.syncDirectory();
    } catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;}
  }
}
