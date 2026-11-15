import { request, type IncomingMessage } from 'node:http';
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

export function agentDatabaseExport(serviceId:string, input:{kind:'postgres'|'mariadb'|'redis';database:string;user:string}, options:AgentRequestOptions={}):Promise<IncomingMessage> {
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
