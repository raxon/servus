import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Store } from './store.js';
import { AppError } from './errors.js';
import { AgentRequestError } from '../agent/client.js';
import { hostCertificateSchema, hostDomainPattern, isHostApplication, type HostConnection, type HostDomainStatus } from '../shared/host-domain.js';
import { validateHostCertificate } from '../agent/acme/host-certificate-validation.js';
import type { ServiceInput, User } from '../shared/types.js';

export interface HostDomainOptions {apiOrigin:string;automatic?:boolean;fetch?:typeof fetch}
type RuntimeRequest=(path:string,input:unknown,options?:{timeoutMs?:number})=>Promise<unknown>;
const registrySchema=z.object({hostname:z.string().regex(hostDomainPattern),ip:z.string().min(1).max(64),dnsStatus:z.literal('ready')}).strict();
const legacyCertificatePendingMessage='The wildcard certificate is being prepared. Synchronization will retry automatically.';

export function validateHostApiOrigin(input:string):string {
  const url=new URL(input);
  if(url.protocol!=='https:' || url.username || url.password || url.pathname!=='/' || url.search || url.hash)throw new Error('The host domain API must be an HTTPS origin.');
  return url.origin;
}

export function generatedApplicationHostname(project:string,service:string,hostname:string):string {
  if(!hostDomainPattern.test(hostname))throw new Error('Invalid host domain.');
  const raw=`${project}-${service}`;
  const label=raw.length<=63?raw:`${raw.slice(0,50).replace(/-+$/,'')}-${createHash('sha256').update(raw).digest('hex').slice(0,12)}`;
  return `${label}.${hostname}`;
}

export class HostDomainManager {
  private task:Promise<void>|undefined;
  private stopped=false;
  private readonly origin:string|undefined;
  private readonly transport:typeof fetch;
  constructor(private readonly store:Store,private readonly options:HostDomainOptions|undefined,private readonly runtimeRequest:RuntimeRequest,private readonly allowOrigin:(origin:string)=>void,private readonly admit?:()=>undefined|(()=>void)) {
    this.origin=options?validateHostApiOrigin(options.apiOrigin):undefined;
    this.transport=options?.fetch??fetch;
    const saved=store.vault.hostConnection();
    if(saved?.hostname && saved.ready)this.allowOrigin(`https://${saved.hostname}`);
  }
  status():HostDomainStatus {
    const saved=this.store.vault.hostConnection();
    const ready=!!saved?.ready && !!saved.certificateExpiresAt && Date.parse(saved.certificateExpiresAt)>Date.now();
    return {available:!!this.origin,enabled:saved?.enabled??false,ready,busy:!!this.task,...(saved?{hostname:saved.hostname,ip:saved.ip,dnsStatus:saved.dnsStatus,certificateExpiresAt:saved.certificateExpiresAt,staging:saved.staging,lastSyncAt:saved.lastSyncAt,lastError:saved.lastError===legacyCertificatePendingMessage?undefined:saved.lastError}:{})};
  }
  proof(challenge:string):string|undefined {
    const saved=this.store.vault.hostConnection();
    if(!saved?.hostname || !/^[a-f0-9]{64}$/.test(challenge))return undefined;
    return createHmac('sha256',saved.token).update(`servus-host-proof:${challenge}`).digest('hex');
  }
  start(enable=false):void {
    if(this.stopped || this.task || !this.store.isSetup())return;
    const saved=this.store.vault.hostConnection();
    if(!this.origin) {if(enable)throw new AppError('HOST_DOMAINS_UNAVAILABLE','The host domain API has not been configured',503);return;}
    if(!enable && !(saved?.enabled || this.options?.automatic))return;
    if(saved && saved.apiOrigin!==this.origin)throw new AppError('HOST_API_CHANGED','Restore the original host domain API before synchronizing this installation',409);
    const connection:HostConnection=saved??{kind:'servus-host-v1',machineId:randomUUID(),token:randomBytes(32).toString('base64url'),apiOrigin:this.origin,enabled:true,ready:false};
    const release=this.admit?.();
    if(this.admit && !release)return;
    try {this.store.vault.setHostConnection({...connection,enabled:true,lastAttemptAt:new Date().toISOString()});}
    catch(error){release?.();throw error;}
    this.task=this.synchronize().catch(()=>{}).finally(()=>{this.task=undefined;release?.();});
  }
  async tick():Promise<void> {
    const saved=this.store.vault.hostConnection();
    const interval=saved?.ready?6*3_600_000:60_000;
    if(saved?.lastAttemptAt && Date.now()-Date.parse(saved.lastAttemptAt)<interval)return;
    this.start();
  }
  async drain():Promise<void> {this.stopped=true;await this.task;}
  async settled():Promise<void> {await this.task;}
  private save(patch:Partial<HostConnection>):HostConnection {
    const saved=this.store.vault.hostConnection();
    if(!saved)throw new Error('Host identity is missing.');
    const next={...saved,...patch};this.store.vault.setHostConnection(next);return next;
  }
  private async request(operation:string,connection:HostConnection):Promise<unknown> {
    try {
      const response=await this.transport(`${connection.apiOrigin}/api/hosts/${operation}`,{method:'POST',headers:{authorization:`Bearer ${connection.token}`,'content-type':'application/json'},body:JSON.stringify({machineId:connection.machineId}),signal:AbortSignal.timeout(25_000),redirect:'error'});
      if(!response.ok) {
        const body=z.object({error:z.string().regex(/^[A-Z_]{1,80}$/)}).safeParse(await response.json());
        throw new AppError('HOST_REGISTRY_UNAVAILABLE',body.success?`Host registry: ${body.data.error}`:'The host registry is unavailable',503);
      }
      const text=await response.text();
      if(text.length>64*1024)throw new Error();
      return JSON.parse(text);
    } catch(error) {
      if(error instanceof AppError)throw error;
      throw new AppError('HOST_REGISTRY_UNAVAILABLE','The host registry could not be reached securely',503);
    }
  }
  private async synchronize():Promise<void> {
    try {
      let connection=this.store.vault.hostConnection()!;
      const registry=registrySchema.parse(await this.request(connection.hostname?'sync':'register',connection));
      if(connection.hostname && connection.hostname!==registry.hostname)throw new Error('The registry returned a different host domain.');
      connection=this.save({...registry,lastError:undefined});
      const response=await this.request('certificate',connection);
      if(z.object({status:z.literal('pending'),retryAfter:z.number(),error:z.string().optional()}).safeParse(response).success) {
        this.save({lastSyncAt:new Date().toISOString(),lastError:undefined});return;
      }
      const {status,...value}=z.object({status:z.literal('ready'),...hostCertificateSchema.shape}).strict().parse(response);
      if(value.hostname!==connection.hostname)throw new Error('The certificate belongs to another host.');
      validateHostCertificate(value);
      if(!this.store.vault.httpsIngress()) {
        const administrator=this.store.db.prepare("SELECT email FROM users WHERE role='admin' ORDER BY created_at LIMIT 1").get() as {email:string};
        this.store.vault.setHttpsIngress(administrator.email,value.staging);
      }
      const result=await this.runtimeRequest('/host-domain/configure',value,{timeoutMs:400_000});
      z.object({ok:z.literal(true)}).strict().parse(result);
      this.save({certificateExpiresAt:value.expiresAt,staging:value.staging});
      // Enable the exact origin before probing, so an already open browser can recover.
      this.allowOrigin(`https://${value.hostname}`);
      const challenge=randomBytes(32).toString('hex');
      const publicResponse=await this.transport(`https://${value.hostname}/api/v1/host-domain/proof/${challenge}`,{signal:AbortSignal.timeout(10_000),redirect:'error'});
      const proof=z.object({proof:z.string()}).strict().parse(await publicResponse.json());
      if(!publicResponse.ok || proof.proof!==this.proof(challenge))throw new Error('Public HTTPS does not reach this panel.');
      this.save({ready:true,certificateExpiresAt:value.expiresAt,staging:value.staging,lastSyncAt:new Date().toISOString(),lastError:undefined});
    } catch(error) {
      const message=error instanceof AppError?error.message:error instanceof AgentRequestError?this.store.vault.redact(error.message).slice(0,300):'Host DNS or HTTPS could not be verified. Check the ingress and retry.';
      this.save({lastError:message});
    }
  }
}

