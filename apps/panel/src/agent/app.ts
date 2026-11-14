import Fastify from 'fastify';
import Database from 'better-sqlite3';
import websocket from '@fastify/websocket';
import type { Duplex } from 'node:stream';
import type Docker from 'dockerode';
import { SecretVault } from '../shared/secrets.js';
import { createHash, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { agentConfig } from './config.js';
import { DockerRuntime, message, isUncertainRuntimeError, type RecoveryContext } from './runtime.js';
import type { Service } from '../shared/types.js';
import type { AgentMaintenanceGate } from './maintenance.js';

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
  maintenance?.bindJournal(() => Boolean(journal.prepare("SELECT 1 FROM operations WHERE state='running' LIMIT 1").get()));
  const active = new Map<string, Promise<unknown>>();
  const locks = new Set<string>();
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
  app.get<{Params:{id:string};Querystring:{containerId?:string;shell?:string}}>('/services/:id/console', {websocket:true,preValidation:async(req,reply)=>{
    if(!z.string().uuid().safeParse(req.params.id).success||!['/bin/sh','/bin/bash'].includes(req.query.shell||'/bin/sh')||(req.query.containerId&&!/^[a-f0-9]{12,64}$/.test(req.query.containerId)))return reply.code(400).send({error:{code:'INVALID_CONSOLE',message:'Invalid console target.'}});
    const release=maintenance?.admit();
    if(maintenance&&!release)return reply.code(503).send({error:{code:'MAINTENANCE',message:'Agent is draining.'}});
    try { await runtime.consoleContainer!(req.params.id,req.query.containerId); }
    catch { return reply.code(404).send({error:{code:'CONTAINER_NOT_FOUND',message:'No permitted running container is available.'}}); }
    finally { release?.(); }
  }}, (socket,req)=>{
    const release=maintenance?.admit();
    if(maintenance&&!release){socket.close(1012,'Agent is draining');return;}
    let closed=false, exec: Docker.Exec|undefined, stream:Duplex|undefined;
    let endSession: () => void = () => {};
    const sessionEnd = new Promise<void>(resolve => { endSession = resolve; });
    const unregister = maintenance?.registerCloser(()=>socket.close(1012,'Agent is draining'));
    const idle=setTimeout(()=>socket.close(1000,'Console expired'),15*60000);idle.unref();
    const ready=runtime.consoleContainer!(req.params.id,req.query.containerId).then(async container=>{
      if(closed)return;
      // Docker stream closure does not establish that its exec process has exited.
      maintenance?.markUncertain();
      exec=await container.exec({Cmd:[req.query.shell||'/bin/sh'],Tty:true,AttachStdin:true,AttachStdout:true,AttachStderr:true});
      stream=await exec.start({hijack:true,stdin:true,Tty:true});
      if(closed){stream.destroy();return;}
      stream.on('data',chunk=>{if(socket.readyState===1)socket.send(chunk,{binary:true});});
      stream.on('end',()=>socket.close(1000,'Shell exited'));stream.on('error',()=>socket.close(1011,'Shell disconnected'));
    }).catch(()=>socket.close(1011,'Unable to start shell'));
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
    void Promise.allSettled([ready,sessionEnd]).then(()=>{unregister?.();release?.();});
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
    const unresolved = journal.prepare("SELECT id FROM operations WHERE service_id=? AND state='running' AND id!=? LIMIT 1").get(body.service.id, body.operationId);
    if (unresolved || locks.has(body.service.id)) return reply.code(409).send({ error: { code: 'SERVICE_BUSY', message: 'Another operation is changing this service.' } });
    locks.add(body.service.id);
    journal.prepare("INSERT INTO operations(id,request_hash,state,updated_at,service_id) VALUES(?,?,'running',?,?) ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at,service_id=excluded.service_id").run(body.operationId, hash, new Date().toISOString(), body.service.id);
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
    if (isUncertainRuntimeError(error)) return reply.code(503).send({ error: { code: 'OPERATION_UNCERTAIN', message: 'Docker connection interrupted. Reconcile the same operation before making another change.' } });
    return reply.code(422).send({ error: { code: 'RUNTIME_FAILED', message: vault.redact(message(error)) } });
  });
  app.addHook('onClose', async () => { await Promise.allSettled(active.values()); journal.close(); });
  return app;
}
