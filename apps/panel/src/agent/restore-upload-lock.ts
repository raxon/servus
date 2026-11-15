import Database from 'better-sqlite3';
import { constants, closeSync, existsSync, lstatSync, mkdirSync, openSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** A separate SQLite file provides a process-owned lock without blocking the agent journal. */
export function acquireRestoreUploadLock(dataDir:string,operationId:string,create:boolean):()=>void {
  if(!/^[a-f0-9]{32}$/.test(operationId))throw new Error('Invalid restore upload identity.');
  const root=resolve(dataDir),owner=process.getuid?.(),rootInfo=lstatSync(root);
  if(!rootInfo.isDirectory()||rootInfo.isSymbolicLink()||(owner!==undefined&&rootInfo.uid!==owner)||(rootInfo.mode&0o077)!==0)throw new Error('Restore storage is not private.');
  const dir=join(root,'restore-upload-locks');
  if(!existsSync(dir)){try{mkdirSync(dir,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}}
  const directory=lstatSync(dir);
  if(!directory.isDirectory()||directory.isSymbolicLink()||(owner!==undefined&&directory.uid!==owner)||(directory.mode&0o777)!==0o700)throw new Error('Restore lock storage is not private.');
  const path=join(dir,`${operationId}.sqlite`);
  if(create){
    try{const fd=openSync(path,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);closeSync(fd);}
    catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')throw new Error('Restore operation is already active or unresolved.');throw error;}
  }
  const info=lstatSync(path);
  if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||(owner!==undefined&&info.uid!==owner)||(info.mode&0o777)!==0o600)throw new Error('Restore upload lock is invalid.');
  const db=new Database(path,{fileMustExist:true,timeout:0});
  try{db.pragma('busy_timeout = 0');db.exec('BEGIN EXCLUSIVE');}
  catch(error){db.close();throw error;}
  let released=false;
  return ()=>{if(released)return;released=true;try{db.exec('ROLLBACK');}finally{db.close();}};
}
