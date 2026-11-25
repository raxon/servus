import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { User } from '../shared/types.js';
import type { Store } from './store.js';
import { AppError } from './errors.js';

export const API_TOKEN_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS api_tokens (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id), name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE, scope TEXT NOT NULL CHECK(scope IN ('read','deploy')),
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL, last_used_at TEXT, revoked_at TEXT
);`;
interface TokenIdentity { id: string; projectId: string; scope: 'read'|'deploy'; user: User }
const fingerprint = (value:string) => createHash('sha256').update(value).digest('hex');

/** Bearer credentials grant a small HTTP surface for one project, with live membership checks. */
export class ApiTokens {
  private identities = new WeakMap<FastifyRequest,TokenIdentity>();
  constructor(private store: Store) {}
  current(request:FastifyRequest) { return this.identities.get(request); }
  revokeUser(userId:string) { this.store.db.prepare('UPDATE api_tokens SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL').run(new Date().toISOString(),userId); }
  authenticate(request:FastifyRequest): {user:User;csrfToken:string} {
    const header=request.headers.authorization;
    if(typeof header!=='string'||!/^Bearer srv_[a-f0-9]{64}$/.test(header)||request.cookies.panel_session)
      throw new AppError('UNAUTHORIZED','Use one valid Bearer token without a session cookie',401);
    const row=this.store.db.prepare(`SELECT t.id,t.project_id AS projectId,t.scope,u.id AS userId,u.email,u.role,u.created_at AS createdAt
      FROM api_tokens t JOIN users u ON u.id=t.user_id
      WHERE t.token_hash=? AND t.revoked_at IS NULL AND t.expires_at>?`).get(fingerprint(header.slice(7)),new Date().toISOString()) as
      {id:string;projectId:string;scope:'read'|'deploy';userId:string;email:string;role:User['role'];createdAt:string}|undefined;
    if(!row)throw new AppError('UNAUTHORIZED','API token is invalid, expired or revoked',401);
    const user:User={id:row.userId,email:row.email,role:row.role,createdAt:row.createdAt};
    const route=request.routeOptions.url??'',params=request.params as Record<string,string>;
    const read=request.method==='GET'||(request.method==='HEAD'&&route==='/api/v1/compose/:id/actions'),write=request.method==='POST'||request.method==='PATCH'||request.method==='PUT';
    let projectId:string|undefined;
    if(read&&route==='/api/v1/projects')projectId=row.projectId;
    else if((read&&['/api/v1/projects/:id','/api/v1/projects/:id/services','/api/v1/projects/:id/compose','/api/v1/projects/:id/env','/api/v1/projects/:id/scripts'].includes(route))||
      (request.method==='POST'&&route==='/api/v1/projects/:id/compose')||
      (request.method==='PUT'&&route==='/api/v1/projects/:id/env')||
      (request.method==='POST'&&route==='/api/v1/projects/:id/scripts/:scriptId/run'))projectId=params.id;
    else if(read&&route==='/api/v1/openapi.json')projectId=row.projectId;
    else if((read&&['/api/v1/services/:id','/api/v1/services/:id/actions','/api/v1/services/:id/metrics','/api/v1/services/:id/metrics/history','/api/v1/services/:id/containers','/api/v1/services/:id/logs','/api/v1/services/:id/logs/history','/api/v1/services/:id/backups'].includes(route))||
      (request.method==='POST'&&['/api/v1/services/:id/deploy','/api/v1/services/:id/start','/api/v1/services/:id/stop','/api/v1/services/:id/restart','/api/v1/services/:id/backups'].includes(route))||
      (request.method==='PATCH'&&route==='/api/v1/services/:id'))
      projectId=this.store.getService(params.id!)?.projectId;
    else if((read&&['/api/v1/actions/:id','/api/v1/actions/:id/build-log'].includes(route))||(request.method==='POST'&&route==='/api/v1/actions/:id/cancel'))projectId=this.store.getAction(params.id!)?.projectId;
    else if((read&&['/api/v1/compose/:id','/api/v1/compose/:id/actions','/api/v1/compose/:id/logs','/api/v1/compose/:id/metrics'].includes(route))||
      (request.method==='PATCH'&&route==='/api/v1/compose/:id')||
      (request.method==='POST'&&['/api/v1/compose/:id/deploy','/api/v1/compose/:id/start','/api/v1/compose/:id/stop','/api/v1/compose/:id/restart','/api/v1/compose/:id/destroy'].includes(route)))
      projectId=(this.store.db.prepare(`SELECT project_id FROM compose_workloads WHERE id=? ${read&&route==='/api/v1/compose/:id/actions'?'':'AND deleted_at IS NULL'}`).get(params.id!) as {project_id:string}|undefined)?.project_id;
    else throw new AppError('TOKEN_SCOPE','This endpoint requires an interactive session',403);
    if(projectId!==row.projectId||!this.store.canAccess(user,row.projectId,!read))throw new AppError('NOT_FOUND','Resource not found',404);
    if(!read&&row.scope!=='deploy')throw new AppError('TOKEN_SCOPE','This token only allows reading',403);
    this.identities.set(request,{id:row.id,projectId:row.projectId,scope:row.scope,user});
    this.store.db.prepare('UPDATE api_tokens SET last_used_at=? WHERE id=?').run(new Date().toISOString(),row.id);
    return {user,csrfToken:''};
  }
  register(app:FastifyInstance,session:(req:FastifyRequest,mutation?:boolean)=>{user:User;csrfToken:string}) {
    app.get('/api/v1/auth/api-tokens',async req=>{
      const {user}=session(req);
      return {tokens:this.store.db.prepare(`SELECT id,project_id AS projectId,name,scope,created_at AS createdAt,expires_at AS expiresAt,last_used_at AS lastUsedAt,revoked_at AS revokedAt
        FROM api_tokens WHERE user_id=? ORDER BY created_at DESC`).all(user.id)};
    });
    app.post('/api/v1/auth/api-tokens',{config:{rateLimit:{max:10,timeWindow:'1 minute'}}},async(req,reply)=>{
      const {user}=session(req,true);
      const input=z.object({projectId:z.string().uuid(),name:z.string().trim().min(1).max(80),scope:z.enum(['read','deploy']).default('read'),expiresInDays:z.number().int().min(1).max(365).default(30)}).strict().parse(req.body);
      if(!this.store.canAccess(user,input.projectId,input.scope==='deploy'))throw new AppError('NOT_FOUND','Project not found',404);
      const token=`srv_${randomBytes(32).toString('hex')}`,id=randomUUID(),createdAt=new Date().toISOString(),expiresAt=new Date(Date.now()+input.expiresInDays*86_400_000).toISOString();
      this.store.db.transaction(()=>{
        const active=this.store.db.prepare('SELECT count(*) AS n FROM api_tokens WHERE user_id=? AND revoked_at IS NULL AND expires_at>?').get(user.id,createdAt) as {n:number};
        if(active.n>=50)throw new AppError('TOKEN_LIMIT','Revoke an existing token before creating another',409);
        this.store.db.prepare('INSERT INTO api_tokens(id,user_id,project_id,name,token_hash,scope,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?)').run(id,user.id,input.projectId,input.name,fingerprint(token),input.scope,createdAt,expiresAt);
        this.store.recordAudit(user.id,'api-token.create',id);
      }).immediate();
      return reply.code(201).send({id,token,projectId:input.projectId,name:input.name,scope:input.scope,createdAt,expiresAt});
    });
    app.delete<{Params:{id:string}}>('/api/v1/auth/api-tokens/:id',async req=>{
      const {user}=session(req,true),id=z.string().uuid().parse(req.params.id);
      const result=this.store.db.prepare('UPDATE api_tokens SET revoked_at=COALESCE(revoked_at,?) WHERE id=? AND user_id=?').run(new Date().toISOString(),id,user.id);
      if(!result.changes)throw new AppError('NOT_FOUND','Token not found',404);
      this.store.recordAudit(user.id,'api-token.revoke',id);return {success:true};
    });
    app.get('/api/v1/openapi.json',async req=>{session(req);return publicApiDocument();});
  }
}

export function publicApiDocument() {
  const parameter=(name:string)=>({name,in:'path',required:true,schema:{type:'string',format:'uuid'}});
  const get=(summary:string,parameters:unknown[]=[])=>({summary,parameters,security:[{bearerAuth:[]}],responses:{'200':{description:'Authorized result'},'401':{description:'Invalid token'},'404':{description:'Resource unavailable'}}});
  const paths:Record<string,unknown>={
    '/projects':{get:get('List the token project')},
    '/projects/{id}':{get:get('Inspect a project',[parameter('id')])},
    '/projects/{id}/services':{get:get('List project services',[parameter('id')])},
    '/projects/{id}/compose':{get:get('List project Compose workloads with source contents omitted',[parameter('id')]),post:{summary:'Create and deploy a Compose workload; requires deploy scope',security:[{bearerAuth:[]}],parameters:[parameter('id'),{name:'Idempotency-Key',in:'header',required:true,schema:{type:'string',minLength:1,maxLength:128}}],responses:{'202':{description:'Compose workload created and deployment queued'},'403':{description:'Insufficient scope'},'409':{description:'Name, domain or idempotency conflict'}}}},
    '/projects/{id}/env':{get:get('List shared project environment variables with secret values masked',[parameter('id')]),put:{summary:'Save shared project environment variables; requires deploy scope',security:[{bearerAuth:[]}],parameters:[parameter('id')],responses:{'200':{description:'Updated shared environment variables'},'403':{description:'Insufficient scope'}}}},
    '/projects/{id}/scripts':{get:get('List saved project operational scripts',[parameter('id')])},
    '/projects/{id}/scripts/{scriptId}/run':{post:{summary:'Run a saved operational script inside a running service container; requires deploy scope',security:[{bearerAuth:[]}],parameters:[parameter('id'),parameter('scriptId')],responses:{'200':{description:'Script execution output and exit code'},'403':{description:'Insufficient scope'}}}},
  };
  for(const suffix of ['', '/actions','/metrics','/containers','/logs','/backups'])paths[`/services/{id}${suffix}`]={get:get(`Read service${suffix||' configuration'}`,[parameter('id')])};
  paths['/services/{id}']={...(paths['/services/{id}'] as Record<string,unknown>),patch:{summary:'Update saved service configuration with optimistic locking; requires deploy scope',security:[{bearerAuth:[]}],parameters:[parameter('id')],responses:{'200':{description:'Updated service configuration'},'403':{description:'Insufficient scope'},'409':{description:'Revision or domain conflict'}}}};
  paths['/services/{id}/backups']={...(paths['/services/{id}/backups'] as Record<string,unknown>),post:{summary:'Queue a manual database backup; requires deploy scope',security:[{bearerAuth:[]}],parameters:[parameter('id'),{name:'Idempotency-Key',in:'header',required:true,schema:{type:'string',minLength:1,maxLength:128}}],responses:{'202':{description:'Durable database backup queued'},'403':{description:'Insufficient scope'},'409':{description:'Idempotency conflict or backup busy'}}}};
  paths['/services/{id}/metrics/history']={get:get('Read historical service metrics',[parameter('id'),{name:'window',in:'query',required:false,schema:{type:'string',enum:['1h','6h','24h'],default:'1h'}}])};
  paths['/services/{id}/logs/history']={get:get('Search archived service logs',[parameter('id'),{name:'window',in:'query',required:false,schema:{type:'string',enum:['1h','6h','24h','7d'],default:'24h'}},{name:'q',in:'query',required:false,schema:{type:'string',maxLength:200}},{name:'level',in:'query',required:false,schema:{type:'string',enum:['all','error','warn','info'],default:'all'}},{name:'limit',in:'query',required:false,schema:{type:'integer',minimum:1,maximum:500,default:200}}])};
  for(const suffix of ['', '/build-log'])paths[`/actions/{id}${suffix}`]={get:get('Inspect deployment action',[parameter('id')])};
  paths['/actions/{id}/cancel']={post:{summary:'Cancel a queued action or active build; requires deploy scope',security:[{bearerAuth:[]}],parameters:[parameter('id')],responses:{'200':{description:'Queued action cancelled'},'202':{description:'Active build cancellation requested'},'403':{description:'Insufficient scope'},'409':{description:'Action can no longer be cancelled'}}}};
  for(const suffix of ['', '/actions','/logs','/metrics'])paths[`/compose/{id}${suffix}`]={get:get(`Read Compose workload${suffix||' metadata; source contents omitted'}`,[parameter('id')])};
  paths['/compose/{id}']={...(paths['/compose/{id}'] as Record<string,unknown>),patch:{summary:'Update saved Compose workload configuration with optimistic locking; requires deploy scope',security:[{bearerAuth:[]}],parameters:[parameter('id')],responses:{'200':{description:'Updated Compose workload metadata'},'403':{description:'Insufficient scope'},'409':{description:'Revision or domain conflict'}}}};
  for(const operation of ['deploy','start','stop','restart','destroy'])paths[`/compose/{id}/${operation}`]={post:{summary:`Queue Compose ${operation}; requires deploy scope`,security:[{bearerAuth:[]}],parameters:[parameter('id'),{name:'Idempotency-Key',in:'header',required:true,schema:{type:'string',minLength:1,maxLength:128}}],...(operation==='destroy'?{requestBody:{required:true,content:{'application/json':{schema:{type:'object',required:['confirm'],additionalProperties:false,properties:{confirm:{type:'boolean',const:true}}}}}}}:{}),responses:{'202':{description:'Durable Compose action; poll /compose/{id}/actions'},'403':{description:'Insufficient scope'},'404':{description:'Resource unavailable'},'409':{description:'Idempotency conflict or workload busy'}}}};
  for(const operation of ['deploy','start','stop','restart'])paths[`/services/{id}/${operation}`]={post:{summary:`Queue ${operation}; requires deploy scope`,security:[{bearerAuth:[]}],parameters:[parameter('id'),{name:'Idempotency-Key',in:'header',required:true,schema:{type:'string',minLength:1,maxLength:128}}],...(operation==='deploy'?{requestBody:{required:false,content:{'application/json':{schema:{type:'object',additionalProperties:false,properties:{forceRebuild:{type:'boolean'}}}}}}}:{}),responses:{'202':{description:'Durable action; poll /actions/{id}'},'403':{description:'Insufficient scope'},'409':{description:'Idempotency conflict or service busy'}}}};
  return {openapi:'3.1.0',info:{title:'Servus project API',version:'1.0.0'},servers:[{url:'/api/v1'}],components:{securitySchemes:{bearerAuth:{type:'http',scheme:'bearer',description:'Project-scoped read or deploy token. The owner must retain project access.'}}},paths};
}
