import { isIP } from 'node:net';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import type { ServiceConfiguration, ServiceInput, ServicePatch } from '../shared/types.js';
import { AppError } from './errors.js';

export const nameSchema = z.string().min(1).max(63).regex(/^[a-z0-9][a-z0-9-]*$/, 'Use lowercase letters, numbers and hyphens');
const imageSchema = z.string().min(1).max(300).regex(/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/,'Enter a valid image reference');
export const hostnameSchema = z.string().min(1).max(253).toLowerCase().refine(value=>value.split('.').every(label=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)),'Enter valid DNS labels without protocol or port');
const targetSchema = z.string().min(2).max(255).refine(value=>value.startsWith('/')&&!value.includes('\0')&&!value.split('/').includes('..')&&value!=='/'&&!value.startsWith('/var/run/docker.sock')&&!value.startsWith('/proc')&&!value.startsWith('/sys'),'Use an absolute container path outside protected directories');
const kindSchema = z.enum(['app','postgres','redis','mariadb']);
const sourceSchema = z.discriminatedUnion('type',[
  z.object({type:z.literal('image')}).strict(),
  z.object({type:z.literal('git'),repository:z.string().url().max(1000),branch:z.string().min(1).max(200).regex(/^[^\s\x00-\x1f~^:?*\[\\]+$/),context:z.string().max(255).default('.'),dockerfile:z.string().max(255).default('Dockerfile')}).strict(),
]);
const envSchema = z.object({name:z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(128),value:z.string().max(32000).optional(),secret:z.boolean().optional(),secretRef:z.string().uuid().optional()}).strict();
const domainSchema = z.object({hostname:hostnameSchema,port:z.number().int().min(1).max(65535),primary:z.boolean().optional()}).strict();
const mountSchema = z.object({type:z.enum(['volume','file','bind']),name:nameSchema,target:targetSchema,readOnly:z.boolean().optional(),content:z.string().max(32000).optional(),source:z.string().max(1000).optional()}).strict();
const resourcesSchema = z.object({cpu:z.number().min(0.1).max(64),memoryMb:z.number().int().min(32).max(131072)}).strict();
const databaseSchema = z.object({database:z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/).max(63),user:z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/).max(63),password:z.string().min(12).max(128).optional(),passwordSecretRef:z.string().uuid().optional()}).strict();
const fields={kind:kindSchema.optional(),source:sourceSchema.optional(),environment:z.array(envSchema).max(100).optional(),domains:z.array(domainSchema).max(20).optional(),mounts:z.array(mountSchema).max(20).optional(),resources:resourcesSchema.optional(),database:databaseSchema.optional()};
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
  const unique=(values:string[],name:string)=>{if(new Set(values).size!==values.length)throw new AppError('DUPLICATE_CONFIG',`${name} must be unique`);};
  unique((config.environment??[]).map(item=>item.name),'Environment names');
  unique((config.domains??[]).map(item=>item.hostname),'Domain hostnames');
  unique((config.mounts??[]).map(item=>item.name),'Mount names');
  unique((config.mounts??[]).map(item=>item.target),'Mount target paths');
  if((config.domains??[]).filter(domain=>domain.primary).length>1)throw new AppError('MULTIPLE_PRIMARY_DOMAINS','Only one domain can be primary');
  if(kind!=='app'&&(config.replicas??1)!==1)throw new AppError('STATEFUL_REPLICAS','Database services require exactly one replica');
  if((config.replicas??1)>1&&(config.mounts??[]).some(mount=>!(mount.readOnly??(mount.type==='file'))))throw new AppError('STATEFUL_REPLICAS','Writable mounts require exactly one replica');
  if(kind!=='app'&&config.domains?.length)throw new AppError('DATABASE_ROUTING','Database services do not expose HTTP domains');
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
    if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw new AppError('GIT_SOURCE','Only public HTTP(S) Git sources without credentials, query strings or fragments are supported');
    const allowed=(process.env.PANEL_GIT_HTTP_HOSTS??'').split(',').map(item=>item.trim()).filter(Boolean);
    if(url.protocol==='http:'&&!allowed.includes(url.hostname))throw new AppError('GIT_SOURCE','HTTP Git sources require an explicit local-test allowlist');
    if(!allowed.includes(url.hostname)&&(url.hostname==='localhost'||url.hostname.endsWith('.localhost')||url.hostname==='metadata.google.internal'||isIP(url.hostname)!==0))throw new AppError('GIT_SOURCE','Local or IP-based Git hosts require an explicit allowlist');
    for(const path of [source.context,source.dockerfile])if(path.startsWith('/')||path.split(/[\\/]/).includes('..')||path.includes('\0'))throw new AppError('GIT_PATH','Build paths must stay within the repository');
  }
}

export function configurationOf(input: ServiceConfiguration): ServiceConfiguration {
  return {kind:input.kind??'app',source:input.source??{type:'image'},environment:input.environment??[],domains:input.domains,mounts:(input.mounts??[]).map(mount=>({...mount,readOnly:mount.readOnly??mount.type==='file'})),resources:input.resources,database:input.database};
}

export function parseServicePatch(value:unknown): ServicePatch { return servicePatchSchema.parse(value); }
