import type Docker from 'dockerode';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as pause } from 'node:timers/promises';
import type { RestoreJournal } from './restore-journal.js';
import { DatabaseImportError } from './database-import.js';
import { execOutput } from './observability.js';
import { verifyRestoreSourceVolume } from './restore-source-volume.js';

const temporarySecrets='rw,noexec,nosuid,nodev,size=1m,mode=0700';
const maximumBytes=2*1024*1024*1024;

/** Execute a bounded command without retaining database data or secret output. */
async function command(socket:string,args:string[],input?:Readable|Buffer,timeoutMs=10_000) {
  const child=spawn('docker',['--host',`unix://${socket}`,...args],{stdio:[input?'pipe':'ignore','ignore','ignore'],env:{PATH:process.env.PATH??'/usr/bin:/bin'}});
  const exit=new Promise<void>((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>code===0&&!signal?resolve():reject(new Error('Redis restore command failed.')));});
  const timeout=setTimeout(()=>child.kill('SIGKILL'),timeoutMs);timeout.unref();
  try {await Promise.all([exit,input instanceof Buffer?new Promise<void>((resolve,reject)=>{child.stdin!.once('error',reject);child.stdin!.end(input,resolve);}):input?pipeline(input,child.stdin!):Promise.resolve()]);}
  finally {clearTimeout(timeout);child.kill('SIGKILL');if(input&&!Buffer.isBuffer(input))input.destroy();}
}

