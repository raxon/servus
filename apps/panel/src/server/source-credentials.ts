import { AppError } from './errors.js';
import { canonicalRegistry, imageRegistry, registryCredentialSchema, registryRecordSchema, type RegistryCredential } from '../shared/source-credentials.js';
import type { SecretVault } from '../shared/secrets.js';
import ssh2 from 'ssh2';
import {gitSshCredentialSchema,gitSshRecordSchema,normalizeKnownHosts,parseSshRepository,type GitSshCredential,type GitSshRecord} from '../shared/source-credentials.js';
const {utils:sshUtils}=ssh2;

interface RegistryProtection { vault:SecretVault;put:(value:string,purpose:'registry')=>string;requireOwned:(reference:string,purpose:'registry')=>string }

export function protectRegistryCredential(serviceId:string,image:string,value:RegistryCredential|null|undefined,options:RegistryProtection):RegistryCredential|null|undefined {
  if(value==null)return value;
  const input=registryCredentialSchema.parse(value),server=canonicalRegistry(input.server);
  if(imageRegistry(image)!==server)throw new AppError('REGISTRY_MISMATCH','The registry credential must match the image registry',400);
  if(input.password!==undefined){const record={kind:'registry-credential-v1' as const,serviceId,server,username:input.username,password:input.password};return{server,username:input.username,secretRef:options.put(JSON.stringify(record),'registry')};}
  const reference=options.requireOwned(input.secretRef!,'registry');
  let record;
  try{record=registryRecordSchema.parse(JSON.parse(options.vault.get(reference)));}catch{throw new AppError('SECRET_REFERENCE','The registry credential is unavailable',403);}
  if(record.serviceId!==serviceId||record.server!==server||record.username!==input.username)throw new AppError('SECRET_REFERENCE','The registry credential belongs to another service, host or account',403);
  return{server,username:input.username,secretRef:reference};
}

interface SshProtection {vault:SecretVault;put:(value:string,purpose:'git-ssh')=>string;requireOwned:(reference:string,purpose:'git-ssh')=>string}
export function protectGitSshCredential(serviceId:string,repository:string,value:GitSshCredential,options:SshProtection):GitSshCredential {
  const input=gitSshCredentialSchema.parse(value),target=parseSshRepository(repository),knownHosts=normalizeKnownHosts(input.knownHosts,repository);
  for(const line of knownHosts.trim().split('\n')){
    const key=Buffer.from(line.split(' ')[2]!,'base64');
    if(key.length!==51||key.readUInt32BE(0)!==11||key.subarray(4,15).toString()!=='ssh-ed25519'||key.readUInt32BE(15)!==32)throw new AppError('GIT_SSH_HOST_KEY','Invalid Ed25519 host key',400);
  }
  let record:GitSshRecord;
  if(input.secretRef){
    const reference=options.requireOwned(input.secretRef,'git-ssh');
    try{record=gitSshRecordSchema.parse(JSON.parse(options.vault.get(reference)));}catch{throw new AppError('SECRET_REFERENCE','The SSH deploy key is unavailable',403);}
    if(record.serviceId!==serviceId||record.repository!==target.url.href||input.publicKey!==undefined&&input.publicKey!==record.publicKey)throw new AppError('SECRET_REFERENCE','The deploy key belongs to another service or repository',403);
    if(record.knownHosts===knownHosts)return{knownHosts,publicKey:record.publicKey,secretRef:reference};
    record={...record,knownHosts};
  }else{
    const generated=sshUtils.generateKeyPairSync('ed25519',{comment:`servus-${serviceId}`});
    record={kind:'git-ssh-v1',serviceId,repository:target.url.href,privateKey:generated.private,publicKey:generated.public,knownHosts};
  }
  return{knownHosts,publicKey:record.publicKey,secretRef:options.put(JSON.stringify(record),'git-ssh')};
}
