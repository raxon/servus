import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { composeConfigSchema, composeName, type ComposeAction, type ComposeApplyResult, type ComposeConfiguration, type ComposeOperationType, type ComposeWorkload } from '../shared/compose.js';
import { parseComposeDefinition } from '../agent/compose-configuration.js';
import type { Store } from './store.js';
import type { User } from '../shared/types.js';
import { AppError } from './errors.js';
import { AgentRequestError, type agentRequest } from '../agent/client.js';
import type { MaintenanceGate } from './maintenance.js';
import { canonicalDnsName } from '../agent/acme/dns01.js';

interface Options { store: Store; session: (request: FastifyRequest, mutation?:boolean) => { user: User }; projectAccess: (user: User, projectId: string, write?: boolean) => unknown; agentRequest: typeof agentRequest; agentConnection?: { socketPath: string; token: string }; maintenance?: MaintenanceGate }
interface Row { id: string; project_id: string; name: string; revision: number; deployed_revision: number | null; state: ComposeWorkload['state']; configuration: string; created_at: string; updated_at: string; last_error: string | null; deleted_at: string | null }
interface ActionRow { id:string;workload_id:string;project_id:string;type:ComposeOperationType;status:ComposeAction['status'];revision:number;snapshot:string;request_hash:string;error:string|null;logs:string;created_at:string;updated_at:string }
const now = () => new Date().toISOString();
export interface ComposeCreateInput { projectId:string;user:User;name:string;configuration:unknown;key:string;requestHash?:string }
const retrySchema=z.object({hostname:z.string().min(1).max(253)}).strict();
const jobSchema=z.object({configuration:composeConfigSchema,certificateRetry:retrySchema}).strict();
const readSnapshot=(value:unknown)=>jobSchema.safeParse(value).success?jobSchema.parse(value):{configuration:composeConfigSchema.parse(value)};
const certificateCommon={hostname:z.string().min(1).max(253),checkedAt:z.string().datetime(),publicVerified:z.boolean(),eventsAvailable:z.boolean(),lastFailure:z.object({observedAt:z.string().datetime(),operation:z.enum(['issuance','renewal']),category:z.enum(['dns','rate_limit','contact','challenge','other'])}).strict().optional()};
const certificateSchema=z.discriminatedUnion('status',[
  z.object({...certificateCommon,status:z.literal('not_found')}).strict(),
  z.object({...certificateCommon,status:z.enum(['active','expired','not_yet_valid']),notBefore:z.string().datetime(),expiresAt:z.string().datetime(),fingerprint:z.string().regex(/^(?:[A-F0-9]{2}:){31}[A-F0-9]{2}$/)}).strict(),
]);

