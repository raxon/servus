import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { Action, ActionEvent, ActionType, ClaimedJob, Project, Service, ServiceInput, ServicePatch, ServiceState, User } from '../shared/types.js';
import { AppError } from './errors.js';
import * as schema from './schema.js';
import { SecretVault } from '../shared/secrets.js';
import { configurationOf, validateConfiguration } from './configuration.js';

const now = () => new Date().toISOString();
const startupPause = new Int32Array(new SharedArrayBuffer(4));
function retryStartupLock<T>(operation:()=>T): T {
  const deadline=Date.now()+5000;
  for(;;) {
    try { return operation(); }
    catch(error) {
      const code=error instanceof Error && 'code' in error ? String(error.code) : '';
      if(!/^SQLITE_(BUSY|LOCKED)/.test(code)||Date.now()>=deadline)throw error;
      // SQLite journal-mode transitions can return busy without applying busy_timeout.
      Atomics.wait(startupPause,0,0,20);
    }
  }
}
export const hashToken = (value: string) => createHash('sha256').update(value).digest('hex');
type Row = Record<string, unknown>;
const serviceColumns = `id, project_id AS projectId, COALESCE(display_name,name) AS name, image, port, COALESCE(display_hostname,hostname) AS hostname, replicas, revision,
 deployed_revision AS deployedRevision, state, last_error AS lastError, created_at AS createdAt, updated_at AS updatedAt,
 config, deleted_at AS deletedAt, source_commit AS sourceCommit, image_digest AS imageDigest`;
const actionColumns = `id, project_id AS projectId, service_id AS serviceId, type, status, phase, error,
 created_at AS createdAt, updated_at AS updatedAt, finished_at AS finishedAt`;

