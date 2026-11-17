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
import { inspectDomainDns } from './domain-dns.js';
import { inspectDomainTls } from './domain-tls.js';
import { canonicalDnsName } from '../agent/acme/dns01.js';
import { nameSchema, normalizeServiceInput, parseServicePatch, validateConfiguration } from './configuration.js';
import { agentRequest as defaultAgentRequest, agentDatabaseExport, agentDatabaseUpload, AgentRequestError } from '../agent/client.js';
import { registerConsole } from './console.js';
import { registerCentralAuth } from './central-auth.js';
import { HostDomainManager, registerHostDomainRoutes, withAutomaticHostDomain, type HostDomainOptions } from './host-domain.js';
import { isHostApplication } from '../shared/host-domain.js';
import { BUILD_INFO } from './generated-build-info.js';
import { clientAddress, normalizeClientAddress, trustedProxyRequest } from './proxy-address.js';
import { MaintenanceGate } from './maintenance.js';
import { registerUpdates } from './updates.js';
import { registerInstallationBackups } from './installation-backups.js';
import { ApiTokens } from './api-tokens.js';
import { registerBackups } from './backups.js';
import { registerVolumeBackups } from './volume-backups.js';
import { registerGithubRepositories } from './github-repositories.js';
import { registerReleaseNotes } from './release-notes.js';
import { registerTwoFactor } from './two-factor.js';
import { registerCompose } from './compose.js';
import { registerDeployWebhooks } from './deploy-webhooks.js';
import { registerTemplates } from './templates.js';
import { startLegacyRecovery, legacyRecoveryStatus, UpdaterClientError } from './updater-client.js';