export function registerCompose(app: FastifyInstance, options: Options) {
  const { store } = options, db = store.db, workerId = randomUUID();
  let running = false, closing = false, active: Promise<void> | undefined;
  const config = (row:Row) => composeConfigSchema.parse(JSON.parse(store.vault.open(row.configuration)));
  const workload = (row:Row):ComposeWorkload => ({id:row.id,projectId:row.project_id,name:row.name,revision:row.revision,deployedRevision:row.deployed_revision,state:row.state,sourceType:config(row).source.type,domains:config(row).domains,createdAt:row.created_at,updatedAt:row.updated_at,lastError:row.last_error});
  const action = (row:ActionRow):ComposeAction => ({id:row.id,workloadId:row.workload_id,projectId:row.project_id,type:row.type,status:row.status,revision:row.revision,error:row.error,logs:row.logs,createdAt:row.created_at,updatedAt:row.updated_at});
  const get = (id:string,request:FastifyRequest,write=false,includeDeleted=false) => {
    const user = options.session(request,!['GET','HEAD','OPTIONS'].includes(request.method)).user;
    const row = db.prepare(`SELECT * FROM compose_workloads WHERE id=? ${includeDeleted ? '' : 'AND deleted_at IS NULL'}`).get(z.string().uuid().parse(id)) as Row | undefined;
    if (!row) throw new AppError('NOT_FOUND','Compose workload not found',404);
    options.projectAccess(user,row.project_id,write); return {row,user};
  };
  const reserve = (id:string,domains:ComposeConfiguration['domains']) => {
    for (const domain of domains) {
      if (db.prepare('SELECT 1 FROM domain_reservations WHERE hostname=?').get(domain.hostname)) throw new AppError('DOMAIN_CONFLICT','This domain belongs to another service',409);
      const previous = db.prepare('SELECT workload_id FROM compose_domains WHERE hostname=?').get(domain.hostname) as {workload_id:string}|undefined;
      if (previous && previous.workload_id !== id) throw new AppError('DOMAIN_CONFLICT','This domain belongs to another Compose workload',409);
      db.prepare('INSERT OR IGNORE INTO compose_domains VALUES(?,?)').run(domain.hostname,id);
    }
  };
  const validate = (configuration:ComposeConfiguration) => {
    for(const domain of configuration.domains.filter(item=>item.https)) {
      try{if(canonicalDnsName(domain.hostname)!==domain.hostname||domain.hostname.endsWith('.localhost'))throw new Error();}
      catch{throw new AppError('INVALID_HTTPS_DOMAIN','Compose HTTPS requires a canonical public hostname',400);}
    }
    if (new Set(configuration.domains.map(item=>item.hostname)).size !== configuration.domains.length) throw new AppError('DUPLICATE_DOMAIN','Compose domains must be unique',400);
    if (configuration.source.type === 'inline') {
      let definition;
      try { definition = parseComposeDefinition(configuration.source.yaml); } catch(error) { throw new AppError('INVALID_COMPOSE',error instanceof Error?error.message:'Invalid Compose source',400); }
      for (const domain of configuration.domains) if (!Object.hasOwn(definition.services,domain.service)) throw new AppError('INVALID_COMPOSE','Domain target must name a Compose service',400);
    }
  };
  const enqueue = (row:Row,type:ComposeOperationType,user:User,key:string,creationHash?:string,override?:{snapshot:string;revision:number}) => db.transaction(()=>{
    const hash=creationHash??createHash('sha256').update(JSON.stringify({workloadId:row.id,type})).digest('hex');
    const existing=db.prepare('SELECT * FROM compose_actions WHERE actor_id=? AND idempotency_key=?').get(user.id,key) as ActionRow|undefined;
    if(existing){if(existing.request_hash!==hash)throw new AppError('IDEMPOTENCY_CONFLICT','This key was used for another Compose operation',409);return action(existing);}
    if(db.prepare("SELECT 1 FROM compose_actions WHERE workload_id=? AND status IN ('queued','running')").get(row.id))throw new AppError('COMPOSE_BUSY','Another Compose operation is queued or running',409);
    if(type!=='deploy'&&type!=='destroy'&&row.deployed_revision===null)throw new AppError('COMPOSE_NOT_DEPLOYED','Deploy this workload first',409);
    const id=randomUUID(),timestamp=now();
    db.prepare("INSERT INTO compose_actions(id,workload_id,project_id,actor_id,type,status,revision,snapshot,request_hash,idempotency_key,created_at,updated_at) VALUES(?,?,?,?,?,'queued',?,?,?,?,?,?)").run(id,row.id,row.project_id,user.id,type,override?.revision??row.revision,override?.snapshot??row.configuration,hash,key,timestamp,timestamp);
    store.recordAudit(user.id,`compose.${type}`,row.id);
    return action(db.prepare('SELECT * FROM compose_actions WHERE id=?').get(id) as ActionRow);
  }).immediate();
  async function processQueue() {
    if(running||closing)return;
    const release=options.maintenance?.admit();if(options.maintenance&&!release)return;
    running=true;
    let heartbeat:ReturnType<typeof setInterval>|undefined;
    try {
      const row=db.transaction(()=>{
        const item=db.prepare("SELECT * FROM compose_actions WHERE status='queued' OR(status='running' AND lease_until<=?) ORDER BY created_at,rowid LIMIT 1").get(now()) as ActionRow|undefined;
        if(!item)return undefined;
        db.prepare("UPDATE compose_actions SET status='running',worker_id=?,lease_until=?,updated_at=? WHERE id=?").run(workerId,new Date(Date.now()+60_000).toISOString(),now(),item.id);
        return item;
      }).immediate();
      if(!row)return;
      heartbeat=setInterval(()=>{db.prepare("UPDATE compose_actions SET lease_until=? WHERE id=? AND worker_id=? AND status='running' AND lease_until>?").run(new Date(Date.now()+60_000).toISOString(),row.id,workerId,now());},15_000);
      const snapshot=readSnapshot(JSON.parse(store.vault.open(row.snapshot))),configuration=snapshot.configuration;
      try {
        const result=await options.agentRequest<ComposeApplyResult>('/compose/apply',{operationId:row.id,workloadId:row.workload_id,projectId:row.project_id,revision:row.revision,type:row.type,configuration,...('certificateRetry' in snapshot?{certificateRetry:snapshot.certificateRetry}:{})},{...options.agentConnection,timeoutMs:300_000});
        const parsed=z.object({state:z.enum(['running','stopped','deleted']),revision:z.number().int().positive(),logs:z.string().max(32000)}).strict().parse(result);
        db.transaction(()=>{
          if(!db.prepare("SELECT 1 FROM compose_actions WHERE id=? AND worker_id=? AND status='running' AND lease_until>?").get(row.id,workerId,now()))return;
          db.prepare("UPDATE compose_actions SET status='succeeded',logs=?,updated_at=?,lease_until=NULL WHERE id=?").run(store.vault.redact(parsed.logs),now(),row.id);
          db.prepare('UPDATE compose_workloads SET state=?,deployed_revision=?,updated_at=?,last_error=NULL,deleted_at=? WHERE id=?').run(parsed.state,parsed.revision,now(),parsed.state==='deleted'?now():null,row.workload_id);
          if(parsed.state==='deleted')db.prepare('DELETE FROM compose_domains WHERE workload_id=?').run(row.workload_id);
          else if(row.type==='deploy') {
            const current=db.prepare('SELECT * FROM compose_workloads WHERE id=?').get(row.workload_id) as Row;
            db.prepare('DELETE FROM compose_domains WHERE workload_id=?').run(row.workload_id);reserve(row.workload_id,[...configuration.domains,...config(current).domains]);
          }
        }).immediate();
      } catch(error) {
        const uncertain=error instanceof AgentRequestError&&(error.certainty==='uncertain'||error.code==='SERVICE_BUSY');
        if(uncertain)db.prepare("UPDATE compose_actions SET lease_until=?,worker_id=NULL WHERE id=? AND worker_id=? AND status='running' AND lease_until>?").run(new Date(Date.now()+5000).toISOString(),row.id,workerId,now());
        else {
          const message=store.vault.redact(error instanceof Error?error.message:'Compose operation failed').slice(0,4000);
          db.transaction(()=>{const changed=db.prepare("UPDATE compose_actions SET status='failed',error=?,updated_at=?,lease_until=NULL WHERE id=? AND worker_id=? AND status='running' AND lease_until>?").run(message,now(),row.id,workerId,now());if(changed.changes===1)db.prepare("UPDATE compose_workloads SET state='failed',last_error=?,updated_at=? WHERE id=?").run(message,now(),row.workload_id);}).immediate();
        }
      }
    } finally {if(heartbeat)clearInterval(heartbeat);running=false;release?.();}
  }
  const wake=()=>{if(!running&&!closing){active=processQueue();void active.catch(()=>options.maintenance?.markUncertain('handler'));}};
  const timer=setInterval(wake,1000);timer.unref();
  app.addHook('onClose',async()=>{closing=true;clearInterval(timer);await active;});

  const createWorkload=(input:ComposeCreateInput)=>{
    const projectId=z.string().uuid().parse(input.projectId),user=input.user,name=composeName.parse(input.name),configuration=composeConfigSchema.parse(input.configuration),key=z.string().min(1).max(128).parse(input.key);
    options.projectAccess(user,projectId,true);validate(configuration);
    const creationHash=input.requestHash?z.string().regex(/^[a-f0-9]{64}$/).parse(input.requestHash):createHash('sha256').update(JSON.stringify({projectId,name,configuration})).digest('hex');
    const result=db.transaction(()=>{
      const duplicate=db.prepare('SELECT * FROM compose_actions WHERE actor_id=? AND idempotency_key=?').get(user.id,key) as ActionRow|undefined;
      if(duplicate){if(duplicate.request_hash!==creationHash)throw new AppError('IDEMPOTENCY_CONFLICT','This key was used for another Compose request',409);return{workload:workload(db.prepare('SELECT * FROM compose_workloads WHERE id=?').get(duplicate.workload_id) as Row),action:action(duplicate)};}
      const id=randomUUID(),timestamp=now();
      try{db.prepare("INSERT INTO compose_workloads(id,project_id,name,revision,state,configuration,created_at,updated_at) VALUES(?,?,?,1,'pending',?,?,?)").run(id,projectId,name,store.vault.seal(JSON.stringify(configuration)),timestamp,timestamp);}catch{throw new AppError('NAME_CONFLICT','This Compose name is already used in the project',409);}
      reserve(id,configuration.domains);const row=db.prepare('SELECT * FROM compose_workloads WHERE id=?').get(id) as Row;
      return{workload:workload(row),action:enqueue(row,'deploy',user,key,creationHash)};
    }).immediate();wake();return result;
  };
  app.get<{Params:{id:string}}>('/api/v1/projects/:id/compose',async request=>{const{user}=options.session(request);options.projectAccess(user,request.params.id);return(db.prepare('SELECT * FROM compose_workloads WHERE project_id=? AND deleted_at IS NULL ORDER BY created_at').all(request.params.id) as Row[]).map(workload);});
  app.post<{Params:{id:string}}>('/api/v1/projects/:id/compose',async(request,reply)=>{
    const{user}=options.session(request,true),{name,...configuration}=composeConfigSchema.extend({name:composeName}).strict().parse(request.body);
    return reply.code(202).send(createWorkload({projectId:request.params.id,user,name,configuration,key:z.string().min(1).max(128).parse(request.headers['idempotency-key'])}));
  });
  app.get<{Params:{id:string}}>('/api/v1/compose/:id',async request=>workload(get(request.params.id,request).row));
  app.get<{Params:{id:string}}>('/api/v1/compose/:id/configuration',async request=>{const{row,user}=get(request.params.id,request,true);store.recordAudit(user.id,'compose.configuration.reveal',row.id);return config(row);});
  const deployedConfiguration=(id:string)=>{
    const latest=db.prepare("SELECT snapshot,revision FROM compose_actions WHERE workload_id=? AND type='deploy' AND status='succeeded' ORDER BY updated_at DESC,rowid DESC LIMIT 1").get(id) as {snapshot:string;revision:number}|undefined;
    if(!latest)throw new AppError('COMPOSE_NOT_DEPLOYED','Deploy the HTTPS domain before checking or retrying its certificate',409);
    return {configuration:readSnapshot(JSON.parse(store.vault.open(latest.snapshot))).configuration,revision:latest.revision};
  };
  const certificateDomain=(configuration:ComposeConfiguration,hostname:string)=>{
    let host:string;try{host=canonicalDnsName(hostname);}catch{throw new AppError('CERTIFICATE_DOMAIN','Enter a canonical public hostname',400);}
    if(host!==hostname||!configuration.domains.some(domain=>domain.hostname===host&&domain.https))throw new AppError('CERTIFICATE_DOMAIN','This domain is not deployed with automatic HTTPS on this Compose workload',400);
    return host;
  };
  app.post<{Params:{id:string}}>('/api/v1/compose/:id/check-managed-certificate',{config:{rateLimit:{max:20,timeWindow:'1 minute'}}},async request=>{
    const{row}=get(request.params.id,request,true),input=retrySchema.parse(request.body),deployed=deployedConfiguration(row.id);
    const hostname=certificateDomain(deployed.configuration,input.hostname);
    const result=await options.agentRequest(`/compose/${row.id}/certificate`,{projectId:row.project_id,hostname},{...options.agentConnection,timeoutMs:30_000});
    get(request.params.id,request,true);
    const parsed=certificateSchema.safeParse(result);
    if(!parsed.success||parsed.data.hostname!==hostname)throw new AppError('CERTIFICATE_UNAVAILABLE','Compose certificate status could not be verified',503);
    return parsed.data;
  });
  app.post<{Params:{id:string}}>('/api/v1/compose/:id/retry-certificate',{config:{rateLimit:{max:5,timeWindow:'1 minute'}}},async(request,reply)=>{
    const{row,user}=get(request.params.id,request,true),input=retrySchema.parse(request.body),deployed=deployedConfiguration(row.id);
    const hostname=certificateDomain(deployed.configuration,input.hostname),key=z.string().min(1).max(128).parse(request.headers['idempotency-key']);
    const snapshot=store.vault.seal(JSON.stringify({configuration:deployed.configuration,certificateRetry:{hostname}}));
    const hash=createHash('sha256').update(JSON.stringify({workloadId:row.id,type:'retry-certificate',hostname})).digest('hex');
    const queued=enqueue(row,'deploy',user,key,hash,{snapshot,revision:deployed.revision});wake();return reply.code(202).send(queued);
  });
  app.patch<{Params:{id:string}}>('/api/v1/compose/:id',async request=>{
    const{row}=get(request.params.id,request,true),input=composeConfigSchema.extend({expectedRevision:z.number().int().positive()}).strict().parse(request.body),{expectedRevision,...configuration}=input;validate(configuration);
    return db.transaction(()=>{
      const latest=db.prepare('SELECT * FROM compose_workloads WHERE id=?').get(row.id) as Row;
      if(latest.revision!==expectedRevision)throw new AppError('REVISION_CONFLICT','Configuration changed. Reload before saving.',409);
      reserve(row.id,configuration.domains);db.prepare('UPDATE compose_workloads SET configuration=?,revision=revision+1,updated_at=? WHERE id=?').run(store.vault.seal(JSON.stringify(configuration)),now(),row.id);
      return workload(db.prepare('SELECT * FROM compose_workloads WHERE id=?').get(row.id) as Row);
    }).immediate();
  });
  for(const type of ['deploy','start','stop','restart','destroy'] as const)app.post<{Params:{id:string}}>(`/api/v1/compose/:id/${type}`,async(request,reply)=>{const{row,user}=get(request.params.id,request,true);if(type==='destroy')z.object({confirm:z.literal(true)}).strict().parse(request.body);const key=z.string().min(1).max(128).parse(request.headers['idempotency-key']);const queued=enqueue(row,type,user,key);wake();return reply.code(202).send(queued);});
  app.get<{Params:{id:string}}>('/api/v1/compose/:id/actions',async request=>{get(request.params.id,request,false,true);return(db.prepare('SELECT * FROM compose_actions WHERE workload_id=? ORDER BY created_at DESC,rowid DESC LIMIT 100').all(request.params.id) as ActionRow[]).map(action);});
  for(const type of ['logs','containers'] as const)app.get<{Params:{id:string}}>(`/api/v1/compose/:id/${type}`,async request=>{const{row}=get(request.params.id,request);const result=await options.agentRequest(`/compose/${row.id}/${type}?projectId=${row.project_id}`,undefined,options.agentConnection);get(request.params.id,request);return result;});
  return {wake,processQueue,createWorkload};
}