export class Store {
  readonly db: Database.Database;
  readonly orm;
  readonly vault: SecretVault;
  constructor(readonly dataDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.db = new Database(join(dataDir, 'panel.sqlite'));
    this.db.pragma('busy_timeout = 5000');
    retryStartupLock(()=>this.db.pragma('journal_mode = WAL'));
    this.db.pragma('foreign_keys = ON');
    const version = this.db.pragma('user_version', { simple: true }) as number;
    if (version > 4) throw new Error('This database requires a newer panel release');
    if (version === 0) this.db.transaction(() => {
      const currentVersion = this.db.pragma('user_version', { simple: true }) as number;
      if(currentVersion>=1)return;
      this.db.exec(`
        CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','member')), created_at TEXT NOT NULL);
        CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, csrf_token TEXT NOT NULL, expires_at TEXT NOT NULL, absolute_expires_at TEXT NOT NULL);
        CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE memberships (project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, role TEXT NOT NULL CHECK(role IN ('editor','viewer')), PRIMARY KEY(project_id,user_id));
        CREATE TABLE services (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), name TEXT NOT NULL, image TEXT NOT NULL, port INTEGER NOT NULL, hostname TEXT NOT NULL UNIQUE, replicas INTEGER NOT NULL, revision INTEGER NOT NULL, deployed_revision INTEGER, state TEXT NOT NULL, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(project_id,name));
        CREATE TABLE actions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), service_id TEXT NOT NULL REFERENCES services(id), actor_id TEXT NOT NULL REFERENCES users(id), type TEXT NOT NULL, status TEXT NOT NULL, phase TEXT NOT NULL, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, finished_at TEXT);
        CREATE TABLE jobs (id TEXT PRIMARY KEY, action_id TEXT NOT NULL UNIQUE REFERENCES actions(id), service_id TEXT NOT NULL REFERENCES services(id), snapshot TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, worker_id TEXT, lease_until TEXT, created_at TEXT NOT NULL);
        CREATE UNIQUE INDEX active_job_service ON jobs(service_id) WHERE status IN ('queued','running');
        CREATE TABLE action_events (id TEXT PRIMARY KEY, action_id TEXT NOT NULL REFERENCES actions(id), sequence INTEGER NOT NULL, level TEXT NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(action_id,sequence));
        CREATE TABLE idempotency (actor_id TEXT NOT NULL REFERENCES users(id), key TEXT NOT NULL, request_hash TEXT NOT NULL, action_id TEXT NOT NULL REFERENCES actions(id), PRIMARY KEY(actor_id,key));
        CREATE INDEX action_project_created ON actions(project_id,created_at);
        PRAGMA user_version = 1;
      `);
    }).immediate();
    this.db.transaction(()=>{
      if(Number(this.db.pragma('user_version',{simple:true}))>=2)return;
      this.db.exec(`
        ALTER TABLE projects ADD COLUMN deleted_at TEXT;
        ALTER TABLE projects ADD COLUMN display_name TEXT;
        ALTER TABLE services ADD COLUMN config TEXT NOT NULL DEFAULT '{}';
        ALTER TABLE services ADD COLUMN deleted_at TEXT;
        ALTER TABLE services ADD COLUMN display_name TEXT;
        ALTER TABLE services ADD COLUMN display_hostname TEXT;
        ALTER TABLE services ADD COLUMN source_commit TEXT;
        ALTER TABLE services ADD COLUMN image_digest TEXT;
        CREATE TABLE service_secret_refs (reference TEXT PRIMARY KEY, service_id TEXT NOT NULL REFERENCES services(id));
        CREATE TABLE domain_reservations (hostname TEXT PRIMARY KEY, service_id TEXT NOT NULL REFERENCES services(id));
        CREATE TABLE audit_events (id TEXT PRIMARY KEY, actor_id TEXT NOT NULL REFERENCES users(id), operation TEXT NOT NULL, resource_id TEXT NOT NULL, created_at TEXT NOT NULL);
        INSERT INTO domain_reservations SELECT hostname,id FROM services;
        PRAGMA user_version = 2;
      `);
    }).immediate();
    this.db.transaction(()=>{
      if(Number(this.db.pragma('user_version',{simple:true}))>=3)return;
      this.db.exec(`
        CREATE TABLE local_credentials (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, password_hash TEXT NOT NULL);
        INSERT INTO local_credentials SELECT id,password_hash FROM users;
        UPDATE users SET password_hash='external-credentials';
        CREATE TABLE external_identities (issuer TEXT NOT NULL, subject TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, PRIMARY KEY(issuer,subject));
        CREATE TABLE central_sessions (token_hash TEXT PRIMARY KEY REFERENCES sessions(token_hash) ON DELETE CASCADE);
        CREATE TABLE central_config (id INTEGER PRIMARY KEY CHECK(id=1), issuer TEXT NOT NULL, client_id TEXT NOT NULL, client_secret TEXT NOT NULL, callback_url TEXT NOT NULL, revoke_token TEXT NOT NULL);
        CREATE TABLE central_pending_revocations (client_id TEXT PRIMARY KEY, service_origin TEXT NOT NULL, revoke_token TEXT NOT NULL);
        CREATE TABLE central_pairings (id TEXT PRIMARY KEY, service_url TEXT NOT NULL, callback_url TEXT NOT NULL, secret TEXT NOT NULL, actor_id TEXT NOT NULL REFERENCES users(id), expires_at TEXT NOT NULL, redeemed_credentials TEXT);
        CREATE TABLE central_invitations (token_hash TEXT PRIMARY KEY, email TEXT NOT NULL, actor_id TEXT NOT NULL REFERENCES users(id), expires_at TEXT NOT NULL, used_at TEXT);
        CREATE TABLE central_transactions (state_hash TEXT PRIMARY KEY, cookie_hash TEXT NOT NULL, verifier TEXT NOT NULL, nonce TEXT NOT NULL, invitation_hash TEXT, expires_at TEXT NOT NULL);
        PRAGMA user_version = 3;
      `);
    }).immediate();
    this.db.transaction(()=>{
      if(Number(this.db.pragma('user_version',{simple:true}))>=4)return;
      this.db.exec(`
        ALTER TABLE central_transactions ADD COLUMN link_user_id TEXT REFERENCES users(id);
        ALTER TABLE central_transactions ADD COLUMN link_session_hash TEXT;
        CREATE TABLE central_link_proofs (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, session_hash TEXT NOT NULL, issuer TEXT NOT NULL, subject TEXT NOT NULL, expires_at TEXT NOT NULL);
        PRAGMA user_version = 4;
      `);
    }).immediate();
    this.orm = drizzle(this.db, { schema });
    this.vault = new SecretVault(dataDir);
  }
  close() { this.db.close(); }
  isSetup() { return (this.db.prepare('SELECT count(*) AS count FROM users WHERE role = ?').get('admin') as { count: number }).count > 0; }
  createUser(email: string, passwordHash: string, role: User['role'] = 'member'): User {
    const user = { id: randomUUID(), email: email.toLowerCase(), role, createdAt: now() };
    this.db.prepare('INSERT INTO users VALUES (?,?,?,?,?)').run(user.id, user.email, 'external-credentials', role, user.createdAt);
    this.db.prepare('INSERT INTO local_credentials VALUES (?,?)').run(user.id,passwordHash);
    return user;
  }
  setup(email: string, passwordHash: string): User {
    return this.db.transaction(() => {
      if (this.isSetup()) throw new AppError('SETUP_COMPLETE', 'Setup is already complete', 409);
      return this.createUser(email, passwordHash, 'admin');
    }).immediate();
  }
  removeLegacyBootstrapToken() {
    try { unlinkSync(join(this.dataDir,'bootstrap-token')); }
    catch { /* The legacy file does not participate in setup. */ }
  }
  findUser(email: string) {
    return this.db.prepare('SELECT u.id,u.email,u.role,u.created_at AS createdAt,c.password_hash AS passwordHash FROM users u JOIN local_credentials c ON c.user_id=u.id WHERE u.email = ?').get(email.toLowerCase()) as (User & { passwordHash: string }) | undefined;
  }
  localCredentialForSession(userId: string, token: string) {
    return this.db.prepare(`SELECT c.password_hash AS passwordHash FROM local_credentials c
      JOIN sessions s ON s.user_id=c.user_id LEFT JOIN central_sessions cs ON cs.token_hash=s.token_hash
      WHERE c.user_id=? AND s.token_hash=? AND cs.token_hash IS NULL AND s.expires_at>? AND s.absolute_expires_at>?`)
      .get(userId,hashToken(token),now(),now()) as {passwordHash:string} | undefined;
  }
  createLocalSession(userId:string, expectedHash:string) {
    return this.db.transaction(()=>{
      const credential=this.db.prepare('SELECT 1 FROM local_credentials WHERE user_id=? AND password_hash=?').get(userId,expectedHash);
      return credential ? this.createSession(userId) : null;
    }).immediate();
  }
  changeLocalPassword(userId:string, token:string, expectedHash:string, replacementHash:string) {
    return this.db.transaction(()=>{
      const credential=this.localCredentialForSession(userId,token);
      if(!credential || credential.passwordHash!==expectedHash)return false;
      const changed=this.db.prepare('UPDATE local_credentials SET password_hash=? WHERE user_id=? AND password_hash=?').run(replacementHash,userId,expectedHash);
      if(changed.changes!==1)return false;
      this.db.prepare('DELETE FROM sessions WHERE user_id=? AND token_hash<>?').run(userId,hashToken(token));
      this.recordAudit(userId,'account.password.changed',userId);
      return true;
    }).immediate();
  }
  createSession(userId: string, central = false) {
    const token = randomBytes(32).toString('hex'), csrfToken = randomBytes(32).toString('hex');
    const absolute = new Date(Date.now() + (central ? 900_000 : 30 * 86_400_000)).toISOString();
    this.db.transaction(()=>{
      this.db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?)').run(hashToken(token), userId, csrfToken, central ? absolute : new Date(Date.now() + 86_400_000).toISOString(), absolute);
      if(central)this.db.prepare('INSERT INTO central_sessions VALUES (?)').run(hashToken(token));
    })();
    return { token, csrfToken };
  }
  getSession(token: string) {
    const row = this.db.prepare(`SELECT u.id,u.email,u.role,u.created_at AS createdAt,s.csrf_token AS csrfToken,s.expires_at AS expiresAt,s.absolute_expires_at AS absoluteExpiresAt FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?`).get(hashToken(token)) as (User & { csrfToken: string; expiresAt: string; absoluteExpiresAt: string }) | undefined;
    if (!row || row.expiresAt <= now() || row.absoluteExpiresAt <= now()) { this.deleteSession(token); return null; }
    const expires = new Date(Math.min(Date.now() + 86_400_000, Date.parse(row.absoluteExpiresAt))).toISOString();
    this.db.prepare('UPDATE sessions SET expires_at=? WHERE token_hash=?').run(expires, hashToken(token));
    return { user: { id: row.id, email: row.email, role: row.role, createdAt: row.createdAt } as User, csrfToken: row.csrfToken };
  }
  deleteSession(token: string) { this.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hashToken(token)); }
  addMember(projectId: string, userId: string, role: 'editor' | 'viewer') { this.db.prepare('INSERT INTO memberships VALUES (?,?,?) ON CONFLICT(project_id,user_id) DO UPDATE SET role=excluded.role').run(projectId, userId, role); }
  canAccess(user: User, projectId: string, write = false): boolean {
    if (!this.getProject(projectId)) return false;
    if (user.role === 'admin') return true;
    const member = this.db.prepare('SELECT role FROM memberships WHERE project_id=? AND user_id=?').get(projectId, user.id) as { role: string } | undefined;
    return !!member && (!write || member.role === 'editor');
  }
  listProjects(user?: User): Project[] {
    const rows = this.db.prepare(`SELECT p.id,COALESCE(p.display_name,p.name) AS name,p.description,p.created_at AS createdAt,(SELECT count(*) FROM services s WHERE s.project_id=p.id AND s.deleted_at IS NULL) AS serviceCount FROM projects p WHERE p.deleted_at IS NULL ORDER BY p.created_at DESC`).all() as Project[];
    return user ? rows.filter(p => this.canAccess(user, p.id)) : rows;
  }
  getProject(id: string, includeDeleted=false): Project | undefined { return this.db.prepare(`SELECT p.id,COALESCE(p.display_name,p.name) AS name,p.description,p.created_at AS createdAt,(SELECT count(*) FROM services s WHERE s.project_id=p.id AND s.deleted_at IS NULL) AS serviceCount FROM projects p WHERE p.id=? ${includeDeleted?'':'AND p.deleted_at IS NULL'}`).get(id) as Project|undefined; }
  createProject(name: string, description = '', actorId?:string): Project {
    return this.db.transaction(()=>{
      const project = { id: randomUUID(), name, description, createdAt: now(), serviceCount: 0 };
      try { this.db.prepare('INSERT INTO projects(id,name,description,created_at) VALUES (?,?,?,?)').run(project.id, name, description, project.createdAt); }
      catch (error) { this.constraintError(error); }
      if(actorId)this.recordAudit(actorId,'project.create',project.id);
      return project;
    }).immediate();
  }
  updateProject(id:string, input:{name?:string;description?:string}, actorId?:string): Project {
    return this.db.transaction(()=>{
      const project=this.getProject(id);if(!project)throw new AppError('NOT_FOUND','Project not found',404);
      try{this.db.prepare('UPDATE projects SET name=?,description=? WHERE id=? AND deleted_at IS NULL').run(input.name??project.name,input.description??project.description,id);}
      catch(error){this.constraintError(error);}
      if(actorId)this.recordAudit(actorId,'project.update',id);
      return this.getProject(id)!;
    }).immediate();
  }
  deleteProject(id:string, actorId?:string) {
    this.db.transaction(()=>{
      if(!this.getProject(id))throw new AppError('NOT_FOUND','Project not found',404);
      if(this.listServices(id).length)throw new AppError('PROJECT_NOT_EMPTY','Destroy all services before deleting this project',409);
      this.db.prepare('UPDATE projects SET display_name=name,name=?,deleted_at=? WHERE id=?').run(`archived-${id}`,now(),id);
      if(actorId)this.recordAudit(actorId,'project.delete',id);
    }).immediate();
  }
  canReadAudit(user:User,projectId:string):boolean {
    if(!this.getProject(projectId,true))return false;
    return user.role==='admin'||!!this.db.prepare('SELECT 1 FROM memberships WHERE project_id=? AND user_id=?').get(projectId,user.id);
  }
  private hydrateService(row:Row|undefined):Service|undefined {
    if(!row)return undefined;
    const {config,...rest}=row;
    const result={...JSON.parse(String(config??'{}')),...rest} as unknown as Service;
    if(!result.kind)result.kind='app';
    if(!result.source)result.source={type:'image'};
    return result;
  }
  listServices(projectId?: string): Service[] { return this.db.prepare(`SELECT ${serviceColumns} FROM services WHERE deleted_at IS NULL ${projectId ? 'AND project_id=?' : ''} ORDER BY created_at DESC`).all(...(projectId ? [projectId] : [])).map(row=>this.hydrateService(row as Row)!); }
  getService(id: string, includeDeleted=false): Service | undefined { return this.hydrateService(this.db.prepare(`SELECT ${serviceColumns} FROM services WHERE id=? ${includeDeleted?'':'AND deleted_at IS NULL'}`).get(id) as Row|undefined); }
  createService(projectId: string, input: ServiceInput, actorId: string, idempotencyKey?: string) {
    return this.db.transaction(() => {
      const requestHash = hashToken(JSON.stringify({projectId,input:{...input,replicas:input.replicas ?? 1}}));
      if (idempotencyKey) {
        const previous = this.db.prepare('SELECT request_hash,action_id FROM idempotency WHERE actor_id=? AND key=?').get(actorId,idempotencyKey) as {request_hash:string;action_id:string}|undefined;
        if(previous) {
          if(previous.request_hash!==requestHash)throw new AppError('IDEMPOTENCY_CONFLICT','This idempotency key was used for a different operation',409);
          const snapshot=this.db.prepare('SELECT snapshot FROM jobs WHERE action_id=?').get(previous.action_id) as {snapshot:string};
          return {service:JSON.parse(snapshot.snapshot) as Service,action:this.getAction(previous.action_id)!};
        }
      }
      const service: Service = { id: randomUUID(), projectId, ...input, replicas: input.replicas ?? 1, revision: 1, deployedRevision: null, state: 'pending', lastError: null, createdAt: now(), updatedAt: now() };
      validateConfiguration(service);
      if(service.kind&&service.kind!=='app')service.hostname=`${service.id}.internal`;
      if(service.domains?.length===0)service.hostname=`${service.id}.internal`;
      try { this.db.prepare('INSERT INTO services(id,project_id,name,image,port,hostname,replicas,revision,deployed_revision,state,last_error,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(service.id,projectId,service.name,service.image,service.port,service.hostname,service.replicas,1,null,service.state,null,service.createdAt,service.updatedAt); }
      catch (error) { this.constraintError(error); }
      const protectedConfig=this.protectConfiguration(service.id,service);
      this.db.prepare('UPDATE services SET config=? WHERE id=?').run(JSON.stringify(protectedConfig),service.id);
      this.reserveDomains({...service,...protectedConfig});
      const action = this.createAction(service.id, 'deploy', actorId, `initial:${service.id}`);
      if(idempotencyKey)this.db.prepare('INSERT INTO idempotency VALUES (?,?,?,?)').run(actorId,idempotencyKey,requestHash,action.id);
      return { service:this.getService(service.id)!, action };
    }).immediate();
  }
  updateService(id: string, patch: ServicePatch, actorId?:string): Service {
    return this.db.transaction(() => {
      const service = this.getService(id);
      if (!service) throw new AppError('NOT_FOUND', 'Service not found', 404);
      if (service.revision !== patch.expectedRevision) throw new AppError('REVISION_CONFLICT', 'Configuration changed. Reload before saving.', 409);
      const next = { ...service, ...patch, revision: service.revision + 1, updatedAt: now() };
      if(!patch.domains&&(patch.hostname!==undefined||patch.port!==undefined)&&(next.kind??'app')==='app'&&service.domains!==undefined) {
        if(!service.domains.length&&patch.hostname)next.domains=[{hostname:patch.hostname,port:patch.port??service.port,primary:true}];
        else {const index=Math.max(0,service.domains.findIndex(domain=>domain.primary));next.domains=service.domains.map((domain,i)=>i===index?{...domain,hostname:patch.hostname??domain.hostname,port:patch.port??domain.port}:domain);}
      }
      if((next.kind??'app')!==(service.kind??'app'))throw new AppError('KIND_IMMUTABLE','Service type cannot change after creation');
      if((service.kind??'app')!=='app'&&service.deployedRevision!==null&&patch.image!==undefined&&patch.image!==service.image)throw new AppError('DATABASE_UPGRADE_REQUIRES_MIGRATION','Changing a deployed database image requires an explicit backup and migration procedure',409);
      if((service.kind??'app')!=='app'&&patch.database) {
        const current=service.database;
        if(patch.database.password!==undefined||patch.database.database!==current?.database||patch.database.user!==current?.user||patch.database.passwordSecretRef!==current?.passwordSecretRef)throw new AppError('DATABASE_CREDENTIALS_IMMUTABLE','Managed database names and credentials cannot be changed through configuration. Use a dedicated migration or credential-rotation operation.',409);
      }
      validateConfiguration(next);
      if(next.domains?.length) {const primary=next.domains.find(domain=>domain.primary)??next.domains[0]!;next.hostname=primary.hostname;next.port=primary.port;}
      else if(next.domains?.length===0)next.hostname=`${id}.internal`;
      const protectedConfig=this.protectConfiguration(id,next);
      try { this.db.prepare('UPDATE services SET image=?,port=?,hostname=?,replicas=?,revision=?,config=?,updated_at=? WHERE id=?').run(next.image,next.port,next.hostname,next.replicas,next.revision,JSON.stringify(protectedConfig),next.updatedAt,id); }
      catch (error) { this.constraintError(error); }
      this.reserveDomains({...next,...protectedConfig});
      if(actorId)this.recordAudit(actorId,'service.update',id);
      return this.getService(id)!;
    }).immediate();
  }
  createAction(serviceId: string, type: ActionType, actorId: string, key: string): Action {
    return this.db.transaction(() => {
      const service = this.getService(serviceId,true);
      if (!service) throw new AppError('NOT_FOUND', 'Service not found', 404);
      const requestHash = hashToken(JSON.stringify({ serviceId, type }));
      const previous = this.db.prepare('SELECT request_hash,action_id FROM idempotency WHERE actor_id=? AND key=?').get(actorId,key) as { request_hash: string; action_id: string } | undefined;
      if (previous) {
        if (previous.request_hash !== requestHash) throw new AppError('IDEMPOTENCY_CONFLICT', 'This idempotency key was used for a different operation', 409);
        return this.getAction(previous.action_id)!;
      }
      if(service.deletedAt)throw new AppError('SERVICE_DELETED','This service has been destroyed',410);
      if (this.db.prepare("SELECT id FROM jobs WHERE service_id=? AND status IN ('queued','running')").get(serviceId)) throw new AppError('SERVICE_BUSY', 'Another operation is already queued or running for this service', 409);
      const action: Action = { id: randomUUID(), projectId: service.projectId, serviceId, type, status: 'queued', phase: 'queued', error: null, createdAt: now(), updatedAt: now(), finishedAt: null };
      this.db.prepare('INSERT INTO actions VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(action.id,action.projectId,serviceId,actorId,type,action.status,action.phase,null,action.createdAt,action.updatedAt,null);
      this.db.prepare('INSERT INTO jobs (id,action_id,service_id,snapshot,status,created_at) VALUES (?,?,?,?,?,?)').run(randomUUID(),action.id,serviceId,JSON.stringify(service),'queued',now());
      this.db.prepare('INSERT INTO idempotency VALUES (?,?,?,?)').run(actorId,key,requestHash,action.id);
      this.appendEvent(action.id,'info',`${type[0]!.toUpperCase()}${type.slice(1)} queued for configuration revision ${service.revision}`);
      return action;
    }).immediate();
  }
  getAction(id: string): Action | undefined { return this.db.prepare(`SELECT ${actionColumns} FROM actions WHERE id=?`).get(id) as Action | undefined; }
  listActions(projectId?: string, serviceId?: string): Action[] {
    const where: string[] = [], params: string[] = [];
    if (projectId) { where.push('project_id=?'); params.push(projectId); }
    if (serviceId) { where.push('service_id=?'); params.push(serviceId); }
    return this.db.prepare(`SELECT ${actionColumns} FROM actions ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT 200`).all(...params) as Action[];
  }
  getEvents(actionId: string): ActionEvent[] { return this.db.prepare('SELECT id,action_id AS actionId,sequence,level,message,created_at AS createdAt FROM action_events WHERE action_id=? ORDER BY sequence DESC LIMIT 500').all(actionId).reverse() as ActionEvent[]; }
  appendEvent(actionId: string, level: ActionEvent['level'], message: string) {
    this.db.prepare('INSERT INTO action_events SELECT ?,?,COALESCE(MAX(sequence),0)+1,?,?,? FROM action_events WHERE action_id=?').run(randomUUID(),actionId,level,this.vault.redact(message).slice(0,8000),now(),actionId);
  }
  appendOwnedEvent(actionId: string, workerId: string, level: ActionEvent['level'], message: string): boolean {
    return this.db.prepare(`INSERT INTO action_events (id,action_id,sequence,level,message,created_at)
      SELECT ?,?,COALESCE((SELECT MAX(sequence) FROM action_events WHERE action_id=?),0)+1,?,?,?
      WHERE EXISTS (SELECT 1 FROM jobs WHERE action_id=? AND worker_id=? AND status='running' AND lease_until>?)`)
      .run(randomUUID(),actionId,actionId,level,this.vault.redact(message).slice(0,8000),now(),actionId,workerId,now()).changes===1;
  }
  claimNextJob(workerId: string, leaseMs: number): ClaimedJob | null {
    return this.db.transaction(() => {
      const row = this.db.prepare("SELECT j.*,a.type FROM jobs j JOIN actions a ON a.id=j.action_id WHERE j.status='queued' OR (j.status='running' AND j.lease_until<=?) ORDER BY j.created_at LIMIT 1").get(now()) as Row | undefined;
      if (!row) return null;
      const until = new Date(Date.now()+leaseMs).toISOString();
      this.db.prepare("UPDATE jobs SET status='running',attempts=attempts+1,worker_id=?,lease_until=? WHERE id=?").run(workerId,until,row.id);
      this.db.prepare("UPDATE actions SET status='running',phase=?,updated_at=? WHERE id=?").run(row.status === 'running' ? 'reconciling' : 'planning',now(),row.action_id);
      return { id: row.id as string, actionId: row.action_id as string, serviceId: row.service_id as string, type: row.type as ActionType, snapshot: JSON.parse(row.snapshot as string) as Service, attempts: Number(row.attempts)+1, recovered: row.status === 'running', workerId, leaseUntil: until };
    }).immediate();
  }
  renewJob(jobId: string, workerId: string, leaseMs: number): boolean { return this.db.prepare("UPDATE jobs SET lease_until=? WHERE id=? AND worker_id=? AND status='running' AND lease_until>?").run(new Date(Date.now()+leaseMs).toISOString(),jobId,workerId,now()).changes === 1; }
  private ownedAction(actionId: string, workerId: string): boolean { return !!this.db.prepare("SELECT id FROM jobs WHERE action_id=? AND worker_id=? AND status='running' AND lease_until>?").get(actionId,workerId,now()); }
  setActionPhase(actionId: string, workerId: string, phase: string): boolean {
    return this.db.prepare("UPDATE actions SET phase=?,updated_at=? WHERE id=? AND EXISTS (SELECT 1 FROM jobs WHERE action_id=? AND worker_id=? AND status='running' AND lease_until>?)").run(phase,now(),actionId,actionId,workerId,now()).changes===1;
  }
  completeAction(actionId: string, workerId: string, runtime?: { state: ServiceState; deployedRevision?: number; lastError?: string | null; sourceCommit?:string|null;imageDigest?:string|null }): boolean {
    return this.db.transaction(() => {
      if (!this.ownedAction(actionId,workerId)) return false;
      const action = this.getAction(actionId)!;
      this.db.prepare("UPDATE actions SET status='succeeded',phase='complete',updated_at=?,finished_at=? WHERE id=?").run(now(),now(),actionId);
      this.db.prepare("UPDATE jobs SET status='succeeded',lease_until=NULL WHERE action_id=?").run(actionId);
      if (runtime) this.updateServiceRuntime(action.serviceId,runtime);
      if(action.type==='deploy') {
        const job=this.db.prepare('SELECT snapshot FROM jobs WHERE action_id=?').get(actionId) as {snapshot:string};
        if((JSON.parse(job.snapshot) as Service).source?.type!=='git')this.db.prepare('UPDATE services SET source_commit=NULL WHERE id=?').run(action.serviceId);
        const service=this.getService(action.serviceId);
        if(service)this.reserveDomains(service);
      }
      if(action.type==='destroy') {
        this.db.prepare('DELETE FROM domain_reservations WHERE service_id=?').run(action.serviceId);
        this.db.prepare("UPDATE services SET display_name=name,display_hostname=hostname,name=?,hostname=?,state='stopped',deleted_at=?,updated_at=? WHERE id=?").run(`archived-${action.serviceId}`,`archived-${action.serviceId}.invalid`,now(),now(),action.serviceId);
      }
      this.appendEvent(actionId,'info','Operation completed successfully'); return true;
    }).immediate();
  }
  failAction(actionId: string, workerId: string, error: string): boolean {
    return this.db.transaction(() => {
      if (!this.ownedAction(actionId,workerId)) return false;
      error=this.vault.redact(error);
      const action = this.getAction(actionId)!;
      this.db.prepare("UPDATE actions SET status='failed',phase='failed',error=?,updated_at=?,finished_at=? WHERE id=?").run(error.slice(0,2000),now(),now(),actionId);
      this.db.prepare("UPDATE jobs SET status='failed',lease_until=NULL WHERE action_id=?").run(actionId);
      this.updateServiceRuntime(action.serviceId,{state:'failed',lastError:error.slice(0,2000)});
      const service=this.getService(action.serviceId);
      if(service&&action.type==='deploy')this.reserveDomains(service);
      this.appendEvent(actionId,'error',error); return true;
    }).immediate();
  }
  updateServiceRuntime(serviceId: string, runtime: { state: ServiceState; deployedRevision?: number; lastError?: string | null;sourceCommit?:string|null;imageDigest?:string|null }, guardActionId?: string) {
    return this.db.transaction(()=>{
      const service = this.getService(serviceId); if (!service) return false;
      if(guardActionId) {
        const latest=this.db.prepare('SELECT action_id FROM jobs WHERE service_id=? ORDER BY rowid DESC LIMIT 1').get(serviceId) as {action_id:string}|undefined;
        if(latest?.action_id!==guardActionId)return false;
      }
      this.db.prepare('UPDATE services SET state=?,deployed_revision=?,last_error=?,source_commit=?,image_digest=?,updated_at=? WHERE id=?').run(runtime.state,runtime.deployedRevision ?? service.deployedRevision,runtime.lastError ? this.vault.redact(runtime.lastError):null,runtime.sourceCommit===undefined?service.sourceCommit??null:runtime.sourceCommit,runtime.imageDigest===undefined?service.imageDigest??null:runtime.imageDigest,now(),serviceId);
      return true;
    }).immediate();
  }
  private requireOwnedSecret(serviceId:string,reference:string) {
    if(!this.db.prepare('SELECT 1 FROM service_secret_refs WHERE reference=? AND service_id=?').get(reference,serviceId))throw new AppError('SECRET_REFERENCE','This secret reference does not belong to this service',403);
    try{this.vault.get(reference);}catch{throw new AppError('SECRET_REFERENCE','This secret is unavailable',400);}
    return reference;
  }
  private putServiceSecret(serviceId:string,value:string) {
    const reference=this.vault.put(value);
    this.db.prepare('INSERT INTO service_secret_refs(reference,service_id) VALUES (?,?)').run(reference,serviceId);
    return reference;
  }
  private protectConfiguration(serviceId:string,input:Service):import('../shared/types.js').ServiceConfiguration {
    const config=configurationOf(input);
    config.environment=(config.environment??[]).map(env=>{
      if(!env.secret)return {name:env.name,value:env.value??'',secret:false};
      const reference=env.value!==undefined?this.putServiceSecret(serviceId,env.value):env.secretRef?this.requireOwnedSecret(serviceId,env.secretRef):null;
      if(!reference)throw new AppError('SECRET_REQUIRED','Enter a secret value or retain its existing reference');
      return {name:env.name,secret:true,secretRef:reference};
    });
    if((config.kind??'app')!=='app') {
      const database=config.database??{database:'app',user:'app'};
      const reference=database.password!==undefined?this.putServiceSecret(serviceId,database.password):database.passwordSecretRef?this.requireOwnedSecret(serviceId,database.passwordSecretRef):this.putServiceSecret(serviceId,randomBytes(24).toString('base64url'));
      config.database={database:database.database,user:database.user,passwordSecretRef:reference};
    } else if(config.database)throw new AppError('DATABASE_CONFIG','Database settings belong to managed database services');
    return config;
  }
  private reserveDomains(service:Service) {
    const domainNames=(item:Service)=>(item.kind??'app')==='app'?(item.domains??[{hostname:item.hostname,port:item.port}]).map(domain=>domain.hostname):[];
    const names=new Set(domainNames(service));
    const snapshots=this.db.prepare(`SELECT j.snapshot,j.status FROM jobs j JOIN actions a ON a.id=j.action_id
      WHERE j.service_id=? AND a.type='deploy' AND j.status IN ('queued','running','succeeded','failed') ORDER BY j.rowid DESC`).all(service.id) as {snapshot:string;status:string}[];
    let deployedFound=false;
    for(const row of snapshots) {
      const snapshot=JSON.parse(row.snapshot) as Service;
      if(row.status==='queued'||row.status==='running')for(const hostname of domainNames(snapshot))names.add(hostname);
      else if(row.status==='failed'&&!deployedFound)for(const hostname of domainNames(snapshot))names.add(hostname);
      else if(!deployedFound&&service.deployedRevision!==null&&snapshot.revision===service.deployedRevision) {
        for(const hostname of domainNames(snapshot))names.add(hostname);
        deployedFound=true;
      }
    }
    this.db.prepare('DELETE FROM domain_reservations WHERE service_id=?').run(service.id);
    try{for(const hostname of names)this.db.prepare('INSERT INTO domain_reservations(hostname,service_id) VALUES (?,?)').run(hostname,service.id);}
    catch(error){this.constraintError(error);}
  }
  connectionInfo(serviceId:string,reveal=false):import('../shared/types.js').ConnectionInfo {
    const service=this.getService(serviceId);
    if(!service||!service.kind||service.kind==='app')throw new AppError('NOT_FOUND','Managed database not found',404);
    const deployed=this.db.prepare("SELECT j.snapshot FROM jobs j JOIN actions a ON a.id=j.action_id WHERE j.service_id=? AND a.type='deploy' AND a.status='succeeded' ORDER BY a.finished_at DESC,a.rowid DESC LIMIT 1").get(serviceId) as {snapshot:string}|undefined;
    if(!deployed||service.deployedRevision===null)throw new AppError('DATABASE_NOT_DEPLOYED','Database connection is available after its first confirmed deployment',409);
    const database=(JSON.parse(deployed.snapshot) as Service).database??{database:'app',user:'app'};
    const result:import('../shared/types.js').ConnectionInfo={host:`panel-app-${service.id}`,port:service.kind==='postgres'?5432:service.kind==='mariadb'?3306:6379,database:service.kind==='redis'?'0':database.database,user:service.kind==='redis'?'default':database.user};
    if(reveal&&database.passwordSecretRef){this.requireOwnedSecret(serviceId,database.passwordSecretRef);result.password=this.vault.get(database.passwordSecretRef);}
    return result;
  }
  recordAudit(actorId:string,operation:string,resourceId:string) {this.db.prepare('INSERT INTO audit_events(id,actor_id,operation,resource_id,created_at) VALUES (?,?,?,?,?)').run(randomUUID(),actorId,operation,resourceId,now());}
  private constraintError(error: unknown): never {
    if (error instanceof Error && error.message.includes('UNIQUE constraint')) throw new AppError('CONFLICT','A resource with this name or hostname already exists',409);
    throw error;
  }
}
