import { z } from 'zod';

/** Docker image registry identities never contain a scheme, path or user information. */
export function canonicalRegistry(server: string): string {
  if (!server || server.length > 253 || /[\s/@?#\\]/.test(server) || server.includes('://')) throw new Error('Enter a registry hostname with an optional port, without a URL or credentials.');
  const url = new URL(`https://${server}`);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || url.port && (Number(url.port)<1||Number(url.port)>65535) || !url.hostname.split('.').every(part => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(part))) throw new Error('Invalid registry hostname.');
  let host = url.hostname.toLowerCase();
  if (['index.docker.io','registry-1.docker.io'].includes(host)) host = 'docker.io';
  return host + (url.port ? `:${url.port}` : '');
}

export function imageRegistry(image: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,511}$/.test(image) || image.includes('://')) throw new Error('Invalid image reference.');
  const slash = image.indexOf('/');
  if (slash < 0) return 'docker.io';
  const first = image.slice(0,slash);
  return first.includes('.') || first.includes(':') || first === 'localhost' ? canonicalRegistry(first) : 'docker.io';
}

export const registryCredentialSchema = z.object({
  server: z.string().refine(value=>{try{canonicalRegistry(value);return true;}catch{return false;}},'Use a registry hostname and optional port'),
  username: z.string().min(1).max(256).regex(/^[^\x00-\x1f\x7f]+$/),
  password: z.string().min(1).max(4096).refine(value=>!value.includes('\0')).optional(),
  secretRef: z.string().uuid().optional(),
}).strict().refine(value=>Boolean(value.password)!==Boolean(value.secretRef),'Supply a new password or preserve the saved reference');
export type RegistryCredential = z.infer<typeof registryCredentialSchema>;
export const registryRecordSchema = z.object({kind:z.literal('registry-credential-v1'),serviceId:z.string().uuid(),server:z.string(),username:z.string().min(1).max(256),password:z.string().min(1).max(4096)}).strict();

export interface GitSshCredential { knownHosts:string;secretRef?:string;publicKey?:string }
export interface GitSshRecord {kind:'git-ssh-v1';serviceId:string;repository:string;privateKey:string;publicKey:string;knownHosts:string}

export function parseSshRepository(repository:string):{url:URL;hostname:string;port:number;username:string;knownHost:string} {
  const url=new URL(repository),hostname=url.hostname.replace(/^\[|\]$/g,'').toLowerCase(),username=url.username,port=url.port?Number(url.port):22;
  const validHost=hostname.includes(':')?/^[0-9a-f:]+$/i.test(hostname):hostname.split('.').every(part=>/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(part));
  if(url.protocol!=='ssh:'||url.password||url.search||url.hash||!hostname||!validHost||!Number.isInteger(port)||port<1||port>65535||!/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(username)||!/^\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(url.pathname)||url.pathname.split('/').includes('..'))throw new Error('Use an SSH repository URL such as ssh://git@git.example.com/owner/repository.git.');
  return{url,hostname,port,username,knownHost:port===22?hostname:`[${hostname}]:${port}`};
}

/** Trust only explicit Ed25519 keys for the exact repository host and port. */
export function normalizeKnownHosts(value:string,repository:string):string {
  const host=parseSshRepository(repository).knownHost;
  if(!value||value.length>4096)throw new Error('Paste the verified Ed25519 known_hosts entry for this repository host.');
  const entries=value.split(/\r?\n/).map(line=>line.trim()).filter(line=>line&&!line.startsWith('#'));
  if(entries.length<1||entries.length>4)throw new Error('Supply one to four verified host keys.');
  const normalized=entries.map(line=>{const fields=line.split(/\s+/);if(fields[0]!==host||fields[1]!=='ssh-ed25519'||!fields[2]||!/^[A-Za-z0-9+/]{60,128}={0,2}$/.test(fields[2]))throw new Error(`Known hosts must contain only Ed25519 entries for ${host}.`);return`${host} ssh-ed25519 ${fields[2]}`;});
  return[...new Set(normalized)].sort().join('\n')+'\n';
}

export const gitSshCredentialSchema=z.object({knownHosts:z.string().min(1).max(4096),secretRef:z.string().uuid().optional(),publicKey:z.string().max(1024).optional()}).strict();
export const gitSshRecordSchema=z.object({kind:z.literal('git-ssh-v1'),serviceId:z.string().uuid(),repository:z.string().max(1000),privateKey:z.string().min(64).max(16384),publicKey:z.string().min(64).max(1024),knownHosts:z.string().min(1).max(4096)}).strict();
