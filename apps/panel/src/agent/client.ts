import { request, type IncomingMessage } from 'node:http';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { agentConfig } from './config.js';
import type { RuntimeStatus, Service, ServiceState } from '../shared/types.js';

export interface ApplyResult { state: ServiceState; deployedRevision: number; imageDigest?: string | null; sourceCommit?: string | null; messages: string[] }
export type AgentErrorCertainty = 'definitive' | 'uncertain';

export class AgentRequestError extends Error {
  constructor(message: string, readonly certainty: AgentErrorCertainty, readonly statusCode?: number, readonly code?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AgentRequestError';
  }
}

export interface AgentRequestOptions { socketPath?: string; token?: string; timeoutMs?: number }
const failure = z.object({ error: z.object({ code: z.string().min(1), message: z.string().min(1) }) });
const resultSchema = z.object({
  state: z.enum(['running','stopped']), deployedRevision: z.number().int().positive(),
  imageDigest: z.string().nullable().optional(), sourceCommit: z.string().nullable().optional(), messages: z.array(z.string()).max(1000),
});

export function agentRequest<T>(path: string, body?: unknown, options: AgentRequestOptions = {}): Promise<T> {
  const config = options.socketPath && options.token ? undefined : agentConfig();
  const timeoutMs = options.timeoutMs ?? 180000;
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error: AgentRequestError | null, value?: T) => {
      if(settled) return;
      settled = true;
      clearTimeout(timer);
      if(error) reject(error); else resolve(value as T);
    };
    const uncertain = (message: string, cause?: unknown) => new AgentRequestError(message,'uncertain',undefined,undefined,{cause});
    const req = request({ socketPath: options.socketPath ?? config!.socketPath, path, method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${options.token ?? config!.token}`, 'content-type': 'application/json' } }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', part => {
        text += part;
        if(text.length > 1024 * 1024) req.destroy(uncertain('Agent response exceeds the supported size; operation outcome is unknown.'));
      });
      res.once('aborted', () => finish(uncertain('The agent connection closed before its outcome was received.')));
      res.once('error', error => finish(uncertain('The agent response could not be received.',error)));
      res.once('end', () => {
        const status = res.statusCode ?? 500;
        let data: unknown;
        try { data = JSON.parse(text); }
        catch(error) { finish(uncertain('Agent returned an unreadable response; operation outcome is unknown.',error)); return; }
        if(status >= 400) {
          const parsed = failure.safeParse(data);
          if(!parsed.success) { finish(uncertain('Agent returned an invalid error response; operation outcome is unknown.')); return; }
          const transient = status >= 500 || [408,425,429].includes(status) || parsed.data.error.code === 'SERVICE_BUSY';
          finish(new AgentRequestError(parsed.data.error.message.slice(0,2000),transient ? 'uncertain' : 'definitive',status,parsed.data.error.code));
          return;
        }
        if(status < 200 || status >= 300) { finish(uncertain('Agent returned an unexpected response status; operation outcome is unknown.')); return; }
        finish(null,data as T);
      });
    });
    req.once('error', error => finish(error instanceof AgentRequestError ? error : uncertain('The local agent connection failed; operation outcome is unknown.',error)));
    timer = setTimeout(() => req.destroy(uncertain('Agent operation timed out; operation outcome is unknown.')),timeoutMs);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

export async function runtimeStatus(): Promise<RuntimeStatus> {
  try { return await agentRequest<RuntimeStatus>('/runtime'); }
  catch { return { online: false, error: 'The local Docker agent is unavailable.', ingressPort: Number(process.env.PANEL_INGRESS_PORT || 18080) }; }
}

export async function applyService(operationId: string, service: Service, type: string, options?: AgentRequestOptions): Promise<ApplyResult> {
  const data = await agentRequest<unknown>('/services/apply', { operationId, service, type },options);
  const parsed = resultSchema.safeParse(data);
  if(!parsed.success) throw new AgentRequestError('Agent returned an invalid operation result; its outcome is unknown.','uncertain');
  return parsed.data;
}

export function agentDatabaseExport(serviceId:string, input:{kind:'postgres'|'mariadb'|'redis'|'mysql'|'mongodb';database:string;user:string}, options:AgentRequestOptions={}):Promise<IncomingMessage> {
  const config=options.socketPath&&options.token?undefined:agentConfig();
  return new Promise((resolve,reject)=>{
    let settled=false;
    const body=JSON.stringify(input);
    const req=request({socketPath:options.socketPath??config!.socketPath,path:`/services/${serviceId}/database-export`,method:'POST',
      headers:{authorization:`Bearer ${options.token??config!.token}`,'content-type':'application/json','content-length':Buffer.byteLength(body)}},res=>{
      clearTimeout(timer);
      if(res.statusCode!==200){
        res.resume();settled=true;reject(new AgentRequestError('The database export could not be created.','definitive',res.statusCode));return;
      }
      settled=true;res.setTimeout(300_000,()=>res.destroy(new Error('Database export transfer timed out.')));resolve(res);
    });
    const timer=setTimeout(()=>req.destroy(new Error('Database export timed out.')),options.timeoutMs??330_000);
    req.once('error',error=>{clearTimeout(timer);if(!settled){settled=true;reject(new AgentRequestError('The database export service is unavailable.','uncertain',undefined,undefined,{cause:error}));}});
    req.end(body);
  });
}

export function agentDatabaseUpload(serviceId: string, input: {
  operationId: string; kind: 'postgres' | 'mariadb' | 'redis' | 'mysql' | 'mongodb'; size: number; stream: Readable; signal?: AbortSignal;
}, options: AgentRequestOptions = {}): Promise<{ operationId: string; size: number; sha256: string; phase: 'reserved' }> {
  if (!z.string().uuid().safeParse(serviceId).success || !/^[a-f0-9]{32}$/.test(input.operationId) || !['postgres','mariadb','redis','mysql','mongodb'].includes(input.kind) || !Number.isSafeInteger(input.size) || input.size < 1 || input.size > 2 * 1024 * 1024 * 1024 || !(input.stream instanceof Readable)) throw new Error('Invalid database restore upload.');
  const config = options.socketPath && options.token ? undefined : agentConfig();
  const schema = z.object({ operationId:z.literal(input.operationId), size:z.literal(input.size), sha256:z.string().regex(/^[a-f0-9]{64}$/), phase:z.literal('reserved') }).strict();
  return new Promise((resolve, reject) => {
    let settled = false, sent = false, response: z.infer<typeof schema> | undefined, size = 0, digest = '';
    const hash = createHash('sha256');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const uncertain = (message:string, cause?:unknown) => new AgentRequestError(message, 'uncertain', undefined, undefined, {cause});
    const finish = (error?:AgentRequestError) => {
      if (settled) return;
      if (!error && (!sent || !response)) return;
      if (!error && response!.sha256 !== digest) error = uncertain('The uploaded archive digest did not match the agent response.');
      settled = true; clearTimeout(timer); input.signal?.removeEventListener('abort', abort);
      if (error) { input.stream.destroy(); req.destroy(); reject(error); } else resolve(response!);
    };
    const abort = () => finish(uncertain('The database restore upload was interrupted.'));
    const req = request({ socketPath:options.socketPath ?? config!.socketPath, method:'POST', path:`/services/${serviceId}/database-restore/upload?operationId=${input.operationId}&kind=${input.kind}`,
      headers:{ authorization:`Bearer ${options.token ?? config!.token}`, 'content-type':'application/octet-stream', 'content-length':String(input.size) } }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', part => { text += part; if (text.length > 8192) { res.destroy(); finish(uncertain('The agent returned an oversized upload response.')); } });
      res.once('aborted', () => finish(uncertain('The agent closed the upload response.')));
      res.once('error', error => finish(uncertain('The upload response could not be received.',error)));
      res.once('end', () => {
        if (res.statusCode !== 200) { finish(uncertain('The agent could not accept the database restore upload.')); return; }
        try { const parsed = schema.safeParse(JSON.parse(text)); if (!parsed.success) throw new Error('Invalid upload response'); response = parsed.data; finish(); }
        catch (error) { finish(uncertain('The agent returned an invalid upload response.',error)); }
      });
    });
    req.once('error', error => finish(uncertain('The agent connection failed during the upload.',error)));
    const counter = new Transform({ transform(chunk:Buffer, _encoding, callback) { size += chunk.length; if (size > input.size) callback(new Error('Upload exceeds its declared size.')); else { hash.update(chunk); callback(null,chunk); } },
      flush(callback) { callback(size === input.size ? undefined : new Error('Upload is shorter than its declared size.')); } });
    timer = setTimeout(() => finish(uncertain('The database restore upload timed out.')), options.timeoutMs ?? 30 * 60_000); timer.unref();
    input.signal?.addEventListener('abort', abort, {once:true});
    if (input.signal?.aborted) { abort(); return; }
    void pipeline(input.stream, counter, req).then(() => { digest = hash.digest('hex'); sent = true; finish(); }).catch(error => finish(uncertain('The database restore upload could not be sent.',error)));
  });
}
