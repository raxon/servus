import { isIP } from 'node:net';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import type { ServiceConfiguration, ServiceInput, ServicePatch } from '../shared/types.js';
import { AppError } from './errors.js';
import { canonicalDnsName } from '../agent/acme/dns01.js';
import { validEnvFilePath } from '../shared/build-options.js';
import { databaseAccessSchema, databasePortAllowed } from '../shared/database-access.js';
import {registryCredentialSchema,gitSshCredentialSchema,canonicalRegistry,imageRegistry,normalizeKnownHosts,parseSshRepository} from '../shared/source-credentials.js';

export const nameSchema = z.string().min(1).max(63).regex(/^[a-z0-9][a-z0-9-]*$/, 'Use lowercase letters, numbers and hyphens');
const imageSchema = z.string().min(1).max(300).regex(/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/,'Enter a valid image reference');
export const hostnameSchema = z.string().min(1).max(253).toLowerCase().refine(value=>value.split('.').every(label=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)),'Enter valid DNS labels without protocol or port');
const targetSchema = z.string().min(2).max(255).refine(value=>value.startsWith('/')&&!value.includes('\0')&&!value.split('/').includes('..')&&value!=='/'&&!value.startsWith('/var/run/docker.sock')&&!value.startsWith('/proc')&&!value.startsWith('/sys'),'Use an absolute container path outside protected directories');
const kindSchema = z.enum(['app','postgres','redis','mariadb']);
const buildResourcesSchema = z.object({
  cpuQuotaPercent: z.number().int().min(10).max(1600).optional(),
  memoryMb: z.number().int().min(128).max(65536).optional(),
  timeoutSeconds: z.number().int().min(30).max(1800).optional(),
}).strict();
const sourceSchema = z.discriminatedUnion('type',[
  z.object({type:z.literal('image')}).strict(),
  z.object({type:z.literal('git'),repository:z.string().url().max(1000),branch:z.string().min(1).max(200).regex(/^[^\s\x00-\x1f~^:?*\[\\]+$/),context:z.string().max(255).default('.'),dockerfile:z.string().max(255).default('Dockerfile'),envFile:z.string().refine(validEnvFilePath,'Use a relative file path outside Git and build configuration files').optional(),buildResources:buildResourcesSchema.optional(),sharedGithub:z.boolean().optional(),ssh:gitSshCredentialSchema.optional(),credential:z.object({username:z.string().min(1).max(256).regex(/^[^\x00-\x20\x7f:=]+$/),token:z.string().min(1).max(4096).regex(/^[^\x00-\x20\x7f]+$/).optional(),secretRef:z.string().uuid().optional()}).strict().refine(v=>Boolean(v.token)!==Boolean(v.secretRef)).optional()}).strict(),
]);
const envSchema = z.object({name:z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(128),value:z.string().max(32000).optional(),secret:z.boolean().optional(),secretRef:z.string().uuid().optional()}).strict();
const pathPrefixSchema = z.string().min(1).max(128).refine(
  value => value === '/' || (/^\/[A-Za-z0-9._~/-]*[A-Za-z0-9._~-]$/.test(value) && !value.includes('//') && !value.split('/').includes('..')),
  'Path prefix must start with / and contain no traversal or double slashes',
);
function validIpOrCidr(entry: string): boolean {
  const parts = entry.split('/');
  if (parts.length > 2) return false;
  const addr = parts[0]!;
  const version = isIP(addr);
  if (version === 0) return false;
  if (parts.length === 1) return true;
  if (!/^(?:0|[1-9][0-9]*)$/.test(parts[1]!)) return false;
  const prefix = Number(parts[1]);
  return version === 4 ? prefix >= 0 && prefix <= 32 : prefix >= 0 && prefix <= 128;
}
const ipAllowEntrySchema = z.string().min(3).max(64).refine(validIpOrCidr, 'Enter a valid IPv4/IPv6 address or CIDR block');
const htpasswdEntrySchema = z.string().min(10).max(200).regex(
  /^[A-Za-z0-9._-]{1,64}:(?:\$(?:2[aby]|apr1)\$[A-Za-z0-9./$]{10,120}|\{SHA\}[A-Za-z0-9+/=]{20,64})$/,
  'Basic auth entries must use hashed htpasswd credentials (bcrypt, apr1 or {SHA})',
);
const redirectTargetSchema = z.string().url().max(500).refine(value => {
  if (value.includes('$') || value.includes('`') || /[\x00-\x20\x7f]/.test(value)) return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password;
  } catch { return false; }
}, 'Redirect target must be an http(s) URL without credentials or regex variables');
const domainSchema = z.object({
  hostname: hostnameSchema,
  port: z.number().int().min(1).max(65535),
  primary: z.boolean().optional(),
  https: z.boolean().optional(),
  redirectHttps: z.boolean().optional(),
  pathPrefix: pathPrefixSchema.optional(),
  stripPrefix: z.boolean().optional(),
  ipAllowList: z.array(ipAllowEntrySchema).min(1).max(32).optional(),
  basicAuth: z.object({ users: z.array(htpasswdEntrySchema).min(1).max(20) }).strict().optional(),
  redirectTarget: redirectTargetSchema.optional(),
  redirectPermanent: z.boolean().optional(),
}).strict();
const mountSchema = z.object({type:z.enum(['volume','file','bind']),name:nameSchema,target:targetSchema,readOnly:z.boolean().optional(),content:z.string().max(32000).optional(),source:z.string().max(1000).optional()}).strict();
const resourcesSchema = z.object({cpu:z.number().min(0.1).max(64),memoryMb:z.number().int().min(32).max(131072)}).strict();
const databaseSchema = z.object({database:z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/).max(63),user:z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/).max(63),password:z.string().min(12).max(128).optional(),passwordSecretRef:z.string().uuid().optional()}).strict();
const notesSchema = z.string().max(4000).refine(value => !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value), 'Notes cannot contain control characters');
const servicePortSchema = z.object({
  publishedPort: z.number().int().min(1024).max(65535),
  targetPort: z.number().int().min(1).max(65535),
  protocol: z.enum(['tcp', 'udp']).default('tcp'),
}).strict();
const endpointModeSchema = z.enum(['vip', 'dnsrr']);
const healthcheckSchema = z.object({
  command: z.array(z.string().min(1).max(256).refine(v => !v.includes('\0'))).min(1).max(16),
  intervalSeconds: z.number().int().min(5).max(300).default(30),
  timeoutSeconds: z.number().int().min(1).max(60).default(5),
  retries: z.number().int().min(1).max(20).default(3),
  startPeriodSeconds: z.number().int().min(0).max(300).default(0),
}).strict();
const deploymentStrategySchema = z.object({
  order: z.enum(['start-first', 'stop-first']).default('start-first'),
  parallelism: z.number().int().min(1).max(5).default(1),
  failureAction: z.enum(['rollback', 'pause', 'continue']).default('rollback'),
  monitorSeconds: z.number().int().min(5).max(300).default(15),
}).strict();
const fields={kind:kindSchema.optional(),source:sourceSchema.optional(),environment:z.array(envSchema).max(100).optional(),domains:z.array(domainSchema).max(20).optional(),mounts:z.array(mountSchema).max(20).optional(),resources:resourcesSchema.optional(),database:databaseSchema.optional(),databaseAccess:databaseAccessSchema.optional(),registry:registryCredentialSchema.nullable().optional(),ports:z.array(servicePortSchema).max(10).optional(),endpointMode:endpointModeSchema.optional(),healthcheck:healthcheckSchema.optional(),deploymentStrategy:deploymentStrategySchema.optional(),notes:notesSchema.optional()};
export const newServiceSchema=z.object({name:nameSchema,image:imageSchema.optional(),port:z.number().int().min(1).max(65535).optional(),hostname:hostnameSchema.optional(),replicas:z.number().int().min(1).max(5).default(1),...fields}).strict();
export const servicePatchSchema=z.object({expectedRevision:z.number().int().positive(),image:imageSchema.optional(),port:z.number().int().min(1).max(65535).optional(),hostname:hostnameSchema.optional(),replicas:z.number().int().min(1).max(5).optional(),...fields}).strict();

