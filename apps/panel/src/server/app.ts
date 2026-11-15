import Fastify, { LogController, type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import staticFiles from '@fastify/static';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';
import { z } from 'zod';
import type { ActionType, RuntimeStatus, User } from '../shared/types.js';
import { hashPassword, verifyPassword } from './auth.js';
import { AppError } from './errors.js';
import { Store } from './store.js';
import { nameSchema, normalizeServiceInput, parseServicePatch } from './configuration.js';
import { agentRequest as defaultAgentRequest, agentDatabaseExport, agentDatabaseUpload, AgentRequestError } from '../agent/client.js';
import { registerConsole } from './console.js';
import { registerCentralAuth } from './central-auth.js';
import { BUILD_INFO } from './generated-build-info.js';
import { clientAddress, normalizeClientAddress, trustedProxyRequest } from './proxy-address.js';
import { MaintenanceGate } from './maintenance.js';
import { registerUpdates } from './updates.js';

const prefix = '/api/v1';
const cookieName = 'panel_session';
const slug = nameSchema;
const credentials = z.object({ email: z.string().email().max(254), password: z.string().min(8).max(128) });
const restoreStatusSchema = z.object({
  operationId:z.string().regex(/^[a-f0-9]{32}$/),
  phase:z.enum(['uploading','reserved','discarding','discarding_candidate','importing','prepared','switching','needs_review','completed','cancelled']),
  kind:z.enum(['postgres','mariadb','redis']),
  stage:z.enum(['pending','candidate_stop','candidate_detached','applying','applied','rolling_back','rolled_back']).optional(),
  rolledBack:z.literal(true).optional(),
}).strict();

export interface AppOptions {
  dataDir: string; webDir?: string; store?: Store; logger?: boolean;
  runtimeStatus?: () => Promise<RuntimeStatus>; allowedOrigins?: string[]; secureCookies?: boolean;
  agentRequest?:typeof defaultAgentRequest; agentConnection?:{socketPath:string;token:string};
  databaseExport?:typeof agentDatabaseExport;
  trustedProxySecret?: string;
  maintenance?: MaintenanceGate;
  updaterSocketPath?: string;
  updaterApplyEnabled?: boolean;
  updaterCurrentVersion?: string;
}
export async function createApp(options: AppOptions) {
  if(options.trustedProxySecret!==undefined && !/^[a-f0-9]{64}$/.test(options.trustedProxySecret))throw new Error('Invalid trusted proxy secret configuration');
  const store = options.store ?? new Store(options.dataDir);
  const app = Fastify({ logger: options.logger ?? false, logController: new LogController({ disableRequestLogging: true }), bodyLimit: 256 * 1024, trustProxy: false });
  const exportTickets=new Map<string,{serviceId:string;sessionHash:string;stream:IncomingMessage;length:string;extension:string;timer:ReturnType<typeof setTimeout>}>();
  let exportsPreparing=0;
  app.addHook('onClose',async()=>{for(const ticket of exportTickets.values()){clearTimeout(ticket.timer);ticket.stream.destroy();}exportTickets.clear();});
  await app.register(cookie);
  await app.register(rateLimit, { global: false, keyGenerator: req => clientAddress(req,options.trustedProxySecret) });
  await app.register(websocket,{options:{maxPayload:65536}});
  const runtimeRequest=options.agentRequest??defaultAgentRequest;
  const maintenance=options.maintenance;
  const requestReleases = new WeakMap<FastifyRequest, () => void>();
  const upgrades = new WeakSet<FastifyRequest>();
  const readOnlyStreams = new WeakSet<FastifyRequest>();
  let staticFilesRegistered = false;
  if (maintenance) {
    app.addHook('onRoute', route => {
      if (!route.url.startsWith('/api/') || route.url === '/api/v1/health' || route.url.endsWith('/console')) return;
      const original=route.handler;
      route.handler=async function(req,reply) {
        const done=maintenance.beginWork();
        try {
          const result=original.call(this,req,reply);
          if (!result || typeof (result as Promise<unknown>).then !== 'function') maintenance.markUncertain('handler');
          return await result;
        } finally { done(); }
      };
    });
    app.addHook('onRequest', async (req,reply) => {
      const path=req.raw.url?.split('?',1)[0];
      if ((path === '/health' || path === '/api/v1/health') && (req.method === 'GET' || req.method === 'HEAD')) return;
      const done=maintenance.admit();
      if (!done) return reply.code(503).send({error:{code:'MAINTENANCE',message:'Service is temporarily unavailable'}});
      requestReleases.set(req,done);
      const staticAsset=staticFilesRegistered&&(req.method==='GET'||req.method==='HEAD')&&req.routeOptions.url==='/*';
      let finished=false;
      reply.raw.once('finish',()=>{finished=true;});
      req.raw.once('aborted',()=>{if(!staticAsset&&!readOnlyStreams.has(req))maintenance.markUncertain('request_aborted');done();});
      reply.raw.once('close',()=>{
        if (!staticAsset && !readOnlyStreams.has(req) && !upgrades.has(req) && !finished) maintenance.markUncertain('response_closed');
        done();
      });
    });
    app.addHook('onResponse',async req=>{requestReleases.get(req)?.();});
  }
  const allowedOrigins = new Set(options.allowedOrigins ?? ['http://localhost:4180','http://127.0.0.1:4180','http://localhost:4181','http://127.0.0.1:4181']);
  app.addHook('onRequest', async (req, reply) => {
    reply.header('X-Content-Type-Options','nosniff');
    reply.header('Referrer-Policy','same-origin');
    reply.header('X-Frame-Options','DENY');
    reply.header('Cache-Control','no-store');
    if(trustedProxyRequest(req,options.trustedProxySecret)) {
      const forwarded=req.headers['x-servus-client-ip'];
      if(typeof forwarded!=='string'||!normalizeClientAddress(forwarded))throw new AppError('INVALID_PROXY_ADDRESS','Invalid proxy client address',400);
    }
    if (!['GET','HEAD','OPTIONS'].includes(req.method) && req.headers.origin && !allowedOrigins.has(req.headers.origin)) throw new AppError('ORIGIN_DENIED','This request origin is not allowed',403);
  });
  app.setErrorHandler((error, req, reply) => {
    if (error instanceof z.ZodError) return reply.code(400).send({error:{code:'VALIDATION_ERROR',message:error.issues.map(issue => `${issue.path.join('.') || 'input'}: ${issue.message}`).join('; ')}});
    if (error instanceof AppError) return reply.code(error.statusCode).send({error:{code:error.code,message:error.message}});
    if (error instanceof AgentRequestError) return reply.code(503).send({error:{code:'RUNTIME_UNAVAILABLE',message:store.vault.redact(error.message)}});
    if (typeof error === 'object' && error !== null && 'statusCode' in error && typeof error.statusCode === 'number' && error.statusCode < 500) return reply.code(error.statusCode).send({error:{code:'REQUEST_ERROR',message:'The request could not be processed'}});
    req.log.error({err:error},'Request failed');
    return reply.code(500).send({error:{code:'INTERNAL_ERROR',message:'The operation could not be completed'}});
  });
  if (!options.store) app.addHook('onClose', async () => store.close());

  function session(req: FastifyRequest, mutation = false) {
    const result = req.cookies[cookieName] ? store.getSession(req.cookies[cookieName]!) : null;
    if (!result) throw new AppError('UNAUTHORIZED','Sign in to continue',401);
    if (mutation && req.headers['x-csrf-token'] !== result.csrfToken) throw new AppError('CSRF_DENIED','Refresh the page and try again',403);
    return result;
  }
  function projectAccess(user: User, id: string, write = false) {
    if (!store.canAccess(user,id,write)) throw new AppError('NOT_FOUND','Project not found',404);
  }
  function serviceAccess(req: FastifyRequest, id: string, write = false, includeDeleted=false) {
    const auth = session(req,write), service = store.getService(id,includeDeleted);
    if (!service || !(includeDeleted&&!write?store.canReadAudit(auth.user,service.projectId):store.canAccess(auth.user,service.projectId,write))) throw new AppError('NOT_FOUND','Service not found',404);
    return {auth,service};
  }
  function approveBindMounts(user: User, configuration: {mounts?: readonly {type: string}[]}) {
    if (user.role !== 'admin' && configuration.mounts?.some(mount => mount.type === 'bind')) {
      throw new AppError('FORBIDDEN','Only instance administrators can configure host bind mounts',403);
    }
  }
  function setSession(reply: FastifyReply, user: User, central = false, expectedHash?: string) {
    const created = expectedHash === undefined ? store.createSession(user.id,central) : store.createLocalSession(user.id,expectedHash);
    if(!created)throw new AppError('INVALID_CREDENTIALS','Email or password is incorrect',401);
    reply.setCookie(cookieName,created.token,{path:'/',httpOnly:true,sameSite:'strict',secure:central || (options.secureCookies ?? false),maxAge:central ? 900 : 30*86_400});
    return {user,csrfToken:created.csrfToken};
  }

  app.get(`${prefix}/health`, async () => ({status:'ok',...BUILD_INFO}));
  app.get('/health', async () => ({status:'ok',...BUILD_INFO}));
  app.get(`${prefix}/setup`, async () => ({required:!store.isSetup()}));
  app.post(`${prefix}/setup`, {config:{rateLimit:{max:5,timeWindow:'1 minute'}}}, async (req,reply) => {
    const input = credentials.strict().parse(req.body);
    const user = store.setup(input.email,await hashPassword(input.password));
    store.removeLegacyBootstrapToken();
    return setSession(reply,user);
  });
  app.post(`${prefix}/auth/login`, {config:{rateLimit:{max:10,timeWindow:'1 minute'}}}, async (req,reply) => {
    const input = credentials.parse(req.body), user = store.findUser(input.email);
    if (!user || !await verifyPassword(input.password,user.passwordHash)) throw new AppError('INVALID_CREDENTIALS','Email or password is incorrect',401);
    return setSession(reply,{id:user.id,email:user.email,role:user.role,createdAt:user.createdAt},false,user.passwordHash);
  });
  app.get(`${prefix}/auth/session`, async req => session(req));
  app.post(`${prefix}/auth/logout`, async (req,reply) => { session(req,true);store.deleteSession(req.cookies[cookieName]!);reply.clearCookie(cookieName,{path:'/'});return {success:true}; });
  app.get(`${prefix}/auth/password`,async req=>{
    const {user}=session(req);
    return {available:Boolean(store.localCredentialForSession(user.id,req.cookies[cookieName]!))};
  });
  app.post(`${prefix}/auth/password`,{config:{rateLimit:{max:5,timeWindow:'1 minute'}}},async req=>{
    const {user}=session(req,true);
    const input=z.object({currentPassword:z.string().min(1).max(128),newPassword:z.string().min(8).max(128)}).strict().parse(req.body);
    const token=req.cookies[cookieName]!;
    const credential=store.localCredentialForSession(user.id,token);
    if(!credential)throw new AppError('LOCAL_PASSWORD_UNAVAILABLE','Sign in with a local account to change its password',403);
    if(!await verifyPassword(input.currentPassword,credential.passwordHash))throw new AppError('INVALID_PASSWORD','Current password is incorrect',401);
    const replacement=await hashPassword(input.newPassword);
    if(!store.changeLocalPassword(user.id,token,credential.passwordHash,replacement))throw new AppError('PASSWORD_CHANGE_CONFLICT','Your session or password changed. Sign in and try again',409);
    return {success:true};
  });
  registerCentralAuth(app,{store,allowedOrigins,secureCookies:options.secureCookies??false,session,setSession});

  function administrator(req:FastifyRequest,mutation=false) {
    const auth=session(req,mutation);
    if(auth.user.role!=='admin')throw new AppError('FORBIDDEN','Administrator access required',403);
    return auth.user;
  }
  registerUpdates(app,{administrator,socketPath:options.updaterSocketPath,applyEnabled:options.updaterApplyEnabled,currentVersion:options.updaterCurrentVersion ?? BUILD_INFO.version});
  app.get(`${prefix}/users`,async req=>{
    administrator(req);
    return {users:store.db.prepare('SELECT id,email,role,created_at AS createdAt FROM users ORDER BY email').all()};
  });
  app.get<{Params:{id:string}}>(`${prefix}/projects/:id/members`,async req=>{
    administrator(req);
    if(!store.getProject(req.params.id))throw new AppError('NOT_FOUND','Project not found',404);
    return {members:store.db.prepare('SELECT m.user_id AS userId,u.email,m.role FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.project_id=? ORDER BY u.email').all(req.params.id)};
  });
  app.put<{Params:{id:string;userId:string}}>(`${prefix}/projects/:id/members/:userId`,async req=>{
    const actor=administrator(req,true),{role}=z.object({role:z.enum(['editor','viewer'])}).strict().parse(req.body);
    if(!store.getProject(req.params.id)||!store.db.prepare('SELECT 1 FROM users WHERE id=?').get(req.params.userId))throw new AppError('NOT_FOUND','Project or user not found',404);
    store.db.transaction(()=>{store.addMember(req.params.id,req.params.userId,role);store.recordAudit(actor.id,'project.member.set',`${req.params.id}:${req.params.userId}`);})();
    return {success:true};
  });
  app.delete<{Params:{id:string;userId:string}}>(`${prefix}/projects/:id/members/:userId`,async req=>{
    const actor=administrator(req,true);
    if(!store.getProject(req.params.id)||!store.db.prepare('SELECT 1 FROM users WHERE id=?').get(req.params.userId))throw new AppError('NOT_FOUND','Project or user not found',404);
    store.db.transaction(()=>{store.db.prepare('DELETE FROM memberships WHERE project_id=? AND user_id=?').run(req.params.id,req.params.userId);store.recordAudit(actor.id,'project.member.remove',`${req.params.id}:${req.params.userId}`);})();
    return {success:true};
  });

  app.get(`${prefix}/projects`, async req => store.listProjects(session(req).user));
  app.post(`${prefix}/projects`, async (req,reply) => {
    const {user} = session(req,true);
    if (user.role !== 'admin') throw new AppError('FORBIDDEN','Only administrators can create projects',403);
    const input = z.object({name:slug,description:z.string().max(500).default('')}).parse(req.body);
    return reply.code(201).send(store.createProject(input.name,input.description,user.id));
  });
  app.get<{Params:{id:string}}>(`${prefix}/projects/:id`, async req => { const {user}=session(req);projectAccess(user,req.params.id);return store.getProject(req.params.id); });
  app.patch<{Params:{id:string}}>(`${prefix}/projects/:id`,async req=>{
    const {user}=session(req,true);projectAccess(user,req.params.id,true);
    return store.updateProject(req.params.id,z.object({name:slug.optional(),description:z.string().max(500).optional()}).strict().parse(req.body),user.id);
  });
  app.delete<{Params:{id:string}}>(`${prefix}/projects/:id`,async req=>{
    const {user}=session(req,true);projectAccess(user,req.params.id,true);store.deleteProject(req.params.id,user.id);return {success:true};
  });
  app.get<{Params:{id:string}}>(`${prefix}/projects/:id/services`, async req => {const {user}=session(req);projectAccess(user,req.params.id);return store.listServices(req.params.id);});
  app.post<{Params:{id:string}}>(`${prefix}/projects/:id/services`, async (req,reply) => {
    const {user}=session(req,true);projectAccess(user,req.params.id,true);
    const key=z.string().min(1).max(128).parse(req.headers['idempotency-key']);
    const input=normalizeServiceInput(req.body);
    approveBindMounts(user,input);
    const result=store.createService(req.params.id,input,user.id,key);
    return reply.code(202).send(result);
  });
  app.get<{Params:{id:string}}>(`${prefix}/services/:id`, async req => serviceAccess(req,req.params.id).service);
  app.patch<{Params:{id:string}}>(`${prefix}/services/:id`, async req => {
    const {auth}=serviceAccess(req,req.params.id,true);
    const input=parseServicePatch(req.body);
    approveBindMounts(auth.user,input);
    return store.updateService(req.params.id,input,auth.user.id);
  });
  app.delete<{Params:{id:string}}>(`${prefix}/services/:id`,async(req,reply)=>{
    const {auth}=serviceAccess(req,req.params.id,true,true);const key=z.string().min(1).max(128).parse(req.headers['idempotency-key']);
    return reply.code(202).send(store.createAction(req.params.id,'destroy',auth.user.id,key));
  });
  for (const type of ['deploy','start','stop','restart'] as ActionType[]) app.post<{Params:{id:string}}>(`${prefix}/services/:id/${type}`, async (req,reply) => {
    const {auth}=serviceAccess(req,req.params.id,true);
    const key=z.string().min(1).max(128).parse(req.headers['idempotency-key']);
    return reply.code(202).send(store.createAction(req.params.id,type,auth.user.id,key));
  });
  app.get<{Params:{id:string}}>(`${prefix}/services/:id/actions`, async req => {const {service}=serviceAccess(req,req.params.id,false,true);return store.listActions(undefined,service.id);});
  app.get<{Querystring:{projectId?:string}}>(`${prefix}/actions`, async req => {
    const {user}=session(req);if(req.query.projectId&&!store.canReadAudit(user,req.query.projectId))throw new AppError('NOT_FOUND','Project not found',404);
    return store.listActions(req.query.projectId).filter(action=>store.canReadAudit(user,action.projectId));
  });
  app.get<{Params:{id:string}}>(`${prefix}/actions/:id`, async req => {
    const {user}=session(req),action=store.getAction(req.params.id);
    if(!action||!store.canReadAudit(user,action.projectId))throw new AppError('NOT_FOUND','Action not found',404);
    return {action,events:store.getEvents(action.id)};
  });
  app.get(`${prefix}/runtime`, async req => {session(req);return options.runtimeStatus ? options.runtimeStatus() : {online:false,error:'Runtime agent is not connected'};});
  app.get<{Params:{id:string}}>(`${prefix}/services/:id/connection`,async req=>{serviceAccess(req,req.params.id);return store.connectionInfo(req.params.id);});
  app.post<{Params:{id:string}}>(`${prefix}/services/:id/connection/reveal`,async req=>{const {auth}=serviceAccess(req,req.params.id,true);const result=store.connectionInfo(req.params.id,true);store.recordAudit(auth.user.id,'connection.reveal',req.params.id);return result;});
  app.post<{Params:{id:string}}>(`${prefix}/services/:id/database-export`,async(req,reply)=>{
    const {auth,service}=serviceAccess(req,req.params.id,true);
    z.object({}).strict().parse(req.body??{});
    if(!service.kind||service.kind==='app')throw new AppError('NOT_FOUND','Managed database not found',404);
    const connection=store.connectionInfo(service.id);
    if(exportTickets.size+exportsPreparing>=8)throw new AppError('EXPORT_BUSY','Too many exports are in progress',429);
    exportsPreparing++;
    try {
      const upstream=await (options.databaseExport??agentDatabaseExport)(service.id,{kind:service.kind,database:connection.database,user:connection.user},options.agentConnection);
      const length=upstream.headers['content-length'],extension=upstream.headers['x-export-extension'];
      const expected={postgres:'dump',mariadb:'sql',redis:'rdb'}[service.kind];
      if(typeof length!=='string'||! /^[1-9][0-9]*$/.test(length)||Number(length)>2*1024*1024*1024||extension!==expected){
        upstream.destroy();throw new AppError('EXPORT_INVALID','The database export response is invalid',502);
      }
      const token=randomBytes(32).toString('hex'),sessionHash=createHash('sha256').update(req.cookies[cookieName]!).digest('hex');
      const timer=setTimeout(()=>{exportTickets.delete(token);upstream.destroy();},60_000);timer.unref();
      exportTickets.set(token,{serviceId:service.id,sessionHash,stream:upstream,length,extension:expected,timer});
      upstream.once('error',()=>{clearTimeout(timer);exportTickets.delete(token);});
      const path=`${prefix}/services/${service.id}/database-export/download`;
      reply.setCookie('panel_export',token,{path,httpOnly:true,sameSite:'strict',secure:options.secureCookies??false,maxAge:60});
      store.recordAudit(auth.user.id,'database.export.prepared',service.id);
      return {downloadUrl:path};
    } finally {exportsPreparing--;}
  });
  app.get<{Params:{id:string}}>(`${prefix}/services/:id/database-export/download`,async(req,reply)=>{
    const {auth,service}=serviceAccess(req,req.params.id);
    const path=`${prefix}/services/${service.id}/database-export/download`,token=req.cookies.panel_export;
    reply.clearCookie('panel_export',{path});
    const ticket=token?exportTickets.get(token):undefined;
    if(ticket){exportTickets.delete(token!);clearTimeout(ticket.timer);}
    const sessionHash=createHash('sha256').update(req.cookies[cookieName]!).digest('hex');
    if(!ticket||ticket.serviceId!==service.id||ticket.sessionHash!==sessionHash||!store.canAccess(auth.user,service.projectId,true)){
      ticket?.stream.destroy();throw new AppError('EXPORT_EXPIRED','The database export has expired',404);
    }
    store.recordAudit(auth.user.id,'database.export.download',service.id);
    reply.header('Content-Type','application/octet-stream').header('Content-Length',ticket.length)
      .header('Content-Disposition',`attachment; filename="servus-${service.id}.${ticket.extension}"`);
    reply.raw.once('close',()=>{if(!ticket.stream.destroyed)ticket.stream.destroy();});
    return reply.send(ticket.stream);
  });
  app.register(async scope => {
    scope.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload));
    scope.post<{Params:{id:string;operationId:string};Body:Readable}>(`${prefix}/services/:id/database-restore/:operationId/upload`, {
      onRequest: async req => {
        const {service} = serviceAccess(req,req.params.id,true);
        if (!/^[a-f0-9]{32}$/.test(req.params.operationId)) throw new AppError('INVALID_RESTORE','Invalid database restore identity',400);
        if (!['postgres','mariadb'].includes(service.kind || '')) throw new AppError('NOT_FOUND','Managed database not found',404);
        store.connectionInfo(service.id);
        const size = req.headers['content-length'];
        if (typeof size !== 'string' || !/^[1-9][0-9]*$/.test(size) || Number(size) > 2*1024*1024*1024 || req.headers['content-type']?.split(';',1)[0]?.trim().toLowerCase() !== 'application/octet-stream') throw new AppError('INVALID_UPLOAD','Invalid database restore upload',400);
      },
    }, async (req,reply) => {
      const {auth,service} = serviceAccess(req,req.params.id,true);
      if (!(req.body instanceof Readable)) throw new AppError('INVALID_UPLOAD','Invalid database restore upload',400);
      const controller = new AbortController();
      const abort = () => controller.abort();
      req.raw.once('aborted',abort); reply.raw.once('close',abort);
      store.recordAudit(auth.user.id,'database.restore.upload.started',service.id);
      try {
        const result = await agentDatabaseUpload(service.id,{operationId:req.params.operationId,kind:service.kind as 'postgres'|'mariadb',size:Number(req.headers['content-length']),stream:req.body,signal:controller.signal},options.agentConnection);
        store.recordAudit(auth.user.id,'database.restore.upload.staged',service.id);
        return result;
      } finally { req.raw.off('aborted',abort); reply.raw.off('close',abort); }
    });
  });
  app.get<{Params:{id:string}}>(`${prefix}/services/:id/database-restore`,async req => {
    serviceAccess(req,req.params.id,true);
    const result=await runtimeRequest(`/services/${req.params.id}/database-restore`,undefined,options.agentConnection);
    const parsed=z.object({operation:restoreStatusSchema.nullable()}).strict().safeParse(result);
    if(!parsed.success)throw new AppError('RESTORE_INVALID','The restore status could not be verified',502);
    return parsed.data;
  });
  app.get<{Params:{id:string;operationId:string}}>(`${prefix}/services/:id/database-restore/:operationId`,async req => {
    serviceAccess(req,req.params.id,true);
    if (!/^[a-f0-9]{32}$/.test(req.params.operationId)) throw new AppError('INVALID_RESTORE','Invalid database restore identity',400);
    return runtimeRequest(`/services/${req.params.id}/database-restore/${req.params.operationId}`,undefined,options.agentConnection);
  });
  app.post<{Params:{id:string;operationId:string}}>(`${prefix}/services/:id/database-restore/:operationId/cancel`,async req => {
    const {auth,service} = serviceAccess(req,req.params.id,true);
    if (!/^[a-f0-9]{32}$/.test(req.params.operationId)) throw new AppError('INVALID_RESTORE','Invalid database restore identity',400);
    z.object({}).strict().parse(req.body ?? {});
    const result = await runtimeRequest(`/services/${req.params.id}/database-restore/${req.params.operationId}/cancel`,{},options.agentConnection);
    store.recordAudit(auth.user.id,'database.restore.cancelled',service.id);
    return result;
  });
  for (const action of ['prepare','commit'] as const) {
    app.post<{Params:{id:string;operationId:string}}>(`${prefix}/services/:id/database-restore/:operationId/${action}`,async req => {
      const {auth,service}=serviceAccess(req,req.params.id,true);
      if(!/^[a-f0-9]{32}$/.test(req.params.operationId))throw new AppError('INVALID_RESTORE','Invalid database restore identity',400);
      if(!['postgres','mariadb'].includes(service.kind || ''))throw new AppError('NOT_FOUND','Managed database not found',404);
      if(action==='commit')z.object({confirm:z.literal(true)}).strict().parse(req.body);
      else z.object({}).strict().parse(req.body ?? {});
      store.connectionInfo(service.id);
      store.recordAudit(auth.user.id,`database.restore.${action}.started`,service.id);
      try {
        const result=await runtimeRequest(`/services/${service.id}/database-restore/${req.params.operationId}/${action}`,{}, {...options.agentConnection,timeoutMs:900_000});
        const schema=action==='prepare'
          ? z.object({operationId:z.literal(req.params.operationId),phase:z.literal('prepared')}).strict()
          : z.object({operationId:z.literal(req.params.operationId),phase:z.enum(['completed','cancelled']),rolledBack:z.boolean()}).strict().refine(value=>value.phase!=='completed'||!value.rolledBack);
        const parsed=schema.safeParse(result);
        if(!parsed.success)throw new AppError('RESTORE_UNCERTAIN','The restore outcome is unknown. Check the operation status.',503);
        store.recordAudit(auth.user.id,`database.restore.${action}.${parsed.data.phase}`,service.id);
        return parsed.data;
      } catch(error) {
        if(error instanceof AgentRequestError && error.certainty==='definitive' && error.statusCode===409)throw new AppError('RESTORE_BUSY','The restore cannot continue in its current state',409);
        if(error instanceof AgentRequestError && error.certainty==='uncertain')throw new AppError('RESTORE_UNCERTAIN','The restore outcome is unknown. Check the operation status.',503);
        throw error;
      }
    });
  }
  app.get<{Params:{id:string};Querystring:{tail?:string;since?:string}}>(`${prefix}/services/:id/logs`,async req=>{
    serviceAccess(req,req.params.id);
    const tail=z.coerce.number().int().min(1).max(500).default(200).parse(req.query.tail);
    const since=req.query.since?z.string().max(50).regex(/^[0-9TZ:.+\-]+$/).parse(req.query.since):undefined;
    const result=await runtimeRequest<import('../shared/types.js').ServiceLogs>(`/services/${req.params.id}/logs?tail=${tail}${since?`&since=${encodeURIComponent(since)}`:''}`);
    return {lines:store.vault.redact(result.lines.join('\n')).split('\n').filter(Boolean)};
  });
  app.get<{Params:{id:string}}>(`${prefix}/services/:id/containers`,async req=>{serviceAccess(req,req.params.id);return runtimeRequest<import('../shared/types.js').ContainerInfo[]>(`/services/${req.params.id}/containers`);});
  app.get<{Params:{id:string}}>(`${prefix}/services/:id/metrics`,async req=>{serviceAccess(req,req.params.id);return runtimeRequest<import('../shared/types.js').ServiceMetrics>(`/services/${req.params.id}/metrics`);});
  registerConsole(app,{store,allowedOrigins,serviceAccess,agentConnection:options.agentConnection,runtimeRequest,maintenance,
    onUpgrade:req=>{upgrades.add(req);requestReleases.get(req)?.();},onReadOnlyStream:req=>{readOnlyStreams.add(req);}});

  const webDir=resolve(options.webDir ?? 'dist/web');
  if(existsSync(webDir)) {
    await app.register(staticFiles,{root:webDir,prefix:'/'});
    staticFilesRegistered = true;
    app.setNotFoundHandler((req,reply)=>{
      if(req.method==='GET'&&!req.url.startsWith('/api/')&&req.headers.accept?.includes('text/html'))return reply.sendFile('index.html');
      return reply.code(404).send({error:{code:'NOT_FOUND',message:'Not found'}});
    });
  }
  return app;
}
