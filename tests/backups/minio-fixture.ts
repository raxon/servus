import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execute=promisify(execFile);

async function freePort() {const server=createServer();await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const port=(server.address() as {port:number}).port;await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));return port;}
export async function minioFixture() {
  const directory=mkdtempSync(join(tmpdir(),'servus-minio-fixture-')),release='RELEASE.2025-09-07T16-13-09Z';
  const architecture=process.arch==='arm64'?'arm64':'amd64';
  const platform=process.platform==='darwin'?'darwin':'linux';
  const filename=`minio.${platform}-${architecture}.${release}`,binary=join(directory,'minio');
  const base=`https://github.com/minio/minio/releases/download/${release}/${filename}`;
  const environmentBinary=process.env.SERVUS_MINIO_FIXTURE_BINARY;
  try {
    const checksum=await fetch(`${base}.sha256sum`,{signal:AbortSignal.timeout(20_000)});
    if(!checksum.ok)throw new Error('The official MinIO fixture checksum could not be downloaded.');
    const expected=(await checksum.text()).trim().split(/\s+/)[0];assert.match(expected!,/^[a-f0-9]{64}$/);
    if(environmentBinary)writeFileSync(binary,readFileSync(environmentBinary),{mode:0o700});
    else {
      // Large release assets can outlive one connection budget. Resume only
      // after measurable progress, then verify the complete publisher checksum.
      let received=0;
      for(let attempt=0;attempt<3;attempt++) {
        try {await execute('curl',['--fail','--location','--silent','--show-error','--connect-timeout','10','--max-time','45','--continue-at','-','--output',binary,base],{timeout:50_000,maxBuffer:16*1024});break;}
        catch(error) {const size=(()=>{try{return statSync(binary).size;}catch{return 0;}})();if(attempt===2||size<=received||size>256*1024*1024)throw error;received=size;}
      }
    }
    assert.equal(createHash('sha256').update(readFileSync(binary)).digest('hex'),expected,'The MinIO fixture does not match the official release checksum.');
    chmodSync(binary,0o700);mkdirSync(join(directory,'data'),{mode:0o700});
    const port=await freePort(),consolePort=await freePort(),accessKeyId=`fixture${randomBytes(8).toString('hex')}`,secretAccessKey=randomBytes(24).toString('hex');
    const child=spawn(binary,['server',join(directory,'data'),'--address',`127.0.0.1:${port}`,'--console-address',`127.0.0.1:${consolePort}`],{env:{...process.env,MINIO_ROOT_USER:accessKeyId,MINIO_ROOT_PASSWORD:secretAccessKey,MINIO_BROWSER:'off'},stdio:'ignore'});
    const endpoint=`http://127.0.0.1:${port}`;
    const close=async()=>{if(child.exitCode===null){child.kill('SIGTERM');await new Promise<void>(resolve=>child.once('exit',()=>resolve()));}rmSync(directory,{recursive:true,force:true});};
    try {
      const deadline=Date.now()+30_000;
      while(Date.now()<deadline) {
        if(child.exitCode!==null)throw new Error('The MinIO fixture stopped before startup.');
        try {if((await fetch(`${endpoint}/minio/health/ready`,{signal:AbortSignal.timeout(1000)})).ok)return {endpoint,accessKeyId,secretAccessKey,close};}catch{/* startup */}
        await new Promise(resolve=>setTimeout(resolve,250));
      }
      throw new Error('The MinIO fixture did not become ready.');
    } catch(error){await close();throw error;}
  } catch(error){rmSync(directory,{recursive:true,force:true});throw error;}
}
