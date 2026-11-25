import { spawn } from 'node:child_process';
import { closeSync, createReadStream, createWriteStream, mkdtempSync, openSync, rmdirSync, rmSync, statfsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

type DatabaseKind = 'postgres' | 'mariadb' | 'redis' | 'mysql' | 'mongodb';
export type DatabaseExport = { size:number; extension:'dump'|'sql'|'rdb'|'archive'; stream:()=>ReturnType<typeof createReadStream>; close:()=>void };
export class DatabaseExportUncertainError extends Error {}
const identifier=/^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,62}$/;
const maximumBytes=2*1024*1024*1024;
const reservedBytes=512*1024*1024;

/** Create an unlinked, private export and return it only after the database command succeeds. */
export async function exportDatabase(options:{containerId:string;dockerSocket:string;kind:DatabaseKind;database:string;user:string;signal?:AbortSignal}):Promise<DatabaseExport> {
  if(!/^[a-f0-9]{64}$/.test(options.containerId) || !options.dockerSocket.startsWith('/') || options.dockerSocket.includes('\0') ||
    !['postgres','mariadb','redis','mysql','mongodb'].includes(options.kind) || (options.kind!=='redis'&&(!identifier.test(options.database)||!identifier.test(options.user)))) {
    throw new Error('Invalid database export target.');
  }
  options.signal?.throwIfAborted();
  const available=()=>{const info=statfsSync(tmpdir());return info.bavail*info.bsize;};
  if(available()<=reservedBytes)throw new Error('Not enough free space for a database export.');
  const commands:Record<DatabaseKind,{script:string;extension:DatabaseExport['extension']}>={
    postgres:{script:'set -eu; PGPASSWORD="$(cat /run/secrets/panel-db-password)"; export PGPASSWORD; exec timeout 300 pg_dump -h 127.0.0.1 -U "$1" --format=custom --no-owner --no-privileges -- "$2"',extension:'dump'},
    mariadb:{script:'set -eu; MYSQL_PWD="$(cat /run/secrets/panel-db-password)"; export MYSQL_PWD; exec timeout 300 mariadb-dump -h 127.0.0.1 -u "$1" --single-transaction --quick --skip-lock-tables --no-tablespaces --default-character-set=utf8mb4 -- "$2"',extension:'sql'},
    mysql:{script:'set -eu; MYSQL_PWD="$(cat /run/secrets/panel-db-password)"; export MYSQL_PWD; exec timeout 300 mysqldump -h 127.0.0.1 -u "$1" --single-transaction --quick --skip-lock-tables --no-tablespaces --default-character-set=utf8mb4 -- "$2"',extension:'sql'},
    mongodb:{script:'set -eu; MONGO_PASS="$(cat /run/secrets/panel-db-password)"; exec timeout 300 mongodump --host 127.0.0.1 --username "$1" --password "$MONGO_PASS" --authenticationDatabase admin --db "$2" --archive',extension:'archive'},
    redis:{script:'set -eu; REDISCLI_AUTH="$(cat /run/secrets/panel-db-password)"; export REDISCLI_AUTH; exec timeout 300 redis-cli --rdb -',extension:'rdb'},
  };
  const directory=mkdtempSync(join(tmpdir(),'servus-export-'));
  let fd:number|undefined;
  try {
    const path=join(directory,'data');
    fd=openSync(path,'wx+',0o600);unlinkSync(path);rmdirSync(directory);
    const command=commands[options.kind];
    const child=spawn('docker',['--host',`unix://${options.dockerSocket}`,'exec',options.containerId,'sh','-c',command.script,'servus-export',options.user,options.database],
      {stdio:['ignore','pipe','pipe'],env:{...process.env,PATH:`${process.env.PATH||'/usr/bin:/bin'}:/usr/local/bin`}});
    let size=0,closed=false,nextSpaceCheck=8*1024*1024;
    const limit=new Transform({transform(chunk:Buffer,_encoding,callback){
      size+=chunk.length;
      try {
        if(size>maximumBytes)return callback(new Error('Database export exceeds the supported size.'));
        if(size>=nextSpaceCheck){nextSpaceCheck=size+8*1024*1024;if(available()<=reservedBytes)return callback(new Error('Not enough free space for a database export.'));}
        callback(null,chunk);
      }catch(error){callback(error as Error);}
    }});
    child.stderr.resume();
    const timeout=setTimeout(()=>child.kill('SIGKILL'),305_000);timeout.unref();
    const abort=()=>child.kill('SIGKILL');options.signal?.addEventListener('abort',abort,{once:true});
    if(options.signal?.aborted)abort();
    const exit=new Promise<{code:number|null;signal:NodeJS.Signals|null}>((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});
    try {
      const output=pipeline(child.stdout,limit,createWriteStream('',{fd,autoClose:false}));
      let result:{code:number|null;signal:NodeJS.Signals|null};
      try { [result]=await Promise.all([exit,output]); }
      catch(error){
        child.kill('SIGKILL');
        const stopped=await exit.catch(()=>undefined);
        if(child.pid && (!stopped || stopped.signal))throw new DatabaseExportUncertainError('Database export process may still be running.',{cause:error});
        throw error;
      }
      if(result.signal)throw new DatabaseExportUncertainError('Database export process may still be running.');
      options.signal?.throwIfAborted();
      if(result.code!==0||size===0)throw new Error('Database export failed.');
      const ownedFd=fd;fd=undefined;
      return {size,extension:command.extension,stream:()=>{
        if(closed)throw new Error('Database export is closed.');
        return createReadStream('',{fd:ownedFd,autoClose:false,start:0});
      },close:()=>{if(!closed){closed=true;closeSync(ownedFd);}}};
    } finally {clearTimeout(timeout);options.signal?.removeEventListener('abort',abort);}
  } finally {
    if(fd!==undefined)closeSync(fd);
    rmSync(directory,{recursive:true,force:true});
  }
}
