import Fastify from 'fastify';
import Database from 'better-sqlite3';
import websocket from '@fastify/websocket';
import { Readable, type Duplex } from 'node:stream';
import Docker from 'dockerode';
import { SecretVault } from '../shared/secrets.js';
import { createHash, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { agentConfig } from './config.js';
import { DockerRuntime, message, isUncertainRuntimeError, type RecoveryContext } from './runtime.js';
import type { Service } from '../shared/types.js';
import { consoleExecStopped, type AgentMaintenanceGate } from './maintenance.js';
import { DatabaseExportUncertainError, exportDatabase } from './database-export.js';
import { RestoreJournal } from './restore-journal.js';
import { acquireRestoreUploadLock } from './restore-upload-lock.js';
import { discardInterruptedRestoreArchive, readRestoreArchive } from './restore-archive.js';
import { uploadRestoreArchive } from './restore-upload.js';
import { cancelStagedRestore } from './restore-cancel.js';
import { cancelPreparedRestore } from './restore-candidate-cancel.js';
import { loadRestoreSource } from './restore-source.js';
import { prepareRestoreCandidate } from './restore-preparation.js';
import { createRestoreCandidate } from './restore-candidate.js';
import { DatabaseImportError, importDatabaseCandidate } from './database-import.js';
import { inspectRestoreSwitch } from './restore-switch-inspect.js';
import { commitPreparedRestore, RestoreCommitUncertainError } from './restore-commit.js';

const hostname = z.string().max(253).regex(/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/);
const input = z.object({
  operationId: z.string().uuid(),
  type: z.enum(['deploy', 'start', 'stop', 'restart', 'destroy']),
  service: z.object({
    id: z.string().uuid(), projectId: z.string().uuid(), name: z.string().min(1).max(63),
    image: z.string().min(1).max(300).regex(/^[a-zA-Z0-9][a-zA-Z0-9._\-/:@]*$/), hostname,
    port: z.number().int().min(1).max(65535), replicas: z.number().int().min(1).max(5),
    revision: z.number().int().positive(), deployedRevision: z.number().int().nullable(),
    state: z.enum(['pending', 'running', 'stopped', 'deploying', 'failed', 'unknown']),
    createdAt: z.string(), updatedAt: z.string(), lastError: z.string().nullable(),
    kind: z.enum(['app','postgres','redis','mariadb']).optional(),
    source: z.discriminatedUnion('type', [z.object({type:z.literal('image')}), z.object({type:z.literal('git'),repository:z.string().url(),branch:z.string().min(1).max(128),context:z.string().max(256),dockerfile:z.string().max(256),credential:z.object({username:z.string().min(1).max(256),secretRef:z.string().uuid()}).strict().optional()})]).optional(),
    environment: z.array(z.object({name:z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(128),value:z.string().max(32768).optional(),secret:z.boolean().optional(),secretRef:z.string().uuid().optional()}).refine(value=>!value.secret||Boolean(value.secretRef)&&value.value===undefined)).max(100).optional(),
    domains: z.array(z.object({hostname,port:z.number().int().min(1).max(65535),primary:z.boolean().optional()})).max(20).optional(),
    mounts: z.array(z.object({type:z.enum(['volume','file','bind']),name:z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/),target:z.string().startsWith('/').max(256),readOnly:z.boolean().optional(),content:z.string().max(32768).optional(),source:z.string().max(512).optional()})).max(20).optional(),
    resources: z.object({cpu:z.number().min(0.1).max(64),memoryMb:z.number().int().min(32).max(131072)}).optional(),
    database: z.object({database:z.string().min(1).max(63),user:z.string().min(1).max(63),passwordSecretRef:z.string().uuid().optional()}).strict().optional(),
    imageDigest:z.string().nullable().optional(),sourceCommit:z.string().nullable().optional(),deletedAt:z.string().nullable().optional(),
  }),
});

type JournalRow = {
  request_hash: string; state: string; response: string | null;
  previous_spec: string | null; previous_recorded: number; target_spec: string | null;
  operation_stage: 'applying' | 'rolling_back'; previous_error: string | null;
};
type AgentRuntime = Pick<DockerRuntime, 'status' | 'inspectService' | 'apply'> & Partial<Pick<DockerRuntime, 'containers' | 'metrics' | 'logs' | 'consoleContainer'>>;

