import type { FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import Docker from 'dockerode';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { SecretVault } from '../shared/secrets.js';
import { composeConfigSchema, type ComposeApplyRequest, type ComposeApplyResult } from '../shared/compose.js';
import { parseComposeDefinition, compileComposeDefinition, type ComposeDefinition, type ComposeCertificateRetryHint } from './compose-configuration.js';
import { resolveRepository } from './build.js';
import {buildComposeImages,composeBuildIds,composeBuildPath,verifyComposeBuiltImages,type ComposeBuiltImages} from './compose-build.js';
import type { agentConfig } from './config.js';
import type { AgentMaintenanceGate } from './maintenance.js';
import { assertComposeHttpsIngress, configuredComposeHttps, composeCertificateStatus, ComposeTlsError, type ComposeTlsOptions } from './compose-tls.js';
import { composeMetrics } from './observability.js';

export const AGENT_COMPOSE_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS compose_operations(id TEXT PRIMARY KEY,workload_id TEXT NOT NULL,project_id TEXT NOT NULL,type TEXT NOT NULL,request_hash TEXT NOT NULL,state TEXT NOT NULL,process_group INTEGER,snapshot TEXT NOT NULL,response TEXT,error TEXT,updated_at TEXT NOT NULL); CREATE UNIQUE INDEX IF NOT EXISTS compose_running_workload ON compose_operations(workload_id) WHERE state='running';`;
const requestSchema = z.object({ operationId: z.string().uuid(), workloadId: z.string().uuid(), projectId: z.string().uuid(), revision: z.number().int().positive(), type: z.enum(['deploy','start','stop','restart','destroy']), configuration: composeConfigSchema, certificateRetry:z.object({hostname:z.string().min(1).max(253)}).strict().optional() }).strict().refine(value=>!value.certificateRetry||value.type==='deploy');
interface Snapshot { request: ComposeApplyRequest; definition?: ComposeDefinition; commit?: string; retries?:Record<string,ComposeCertificateRetryHint>; previous?:Snapshot|null; stage?:'prepared'|'applying'|'rolling_back'; failure?:string; retryPrepared?:boolean;images?:ComposeBuiltImages;buildStartedAt?:string }
interface Row { id: string; workload_id: string; project_id: string; state: string; request_hash: string; process_group: number | null; snapshot: string; response: string | null; error: string | null }
class ComposeNotDeployedError extends Error {}
const wrapper = `const {spawn}=require('node:child_process');let started=false;process.on('disconnect',()=>{if(!started)process.exit(1)});process.once('message',()=>{started=true;const {command,args}=JSON.parse(process.argv[1]);const child=spawn(command,args,{stdio:['ignore','inherit','inherit'],env:process.env});child.once('error',()=>process.exit(127));child.once('exit',code=>process.exit(code??1));});`;

export class ComposeRuntime {
  readonly journal: Database.Database;
  readonly vault: SecretVault;
  readonly docker: Docker;
  private readonly active = new Set<string>();
  constructor(readonly config: ReturnType<typeof agentConfig>,private readonly options:ComposeTlsOptions&{beforeMutation?:()=>void}={}) {
    mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
    this.vault = new SecretVault(config.dataDir); this.docker = new Docker({ socketPath: config.dockerSocket });
    this.journal = new Database(join(config.dataDir, 'agent.sqlite')); this.journal.pragma('busy_timeout = 5000'); this.journal.exec(AGENT_COMPOSE_SCHEMA_SQL);
  }
  close() { this.journal.close(); }
  private processAlive(group: number | null) {
    if (!group) return false;
    try { process.kill(-group, 0); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; return true; }
  }
  private redact(text: string, definition?: ComposeDefinition) {
    let result = this.vault.redact(text);
    for (const service of Object.values(definition?.services ?? {})) {
      const build=typeof service.build==='object'?Object.values(service.build.args??{}):[];
      const values = Array.isArray(service.environment) ? service.environment.map(entry => entry.slice(entry.indexOf('=') + 1)) : Object.values(service.environment ?? {});
      for (const entry of [...values,...build.map(String)]) if (typeof entry === 'string' && entry.length > 0) result = result.replaceAll(entry, '[REDACTED]').replaceAll(JSON.stringify(entry).slice(1, -1), '[REDACTED]');
    }
    return result;
  }
  private run(command: string, args: string[], cwd: string, operationId?: string, env: NodeJS.ProcessEnv = {}, timeoutMs = 180_000): Promise<string> {
    return new Promise((resolvePromise, reject) => {
      const child = spawn(process.execPath, ['-e', wrapper, JSON.stringify({ command, args })], { cwd, detached: true, env: { PATH: process.env.PATH, HOME: cwd, LANG: 'C', ...(process.env.DOCKER_CONFIG ? { DOCKER_CONFIG: process.env.DOCKER_CONFIG } : {}), ...env }, stdio: ['ignore','pipe','pipe','ipc'] });
      let output = '', timedOut = false;
      const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid!, 'SIGKILL'); } catch {} }, timeoutMs);
      const capture = (data: Buffer) => { output = (output + data.toString('utf8')).slice(-256 * 1024); };
      child.stdout!.on('data', capture); child.stderr!.on('data', capture);
      child.once('spawn', () => {
        try { if (operationId) this.journal.prepare('UPDATE compose_operations SET process_group=?,updated_at=? WHERE id=?').run(child.pid!, new Date().toISOString(), operationId); child.send('go'); }
        catch (error) { try { process.kill(-child.pid!, 'SIGKILL'); } catch {} reject(error); }
      });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', code => { clearTimeout(timer); if (timedOut) reject(new Error('Compose command exceeded its execution deadline.')); else if (code !== 0) reject(new Error('Compose command failed. ' + output.slice(-4000))); else resolvePromise(output); });
    });
  }
  private async source(request: ComposeApplyRequest, directory: string,pinnedCommit?:string): Promise<{ definition: ComposeDefinition; commit?: string;checkout?:string }> {
    if (request.configuration.source.type === 'inline') return { definition: parseComposeDefinition(request.configuration.source.yaml) };
    const source = request.configuration.source, resolved = await resolveRepository(source.repository);
    if (source.branch.includes('..') || source.branch.endsWith('/')) throw new Error('Invalid Compose Git branch.');
    const gitConfig = ['-c','protocol.file.allow=never','-c','http.followRedirects=false','-c','core.hooksPath=/dev/null'];
    if (resolved.resolve) gitConfig.push('-c', `http.curloptResolve=${resolved.resolve}`);
    const env = { GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ASKPASS: '/bin/false' };
    if(pinnedCommit){
      if(!/^[a-f0-9]{40,64}$/.test(pinnedCommit))throw new Error('The pinned Compose commit is invalid.');
      const checkout=join(directory,'repository');mkdirSync(checkout,{mode:0o700});
      await this.run('git',[...gitConfig,'init'],checkout,request.operationId,env,10000);
      await this.run('git',[...gitConfig,'remote','add','origin',source.repository],checkout,request.operationId,env,10000);
      await this.run('git',[...gitConfig,'fetch',...(resolved.url.protocol==='https:'?['--depth','1']:[]),'origin',pinnedCommit],checkout,request.operationId,env,120000);
      await this.run('git',[...gitConfig,'checkout','--detach',pinnedCommit],checkout,request.operationId,env,10000);
    }else await this.run('git', [...gitConfig, 'clone', ...(resolved.url.protocol==='https:'?['--depth','1']:[]),'--single-branch','--branch',source.branch,'--',source.repository,'repository'], directory, request.operationId, env, 120_000);
    const root = realpathSync(join(directory,'repository')), path = composeBuildPath(root,root,source.path,'file'), inside = relative(root,path);
    if (inside === '..' || inside.startsWith('..' + sep) || isAbsolute(inside) || !statSync(path).isFile() || statSync(path).size > 256 * 1024) throw new Error('Compose file must remain inside the repository and be at most 256 KiB.');
    const commit = (await this.run('git', ['rev-parse','HEAD'], root, request.operationId, env)).trim();
    if (!/^[a-f0-9]{40,64}$/.test(commit)||pinnedCommit&&commit!==pinnedCommit) throw new Error('Invalid Compose Git commit.');
    return { definition: parseComposeDefinition(readFileSync(path,'utf8'),'git'), commit,checkout:root };
  }
  private latest(workloadId: string, projectId: string,allowFailed=false): Snapshot {
    const rows = this.journal.prepare(`SELECT snapshot FROM compose_operations WHERE workload_id=? AND project_id=? AND type='deploy' ${allowFailed?'':"AND state='succeeded'"} ORDER BY updated_at DESC,rowid DESC LIMIT 100`).all(workloadId,projectId) as { snapshot: string }[];
    for(const row of rows){const snapshot=JSON.parse(this.vault.open(row.snapshot)) as Snapshot;if(snapshot.definition)return snapshot;}
    throw new ComposeNotDeployedError('Deploy this Compose workload before running lifecycle operations.');
  }
  private async verifyOwnership(prefix: string, definition: any, workloadId: string,projectId:string) {
    const containers = await this.docker.listContainers({ all: true, filters: { label: [`com.docker.compose.project=${prefix}`] } });
    if (containers.some(container => container.Labels?.['panel.workload'] !== workloadId || container.Labels?.['panel.project']!==projectId || container.Labels?.['panel.owner'] !== 'self-hosted-panel')) throw new Error('Compose containers belong to another workload or project.');
    for (const [kind, entries] of [['volume', definition.volumes], ['network', definition.networks]] as const) {
      for (const resource of Object.values(entries ?? {}) as any[]) {
        if (resource.external) {
          const network = await this.docker.getNetwork('panel-ingress').inspect();
          if (network.Labels?.['panel.owner'] !== 'self-hosted-panel' || network.Attachable !== true) throw new Error('The application ingress network is unavailable.');
          continue;
        }
        try {
          const existing = kind === 'volume' ? await this.docker.getVolume(resource.name).inspect() : await this.docker.getNetwork(resource.name).inspect();
          if (existing.Labels?.['panel.workload'] !== workloadId || existing.Labels?.['panel.project']!==projectId || existing.Labels?.['panel.owner'] !== 'self-hosted-panel') throw new Error('Compose storage or networking belongs to another workload or project.');
        } catch (error) { if ((error as { statusCode?: number }).statusCode !== 404) throw error; }
      }
    }
  }
  private stable(snapshot:Snapshot):Snapshot {
    return {request:snapshot.request,definition:snapshot.definition,commit:snapshot.commit,retries:snapshot.retries,images:snapshot.images};
  }
  private saveSnapshot(id:string,snapshot:Snapshot) {
    this.journal.prepare('UPDATE compose_operations SET snapshot=?,updated_at=? WHERE id=?').run(this.vault.seal(JSON.stringify(snapshot)),new Date().toISOString(),id);
  }
  private async execute(snapshot:Snapshot,request:ComposeApplyRequest,directory:string,operation:string[],file='compose.json') {
    const compiled=compileComposeDefinition(snapshot.definition!,snapshot.request.configuration,request.workloadId,request.projectId,snapshot.retries,composeBuildIds(snapshot.images));
    if(!['down','stop'].includes(operation[0]??''))await verifyComposeBuiltImages(this.docker,snapshot.request,snapshot.definition!,snapshot.images);
    await this.verifyOwnership(compiled.prefix,compiled.definition,request.workloadId,request.projectId);
    this.options.beforeMutation?.();
    const path=join(directory,file);writeFileSync(path,JSON.stringify(compiled.definition),{mode:0o600});
    return this.run('docker',['--host',`unix://${this.config.dockerSocket}`,'compose','--project-name',compiled.prefix,'--project-directory',directory,'--file',path,...operation],directory,request.operationId);
  }
  private async rollback(snapshot:Snapshot,request:ComposeApplyRequest,directory:string) {
    snapshot.stage='rolling_back';this.saveSnapshot(request.operationId,snapshot);
    const previous=snapshot.previous;
    await this.execute(previous??snapshot,request,directory,previous?['up','--detach','--no-build','--wait','--wait-timeout','120','--remove-orphans']:['down','--remove-orphans','--timeout','20'],'rollback.json');
  }
  async certificate(workloadId:string,projectId:string,hostname:string) {
    z.string().uuid().parse(workloadId);z.string().uuid().parse(projectId);
    const snapshot=this.latest(workloadId,projectId);
    return composeCertificateStatus(this.docker,workloadId,projectId,snapshot.request.configuration,hostname,this.options);
  }
  async apply(value: unknown): Promise<ComposeApplyResult> {
    const request = requestSchema.parse(value), hash = createHash('sha256').update(JSON.stringify(request)).digest('hex');
    if (this.active.has(request.workloadId)) throw new Error('Another Compose operation is running.');
    const previous = this.journal.prepare('SELECT * FROM compose_operations WHERE id=?').get(request.operationId) as Row | undefined;
    if (previous && previous.request_hash !== hash) throw new Error('Compose operation identity was reused for different input.');
    if (previous?.state === 'succeeded') return JSON.parse(previous.response!) as ComposeApplyResult;
    if (previous?.state === 'failed') throw new Error(previous.error ?? 'Previous Compose operation failed.');
    const other = this.journal.prepare("SELECT * FROM compose_operations WHERE workload_id=? AND state='running'").get(request.workloadId) as Row | undefined;
    if (other && (other.id !== request.operationId || this.processAlive(other.process_group))) throw new Error('The previous Compose process is still running or requires recovery.');
    this.active.add(request.workloadId);
    let directory:string|undefined,checkout:string|undefined,buildLogs='',rolledBack=false;
    let snapshot: Snapshot = previous ? JSON.parse(this.vault.open(previous.snapshot)) : { request };
    try {
      // The core agent serializes ingress changes. A resumed operation must not
      // begin a new ingress migration while its own durable journal is running.
      if(!previous&&!['stop','destroy'].includes(request.type))await this.options.ensureIngress?.();
      if (!previous) this.journal.prepare("INSERT INTO compose_operations(id,workload_id,project_id,type,request_hash,state,snapshot,updated_at) VALUES(?,?,?,?,?,'running',?,?)").run(request.operationId,request.workloadId,request.projectId,request.type,hash,this.vault.seal(JSON.stringify(snapshot)),new Date().toISOString());
      const base = join(this.config.dataDir,'compose'); mkdirSync(base,{recursive:true,mode:0o700});
      directory = mkdtempSync(join(base,request.operationId + '-'));
      if(!snapshot.definition&&(request.type!=='deploy'||request.certificateRetry)) {
        try {
          const deployed=this.latest(request.workloadId,request.projectId,request.type==='destroy');
          snapshot={...this.stable(deployed),request:{...request,revision:deployed.request.revision,configuration:deployed.request.configuration}};
        } catch(error) {
          if(request.type!=='destroy'||!(error instanceof ComposeNotDeployedError))throw error;
          const containers=await this.docker.listContainers({all:true,filters:{label:[`com.docker.compose.project=servus-compose-${request.workloadId.replaceAll('-','')}`]}});
          if(containers.length)throw new Error('Existing Compose containers require recovery before removal.');
          const response:ComposeApplyResult={state:'deleted',revision:request.revision,logs:'No Compose deployment was applied. No volumes were removed.'};
          this.journal.prepare("UPDATE compose_operations SET state='succeeded',process_group=NULL,response=?,updated_at=? WHERE id=?").run(JSON.stringify(response),new Date().toISOString(),request.operationId);return response;
        }
      }
      if(!snapshot.definition){const prepared=await this.source(request,directory);snapshot.definition=prepared.definition;snapshot.commit=prepared.commit;checkout=prepared.checkout;snapshot.stage='prepared';this.saveSnapshot(request.operationId,snapshot);}
      if(request.type==='deploy'&&!Object.hasOwn(snapshot,'previous')) {
        try {snapshot.previous=this.stable(this.latest(request.workloadId,request.projectId));}
        catch(error){if(!(error instanceof ComposeNotDeployedError))throw error;snapshot.previous=null;}
      }
      snapshot.retries??=snapshot.previous?.retries;
      if(snapshot.stage==='rolling_back') {
        await this.rollback(snapshot,request,directory);rolledBack=true;
        throw new Error(snapshot.failure??'Recovered the previous Compose configuration after an interrupted update.');
      }
      const domains=snapshot.request.configuration.domains;
      if(!['stop','destroy'].includes(request.type)&&domains.some(domain=>domain.https))await assertComposeHttpsIngress(this.docker);
      if(request.certificateRetry&&!snapshot.retryPrepared) {
        const host=request.certificateRetry.hostname;
        configuredComposeHttps(snapshot.request.configuration,host);
        const certificate=await composeCertificateStatus(this.docker,request.workloadId,request.projectId,snapshot.request.configuration,host,this.options);
        if(certificate.status!=='not_found')throw new ComposeTlsError('RETRY_UNAVAILABLE','A managed certificate already exists. The shared ingress renews it automatically.');
        const prior=snapshot.retries?.[host],now=Date.now();
        if(prior&&(!Number.isFinite(Date.parse(prior.requestedAt))||Date.parse(prior.requestedAt)>now))throw new ComposeTlsError('RETRY_UNAVAILABLE','The previous certificate retry time cannot be verified.');
        if(prior&&now-Date.parse(prior.requestedAt)<15*60_000)throw new ComposeTlsError('RETRY_COOLDOWN','Wait 15 minutes between certificate retries to avoid certificate authority rate limits.');
        snapshot.retries={...snapshot.retries,[host]:{requestedAt:new Date(now).toISOString(),explicitDomain:!prior?.explicitDomain}};
        snapshot.retryPrepared=true;
      }
      if(request.type==='deploy')for(const domain of domains.filter(item=>item.redirectHttps)) {
        const prior=snapshot.previous?.request.configuration.domains.find(item=>item.hostname===domain.hostname&&item.https&&item.service===domain.service&&item.port===domain.port);
        if(!prior)throw new ComposeTlsError('HTTPS_REDIRECT_UNVERIFIED','Deploy HTTPS without its redirect first, then verify the certificate and public application route.');
        const certificate=await composeCertificateStatus(this.docker,request.workloadId,request.projectId,snapshot.previous!.request.configuration,domain.hostname,this.options);
        if(certificate.status!=='active'||!certificate.publicVerified)throw new ComposeTlsError('HTTPS_REDIRECT_UNVERIFIED','The active certificate and public HTTPS application route could not be verified. Existing HTTP routes were not changed.');
      }
      if(request.type==='deploy'&&!request.certificateRetry&&Object.values(snapshot.definition!.services).some(item=>item.build)) {
        snapshot.images??={};snapshot.buildStartedAt??=new Date().toISOString();this.saveSnapshot(request.operationId,snapshot);
        if(snapshot.request.configuration.source.type==='git'&&!checkout&&Object.entries(snapshot.definition!.services).some(([name,item])=>item.build&&!Object.hasOwn(snapshot.images!,name))){
          if(!snapshot.commit)throw new Error('The pinned Compose commit is missing. A moving branch cannot be used for recovery.');
          const pinned=await this.source(snapshot.request,directory,snapshot.commit);
          if(JSON.stringify(pinned.definition)!==JSON.stringify(snapshot.definition))throw new Error('The pinned Compose definition differs from its prepared snapshot.');
          checkout=pinned.checkout;
        }
        this.options.beforeMutation?.();
        buildLogs=await buildComposeImages({docker:this.docker,dockerSocket:this.config.dockerSocket,request:snapshot.request,definition:snapshot.definition!,checkout,commit:snapshot.commit,directory,images:snapshot.images,run:this.run.bind(this),startedAt:snapshot.buildStartedAt,checkpoint:()=>this.saveSnapshot(request.operationId,snapshot)});
      }
      snapshot.stage='applying';this.saveSnapshot(request.operationId,snapshot);
      const operation = request.type === 'deploy' || request.type === 'start' ? ['up','--detach','--no-build','--wait','--wait-timeout','120','--remove-orphans'] : request.type === 'destroy' ? ['down','--remove-orphans','--timeout','20'] : [request.type,'--timeout','20'];
      let output=(snapshot.commit?`Source commit: ${snapshot.commit}\n`:'')+buildLogs+'\n'+await this.execute(snapshot,request,directory,operation);
      if(!['stop','destroy'].includes(request.type))for(const domain of domains.filter(item=>item.redirectHttps)) {
        const deadline=Date.now()+30_000;let verified=false;
        do {try {const certificate=await composeCertificateStatus(this.docker,request.workloadId,request.projectId,snapshot.request.configuration,domain.hostname,this.options);verified=certificate.status==='active'&&certificate.publicVerified;}catch{}
          if(!verified)await new Promise(resolve=>setTimeout(resolve,1000));
        }while(!verified&&Date.now()<deadline);
        if(!verified)throw new ComposeTlsError('HTTPS_REDIRECT_UNVERIFIED','The updated public HTTPS route did not become ready. Restoring the previous Compose configuration.');
      }
      if(domains.some(domain=>domain.https)&&!domains.some(domain=>domain.redirectHttps))output+='\nHTTPS issuance and renewal are managed asynchronously by the shared ingress. Check certificate status before enabling an HTTP redirect.';
      const response: ComposeApplyResult = { state: request.type === 'stop' ? 'stopped' : request.type === 'destroy' ? 'deleted' : 'running', revision: snapshot.request.revision, logs: this.redact(output,snapshot.definition).slice(-32000) };
      this.journal.prepare("UPDATE compose_operations SET state='succeeded',process_group=NULL,response=?,updated_at=? WHERE id=?").run(JSON.stringify(response),new Date().toISOString(),request.operationId);
      return response;
    } catch (error) {
      const message = this.redact(error instanceof Error ? error.message : 'Compose operation failed',snapshot.definition).slice(0,4000);
      if(request.type==='deploy'&&directory&&['applying','rolling_back'].includes(snapshot.stage??'')&&!rolledBack) {
        snapshot.failure=message;
        try {await this.rollback(snapshot,request,directory);rolledBack=true;}
        catch {
          this.journal.prepare("UPDATE compose_operations SET process_group=NULL,error=?,updated_at=? WHERE id=?").run('The previous Compose routes require recovery before another deployment.',new Date().toISOString(),request.operationId);
          throw new Error('The previous Compose routes require recovery before another deployment.');
        }
      }
      this.journal.prepare("UPDATE compose_operations SET state='failed',process_group=NULL,error=?,updated_at=? WHERE id=?").run(message,new Date().toISOString(),request.operationId);
      throw error instanceof ComposeTlsError?new ComposeTlsError(error.code,message):new Error(message);
    } finally { this.active.delete(request.workloadId);if(directory)rmSync(directory,{recursive:true,force:true}); }
  }
  async read(workloadId: string, projectId: string, type: 'logs' | 'containers') {
    z.string().uuid().parse(workloadId); z.string().uuid().parse(projectId);
    const snapshot = this.latest(workloadId,projectId), compiled = compileComposeDefinition(snapshot.definition!,snapshot.request.configuration,workloadId,projectId,snapshot.retries,composeBuildIds(snapshot.images));
    await this.verifyOwnership(compiled.prefix,compiled.definition,workloadId,projectId);
    const directory = mkdtempSync(join(this.config.dataDir,'compose-read-'));
    try {
      const path = join(directory,'compose.json'); writeFileSync(path,JSON.stringify(compiled.definition),{mode:0o600});
      const operation = type === 'logs' ? ['logs','--no-color','--tail','200','--timestamps'] : ['ps','--all','--format','json'];
      const output = await this.run('docker',['--host',`unix://${this.config.dockerSocket}`,'compose','--project-name',compiled.prefix,'--project-directory',directory,'--file',path,...operation],directory,undefined,{},15_000);
      if (type === 'logs') return { logs: this.redact(output,snapshot.definition).slice(-32000) };
      return { containers: output.trim().split('\n').filter(Boolean).flatMap(line => { const parsed = JSON.parse(line); return (Array.isArray(parsed) ? parsed : [parsed]).map(item => ({ id:item.ID,service:item.Service,state:item.State,health:item.Health })); }) };
    } finally { rmSync(directory,{recursive:true,force:true}); }
  }
  async metrics(workloadId: string, projectId: string) {
    z.string().uuid().parse(workloadId); z.string().uuid().parse(projectId);
    const snapshot = this.latest(workloadId, projectId), compiled = compileComposeDefinition(snapshot.definition!, snapshot.request.configuration, workloadId, projectId, snapshot.retries, composeBuildIds(snapshot.images));
    await this.verifyOwnership(compiled.prefix, compiled.definition, workloadId, projectId);
    return composeMetrics(this.docker, workloadId, projectId);
  }
}