export function registerHostDomainRoutes(app:FastifyInstance,manager:HostDomainManager,session:(req:FastifyRequest,mutation?:boolean)=>{user:User}) {
  app.get('/api/v1/host-domain',async req=>{session(req);return manager.status();});
  app.post('/api/v1/host-domain/sync',{config:{rateLimit:{max:5,timeWindow:'1 minute'}}},async(req,reply)=>{
    const {user}=session(req,true);
    if(user.role!=='admin')throw new AppError('FORBIDDEN','Administrator access required',403);
    z.object({}).strict().parse(req.body??{});
    manager.start(true);return reply.code(202).send(manager.status());
  });
  app.get<{Params:{challenge:string}}>('/api/v1/host-domain/proof/:challenge',{config:{rateLimit:{max:30,timeWindow:'1 minute'}}},async(req,reply)=>{
    const proof=manager.proof(req.params.challenge);
    return proof?{proof}:reply.code(404).send({error:{code:'NOT_FOUND',message:'Not found'}});
  });
}

/** Only implicit application domains are generated; explicit private/custom routing is retained. */
export function withAutomaticHostDomain(store:Store,projectId:string,raw:unknown):unknown {
  if(!raw || typeof raw!=='object' || Array.isArray(raw))return raw;
  const input=raw as Record<string,unknown>;
  if((input.kind!==undefined && input.kind!=='app') || input.hostname!==undefined || input.domains!==undefined || typeof input.name!=='string')return raw;
  const connection=store.vault.hostConnection(),project=store.getProject(projectId);
  if(!connection?.ready || !connection.hostname || !connection.certificateExpiresAt || Date.parse(connection.certificateExpiresAt)<=Date.now() || !project)return raw;
  return {...input,hostname:generatedApplicationHostname(project.name,input.name,connection.hostname),domains:[{hostname:generatedApplicationHostname(project.name,input.name,connection.hostname),port:input.port??80,primary:true,https:true}]};
}

export function assertHostDomainOwnership(store:Store,input:Pick<ServiceInput,'hostname'|'domains'>):void {
  const own=store.vault.hostConnection()?.hostname;
  for(const hostname of [input.hostname,...(input.domains??[]).map(domain=>domain.hostname)]) {
    if(hostname==='host.servus.run' || hostname.endsWith('.host.servus.run')) {
      if(!own || !isHostApplication(hostname,own))throw new AppError('RESERVED_HOST_DOMAIN','Use an application subdomain assigned to this installation',403);
    }
  }
}
