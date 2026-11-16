import { X509Certificate } from 'node:crypto';
import type Docker from 'dockerode';
import { z } from 'zod';
import { canonicalDnsName } from './acme/dns01.js';
import { localAgentImage } from './host-port-probe.js';
import { outputBuffer } from './observability.js';

export type ManagedCertificate = {status:'not_found'} | {status:'active'|'expired'|'not_yet_valid';notBefore:string;expiresAt:string;fingerprint:string};

/** Extract public certificate metadata only. The ACME account and keys never leave the reader. */
export function selectManagedCertificate(raw:string,host:string,Certificate:typeof X509Certificate):ManagedCertificate {
  const data:unknown=JSON.parse(raw);
  if(!data || typeof data!=='object' || Array.isArray(data))throw new Error('Invalid certificate storage.');
  const resolver=(data as Record<string,unknown>).servus;
  if(resolver===undefined)return {status:'not_found'};
  if(!resolver || typeof resolver!=='object' || Array.isArray(resolver))throw new Error('Invalid certificate resolver.');
  const items=(resolver as Record<string,unknown>).Certificates;
  if(items===undefined || items===null)return {status:'not_found'};
  if(!Array.isArray(items) || items.length>10000)throw new Error('Invalid certificate list.');
  let best:{notBefore:string;expiresAt:string;fingerprint:string}|undefined;
  for(const item of items) {
    if(!item || typeof item!=='object' || typeof item.certificate!=='string' || item.certificate.length>100_000)throw new Error('Invalid certificate record.');
    const cert=new Certificate(Buffer.from(item.certificate,'base64'));
    if(!cert.checkHost(host,{subject:'never'}))continue;
    const start=Date.parse(cert.validFrom),end=Date.parse(cert.validTo);
    if(!Number.isFinite(start)||!Number.isFinite(end)||!cert.fingerprint256)throw new Error('Invalid certificate dates.');
    if(!best || end>Date.parse(best.expiresAt))best={notBefore:new Date(start).toISOString(),expiresAt:new Date(end).toISOString(),fingerprint:cert.fingerprint256};
  }
  if(!best)return {status:'not_found'};
  const now=Date.now();
  return {status:now<Date.parse(best.notBefore)?'not_yet_valid':now>=Date.parse(best.expiresAt)?'expired':'active',...best};
}

const resultSchema=z.discriminatedUnion('status',[
  z.object({status:z.literal('not_found')}).strict(),
  z.object({status:z.enum(['active','expired','not_yet_valid']),notBefore:z.string().datetime(),expiresAt:z.string().datetime(),fingerprint:z.string().regex(/^(?:[A-F0-9]{2}:){31}[A-F0-9]{2}$/)}).strict(),
]);

/** The reader runs without network or Docker access and sees the ACME volume read-only. */
export async function inspectManagedCertificate(docker:Docker,hostname:string,imageResolver=localAgentImage):Promise<ManagedCertificate> {
  const host=canonicalDnsName(hostname);
  if(host!==hostname)throw new Error('Invalid certificate hostname.');
  const volume=await docker.getVolume('servus-acme').inspect();
  if(volume.Driver!=='local'||volume.Labels?.['panel.owner']!=='self-hosted-panel'||volume.Labels?.['panel.purpose']!=='acme')throw new Error('Certificate storage cannot be verified.');
  const image=await imageResolver(docker);
  if(!/^sha256:[a-f0-9]{64}$/.test(image))throw new Error('Certificate reader image cannot be verified.');
  const program=`const fs=require('node:fs'),{X509Certificate}=require('node:crypto');const select=${selectManagedCertificate.toString()};try{let fd;try{fd=fs.openSync('/cert/acme.json',fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW)}catch(e){if(e.code==='ENOENT'){console.log(JSON.stringify({status:'not_found'}));process.exit(0)}throw e}try{const st=fs.fstatSync(fd);if(!st.isFile()||st.size>4194304)throw Error('Invalid storage');const raw=fs.readFileSync(fd,'utf8');console.log(JSON.stringify(select(raw,process.argv[1],X509Certificate)))}finally{fs.closeSync(fd)}}catch{process.exit(1)}`;
  const helper=await docker.createContainer({Image:image,Entrypoint:['/usr/local/bin/node'],Cmd:['-e',program,host],User:'0',Tty:true,
    HostConfig:{NetworkMode:'none',ReadonlyRootfs:true,CapDrop:['ALL'],SecurityOpt:['no-new-privileges'],PidsLimit:32,Memory:64*1024*1024,Mounts:[{Type:'volume',Source:'servus-acme',Target:'/cert',ReadOnly:true}]}});
  let timer:ReturnType<typeof setTimeout>|undefined;
  try {
    await helper.start();
    const result=await Promise.race([helper.wait(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Certificate inspection timed out.')),15_000);})]);
    if(result.StatusCode!==0)throw new Error('Certificate storage could not be inspected.');
    const output:unknown=await helper.logs({stdout:true,stderr:false});
    // Dockerode can decode a single JSON log line before returning it.
    if(output && typeof output==='object' && !Buffer.isBuffer(output) && !(Symbol.asyncIterator in output))return resultSchema.parse(output);
    const bytes=await outputBuffer(output,4097);
    if(bytes.length>4096)throw new Error('Certificate inspection returned an invalid response.');
    return resultSchema.parse(JSON.parse(bytes.toString('utf8')));
  } finally {if(timer)clearTimeout(timer);try{await helper.remove({force:true});}catch{}}
}