export function registerComposeAgent(app: FastifyInstance, options: { config: ReturnType<typeof agentConfig>; maintenance?: AgentMaintenanceGate; beforeMutation?:()=>void }&ComposeTlsOptions) {
  const runtime = new ComposeRuntime(options.config,options);
  const active=new Set<Promise<unknown>>();
  const track=<T>(task:Promise<T>)=>{active.add(task);void task.finally(()=>active.delete(task)).catch(()=>{});return task;};
  app.addHook('onClose', async () => {await Promise.allSettled([...active]);runtime.close();});
  app.post('/compose/apply', async (request,reply) => {
    const release = options.maintenance?.admit();
    if (options.maintenance && !release) return reply.code(503).send({error:{code:'MAINTENANCE',message:'Agent is draining.'}});
    try { options.beforeMutation?.();return await track(runtime.apply(request.body)); }
    catch (error) { const message=runtime.vault.redact(error instanceof Error ? error.message : 'Compose operation failed');const busy=/still running|requires? recovery|operation is running/.test(message);return reply.code(error instanceof z.ZodError ? 400 : busy ? 503 : 409).send({error:{code:error instanceof ComposeTlsError?error.code:busy?'SERVICE_BUSY':'COMPOSE_FAILED',message}}); }
    finally { release?.(); }
  });
  app.post<{Params:{id:string}}>('/compose/:id/certificate',async(request,reply)=>{
    const release=options.maintenance?.admit();if(options.maintenance&&!release)return reply.code(503).send({error:{code:'MAINTENANCE',message:'Agent is draining.'}});
    try {
      const input=z.object({projectId:z.string().uuid(),hostname:z.string().min(1).max(253)}).strict().parse(request.body);
      return await track(runtime.certificate(request.params.id,input.projectId,input.hostname));
    } catch(error) {return reply.code(error instanceof z.ZodError?400:error instanceof ComposeTlsError?409:503).send({error:{code:error instanceof ComposeTlsError?error.code:'CERTIFICATE_UNAVAILABLE',message:runtime.vault.redact(error instanceof ComposeTlsError?error.message:'Compose certificate status could not be verified.')}});}
    finally{release?.();}
  });
  for (const type of ['logs','containers'] as const) app.get<{ Params:{id:string}; Querystring:{projectId:string} }>(`/compose/:id/${type}`, async (request,reply) => {
    const release=options.maintenance?.admit();if(options.maintenance&&!release)return reply.code(503).send({error:{code:'MAINTENANCE',message:'Agent is draining.'}});
    try { return await track(runtime.read(request.params.id,request.query.projectId,type)); }
    catch { return reply.code(409).send({error:{code:'COMPOSE_UNAVAILABLE',message:'Compose runtime details are unavailable'}}); }
    finally{release?.();}
  });
  app.get<{ Params:{id:string}; Querystring:{projectId:string} }>('/compose/:id/metrics', async (request,reply) => {
    const release=options.maintenance?.admit();if(options.maintenance&&!release)return reply.code(503).send({error:{code:'MAINTENANCE',message:'Agent is draining.'}});
    try { return await track(runtime.metrics(request.params.id,request.query.projectId)); }
    catch { return reply.code(409).send({error:{code:'COMPOSE_UNAVAILABLE',message:'Compose runtime metrics are unavailable'}}); }
    finally{release?.();}
  });
  return runtime;
}