export function normalizeServiceInput(value: unknown): ServiceInput {
  const parsed=newServiceSchema.parse(value),kind=parsed.kind??'app';
  const defaults={postgres:{image:'postgres:17-alpine',port:5432},redis:{image:'redis:7-alpine',port:6379},mariadb:{image:'mariadb:11.4',port:3306}};
  const db=kind==='app'?undefined:defaults[kind];
  if(kind==='app'&&!parsed.image&&parsed.source?.type!=='git')throw new AppError('IMAGE_REQUIRED','An application image or Git source is required');
  const primary=parsed.domains?.find(domain=>domain.primary)??parsed.domains?.[0];
  const hostname=primary?.hostname??parsed.hostname??`${parsed.name}.internal`;
  const result:ServiceInput={...parsed,kind,image:parsed.image??db?.image??'panel-build:pending',port:primary?.port??parsed.port??db?.port??80,hostname,source:parsed.source??{type:'image'}};
  if(db) {if(parsed.domains?.length)throw new AppError('DATABASE_ROUTING','Database services do not expose HTTP domains');result.domains=[];result.database=parsed.database??{database:'app',user:'app'};}
  else if(!parsed.hostname&&!primary&&parsed.domains===undefined)throw new AppError('HOSTNAME_REQUIRED','Set a hostname or choose an empty domains list for a private application');
  validateConfiguration(result);
  return result;
}

