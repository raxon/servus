import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Service, SessionResponse } from '../shared/types.js';
import type { Store } from './store.js';
import { AppError } from './errors.js';

export const WEBHOOK_SCHEMA_SQL=`CREATE TABLE IF NOT EXISTS deployment_webhooks (
  service_id TEXT PRIMARY KEY REFERENCES services(id), actor_id TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE, secret TEXT NOT NULL, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), created_at TEXT NOT NULL
);`;
interface Options {store:Store;serviceAccess:(req:FastifyRequest,id:string,write?:boolean)=>{auth:SessionResponse;service:Service}}
interface HookRow {service_id:string;actor_id:string;token_hash:string;secret:string;enabled:number;created_at:string}
const digest=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');

export async function registerDeployWebhooks(app:FastifyInstance,{store,serviceAccess}:Options) {
  const base='/api/v1/services/:id/deploy-webhook';
  app.get<{Params:{id:string}}>(base,async req=>{
    const {service,auth}=serviceAccess(req,req.params.id);
    if(!store.canAccess(auth.user,service.projectId,true))throw new AppError('NOT_FOUND','Service not found',404);
    const row=store.db.prepare('SELECT enabled,created_at AS rotatedAt FROM deployment_webhooks WHERE service_id=?').get(req.params.id) as {enabled:number;rotatedAt:string}|undefined;
    return {enabled:!!row?.enabled,rotatedAt:row?.rotatedAt??null};
  });
  app.post<{Params:{id:string}}>(base,{config:{rateLimit:{max:5,timeWindow:'1 minute'}}},async req=>{
    const {service,auth}=serviceAccess(req,req.params.id,true);
    z.object({}).strict().parse(req.body??{});
    if(service.source?.type!=='git')throw new AppError('GIT_SOURCE_REQUIRED','Deployment webhooks require a Git source',400);
    const token=randomBytes(32).toString('hex'),secret=randomBytes(32).toString('hex'),createdAt=new Date().toISOString();
    store.db.transaction(()=>{
      store.db.prepare(`INSERT INTO deployment_webhooks VALUES(?,?,?,?,1,?) ON CONFLICT(service_id) DO UPDATE SET actor_id=excluded.actor_id,token_hash=excluded.token_hash,secret=excluded.secret,enabled=1,created_at=excluded.created_at`)
        .run(service.id,auth.user.id,digest(token),store.vault.seal(secret),createdAt);
      store.recordAudit(auth.user.id,'service.webhook.rotate',service.id);
    }).immediate();
    return {path:`/api/v1/hooks/deploy/${token}`,secret,enabled:true,rotatedAt:createdAt};
  });
  app.delete<{Params:{id:string}}>(base,async req=>{
    const {auth,service}=serviceAccess(req,req.params.id,true);
    store.db.prepare('UPDATE deployment_webhooks SET enabled=0 WHERE service_id=?').run(service.id);
    store.recordAudit(auth.user.id,'service.webhook.disable',service.id);return {enabled:false};
  });
  // Keep exact bytes for GitHub signature verification, isolated from the ordinary JSON parser.
  await app.register(async scope=>{
    scope.removeContentTypeParser('application/json');
    scope.addContentTypeParser('application/json',{parseAs:'buffer'},(_req,body,done)=>done(null,body));
    scope.post<{Params:{token:string}}>('/api/v1/hooks/deploy/:token',{config:{rateLimit:{max:60,timeWindow:'1 minute'}}},async(req,reply)=>{
      if(!/^[a-f0-9]{64}$/.test(req.params.token))throw new AppError('NOT_FOUND','Webhook not found',404);
      const row=store.db.prepare('SELECT * FROM deployment_webhooks WHERE token_hash=? AND enabled=1').get(digest(req.params.token)) as HookRow|undefined;
      if(!row)throw new AppError('NOT_FOUND','Webhook not found',404);
      const service=store.getService(row.service_id),actor=store.db.prepare('SELECT id,email,role,created_at AS createdAt FROM users WHERE id=?').get(row.actor_id) as SessionResponse['user']|undefined;
      if(!service||service.source?.type!=='git'||!actor||!store.canAccess(actor,service.projectId,true))throw new AppError('NOT_FOUND','Webhook not found',404);
      const bytes=req.body===undefined?Buffer.alloc(0):req.body;
      if(!Buffer.isBuffer(bytes))throw new AppError('INVALID_WEBHOOK','Send a JSON payload',400);
      const event=req.headers['x-github-event'];
      let key:string,forceRebuild=false,payloadHash:string|undefined,bodyKey:string|undefined;
      if(event!==undefined) {
        const signature=req.headers['x-hub-signature-256'];
        const expected=createHmac('sha256',store.vault.open(row.secret)).update(bytes).digest();
        if(typeof signature!=='string'||!/^sha256=[a-f0-9]{64}$/.test(signature)||!timingSafeEqual(expected,Buffer.from(signature.slice(7),'hex')))
          throw new AppError('INVALID_WEBHOOK_SIGNATURE','Invalid GitHub signature',401);
        if(new URL(service.source.repository).host!=='github.com')throw new AppError('INVALID_WEBHOOK','This source is not a GitHub repository',400);
        if(event==='ping')return {received:true};
        if(event!=='push')return reply.code(202).send({ignored:true});
        let payload:unknown;try{payload=JSON.parse(bytes.toString('utf8'));}catch{throw new AppError('INVALID_WEBHOOK','Invalid JSON payload',400);}
        const push=z.object({ref:z.string().max(300),deleted:z.boolean().optional(),repository:z.object({full_name:z.string().min(1).max(202)})}).parse(payload);
        const repository=new URL(service.source.repository).pathname.replace(/^\/+|\/+$/g,'').replace(/\.git$/i,'').toLowerCase();
        if(push.deleted||push.ref!==`refs/heads/${service.source.branch}`||push.repository.full_name.toLowerCase()!==repository)return reply.code(202).send({ignored:true});
        const delivery=z.string().uuid().parse(req.headers['x-github-delivery']);
        payloadHash=digest(bytes);
        key=`webhook-delivery:${digest(row.token_hash+delivery)}`;
        bodyKey=`webhook-body:${digest(row.token_hash+payloadHash)}`;
      } else {
        let payload:unknown={};if(bytes.length)try{payload=JSON.parse(bytes.toString('utf8'));}catch{throw new AppError('INVALID_WEBHOOK','Invalid JSON payload',400);}
        const input=z.object({forceRebuild:z.boolean().optional()}).strict().parse(payload);forceRebuild=!!input.forceRebuild;
        const requestKey=z.string().min(1).max(80).parse(req.headers['idempotency-key']);key=`webhook-ci:${digest(row.token_hash+requestKey)}`;
      }
      const action=store.db.transaction(()=>{
        if(payloadHash&&bodyKey) {
          const previous=store.db.prepare('SELECT request_hash,action_id FROM idempotency WHERE actor_id=? AND key=?').get(actor.id,key) as {request_hash:string;action_id:string}|undefined;
          if(previous) {
            if(previous.request_hash!==payloadHash)throw new AppError('IDEMPOTENCY_CONFLICT','This GitHub delivery ID was used for a different payload',409);
            const existing=store.getAction(previous.action_id);
            if(!existing)throw new AppError('NOT_FOUND','Deployment action not found',404);
            return existing;
          }
          // GitHub's delivery header is not signed. Bind the durable action to
          // signed payload bytes as well, so changing that header cannot replay it.
          const queued=store.createAction(service.id,'deploy',actor.id,bodyKey,{forceRebuild});
          store.db.prepare('INSERT INTO idempotency VALUES(?,?,?,?)').run(actor.id,key,payloadHash,queued.id);
          return queued;
        }
        return store.createAction(service.id,'deploy',actor.id,key,{forceRebuild});
      }).immediate();
      store.recordAudit(actor.id,'service.webhook.trigger',service.id);
      return reply.code(202).send(action);
    });
  });
}