const prefix = '/api/v1';
const cookieName = 'panel_session';
const slug = nameSchema;
const credentials = z.object({ email: z.string().email().max(254), password: z.string().min(8).max(128) });
const restoreStatusSchema = z.object({
  operationId:z.string().regex(/^[a-f0-9]{32}$/),
  phase:z.enum(['uploading','reserved','discarding','discarding_candidate','importing','prepared','switching','needs_review','completed','cancelled']),
  kind:z.enum(['postgres','mariadb','redis']),
  stage:z.enum(['pending','candidate_stop','candidate_detached','applying','applied','rolling_back','rolled_back']).optional(),
  reviewPhase:z.enum(['uploading','reserved','discarding','importing','prepared','switching']).optional(),
  recoveryReason:z.enum(['legacy_upload_unverified','preparation_unverified']).optional(),
  rolledBack:z.literal(true).optional(),
  canRollback:z.literal(true).optional(),restoreDirection:z.literal('rollback').optional(),redisRecoveryRequired:z.literal(true).optional(),
}).strict().refine(value=>!value.recoveryReason||(value.recoveryReason==='legacy_upload_unverified'?value.phase==='uploading':value.phase==='importing'));

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
  installationBackupApprovalSecretPath?: string;
  hostDomains?:HostDomainOptions;
}
export async function createApp(options: AppOptions) {
  if(options.trustedProxySecret!==undefined && !/^[a-f0-9]{64}$/.test(options.trustedProxySecret))throw new Error('Invalid trusted proxy secret configuration');
  const store = options.store ?? new Store(options.dataDir);
  const apiTokens = new ApiTokens(store);
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
  const hostDomains=new HostDomainManager(store,options.hostDomains,(path,input,requestOptions)=>runtimeRequest(path,input,{...options.agentConnection,...requestOptions}),origin=>allowedOrigins.add(origin),maintenance?()=>maintenance.admit():undefined);
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
  let hostDomainTimer:ReturnType<typeof setInterval>|undefined;
  const tickHostDomain=async()=>{try{await hostDomains.tick();}catch{app.log.warn('Host domain synchronization could not start');}};
  app.addHook('onReady',async()=>{hostDomainTimer=setInterval(()=>{void tickHostDomain();},60_000);hostDomainTimer.unref();try{hostDomains.start();}catch{app.log.warn('Host domain synchronization could not start');}});
  app.addHook('onClose',async()=>{if(hostDomainTimer)clearInterval(hostDomainTimer);await hostDomains.drain();});

  function session(req: FastifyRequest, mutation = false) {
    if(req.headers.authorization!==undefined)return apiTokens.authenticate(req);
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
  function setSession(reply: FastifyReply, user: User, central = false, expectedHash?: string, request?:FastifyRequest) {
    const created = expectedHash === undefined ? store.createSession(user.id,central) : store.createLocalSession(user.id,expectedHash);
    if(!created)throw new AppError('INVALID_CREDENTIALS','Email or password is incorrect',401);
    const host=store.vault.hostConnection()?.hostname;
    const managedHost=Boolean(host && request?.headers.host?.toLowerCase().split(':',1)[0]===host);
    reply.setCookie(cookieName,created.token,{path:'/',httpOnly:true,sameSite:'strict',secure:central || managedHost || (options.secureCookies ?? false),maxAge:central ? 900 : 30*86_400});
    return {user,csrfToken:created.csrfToken};
  }

  const twoFactor=registerTwoFactor(app,{store,session});

  app.get(`${prefix}/health`, async () => ({status:'ok',...BUILD_INFO}));
  app.get('/health', async () => ({status:'ok',...BUILD_INFO}));
  app.get(`${prefix}/setup`, async () => ({required:!store.isSetup()}));
  app.post(`${prefix}/setup`, {config:{rateLimit:{max:5,timeWindow:'1 minute'}}}, async (req,reply) => {
    const input = credentials.strict().parse(req.body);
    const user = store.setup(input.email,await hashPassword(input.password));
    store.removeLegacyBootstrapToken();
    void tickHostDomain();
    return setSession(reply,user,false,undefined,req);
  });
  app.post(`${prefix}/auth/login`, {config:{rateLimit:{max:10,timeWindow:'1 minute'}}}, async (req,reply) => {
    const input = credentials.extend({totpCode:z.string().max(64).optional()}).strict().parse(req.body), user = store.findUser(input.email);
    if (!user || !await verifyPassword(input.password,user.passwordHash)) throw new AppError('INVALID_CREDENTIALS','Email or password is incorrect',401);
    if(twoFactor.status(user.id).enabled&&!input.totpCode)throw new AppError('TWO_FACTOR_REQUIRED','Enter your authenticator or recovery code',401);
    if(!twoFactor.verifyLogin(user.id,input.totpCode))throw new AppError('TWO_FACTOR_CODE_INVALID','Enter an unused authenticator or recovery code',401);
    return setSession(reply,{id:user.id,email:user.email,role:user.role,createdAt:user.createdAt},false,user.passwordHash,req);
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
    apiTokens.revokeUser(user.id);
    return {success:true};
  });
  apiTokens.register(app,session);
  registerBackups(app,{store,serviceAccess,agentConnection:options.agentConnection,databaseExport:options.databaseExport,maintenance});
  registerVolumeBackups(app,{store,serviceAccess,agentConnection:options.agentConnection,agentRequest:runtimeRequest,maintenance});
  const compose=registerCompose(app,{store,session:req=>session(req,!['GET','HEAD','OPTIONS'].includes(req.method)),projectAccess,agentRequest:runtimeRequest,agentConnection:options.agentConnection,maintenance});
  registerTemplates(app,{session,projectAccess,createWorkload:compose.createWorkload});
  await registerDeployWebhooks(app,{store,serviceAccess});
  registerCentralAuth(app,{store,allowedOrigins,secureCookies:options.secureCookies??false,session,setSession});
  registerHostDomainRoutes(app,hostDomains,session);

  function administrator(req:FastifyRequest,mutation=false) {
    const auth=session(req,mutation);
    if(auth.user.role!=='admin')throw new AppError('FORBIDDEN','Administrator access required',403);
    return auth.user;
  }
  registerUpdates(app,{administrator,socketPath:options.updaterSocketPath,applyEnabled:options.updaterApplyEnabled,currentVersion:options.updaterCurrentVersion ?? BUILD_INFO.version});
  registerInstallationBackups(app,{administrator,socketPath:options.updaterSocketPath,applyEnabled:options.updaterApplyEnabled,approvalSecretPath:options.installationBackupApprovalSecretPath});
  registerReleaseNotes(app,{administrator});
  registerGithubRepositories(app,{store,administrator});
  app.get(`${prefix}/integrations/github`,async req=>{
    administrator(req);
    const connection=store.vault.githubConnection();
    return connection ? {connected:true,username:connection.username} : {connected:false};
  });
  app.put(`${prefix}/integrations/github`,async req=>{
    const actor=administrator(req,true);
    const input=z.object({username:z.string().min(1).max(256).regex(/^[^\x00-\x20\x7f:=]+$/).default('x-access-token'),token:z.string().min(1).max(4096).regex(/^[^\x00-\x20\x7f]+$/)}).strict().parse(req.body);
    store.vault.setGithubConnection(input.username,input.token);
    store.recordAudit(actor.id,'integration.github.set','github');
    return {connected:true,username:input.username};
  });
  app.delete(`${prefix}/integrations/github`,async req=>{
    const actor=administrator(req,true);
    store.vault.deleteGithubConnection();
    store.recordAudit(actor.id,'integration.github.delete','github');
    return {connected:false};
  });
  function approveSharedGithub(user:User, configuration:{source?: import('../shared/types.js').SourceConfig}) {
    if (configuration.source?.type === 'git' && configuration.source.sharedGithub && user.role !== 'admin') throw new AppError('FORBIDDEN','Only administrators can configure the shared GitHub connection',403);
    if(configuration.source?.type==='git'&&configuration.source.ssh&&user.role!=='admin')throw new AppError('FORBIDDEN','Only administrators can configure SSH deploy keys and trusted host keys',403);
  }
  app.get(`${prefix}/settings/https`,async req=>{
    administrator(req);return {settings:store.vault.httpsIngress()};
  });
  app.put(`${prefix}/settings/https`,{config:{rateLimit:{max:5,timeWindow:'1 minute'}}},async req=>{
    const actor=administrator(req,true);
    const input=z.object({email:z.string().email().max(254),staging:z.boolean()}).strict().parse(req.body);
    try {store.vault.setHttpsIngress(input.email,input.staging);} catch {throw new AppError('INVALID_HTTPS_SETTINGS','Enter a valid ACME contact email',400);}
    store.recordAudit(actor.id,'settings.https.set','https');
    return {settings:store.vault.httpsIngress()};
  });
  for(const action of ['migrate','migrate-external','recover'] as const) app.post(`${prefix}/settings/https/${action}`,{config:{rateLimit:{max:5,timeWindow:'1 minute'}}},async req=>{
    const actor=administrator(req,true);
    z.object({confirm:z.literal(true)}).strict().parse(req.body);
    store.recordAudit(actor.id,`settings.https.${action}.started`,'https');
    try {
      const result=await runtimeRequest(`/https/ingress/${action}`,{}, {...options.agentConnection,timeoutMs:400_000});
      if(!z.object({ok:z.literal(true)}).strict().safeParse(result).success)throw new AppError('INGRESS_RECOVERY_REQUIRED','The ingress outcome could not be verified. Check its status before retrying.',503);
      store.recordAudit(actor.id,`settings.https.${action}.completed`,'https');
      return {ok:true};
    } catch(error) {
      store.recordAudit(actor.id,`settings.https.${action}.failed`,'https');
      if(error instanceof AgentRequestError && error.certainty==='definitive')throw new AppError(error.code??'INGRESS_MIGRATION_FAILED',store.vault.redact(error.message),error.statusCode??422);
      throw error;
    }
  });
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

  app.get(`${prefix}/projects`, async req => {const {user}=session(req),token=apiTokens.current(req);return store.listProjects(user).filter(project=>!token||project.id===token.projectId).map(project=>({...project,canWrite:store.canAccess(user,project.id,true)&&(!token||token.scope==='deploy')}));});
  app.post(`${prefix}/projects`, async (req,reply) => {
    const {user} = session(req,true);
    if (user.role !== 'admin') throw new AppError('FORBIDDEN','Only administrators can create projects',403);
    const input = z.object({name:slug,description:z.string().max(500).default('')}).parse(req.body);
    return reply.code(201).send(store.createProject(input.name,input.description,user.id));
  });
  app.get<{Params:{id:string}}>(`${prefix}/projects/:id`, async req => { const {user}=session(req);projectAccess(user,req.params.id);return {...store.getProject(req.params.id)!,canWrite:store.canAccess(user,req.params.id,true)}; });
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
    const input=normalizeServiceInput(withAutomaticHostDomain(store,req.params.id,req.body));
    approveBindMounts(user,input);
    approveSharedGithub(user,input);
    const result=store.createService(req.params.id,input,user.id,key);
    return reply.code(202).send(result);
  });
  app.get<{Params:{id:string}}>(`${prefix}/services/:id`, async req => serviceAccess(req,req.params.id).service);
  app.post<{Params:{id:string}}>(`${prefix}/services/:id/check-managed-certificate`,{config:{rateLimit:{max:20,timeWindow:'1 minute'}}},async req=>{
    const {service}=serviceAccess(req,req.params.id,true);
    const {hostname}=z.object({hostname:z.string().min(1).max(253)}).strict().parse(req.body);
    let canonical:string;
    try {canonical=canonicalDnsName(hostname);}catch {throw new AppError('INVALID_DOMAIN','Enter a valid public hostname',400);}
    if(!service.domains?.some(domain=>domain.hostname===canonical && domain.https))throw new AppError('CERTIFICATE_DOMAIN','Save automatic HTTPS for this service domain before checking its managed certificate',400);
    const value=await runtimeRequest('/certificates/managed',{hostname:canonical},{...options.agentConnection,timeoutMs:25_000});
    const events={eventsAvailable:z.boolean(),lastFailure:z.object({observedAt:z.string().datetime(),operation:z.enum(['issuance','renewal']),category:z.enum(['dns','rate_limit','contact','challenge','other'])}).strict().optional()};
    const certificate=z.discriminatedUnion('status',[
      z.object({status:z.literal('not_found'),...events}).strict(),
      z.object({status:z.enum(['active','expired','not_yet_valid']),notBefore:z.string().datetime(),expiresAt:z.string().datetime(),fingerprint:z.string().regex(/^(?:[A-F0-9]{2}:){31}[A-F0-9]{2}$/),...events}).strict(),
    ]).safeParse(value);
    if(!certificate.success)throw new AppError('CERTIFICATE_UNAVAILABLE','Managed certificate status could not be verified',503);
    return {hostname:canonical,checkedAt:new Date().toISOString(),...certificate.data};
  });
  app.post<{Params:{id:string}}>(`${prefix}/services/:id/retry-certificate`,{config:{rateLimit:{max:5,timeWindow:'1 minute'}}},async req=>{
    const {auth,service}=serviceAccess(req,req.params.id,true);
    const {hostname}=z.object({hostname:z.string().min(1).max(253)}).strict().parse(req.body);
    let canonical:string;
    try {canonical=canonicalDnsName(hostname);}catch {throw new AppError('INVALID_DOMAIN','Enter a valid public hostname',400);}
    if(!service.domains?.some(domain=>domain.hostname===canonical && domain.https))throw new AppError('CERTIFICATE_DOMAIN','Save automatic HTTPS for this service domain before retrying',400);
    const host=store.vault.hostConnection()?.hostname;
    if(host && isHostApplication(canonical,host)) {
      if(auth.user.role!=='admin')throw new AppError('FORBIDDEN','Ask an administrator to synchronize the host certificate',403);
      hostDomains.start(true);return {accepted:true,requestedAt:new Date().toISOString()};
    }
    store.recordAudit(auth.user.id,'certificate.retry.started',service.id);
    try {
      const value=await runtimeRequest('/certificates/retry',{serviceId:service.id,hostname:canonical},{...options.agentConnection,timeoutMs:30_000});
      const result=z.object({accepted:z.literal(true),requestedAt:z.string().datetime()}).strict().safeParse(value);
      if(!result.success)throw new AppError('RETRY_UNCERTAIN','The retry outcome is unknown. Check certificate status.',503);
      store.recordAudit(auth.user.id,'certificate.retry.accepted',service.id);
      return result.data;
    } catch(error) {
      store.recordAudit(auth.user.id,'certificate.retry.failed',service.id);
      if(error instanceof AgentRequestError && error.certainty==='definitive')throw new AppError(error.code??'RETRY_UNAVAILABLE',store.vault.redact(error.message),error.statusCode??409);
      throw error;
    }
  });
  app.post<{Params:{id:string}}>(`${prefix}/services/:id/check-domain-tls`,{config:{rateLimit:{max:20,timeWindow:'1 minute'}}},async req=>{
    const {service}=serviceAccess(req,req.params.id,true);
    if(service.kind && service.kind!=='app')throw new AppError('DATABASE_ROUTING','Database services do not expose HTTP domains',400);
    const {hostname}=z.object({hostname:z.string().min(1).max(253)}).strict().parse(req.body);
    let canonical:string;
    try {canonical=canonicalDnsName(hostname);} catch {throw new AppError('INVALID_DOMAIN','Enter a public hostname without a protocol or port',400);}
    return inspectDomainTls(canonical);
  });

  app.post<{Params:{id:string}}>(`${prefix}/services/:id/check-domain-dns`,{config:{rateLimit:{max:20,timeWindow:'1 minute'}}},async req=>{
    const {service}=serviceAccess(req,req.params.id,true);
    if(service.kind && service.kind!=='app')throw new AppError('DATABASE_ROUTING','Database services do not expose HTTP domains',400);
    const {hostname}=z.object({hostname:z.string().min(1).max(253)}).strict().parse(req.body);
    let canonical:string;
    try {canonical=canonicalDnsName(hostname);} catch {throw new AppError('INVALID_DOMAIN','Enter a public hostname without a protocol or port',400);}
    return inspectDomainDns(canonical);
  });

  app.post<{Params:{id:string}}>(`${prefix}/services/:id/check-source`, async req => {
    const {auth,service}=serviceAccess(req,req.params.id,true);
    if(service.source?.type!=='git')throw new AppError('GIT_SOURCE','Save a Git source before checking it',400);
    if(service.source.sharedGithub && auth.user.role!=='admin')throw new AppError('FORBIDDEN','Only administrators can check the shared GitHub connection',403);
    const raw=req.body && typeof req.body==='object' && Object.keys(req.body).length===0 ? undefined : req.body;
    const changes=z.object({repository:z.string().url().max(1000),branch:z.string().min(1).max(128),context:z.string().max(255),dockerfile:z.string().max(255)}).strict().optional().parse(raw);
    const candidate=changes ? {...service.source,...changes} : service.source;
    if ((service.source.credential && !service.source.sharedGithub || service.source.ssh) && candidate.repository!==service.source.repository) throw new AppError('SECRET_REFERENCE','Save a separate credential for this repository before checking it',403);
    const parsed=parseServicePatch({expectedRevision:service.revision,source:candidate});
    validateConfiguration({kind:service.kind,source:parsed.source});
    let result:unknown;
    try { result=await runtimeRequest('/services/check-source',{service:{...service,source:parsed.source},sharedGithub:!!service.source.sharedGithub},{...options.agentConnection,timeoutMs:150_000}); }
    catch(error) { if(error instanceof AgentRequestError && error.certainty==='definitive')throw new AppError(error.code??'SOURCE_CHECK_FAILED',store.vault.redact(error.message),error.statusCode??422); throw error; }
    const checked=z.object({commit:z.string().regex(/^[a-f0-9]{40,64}$/)}).strict().safeParse(result);
    if(!checked.success)throw new AppError('RUNTIME_UNAVAILABLE','The source check returned an invalid response',503);
    return checked.data;
  });

  app.patch<{Params:{id:string}}>(`${prefix}/services/:id`, async req => {
    const {auth,service}=serviceAccess(req,req.params.id,true);
    const input=parseServicePatch(req.body);
    approveBindMounts(auth.user,input);
    approveSharedGithub(auth.user,input);
    if (input.source && auth.user.role !== 'admin' && service.source?.type === 'git' && service.source.sharedGithub) throw new AppError('FORBIDDEN','Only administrators can change a source using the shared GitHub connection',403);
    if(input.source&&auth.user.role!=='admin'&&service.source?.type==='git'&&service.source.ssh)throw new AppError('FORBIDDEN','Only administrators can change a source using an SSH deploy key',403);
    if (input.source?.type === 'git' && input.source.credential?.secretRef) {
      const previous = service.source?.type === 'git' ? service.source : undefined;
      if (previous?.sharedGithub && !input.source.sharedGithub && input.source.credential.secretRef === previous.credential?.secretRef) throw new AppError('SECRET_REFERENCE','Enter a separate token when disconnecting the shared GitHub connection',403);
      if (auth.user.role !== 'admin' && (!previous || previous.sharedGithub || input.source.credential.secretRef !== previous.credential?.secretRef)) throw new AppError('SECRET_REFERENCE','This Git credential is not available for reuse',403);
    }
    return store.updateService(req.params.id,input,auth.user.id);
  });
  app.delete<{Params:{id:string}}>(`${prefix}/services/:id`,async(req,reply)=>{
    const {auth}=serviceAccess(req,req.params.id,true,true);const key=z.string().min(1).max(128).parse(req.headers['idempotency-key']);
    return reply.code(202).send(store.createAction(req.params.id,'destroy',auth.user.id,key));
  });
  for (const type of ['deploy','start','stop','restart'] as ActionType[]) app.post<{Params:{id:string}}>(`${prefix}/services/:id/${type}`, async (req,reply) => {
    const {auth}=serviceAccess(req,req.params.id,true);
    const key=z.string().min(1).max(128).parse(req.headers['idempotency-key']);
    const deploymentOptions=type==='deploy'?z.object({forceRebuild:z.boolean().optional()}).strict().parse(req.body??{}):undefined;
    return reply.code(202).send(store.createAction(req.params.id,type,auth.user.id,key,deploymentOptions));
  });
  app.post<{Params:{id:string;actionId:string}}>(`${prefix}/services/:id/deployments/:actionId/redeploy`,async(req,reply)=>{
    const {auth}=serviceAccess(req,req.params.id,true);
    z.object({confirm:z.literal(true)}).strict().parse(req.body);
    const key=z.string().min(1).max(128).parse(req.headers['idempotency-key']);
    return reply.code(202).send(store.createHistoricalDeploy(req.params.id,req.params.actionId,auth.user.id,key));
  });
  app.get<{Params:{id:string}}>(`${prefix}/services/:id/configuration-changes`, async req => {const {service}=serviceAccess(req,req.params.id);return store.configurationChanges(service.id);});
  app.get<{Params:{id:string}}>(`${prefix}/services/:id/actions`, async req => {const {service}=serviceAccess(req,req.params.id,false,true);return store.listActions(undefined,service.id);});
  app.get<{Querystring:{projectId?:string}}>(`${prefix}/actions`, async req => {
    const {user}=session(req);if(req.query.projectId&&!store.canReadAudit(user,req.query.projectId))throw new AppError('NOT_FOUND','Project not found',404);
    return store.listActions(req.query.projectId).filter(action=>store.canReadAudit(user,action.projectId));
  });
  app.get<{Params:{id:string}}>(`${prefix}/actions/:id/build-log`,async req=>{
    const {user}=session(req),action=store.getAction(req.params.id);
    if(!action || !store.canReadAudit(user,action.projectId))throw new AppError('NOT_FOUND','Action not found',404);
    if(action.type!=='deploy')return {available:false,text:'',truncated:false};
    let result:unknown;
    try {result=await runtimeRequest(`/services/${action.serviceId}/build-log/${action.id}`,undefined,options.agentConnection);}
    catch(error){if(error instanceof AgentRequestError && error.statusCode===404)return {available:false,text:'',truncated:false};throw error;}
    const checked=z.object({available:z.boolean(),text:z.string().max(512*1024),truncated:z.boolean()}).strict().safeParse(result);
    if(!checked.success)throw new AppError('RUNTIME_UNAVAILABLE','The build log response was invalid',503);
    return {...checked.data,text:store.vault.redact(checked.data.text)};
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
        if (!['postgres','mariadb','redis'].includes(service.kind || '')) throw new AppError('NOT_FOUND','Managed database not found',404);
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
        const result = await agentDatabaseUpload(service.id,{operationId:req.params.operationId,kind:service.kind as 'postgres'|'mariadb'|'redis',size:Number(req.headers['content-length']),stream:req.body,signal:controller.signal},options.agentConnection);
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
  // The host operation can restart the panel, so only an instance administrator may start it.
  const legacyRecoveryIdentity=(restoreId:string,serviceId:string)=>{
    const bytes=createHash('sha256').update('servus-legacy-recovery\0').update(restoreId).digest().subarray(0,16);
    bytes[6]=(bytes[6]! & 0x0f)|0x40; bytes[8]=(bytes[8]! & 0x3f)|0x80;
    const hex=bytes.toString('hex');
    return {operationId:`${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`,restoreId,serviceId};
  };
  const recoveryEndpoint=()=>{
    if(!options.updaterApplyEnabled||!options.updaterSocketPath)throw new AppError('RECOVERY_UNAVAILABLE','Recovery is not available on this installation',503);
    return {socketPath:options.updaterSocketPath};
  };
  const recoveryError=(error:unknown):never=>{
    if(error instanceof UpdaterClientError && error.certainty==='definitive') {
      if(error.code==='not_found')throw new AppError('NOT_FOUND','Recovery operation not found',404);
      if(['operation_in_progress','idempotency_conflict','recovery_required'].includes(error.code))throw new AppError('RESTORE_BUSY','Recovery cannot start in the current state',409);
    }
    throw new AppError('RECOVERY_UNAVAILABLE','Recovery status is unavailable. Check its status before retrying.',503);
  };
  app.get<{Params:{id:string;operationId:string}}>(`${prefix}/services/:id/database-restore/:operationId/legacy-recovery`,async req=>{
    administrator(req);const {service}=serviceAccess(req,req.params.id);
    if(!/^[a-f0-9]{32}$/.test(req.params.operationId))throw new AppError('INVALID_RESTORE','Invalid database restore identity',400);
    try{return {operation:await legacyRecoveryStatus(legacyRecoveryIdentity(req.params.operationId,service.id),recoveryEndpoint())};}
    catch(error){if(error instanceof AppError)throw error;return recoveryError(error);}
  });
  app.post<{Params:{id:string;operationId:string}}>(`${prefix}/services/:id/database-restore/:operationId/legacy-recovery`,{config:{rateLimit:{max:5,timeWindow:'1 minute'}}},async req=>{
    const actor=administrator(req,true),{service}=serviceAccess(req,req.params.id,true);
    if(!/^[a-f0-9]{32}$/.test(req.params.operationId))throw new AppError('INVALID_RESTORE','Invalid database restore identity',400);
    z.object({}).strict().parse(req.body??{});
    if(!['postgres','mariadb'].includes(service.kind||''))throw new AppError('NOT_FOUND','Managed database not found',404);
    const endpoint=recoveryEndpoint();
    const response=await runtimeRequest(`/services/${service.id}/database-restore/${req.params.operationId}`,undefined,options.agentConnection);
    const parsed=restoreStatusSchema.safeParse(response);
    if(!parsed.success||parsed.data.operationId!==req.params.operationId||parsed.data.kind!==service.kind||parsed.data.recoveryReason!=='legacy_upload_unverified')throw new AppError('RESTORE_BUSY','This restore does not need legacy upload recovery',409);
    store.recordAudit(actor.id,'database.restore.legacy_recovery.requested',service.id);
    try{return {operation:await startLegacyRecovery(legacyRecoveryIdentity(req.params.operationId,service.id),endpoint)};}
    catch(error){return recoveryError(error);}
  });
  app.post<{Params:{id:string;operationId:string}}>(`${prefix}/services/:id/database-restore/:operationId/cancel`,async req => {
    const {auth,service} = serviceAccess(req,req.params.id,true);
    if (!/^[a-f0-9]{32}$/.test(req.params.operationId)) throw new AppError('INVALID_RESTORE','Invalid database restore identity',400);
    z.object({}).strict().parse(req.body ?? {});
    let result:unknown;
    try { result = await runtimeRequest(`/services/${req.params.id}/database-restore/${req.params.operationId}/cancel`,{},options.agentConnection); }
    catch(error) {
      if(error instanceof AgentRequestError && error.certainty==='definitive' && error.statusCode===409)throw new AppError('RESTORE_BUSY','The restore cannot be cancelled now. Check the operation status.',409);
      throw error;
    }
    store.recordAudit(auth.user.id,'database.restore.cancelled',service.id);
    return result;
  });
  for (const action of ['prepare','commit','rollback','recover'] as const) {
    app.post<{Params:{id:string;operationId:string}}>(`${prefix}/services/:id/database-restore/:operationId/${action}`,async req => {
      const {auth,service}=serviceAccess(req,req.params.id,true);
      if(!/^[a-f0-9]{32}$/.test(req.params.operationId))throw new AppError('INVALID_RESTORE','Invalid database restore identity',400);
      if(!['postgres','mariadb','redis'].includes(service.kind || '')||(['rollback','recover'].includes(action)&&service.kind!=='redis'))throw new AppError('NOT_FOUND','Managed database not found',404);
      if(action==='commit'||action==='rollback')z.object({confirm:z.literal(true)}).strict().parse(req.body);
      else z.object({}).strict().parse(req.body ?? {});
      store.connectionInfo(service.id);
      store.recordAudit(auth.user.id,`database.restore.${action}.started`,service.id);
      try {
        const result=await runtimeRequest(`/services/${service.id}/database-restore/${req.params.operationId}/${action}`,{}, {...options.agentConnection,timeoutMs:900_000});
        const schema=action==='prepare'
          ? z.object({operationId:z.literal(req.params.operationId),phase:z.literal('prepared')}).strict()
          : action==='recover'?z.object({operationId:z.literal(req.params.operationId),phase:z.enum(['uploading','reserved','discarding','discarding_candidate','importing','prepared','switching','needs_review','completed','cancelled']),rolledBack:z.boolean()}).strict().refine(value=>value.phase!=='completed'||!value.rolledBack)
          : z.object({operationId:z.literal(req.params.operationId),phase:z.enum(['completed','cancelled']),rolledBack:z.boolean()}).strict().refine(value=>value.phase!=='completed'||!value.rolledBack);
        const parsed=schema.safeParse(result);
        if(!parsed.success)throw new AppError('RESTORE_UNCERTAIN','The restore outcome is unknown. Check the operation status.',503);
        store.recordAudit(auth.user.id,`database.restore.${action}.${parsed.data.phase}`,service.id);
        return parsed.data;
      } catch(error) {
        if(error instanceof AgentRequestError && error.certainty==='definitive' && error.code==='RESTORE_IMPORT_FAILED')throw new AppError('RESTORE_IMPORT_FAILED','The export could not be imported. The current database was not changed.',422);
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
