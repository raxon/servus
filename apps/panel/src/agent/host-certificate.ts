import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { X509Certificate } from 'node:crypto';
import { hostDomainPattern, isHostApplication } from '../shared/host-domain.js';
import type { ManagedCertificate } from './managed-certificate.js';

export function inspectHostCertificate(dataDir:string,hostname:string):ManagedCertificate|undefined {
  const path=join(dataDir,'host-domain','active.json');
  if(!existsSync(path))return undefined;
  const saved=JSON.parse(readFileSync(path,'utf8')) as {hostname:string;fingerprint:string};
  if(!hostDomainPattern.test(saved.hostname) || !/^[a-f0-9]{64}$/.test(saved.fingerprint))throw new Error('Invalid host certificate metadata.');
  if(hostname!==saved.hostname&&!isHostApplication(hostname,saved.hostname))return undefined;
  const certificate=new X509Certificate(readFileSync(join(dataDir,'host-domain','tls',`${saved.fingerprint}.crt`)));
  if(certificate.fingerprint256.replaceAll(':','').toLowerCase()!==saved.fingerprint || !certificate.checkHost(hostname,{subject:'never'}))throw new Error('Host certificate does not cover the requested domain.');
  const start=Date.parse(certificate.validFrom),end=Date.parse(certificate.validTo),now=Date.now();
  return {status:now<start?'not_yet_valid':now>=end?'expired':'active',notBefore:new Date(start).toISOString(),expiresAt:new Date(end).toISOString(),fingerprint:certificate.fingerprint256};
}