export async function createAgent(config = agentConfig(), runtime: AgentRuntime = new DockerRuntime(config.dockerSocket, config.ingressPort, config.ingressImage, config.dataDir), maintenance?: AgentMaintenanceGate) {
  const app = Fastify({ logger: false, bodyLimit: 512 * 1024 });
  const vault = new SecretVault(config.dataDir);
  await app.register(websocket, { options: { maxPayload: 65536 } });
  const sealSpec = (spec: unknown) => vault.seal(JSON.stringify(spec));
  const openSpec = (value: string) => JSON.parse(value.startsWith('enc:v1:') ? vault.open(value) : value);
  const journal = new Database(join(config.dataDir, 'agent.sqlite'));
  journal.pragma('journal_mode = WAL');
  journal.pragma('busy_timeout = 5000');
  journal.transaction(() => {
    journal.exec('CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, state TEXT NOT NULL, response TEXT, updated_at TEXT NOT NULL)');
    const columns = new Set((journal.prepare('PRAGMA table_info(operations)').all() as { name: string }[]).map(column => column.name));
    for (const [name, definition] of Object.entries({ previous_spec: 'TEXT', previous_recorded: 'INTEGER NOT NULL DEFAULT 0', target_spec: 'TEXT', operation_stage: "TEXT NOT NULL DEFAULT 'applying'", previous_error: 'TEXT', service_id: 'TEXT' })) {
      if (!columns.has(name)) journal.exec(`ALTER TABLE operations ADD COLUMN ${name} ${definition}`);
    }
  }).immediate();
  for (const row of journal.prepare('SELECT id,previous_spec,target_spec FROM operations').all() as {id:string;previous_spec:string|null;target_spec:string|null}[]) {
    for (const column of ['previous_spec','target_spec'] as const) {
      if (row[column] && !row[column].startsWith('enc:v1:')) journal.prepare(`UPDATE operations SET ${column}=? WHERE id=?`).run(sealSpec(JSON.parse(row[column])),row.id);
    }
  }
  const active = new Map<string, Promise<unknown>>();
  const cancellingRestores = new Set<string>();
  const locks = new Set<string>();
  const consoles = new Map<string, number>(), uncertainConsoles = new Set<string>();
  const restores = new RestoreJournal(journal, serviceId => locks.has(serviceId) || (consoles.get(serviceId) ?? 0) > 0 || uncertainConsoles.has(serviceId));
  maintenance?.bindJournal(scope => (scope ? !restores.onlyUnresolvedLegacyUpload(scope.legacyUploadId) || restores.get(scope.legacyUploadId)?.service_id!==scope.serviceId : restores.hasUnresolved()) || Boolean(journal.prepare("SELECT 1 FROM operations WHERE state='running' LIMIT 1").get()));
  app.addHook('onRequest', async (req, reply) => {
    const value = req.headers.authorization?.replace(/^Bearer /, '') || '';
    const left = createHash('sha256').update(value).digest();
    const right = createHash('sha256').update(config.token).digest();
    if (!timingSafeEqual(left, right)) return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Agent authentication required.' } });
  });
  app.get('/runtime', () => runtime.status());
  app.get<{Params:{id:string}}>('/services/:id/state', (req, reply) => {
    if (!z.string().uuid().safeParse(req.params.id).success) return reply.code(400).send({ error: { code: 'INVALID_ID', message: 'Invalid service identity.' } });
    return runtime.inspectService(req.params.id);
  });
  const query = z.object({tail:z.coerce.number().int().min(1).max(500).default(100),since:z.string().datetime({offset:true}).optional()});
  for (const operation of ['logs','containers','metrics'] as const) app.get<{Params:{id:string};Querystring:{tail?:string;since?:string}}>(`/services/:id/${operation}`, async (req,reply) => {
    if(!z.string().uuid().safeParse(req.params.id).success)return reply.code(400).send({error:{code:'INVALID_ID',message:'Invalid service identity.'}});
    if(operation==='logs') { const parsed=query.safeParse(req.query); if(!parsed.success)return reply.code(400).send({error:{code:'INVALID_QUERY',message:'Invalid log query.'}}); return runtime.logs!(req.params.id,parsed.data.tail,parsed.data.since); }
    return runtime[operation]!(req.params.id);
  });
  app.post<{Params:{id:string}}>('/services/:id/database-export',async(req,reply)=>{
    const parsed=z.object({kind:z.enum(['postgres','mariadb','redis']),database:z.string().min(1).max(63),user:z.string().min(1).max(63)}).strict().safeParse(req.body);
    if(!z.string().uuid().safeParse(req.params.id).success||!parsed.success)return reply.code(400).send({error:{code:'INVALID_EXPORT',message:'Invalid database export request.'}});
    const release=maintenance?.admit();
    if(maintenance&&!release)return reply.code(503).send({error:{code:'MAINTENANCE',message:'Agent is draining.'}});
    let handedOff=false,held=false,finished=false,artifact:Awaited<ReturnType<typeof exportDatabase>>|undefined;
    const finish=()=>{if(finished)return;finished=true;artifact?.close();if(held)locks.delete(req.params.id);release?.();};
    try{
      const unresolved=journal.prepare("SELECT 1 FROM operations WHERE service_id=? AND state='running' LIMIT 1").get(req.params.id);
      if(unresolved||restores.hasUnresolved(req.params.id)||locks.has(req.params.id))return reply.code(409).send({error:{code:'SERVICE_BUSY',message:'Another operation is changing this service.'}});
      locks.add(req.params.id);held=true;
      if(!runtime.consoleContainer)throw new Error('Database export is unavailable.');
      const container=await runtime.consoleContainer(req.params.id);
      const info=await container.inspect();
      const values=new Map((info.Config.Env||[]).map(item=>{const index=item.indexOf('=');return [item.slice(0,index),item.slice(index+1)];}));
      if(parsed.data.kind==='postgres'&&(values.get('POSTGRES_DB')!==parsed.data.database||values.get('POSTGRES_USER')!==parsed.data.user))throw new Error('Database identity does not match the running service.');
      if(parsed.data.kind==='mariadb'&&(values.get('MARIADB_DATABASE')!==parsed.data.database||values.get('MARIADB_USER')!==parsed.data.user))throw new Error('Database identity does not match the running service.');
      try { artifact=await exportDatabase({containerId:container.id,dockerSocket:config.dockerSocket,...parsed.data}); }
      catch(error){if(error instanceof DatabaseExportUncertainError)maintenance?.markUncertain();throw error;}
      if(reply.raw.destroyed)return;
      const stream=artifact.stream();
      reply.raw.once('close',finish);stream.once('error',finish);
      reply.header('Content-Type','application/octet-stream').header('Content-Length',artifact.size).header('X-Export-Extension',artifact.extension);
      handedOff=true;return reply.send(stream);
    }finally{if(!handedOff)finish();}
  });
  let uploads = 0;
  const activeUploads = new Map<string,{serviceId:string;controller:AbortController;done:Promise<void>}>();
  app.register(async scope => {
    scope.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload));
    scope.post<{Params:{id:string};Querystring:{operationId?:string;kind?:string};Body:Readable}>('/services/:id/database-restore/upload', async (req,reply) => {
      const id = req.params.id, operationId = req.query.operationId, kind = req.query.kind;
      const length = req.headers['content-length'];
      if (!z.string().uuid().safeParse(id).success || !operationId || !/^[a-f0-9]{32}$/.test(operationId) || !['postgres','mariadb'].includes(kind || '') || !length || !/^[1-9][0-9]*$/.test(length) || Number(length) > 2 * 1024 * 1024 * 1024 || !(req.body instanceof Readable)) {
        return reply.code(400).send({ error: { code: 'INVALID_UPLOAD', message: 'Invalid database restore upload.' } });
      }
      const release = maintenance?.admit();
      if (maintenance && !release) return reply.code(503).send({ error: { code: 'MAINTENANCE', message: 'Agent is draining.' } });
      if (activeUploads.has(operationId) || cancellingRestores.has(operationId)) { release?.(); return reply.code(409).send({error:{code:'RESTORE_BUSY',message:'This database restore is already active.'}}); }
      if (uploads >= 2) { release?.(); return reply.code(429).send({ error: { code: 'UPLOAD_BUSY', message: 'Too many database restore uploads are active.' } }); }
      uploads++;
      const controller = new AbortController();
      let resolveDone!:()=>void;
      const entry={serviceId:id,controller,done:new Promise<void>(resolve=>{resolveDone=resolve;})};
      activeUploads.set(operationId,entry);
      const abort = () => controller.abort();
      req.raw.once('aborted', abort);
      const timeout = setTimeout(abort, 30 * 60_000); timeout.unref();
      try {
        const result = await uploadRestoreArchive({ journal: restores, operationId, serviceId: id, kind: kind as 'postgres'|'mariadb', dataDir: config.dataDir, key: vault.restoreArchiveKey(operationId), input: () => req.body, signal: controller.signal, sizeLimit: Number(length), expectedSize: Number(length) });
        return { operationId, size: result.size, sha256: result.record.archive_sha256, phase: result.record.phase };
      } finally { uploads--; clearTimeout(timeout); req.raw.off('aborted', abort); if(activeUploads.get(operationId)===entry)activeUploads.delete(operationId); resolveDone(); release?.(); }
    });
  });
  app.get<{Params:{id:string}}>('/services/:id/database-restore', async (req,reply) => {
    if (!z.string().uuid().safeParse(req.params.id).success) return reply.code(400).send({error:{code:'INVALID_RESTORE',message:'Invalid database restore identity.'}});
    const record=restores.latestForService(req.params.id);
    if (!record) return {operation:null};
    const stage=record.phase==='switching'?restores.switchIntent(record.id)?.stage:undefined;
    const reviewPhase=record.phase==='needs_review'?restores.reviewPhase(record.id):undefined;
    const rolledBack=record.phase==='cancelled' && restores.retainedVolume(record.id)?.reason==='rollback_candidate';
    const recoveryReason=record.phase==='uploading' && record.archive_sha256==='0'.repeat(64)?'legacy_upload_unverified'
      :record.phase==='importing' && !cancellingRestores.has(record.id)?'preparation_unverified':undefined;
    return {operation:{operationId:record.id,phase:record.phase,kind:record.kind,...(stage?{stage}:{}),...(reviewPhase?{reviewPhase}:{}),...(rolledBack?{rolledBack:true}:{}),...(recoveryReason?{recoveryReason}:{})}};
  });
  app.get<{Params:{id:string;operationId:string}}>('/services/:id/database-restore/:operationId', async (req,reply) => {
    if (!z.string().uuid().safeParse(req.params.id).success || !/^[a-f0-9]{32}$/.test(req.params.operationId)) return reply.code(400).send({error:{code:'INVALID_RESTORE',message:'Invalid database restore identity.'}});
    const record = restores.get(req.params.operationId);
    if (!record || record.service_id !== req.params.id) return reply.code(404).send({error:{code:'NOT_FOUND',message:'Database restore operation not found.'}});
    const stage=record.phase==='switching'?restores.switchIntent(record.id)?.stage:undefined;
    const reviewPhase=record.phase==='needs_review'?restores.reviewPhase(record.id):undefined;
    const recoveryReason=record.phase==='uploading' && record.archive_sha256==='0'.repeat(64)?'legacy_upload_unverified'
      :record.phase==='importing' && !cancellingRestores.has(record.id)?'preparation_unverified':undefined;
    return {operationId:record.id,phase:record.phase,kind:record.kind,...(stage?{stage}:{}),...(reviewPhase?{reviewPhase}:{}),...(recoveryReason?{recoveryReason}:{})};
  });
  app.post<{Params:{id:string;operationId:string}}>('/services/:id/database-restore/:operationId/cancel', async (req,reply) => {
    if (!z.string().uuid().safeParse(req.params.id).success || !/^[a-f0-9]{32}$/.test(req.params.operationId)) return reply.code(400).send({error:{code:'INVALID_RESTORE',message:'Invalid database restore identity.'}});
    const record = restores.get(req.params.operationId);
    if (!record || record.service_id !== req.params.id) return reply.code(404).send({error:{code:'NOT_FOUND',message:'Database restore operation not found.'}});
    if (!['uploading','reserved','discarding','prepared','discarding_candidate','cancelled'].includes(record.phase) || cancellingRestores.has(record.id)) return reply.code(409).send({error:{code:'RESTORE_BUSY',message:'This database restore cannot be cancelled now.'}});
    const upload=record.phase==='uploading'?activeUploads.get(record.id):undefined;
    if(upload&&upload.serviceId!==req.params.id)return reply.code(409).send({error:{code:'RESTORE_BUSY',message:'This database restore cannot be cancelled now.'}});
    const release = maintenance?.admit();
    if (maintenance && !release) return reply.code(503).send({error:{code:'MAINTENANCE',message:'Agent is draining.'}});
    cancellingRestores.add(record.id);
    try {
      if(upload){upload.controller.abort();await upload.done;}
      else if(record.phase==='uploading'){
        let unlock:()=>void;
        try{
          const lockId=restores.uploadLockId(record.id);
          // A legacy path alone is not bound to the journal entry: it may have
          // been left by a different attempt before this upload began.
          if(!lockId)throw new Error('Restore upload lock identity is unavailable.');
          unlock=acquireRestoreUploadLock(config.dataDir,record.id,false,lockId);
        }
        catch{return reply.code(409).send({error:{code:'RESTORE_BUSY',message:'The interrupted upload requires recovery.'}});}
        try{
          const current=restores.get(record.id);
          if(!current||current.service_id!==req.params.id||current.phase!=='uploading')throw new RestoreCommitUncertainError('Restore upload state changed during recovery.');
          discardInterruptedRestoreArchive(config.dataDir,record.id);
          const result=restores.advance(record.id,'uploading','cancelled');
          return {operationId:result.id,phase:result.phase};
        }finally{unlock();}
      }
      const current=restores.get(record.id);
      if(!current||current.service_id!==req.params.id||!['reserved','discarding','prepared','discarding_candidate','cancelled'].includes(current.phase))throw new RestoreCommitUncertainError('Restore upload cleanup requires recovery.');
      const result = ['prepared','discarding_candidate'].includes(current.phase)
      ? await cancelPreparedRestore({journal:restores,docker:new Docker({socketPath:config.dockerSocket}),dataDir:config.dataDir,serviceId:req.params.id,operationId:req.params.operationId})
      : cancelStagedRestore({journal:restores,dataDir:config.dataDir,serviceId:req.params.id,operationId:req.params.operationId}); return {operationId:result.id,phase:result.phase}; }
    finally { cancellingRestores.delete(record.id);release?.(); }
  });
  app.post<{Params:{id:string;operationId:string}}>('/services/:id/database-restore/:operationId/prepare', async (req,reply) => {
    if (!z.string().uuid().safeParse(req.params.id).success || !/^[a-f0-9]{32}$/.test(req.params.operationId)) return reply.code(400).send({error:{code:'INVALID_RESTORE',message:'Invalid database restore identity.'}});
    const record = restores.get(req.params.operationId);
    if (!record || record.service_id !== req.params.id) return reply.code(404).send({error:{code:'NOT_FOUND',message:'Database restore operation not found.'}});
    if (record.phase !== 'reserved' || !['postgres','mariadb'].includes(record.kind) || cancellingRestores.has(record.id)) return reply.code(409).send({error:{code:'RESTORE_BUSY',message:'This database restore cannot be prepared now.'}});
    const release = maintenance?.admit();
    if (maintenance && !release) return reply.code(503).send({error:{code:'MAINTENANCE',message:'Agent is draining.'}});
    cancellingRestores.add(record.id);
    try {
      if (!runtime.consoleContainer) throw new Error('Database restore is unavailable.');
      const kind = record.kind as 'postgres'|'mariadb';
      const source = loadRestoreSource({dataDir:config.dataDir,serviceId:req.params.id,kind,vault});
      const sourceContainer = await runtime.consoleContainer(req.params.id);
      const result = await prepareRestoreCandidate({journal:restores,operationId:record.id,serviceId:req.params.id,importCandidate:importDatabaseCandidate,
        allocateTarget:async()=>{
          const candidate = await createRestoreCandidate({docker:new Docker({socketPath:config.dockerSocket}),dockerSocket:config.dockerSocket,journal:restores,operationId:record.id,serviceId:req.params.id,sourceContainerId:sourceContainer.id,kind,...source});
          return {containerId:candidate.containerId,dockerSocket:config.dockerSocket,database:source.database,user:source.user,input:()=>readRestoreArchive({dataDir:config.dataDir,operationId:record.id,key:vault.restoreArchiveKey(record.id)})};
        }});
      return {operationId:result.id,phase:result.phase};
    } catch(error) {
      if(error instanceof DatabaseImportError && restores.get(record.id)?.phase==='discarding_candidate') {
        try { await cancelPreparedRestore({journal:restores,docker:new Docker({socketPath:config.dockerSocket}),dataDir:config.dataDir,serviceId:req.params.id,operationId:record.id}); }
        catch(cause) { throw new RestoreCommitUncertainError('Restore candidate cleanup requires recovery.',{cause}); }
        return reply.code(422).send({error:{code:'RESTORE_IMPORT_FAILED',message:'The export could not be imported. The current database was not changed.'}});
      }
      throw error;
    } finally { cancellingRestores.delete(record.id);release?.(); }
  });
  app.post<{Params:{id:string;operationId:string}}>('/services/:id/database-restore/:operationId/commit', async (req,reply) => {
    if(!z.string().uuid().safeParse(req.params.id).success||!/^[a-f0-9]{32}$/.test(req.params.operationId)||!z.object({}).strict().safeParse(req.body??{}).success)return reply.code(400).send({error:{code:'INVALID_RESTORE',message:'Invalid database restore request.'}});
    const record=restores.get(req.params.operationId);
    if(!record||record.service_id!==req.params.id)return reply.code(404).send({error:{code:'NOT_FOUND',message:'Database restore operation not found.'}});
    if(!['prepared','switching','completed','cancelled'].includes(record.phase)||cancellingRestores.has(record.id))return reply.code(409).send({error:{code:'RESTORE_BUSY',message:'This database restore cannot be committed now.'}});
    const release=maintenance?.admit();
    if(maintenance&&!release)return reply.code(503).send({error:{code:'MAINTENANCE',message:'Agent is draining.'}});
    cancellingRestores.add(record.id);
    try{return await commitPreparedRestore({docker:new Docker({socketPath:config.dockerSocket}),journal:restores,vault,dataDir:config.dataDir,serviceId:req.params.id,operationId:req.params.operationId});}
    finally{cancellingRestores.delete(record.id);release?.();}
  });
  app.get<{Params:{id:string;operationId:string}}>('/services/:id/database-restore/:operationId/switch-inspection', async (req,reply) => {
    if (!z.string().uuid().safeParse(req.params.id).success || !/^[a-f0-9]{32}$/.test(req.params.operationId)) return reply.code(400).send({error:{code:'INVALID_RESTORE',message:'Invalid database restore identity.'}});
    const record=restores.get(req.params.operationId);
    if (!record || record.service_id!==req.params.id) return reply.code(404).send({error:{code:'NOT_FOUND',message:'Database restore operation not found.'}});
    return inspectRestoreSwitch({docker:new Docker({socketPath:config.dockerSocket}),journal:restores,serviceId:req.params.id,operationId:req.params.operationId});
  });
  app.get<{Params:{id:string};Querystring:{containerId?:string;shell?:string}}>('/services/:id/console', {websocket:true,preValidation:async(req,reply)=>{
    if(!z.string().uuid().safeParse(req.params.id).success||!['/bin/sh','/bin/bash'].includes(req.query.shell||'/bin/sh')||(req.query.containerId&&!/^[a-f0-9]{12,64}$/.test(req.query.containerId)))return reply.code(400).send({error:{code:'INVALID_CONSOLE',message:'Invalid console target.'}});
    const release=maintenance?.admit();
    if(maintenance&&!release)return reply.code(503).send({error:{code:'MAINTENANCE',message:'Agent is draining.'}});
    if(restores.hasUnresolved(req.params.id)){release?.();return reply.code(409).send({error:{code:'SERVICE_BUSY',message:'Another operation is changing this service.'}});}
    try { await runtime.consoleContainer!(req.params.id,req.query.containerId); }
    catch { return reply.code(404).send({error:{code:'CONTAINER_NOT_FOUND',message:'No permitted running container is available.'}}); }
    finally { release?.(); }
  }}, (socket,req)=>{
    const release=maintenance?.admit();
    if(maintenance&&!release){socket.close(1012,'Agent is draining');return;}
    if(restores.hasUnresolved(req.params.id)){release?.();socket.close(1013,'Service is busy');return;}
    consoles.set(req.params.id,(consoles.get(req.params.id)??0)+1);
    let closed=false, started=false, startUncertain=false, containerId='', exec: Docker.Exec|undefined, stream:Duplex|undefined;
    let endSession: () => void = () => {};
    const sessionEnd = new Promise<void>(resolve => { endSession = resolve; });
    const unregister = maintenance?.registerCloser(()=>socket.close(1012,'Agent is draining'));
    const idle=setTimeout(()=>socket.close(1000,'Console expired'),15*60000);idle.unref();
    const ready=runtime.consoleContainer!(req.params.id,req.query.containerId).then(async container=>{
      if(closed)return;
      containerId=container.id;
      exec=await container.exec({Cmd:[req.query.shell||'/bin/sh'],Tty:true,AttachStdin:true,AttachStdout:true,AttachStderr:true});
      if(closed)return;
      startUncertain=true;
      stream=await exec.start({hijack:true,stdin:true,Tty:true});
      started=true;startUncertain=false;
      if(closed){stream.destroy();return;}
      stream.on('data',chunk=>{if(socket.readyState===1)socket.send(chunk,{binary:true});});
      stream.on('end',()=>socket.close(1000,'Shell exited'));stream.on('error',()=>socket.close(1011,'Shell disconnected'));
    }).catch(()=>{if(startUncertain)maintenance?.markUncertain();socket.close(1011,'Unable to start shell');});
    socket.on('message',(data,isBinary)=>{
      if(isBinary||data.toString().length>65536){socket.close(1008,'Invalid console packet');return;}
      let packet:{type?:string;data?:string;cols?:number;rows?:number};
      try{packet=JSON.parse(data.toString());}catch{socket.close(1008,'Invalid console packet');return;}
      if(!packet || typeof packet!=='object'||!['input','resize'].includes(packet.type||'')){socket.close(1008,'Invalid console packet');return;}
      if(packet.type==='input'&&(typeof packet.data!=='string'||packet.data.length>32768)){socket.close(1008,'Invalid console input');return;}
      if(packet.type==='resize'&&[packet.cols,packet.rows].some(value=>!Number.isInteger(value)||Number(value)<1||Number(value)>500)){socket.close(1008,'Invalid console size');return;}
      idle.refresh();
      void ready.then(async()=>{if(closed||!stream)return;if(packet.type==='input')stream.write(packet.data);if(packet.type==='resize'&&exec)await exec.resize({w:packet.cols!,h:packet.rows!});}).catch(()=>socket.close(1011,'Shell disconnected'));
    });
    socket.on('close',()=>{closed=true;clearTimeout(idle);if(stream&&!stream.destroyed){stream.write('\u0003exit\n');stream.end();setTimeout(()=>stream?.destroy(),250).unref();}endSession();});
    socket.on('error',()=>{closed=true;clearTimeout(idle);stream?.destroy();endSession();});
    void Promise.allSettled([ready,sessionEnd]).then(async()=>{
      if(startUncertain||(started&&(!exec||!await consoleExecStopped(exec,containerId)))) {uncertainConsoles.add(req.params.id);maintenance?.markUncertain();}
    }).catch(()=>{uncertainConsoles.add(req.params.id);maintenance?.markUncertain();}).finally(()=>{
      const remaining=(consoles.get(req.params.id)??1)-1;if(remaining)consoles.set(req.params.id,remaining);else consoles.delete(req.params.id);
      unregister?.();release?.();
    });
  });
  app.get<{Params:{id:string}}>('/operations/:id', (req, reply) => {
    if (!z.string().uuid().safeParse(req.params.id).success) return reply.code(400).send({ error: { code: 'INVALID_ID', message: 'Invalid operation identity.' } });
    const row = journal.prepare('SELECT state,response FROM operations WHERE id=?').get(req.params.id) as Pick<JournalRow, 'state' | 'response'> | undefined;
    if (!row) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Operation is not recorded.' } });
    const response = row.response ? JSON.parse(row.response) : undefined;
    return { state: row.state, ...(row.state === 'succeeded' ? { result: response } : row.state === 'failed' ? { error: response.error } : {}) };
  });
  app.post('/services/apply', async (req, reply) => {
    const release=maintenance?.admit();
    if(maintenance&&!release)return reply.code(503).send({error:{code:'MAINTENANCE',message:'Agent is draining.'}});
    try {
    const parsed = input.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'INVALID_SPEC', message: 'Invalid service operation.' } });
    const body = parsed.data;
    const hash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
    const previous = journal.prepare('SELECT * FROM operations WHERE id = ?').get(body.operationId) as JournalRow | undefined;
    if (previous && previous.request_hash !== hash) return reply.code(409).send({ error: { code: 'OPERATION_CONFLICT', message: 'Operation identity was reused with different input.' } });
    if (previous?.state === 'succeeded') return JSON.parse(previous.response!);
    if (previous?.state === 'failed') return reply.code(422).send(JSON.parse(previous.response!));
    if (active.has(body.operationId)) return active.get(body.operationId);
    const acquired = journal.transaction(() => {
      const unresolved = journal.prepare("SELECT id FROM operations WHERE service_id=? AND state='running' AND id!=? LIMIT 1").get(body.service.id, body.operationId);
      if (unresolved || restores.hasUnresolved(body.service.id) || locks.has(body.service.id)) return false;
      journal.prepare("INSERT INTO operations(id,request_hash,state,updated_at,service_id) VALUES(?,?,'running',?,?) ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at,service_id=excluded.service_id").run(body.operationId, hash, new Date().toISOString(), body.service.id);
      return true;
    }).immediate();
    if (!acquired) return reply.code(409).send({ error: { code: 'SERVICE_BUSY', message: 'Another operation is changing this service.' } });
    locks.add(body.service.id);
    const recovery: RecoveryContext = {
      previousRecorded: previous?.previous_recorded === 1,
      previousSpec: previous?.previous_spec ? openSpec(previous.previous_spec) : null,
      targetSpec: previous?.target_spec ? openSpec(previous.target_spec) : null,
      stage: previous?.operation_stage || 'applying', previousError: previous?.previous_error || null,
      recordPrevious(spec) {
        journal.prepare('UPDATE operations SET previous_spec=?,previous_recorded=1,updated_at=? WHERE id=?').run(spec ? sealSpec(spec) : null, new Date().toISOString(), body.operationId);
        recovery.previousRecorded = true; recovery.previousSpec = spec;
      },
      recordTarget(spec) {
        journal.prepare('UPDATE operations SET target_spec=?,updated_at=? WHERE id=?').run(sealSpec(spec), new Date().toISOString(), body.operationId);
        recovery.targetSpec = spec;
      },
      beginRollback(error) {
        journal.prepare("UPDATE operations SET operation_stage='rolling_back',previous_error=?,updated_at=? WHERE id=?").run(vault.redact(error), new Date().toISOString(), body.operationId);
        recovery.stage = 'rolling_back'; recovery.previousError = error;
      },
    };
    const operation = runtime.apply(body.service as Service, body.type, body.operationId, recovery).then(value => {
      const result = {...value,messages:value.messages.map(text=>vault.redact(text))};
      journal.prepare("UPDATE operations SET state='succeeded',response=?,updated_at=? WHERE id=?").run(JSON.stringify(result), new Date().toISOString(), body.operationId);
      return result;
    }).catch(error => {
      if (isUncertainRuntimeError(error)) throw error;
      const failure = { error: { code: 'RUNTIME_FAILED', message: vault.redact(message(error)) } };
      journal.prepare("UPDATE operations SET state='failed',response=?,updated_at=? WHERE id=?").run(JSON.stringify(failure), new Date().toISOString(), body.operationId);
      throw error;
    }).finally(() => { active.delete(body.operationId); locks.delete(body.service.id); });
    active.set(body.operationId, operation);
    return await operation;
    } finally { release?.(); }
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof RestoreCommitUncertainError) return reply.code(503).send({error:{code:'RESTORE_UNCERTAIN',message:'Database restore requires recovery before further changes.'}});
    if (isUncertainRuntimeError(error)) return reply.code(503).send({ error: { code: 'OPERATION_UNCERTAIN', message: 'Docker connection interrupted. Reconcile the same operation before making another change.' } });
    return reply.code(422).send({ error: { code: 'RUNTIME_FAILED', message: vault.redact(message(error)) } });
  });
  app.addHook('onClose', async () => { await Promise.allSettled(active.values()); journal.close(); });
  return app;
}
