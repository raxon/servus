import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { lookup } from 'node:dns/promises';
import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import { isPrivateAddress } from '../shared/network-address.js';
import type { S3Destination } from '../shared/storage-target.js';

export async function validateBackupEndpoint(value:S3Destination) {
  const endpoint=new URL(value.endpoint),host=endpoint.hostname.replace(/^\[|\]$/g,'');
  const allowed=(process.env.PANEL_BACKUP_TEST_ENDPOINTS??'').split(',').filter(Boolean).includes(endpoint.origin);
  if(endpoint.username||endpoint.password||endpoint.search||endpoint.hash||endpoint.pathname!=='/'||(!allowed&&endpoint.protocol!=='https:')||!['http:','https:'].includes(endpoint.protocol))throw new Error('Use a public HTTPS S3 endpoint without a path, credentials or query parameters.');
  if(value.provider==='r2'&&!/^[a-f0-9]{32}\.r2\.cloudflarestorage\.com$/.test(host))throw new Error('Use the Cloudflare R2 account endpoint.');
  if(value.provider==='r2'&&!['STANDARD','STANDARD_IA'].includes(value.storageClass))throw new Error('R2 backups support STANDARD and STANDARD_IA storage classes.');
  const addresses=isIP(host)?[{address:host,family:isIP(host)}]:await lookup(host,{all:true});
  if(!addresses.length||(!allowed&&addresses.some(address=>isPrivateAddress(address.address))))throw new Error('The backup endpoint must resolve only to public IP addresses.');
  return {endpoint,addresses};
}

async function clientFor(value:S3Destination) {
  const {endpoint,addresses}=await validateBackupEndpoint(value);
  const pinned=((hostname,options,callback)=>{
    if(hostname!==endpoint.hostname.replace(/^\[|\]$/g,'')){callback(new Error('Unexpected backup endpoint host.'),'',0);return;}
    if(options.all)(callback as unknown as (error:null,addresses:{address:string;family:number}[])=>void)(null,addresses);
    else callback(null,addresses[0]!.address,addresses[0]!.family);
  }) as LookupFunction;
  return new S3Client({region:value.region,endpoint:endpoint.href,forcePathStyle:true,followRegionRedirects:false,maxAttempts:1,
    credentials:{accessKeyId:value.accessKeyId,secretAccessKey:value.secretAccessKey},requestChecksumCalculation:'WHEN_REQUIRED',responseChecksumValidation:'WHEN_REQUIRED',
    requestHandler:{httpAgent:new HttpAgent({lookup:pinned,maxSockets:2}),httpsAgent:new HttpsAgent({lookup:pinned,maxSockets:2}),connectionTimeout:10_000,requestTimeout:330_000,throwOnRequestTimeout:true}});
}

export interface S3BackupIdentity {serviceId:string;backupId:string;objectKey:string;size:number;sha256:string;scope?:'database'|'volume'}
function assertIdentity(destination:S3Destination,identity:S3BackupIdentity) {
  if(!/^[a-f0-9-]{36}$/.test(identity.serviceId)||!/^[a-f0-9-]{36}$/.test(identity.backupId)||!Number.isSafeInteger(identity.size)||identity.size<1||!/^[a-f0-9]{64}$/.test(identity.sha256))throw new Error('Invalid remote backup identity.');
  const prefix=destination.prefix?`${destination.prefix}/`:'';
  const scope=identity.scope==='volume'?'servus-volumes':'servus',extensions=identity.scope==='volume'?'tar':'(?:dump|sql|rdb)',start=`${prefix}${scope}/${identity.serviceId}/`;
  if(!new RegExp(`^${identity.backupId}\\.${extensions}$`).test(identity.objectKey.slice(start.length))||!identity.objectKey.startsWith(start))throw new Error('Remote backup key does not match its service and operation.');
}
function matches(metadata:Record<string,string>|undefined,size:number|undefined,identity:S3BackupIdentity) {
  return size===identity.size&&metadata?.['servus-backup']===identity.backupId&&metadata?.['servus-service']===identity.serviceId&&metadata?.sha256===identity.sha256;
}
export async function uploadS3Backup(destination:S3Destination,identity:S3BackupIdentity,input:Readable,signal?:AbortSignal) {
  assertIdentity(destination,identity);const client=await clientFor(destination);
  try {
    await client.send(new PutObjectCommand({Bucket:destination.bucket,Key:identity.objectKey,Body:input,ContentLength:identity.size,IfNoneMatch:'*',StorageClass:destination.storageClass,
      ChecksumSHA256:Buffer.from(identity.sha256,'hex').toString('base64'),
      Metadata:{'servus-backup':identity.backupId,'servus-service':identity.serviceId,sha256:identity.sha256}}),{abortSignal:signal});
    const head=await client.send(new HeadObjectCommand({Bucket:destination.bucket,Key:identity.objectKey}),{abortSignal:signal});
    if(!matches(head.Metadata,head.ContentLength,identity))throw new Error('Remote backup metadata does not match the exported database.');
  } finally {input.destroy();client.destroy();}
}
export async function readS3Backup(destination:S3Destination,identity:S3BackupIdentity) {
  assertIdentity(destination,identity);const client=await clientFor(destination);
  try {
    const output=await client.send(new GetObjectCommand({Bucket:destination.bucket,Key:identity.objectKey}));
    if(!(output.Body instanceof Readable)||!matches(output.Metadata,output.ContentLength,identity)){if(output.Body instanceof Readable)output.Body.destroy();throw new Error('Remote backup metadata changed.');}
    const hash=createHash('sha256');let size=0;
    const checked=new Transform({transform(chunk:Buffer,_encoding,done){size+=chunk.length;if(size>identity.size)return done(new Error('Remote backup exceeds the recorded size.'));hash.update(chunk);done(null,chunk);},flush(done){done(size===identity.size&&hash.digest('hex')===identity.sha256?undefined:new Error('Remote backup checksum verification failed.'));}});
    checked.once('close',()=>client.destroy());
    void pipeline(output.Body,checked).catch(error=>checked.destroy(error));
    return checked;
  } catch(error) {client.destroy();throw error;}
}
export async function removeS3Backup(destination:S3Destination,identity:S3BackupIdentity) {
  assertIdentity(destination,identity);const client=await clientFor(destination);
  try {
    let head;
    try{head=await client.send(new HeadObjectCommand({Bucket:destination.bucket,Key:identity.objectKey}));}
    catch(error){if(error&&typeof error==='object'&&'$metadata' in error&&(error.$metadata as {httpStatusCode?:number}).httpStatusCode===404)return;throw error;}
    if(!matches(head.Metadata,head.ContentLength,identity))throw new Error('Refusing to remove a remote object not owned by this backup.');
    await client.send(new DeleteObjectCommand({Bucket:destination.bucket,Key:identity.objectKey}));
  } finally {client.destroy();}
}
