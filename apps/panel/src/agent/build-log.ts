import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { SecretVault } from '../shared/secrets.js';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const maxBytes=256*1024;
/** Read a bounded tail of the specific build log; never mix another operation's output. */
export function readBuildLog(dataDir:string,serviceId:string,operationId:string,vault:SecretVault):{available:boolean;text:string;truncated:boolean} {
  if(!uuid.test(serviceId)||!uuid.test(operationId))throw new Error('Invalid build log identity.');
  const base=join(dataDir,'build-logs'),dir=join(base,serviceId),file=join(dir,`${operationId}.log`);
  let fd:number|undefined;
  try {
    for(const path of [base,dir]) {const info=lstatSync(path);if(!info.isDirectory()||info.isSymbolicLink())throw new Error('Invalid build log directory.');}
    fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW);
    const stat=fstatSync(fd);if(!stat.isFile())throw new Error('Invalid build log file.');
    const size=Math.min(maxBytes,stat.size),buffer=Buffer.alloc(size);
    const count=readSync(fd,buffer,0,size,Math.max(0,stat.size-size));
    return {available:true,text:vault.redact(buffer.subarray(0,count).toString('utf8')),truncated:stat.size>size};
  } catch(error) {
    if((error as NodeJS.ErrnoException).code==='ENOENT')return {available:false,text:'',truncated:false};
    throw error;
  } finally {if(fd!==undefined)closeSync(fd);}
}
