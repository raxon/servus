import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import ssh2 from 'ssh2';
import {isPrivateAddress} from '../shared/network-address.js';
import {gitSshRecordSchema,normalizeKnownHosts,parseSshRepository,type GitSshCredential} from '../shared/source-credentials.js';
import type {SecretVault} from '../shared/secrets.js';
const {utils:sshUtils}=ssh2;

/** Pin the connection address separately from the SSH host-key identity. */
export async function resolveSshRepository(repository:string):Promise<{url:URL;hostname:string;port:number;username:string;address:string}> {
  const target=parseSshRepository(repository),allowed=(process.env.PANEL_GIT_SSH_HOSTS??'').split(',').map(value=>value.trim().toLowerCase()).filter(Boolean),literal=isIP(target.hostname);
  const addresses=literal?[{address:target.hostname,family:literal}]:await lookup(target.hostname,{all:true});
  if(!addresses.length||!allowed.includes(target.hostname)&&addresses.some(item=>isPrivateAddress(item.address)))throw new Error('SSH repositories cannot target private addresses without an explicit host allowlist.');
  return{...target,address:(addresses.find(item=>item.family===4)??addresses[0]!).address};
}
const quote=(value:string)=>`'${value.replaceAll("'","'\\''")}'`;
const configQuote=(value:string)=>`"${value.replaceAll('\\','\\\\').replaceAll('"','\\"')}"`;
const proxy=`const net=require('node:net');const socket=net.createConnection({host:process.argv[2],port:Number(process.argv[3])});socket.setTimeout(15000,()=>socket.destroy(new Error('SSH connection timed out')));socket.on('error',()=>{process.exitCode=1;process.stdin.destroy();});process.stdin.pipe(socket);socket.pipe(process.stdout);`;

export async function gitSshCredentials(directory:string,serviceId:string,repository:string,credential:GitSshCredential,vault:SecretVault):Promise<{env:NodeJS.ProcessEnv;secrets:string[];close:()=>void}> {
  if(!credential.secretRef)throw new Error('The SSH source requires a saved deploy key.');
  const target=await resolveSshRepository(repository);
  let record;
  try{record=gitSshRecordSchema.parse(JSON.parse(vault.getServiceSecret(credential.secretRef,serviceId,'git-ssh')));}catch{throw new Error('The SSH deploy key is unavailable for this service.');}
  const knownHosts=normalizeKnownHosts(credential.knownHosts,repository),parsed=sshUtils.parseKey(record.privateKey);
  if(record.serviceId!==serviceId||record.repository!==target.url.href||record.knownHosts!==knownHosts||credential.publicKey!==undefined&&record.publicKey!==credential.publicKey||parsed instanceof Error||parsed.type!=='ssh-ed25519'||parsed.getPublicSSH().toString('base64')!==record.publicKey.split(' ')[1])throw new Error('The SSH deploy key does not match the service, repository or verified host.');
  const root=mkdtempSync(join(directory,'.ssh-credentials-')),key=join(root,'identity'),known=join(root,'known_hosts'),configuration=join(root,'config'),proxyPath=join(root,'proxy.cjs');
  try{
    writeFileSync(key,record.privateKey,{mode:0o600});writeFileSync(known,knownHosts,{mode:0o600});writeFileSync(proxyPath,proxy,{mode:0o600});
    const contents=['Host *',`  HostName ${target.hostname}`,`  User ${target.username}`,`  Port ${target.port}`,`  IdentityFile ${configQuote(key)}`,`  UserKnownHostsFile ${configQuote(known)}`,'  GlobalKnownHostsFile /dev/null','  StrictHostKeyChecking yes','  HostKeyAlgorithms ssh-ed25519','  UpdateHostKeys no','  CheckHostIP no','  IdentityAgent none','  IdentitiesOnly yes','  BatchMode yes','  PasswordAuthentication no','  KbdInteractiveAuthentication no','  PreferredAuthentications publickey','  ForwardAgent no','  ClearAllForwardings yes','  PermitLocalCommand no','  RequestTTY no','  ConnectTimeout 15',`  ProxyCommand ${quote(process.execPath)} ${quote(proxyPath)} ${target.address} ${target.port}`,''].join('\n');
    writeFileSync(configuration,contents,{mode:0o600});
    return{env:{GIT_SSH_COMMAND:`ssh -F ${quote(configuration)}`,GIT_SSH_VARIANT:'ssh'},secrets:[record.privateKey,Buffer.from(record.privateKey).toString('base64')],close:()=>rmSync(root,{recursive:true,force:true})};
  }catch(error){rmSync(root,{recursive:true,force:true});throw error;}
}