export function validateConfiguration(config: ServiceConfiguration & {replicas?:number}) {
  const kind=config.kind??'app';
  if(config.databaseAccess!==undefined) {
    if(kind==='app')throw new AppError('DATABASE_ACCESS','External database access belongs to managed databases');
    databaseAccessSchema.parse(config.databaseAccess);
    if(config.databaseAccess.enabled && !databasePortAllowed(config.databaseAccess.publishedPort,Number(process.env.PANEL_PORT??4180)))throw new AppError('DATABASE_PORT_RESERVED','This TCP port is reserved for the panel API');
  }
  if(config.registry){if(kind!=='app'||config.source?.type==='git')throw new AppError('REGISTRY_SOURCE','Private registry credentials are available for application image sources');if('image'in config&&canonicalRegistry(config.registry.server)!==imageRegistry(String(config.image)))throw new AppError('REGISTRY_MISMATCH','Registry credentials must match the image registry');}
  const unique=(values:string[],name:string)=>{if(new Set(values).size!==values.length)throw new AppError('DUPLICATE_CONFIG',`${name} must be unique`);};
  unique((config.environment??[]).map(item=>item.name),'Environment names');
  unique((config.domains??[]).map(item=>`${item.hostname}:${item.pathPrefix??'/'}`),'Domain routes');
  unique((config.mounts??[]).map(item=>item.name),'Mount names');
  unique((config.mounts??[]).map(item=>item.target),'Mount target paths');
  if((config.domains??[]).filter(domain=>domain.primary).length>1)throw new AppError('MULTIPLE_PRIMARY_DOMAINS','Only one domain can be primary');
  if((config.domains??[]).some(domain=>domain.redirectHttps&&!domain.https))throw new AppError('HTTPS_REDIRECT_REQUIRES_HTTPS','HTTP redirects require automatic HTTPS for the same domain');
  for(const domain of config.domains??[]) {
    if(domain.stripPrefix && (!domain.pathPrefix || domain.pathPrefix === '/')) throw new AppError('STRIP_PREFIX_REQUIRES_PATH','Strip prefix requires a non-root path prefix',400);
    if(domain.redirectTarget && domain.stripPrefix) throw new AppError('INVALID_REDIRECT_RULE','Redirect target cannot be combined with strip prefix',400);
    if(domain.redirectPermanent !== undefined && !domain.redirectTarget) throw new AppError('INVALID_REDIRECT_RULE','Redirect status requires a redirect target URL',400);
  }
  for(const domain of config.domains??[]) if(domain.https) { try { if(canonicalDnsName(domain.hostname)!==domain.hostname || domain.hostname.endsWith('.localhost'))throw new Error(); } catch { throw new AppError('INVALID_HTTPS_DOMAIN','Automatic HTTPS requires a valid public hostname',400); } }
  if(kind!=='app'&&(config.replicas??1)!==1)throw new AppError('STATEFUL_REPLICAS','Database services require exactly one replica');
  if((config.replicas??1)>1&&(config.mounts??[]).some(mount=>!(mount.readOnly??(mount.type==='file'))))throw new AppError('STATEFUL_REPLICAS','Writable mounts require exactly one replica');
  if(kind!=='app'&&config.domains?.length)throw new AppError('DATABASE_ROUTING','Database services do not expose HTTP domains');
  if(kind!=='app'&&config.ports?.length)throw new AppError('DATABASE_PORTS','Use external database access settings for managed database ports',400);
  if(kind!=='app'&&config.endpointMode==='dnsrr')throw new AppError('INVALID_ENDPOINT_MODE','DNSRR endpoint mode is only supported for application services',400);
  if(config.ports?.length) {
    if(config.endpointMode==='dnsrr')throw new AppError('INVALID_ENDPOINT_MODE','DNSRR endpoint mode cannot be combined with published host ports',400);
    const panelPort=Number(process.env.PANEL_PORT??4180),ingressPort=Number(process.env.PANEL_INGRESS_PORT??18080);
    const reserved=new Set([2375,2376,2377,4789,7946,panelPort,ingressPort]);
    unique(config.ports.map(p=>`${p.publishedPort}/${p.protocol??'tcp'}`),'Published ports');
    for(const port of config.ports) {
      if(reserved.has(port.publishedPort))throw new AppError('PORT_RESERVED',`Published port ${port.publishedPort} is reserved for the panel or Swarm control plane`,400);
    }
  }
  const hasWritableMount=(config.mounts??[]).some(mount=>!(mount.readOnly??(mount.type==='file')));
  if((kind!=='app'||hasWritableMount)&&config.deploymentStrategy?.order==='start-first')throw new AppError('STATEFUL_DEPLOYMENT_ORDER','Stateful services require stop-first deployment order',400);
  if(kind!=='app'&&config.source?.type==='git')throw new AppError('DATABASE_SOURCE','Database services use managed images');
  for(const env of config.environment??[]) {
    if(env.secretRef&&!env.secret)throw new AppError('SECRET_REFERENCE','Secret references require secret mode');
    if(kind!=='app'&&/^(POSTGRES_|MARIADB_|MYSQL_|REDIS_)/.test(env.name))throw new AppError('RESERVED_VARIABLE','Database connection variables are managed by the panel');
  }
  for(const mount of config.mounts??[]) {
    if(mount.type==='file'&&mount.content===undefined)throw new AppError('FILE_CONTENT_REQUIRED','File mounts need content');
    if(mount.type==='file'&&mount.readOnly===false)throw new AppError('FILE_READ_ONLY','Managed file mounts are immutable and read-only');
    if(mount.type==='bind'&&(!mount.source?.startsWith('/')||mount.source.split('/').includes('..')))throw new AppError('BIND_SOURCE','Bind mounts need an approved absolute host path');
    if(mount.type==='bind') {
      const path=relative(resolve(process.env.PANEL_MANAGED_BIND_ROOT??'/var/lib/panel/mounts'),resolve(mount.source!));
      if(!path||path==='..'||path.startsWith(`..${sep}`)||isAbsolute(path))throw new AppError('BIND_SOURCE','Bind mounts must stay within the approved managed bind directory');
    }
  }
  if(config.source?.type==='git') {
    const source=config.source,url=new URL(source.repository);
    if(source.envFile!==undefined && !validEnvFilePath(source.envFile))throw new AppError('ENV_FILE_PATH','Use a relative environment file path outside Git and build configuration files');
    if(source.envFile!==undefined && source.envFile===source.dockerfile)throw new AppError('ENV_FILE_PATH','The environment file cannot replace the Dockerfile');
    if(url.protocol==='ssh:'){
      try{const target=parseSshRepository(source.repository);if(!source.ssh||source.credential||source.sharedGithub)throw new Error('SSH Git requires a service deploy key and a verified host key.');normalizeKnownHosts(source.ssh.knownHosts,source.repository);const allowed=(process.env.PANEL_GIT_SSH_HOSTS??'').split(',').map(item=>item.trim());if(!allowed.includes(target.hostname)&&(target.hostname==='localhost'||target.hostname.endsWith('.localhost')||target.hostname==='metadata.google.internal'||isIP(target.hostname)!==0))throw new Error('Private SSH Git hosts require an explicit allowlist.');}catch(error){throw new AppError('GIT_SSH',error instanceof Error?error.message:'Invalid SSH Git source');}
      for(const path of[source.context,source.dockerfile])if(path.startsWith('/')||path.split(/[\\/]/).includes('..')||path.includes('\0'))throw new AppError('GIT_PATH','Build paths must stay within the repository');
      return;
    }
    if(source.ssh)throw new AppError('GIT_SSH','Deploy keys require an ssh:// repository URL');
    if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw new AppError('GIT_SOURCE','Git URLs must not contain credentials, query strings or fragments');
    const allowed=(process.env.PANEL_GIT_HTTP_HOSTS??'').split(',').map(item=>item.trim()).filter(Boolean);
    if(url.protocol==='http:'&&!allowed.includes(url.hostname))throw new AppError('GIT_SOURCE','HTTP Git sources require an explicit local-test allowlist');
    if(source.sharedGithub && (url.protocol!=='https:' || url.host.toLowerCase()!=='github.com'))throw new AppError('GIT_SOURCE','The shared GitHub connection can only be used with github.com');
    if(source.sharedGithub && source.credential?.token)throw new AppError('GIT_SOURCE','Choose either the shared GitHub connection or a separate token');
    if(source.credential&&url.protocol!=='https:')throw new AppError('GIT_SOURCE','Private Git sources require HTTPS');
    if(!allowed.includes(url.hostname)&&(url.hostname==='localhost'||url.hostname.endsWith('.localhost')||url.hostname==='metadata.google.internal'||isIP(url.hostname)!==0))throw new AppError('GIT_SOURCE','Local or IP-based Git hosts require an explicit allowlist');
    for(const path of [source.context,source.dockerfile])if(path.startsWith('/')||path.split(/[\\/]/).includes('..')||path.includes('\0'))throw new AppError('GIT_PATH','Build paths must stay within the repository');
  }
}

export function configurationOf(input: ServiceConfiguration): ServiceConfiguration {
  return {kind:input.kind??'app',source:input.source??{type:'image'},environment:input.environment??[],domains:input.domains,mounts:(input.mounts??[]).map(mount=>({...mount,readOnly:mount.readOnly??mount.type==='file'})),resources:input.resources,database:input.database,databaseAccess:input.databaseAccess,registry:input.registry,ports:input.ports,endpointMode:input.endpointMode,healthcheck:input.healthcheck,deploymentStrategy:input.deploymentStrategy,notes:input.notes};
}

export function parseServicePatch(value:unknown): ServicePatch { return servicePatchSchema.parse(value); }