/** Load an untrusted RDB only in a new, resource-bounded and network-isolated volume. */
export async function importRedisRestore(options:{docker:Docker;dockerSocket:string;journal:RestoreJournal;serviceId:string;operationId:string;sourceContainerId:string;password:string;input:()=>Readable}) {
  const record=options.journal.get(options.operationId);
  if(record?.kind!=='redis'||record.phase!=='importing'||record.service_id!==options.serviceId||!/^[a-f0-9]{64}$/.test(options.sourceContainerId)||!options.password||Buffer.byteLength(options.password)>1024||options.password.includes('\0'))throw new Error('Invalid Redis restore preparation.');
  const source=await options.docker.getContainer(options.sourceContainerId).inspect(),service=await options.docker.getService(`panel-app-${options.serviceId}`).inspect(),node=(await options.docker.info()).Swarm;
  const mounts=service.Spec.TaskTemplate?.ContainerSpec?.Mounts??[],binding=options.journal.validatedVolumeBinding(options.serviceId,'redis'),sourceVolume=binding?.volume_name??`panel-data-${options.serviceId}-database`;
  if(!source.State.Running||source.Config.Labels?.['panel.owner']!=='self-hosted-panel'||source.Config.Labels?.['panel.service']!==options.serviceId||source.Config.Labels?.['com.docker.swarm.service.name']!==`panel-app-${options.serviceId}`||!/^sha256:[a-f0-9]{64}$/.test(source.Image)||service.Spec.Labels?.['panel.kind']!=='redis'||service.Spec.Mode?.Replicated?.Replicas!==1||node?.Nodes!==1||!node.ControlAvailable||mounts.length!==1||mounts[0]?.Type!=='volume'||mounts[0].Source!==sourceVolume||mounts[0].Target!=='/data'||mounts[0].ReadOnly||source.Mounts.length!==1||source.Mounts[0]?.Name!==sourceVolume)throw new Error('The managed Redis source cannot be verified.');
  await verifyRestoreSourceVolume({docker:options.docker,journal:options.journal,serviceId:options.serviceId,kind:'redis',volumeName:sourceVolume,spec:service.Spec});
  const image=await options.docker.getImage(source.Image).inspect();if(image.Id!==source.Image)throw new Error('The pinned Redis image changed.');
  const name=`panel-restore-${options.operationId}`,labels={'panel.restore.operation':options.operationId,'panel.restore.purpose':'candidate','panel.restore.service':options.serviceId};
  for(const resource of [options.docker.getVolume(name),options.docker.getContainer(name)]){try{await resource.inspect();throw new Error('Redis restore candidate already exists.');}catch(error){if((error as {statusCode?:number}).statusCode!==404)throw error;}}
  await options.docker.createVolume({Name:name,Labels:labels});
  const startup='set -eu; until [ -s /run/secrets/panel-db-password ] && [ -f /data/.servus-restore-start ]; do sleep 1; done; exec docker-entrypoint.sh redis-server --dir /data --dbfilename dump.rdb --appendonly no --save "" --protected-mode yes --requirepass "$(cat /run/secrets/panel-db-password)"';
  const candidate=await options.docker.createContainer({name,Image:source.Image,User:'0',Entrypoint:['/bin/sh','-c'],Cmd:[startup],Labels:{...labels,'panel.owner':'self-hosted-panel'},HostConfig:{NetworkMode:'none',ReadonlyRootfs:true,Privileged:false,Memory:Math.min(Math.max(source.HostConfig.Memory||512*1024*1024,128*1024*1024),2*1024*1024*1024),NanoCpus:1_000_000_000,PidsLimit:32,Mounts:[{Type:'volume',Source:name,Target:'/data'}],Tmpfs:{'/run/secrets':temporarySecrets},SecurityOpt:['no-new-privileges:true'],LogConfig:{Type:'none',Config:{}}}});
  await candidate.start();
  const version=await execOutput(options.docker,candidate.id,['redis-server','--version']);if(version.code!==0||!/\bv=7\./.test(version.output))throw new DatabaseImportError('Restore requires the currently deployed Redis 7 image.',true);
  await command(options.dockerSocket,['exec','-i',candidate.id,'sh','-c','set -eu; umask 077; cat > /run/secrets/panel-db-password'],Buffer.from(options.password));
  let bytes=0,header=Buffer.alloc(0);const hash=createHash('sha256'),bounded=new Transform({transform(chunk:Buffer,_encoding,done){bytes+=chunk.length;if(bytes>maximumBytes)return done(new Error('Redis archive exceeds the supported length.'));hash.update(chunk);if(header.length<9){header=Buffer.concat([header,chunk.subarray(0,9-header.length)]);if(header.length===9&&!/^REDIS\d{4}$/.test(header.toString('ascii')))return done(new Error('This is not a Redis RDB archive.'));}done(null,chunk);}});
  const input=options.input();void pipeline(input,bounded).catch(error=>bounded.destroy(error));
  try {
    await command(options.dockerSocket,['exec','-i',candidate.id,'sh','-c','set -eu; umask 077; cat > /data/.servus-restore.rdb; test -s /data/.servus-restore.rdb; chown redis:redis /data /data/.servus-restore.rdb; mv /data/.servus-restore.rdb /data/dump.rdb'],bounded,305_000);
    if(bytes<18||hash.digest('hex')!==record.archive_sha256)throw new Error('Redis archive digest or length changed.');
    await command(options.dockerSocket,['exec','--user','redis',candidate.id,'timeout','300','redis-check-rdb','/data/dump.rdb'],undefined,305_000);
    await command(options.dockerSocket,['exec',candidate.id,'touch','/data/.servus-restore-start']);
    const deadline=Date.now()+120_000;let activated=false;
    while(Date.now()<deadline) {
      const inspected=await candidate.inspect();if(!inspected.State.Running||inspected.Image!==source.Image||inspected.Config.Labels?.['panel.restore.operation']!==record.id)throw new Error('Redis candidate stopped or changed.');
      const auth='REDISCLI_AUTH="$(cat /run/secrets/panel-db-password)" exec redis-cli --no-auth-warning -h 127.0.0.1';
      try {
        const ping=await execOutput(options.docker,candidate.id,['sh','-c',`${auth} ping`]);
        if(ping.code===0&&ping.output.trim()==='PONG') {
          const denied=await execOutput(options.docker,candidate.id,['redis-cli','--no-auth-warning','-h','127.0.0.1','ping']);if(!denied.output.includes('NOAUTH'))throw new Error('Redis candidate does not enforce authentication.');
          if(!activated){const result=await execOutput(options.docker,candidate.id,['sh','-c',`${auth} config set appendonly yes`]);if(result.code!==0||result.output.trim()!=='OK')throw new Error('Redis AOF could not be enabled.');activated=true;}
          const persistence=await execOutput(options.docker,candidate.id,['sh','-c',`${auth} info persistence`]),fields=new Map(persistence.output.trim().split(/\r?\n/).map(line=>{const at=line.indexOf(':');return [line.slice(0,at),line.slice(at+1)];}));
          if(fields.get('loading')==='0'&&fields.get('aof_enabled')==='1'&&fields.get('aof_rewrite_in_progress')==='0'&&fields.get('aof_rewrite_scheduled')==='0'&&fields.get('aof_last_bgrewrite_status')==='ok'&&fields.get('aof_last_write_status')==='ok'&&Number(fields.get('aof_rewrites'))>=1)return;
        }
      }catch(error){if(activated)throw error;}
      await pause(250);
    }
    throw new Error('Redis restore readiness or AOF persistence could not be verified.');
  }catch(error){throw new DatabaseImportError('The Redis RDB could not be verified. Discard the isolated candidate.',true,{cause:error});}
  finally {input.destroy();bounded.destroy();}
}
