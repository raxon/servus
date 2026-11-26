import { z } from 'zod';

export const composeName = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/);
export const composeGitCredentialSchema = z.object({
  username: z.string().min(1).max(256).regex(/^[^\x00-\x20\x7f:=]+$/),
  token: z.string().min(1).max(4096).regex(/^[^\x00-\x20\x7f]+$/).optional(),
}).strict();
export const composeSourceSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('inline'), yaml: z.string().min(1).max(256 * 1024) }).strict(),
  z.object({
    type: z.literal('git'),
    repository: z.string().url().max(1000),
    branch: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/),
    path: z.string().min(1).max(255).refine(value => !value.startsWith('/') && !/[\\\x00-\x1f]/.test(value) && value.split('/').every(part => part && part !== '.' && part !== '..' && part !== '.git')),
    sharedGithub: z.boolean().optional(),
    credential: composeGitCredentialSchema.optional(),
  }).strict(),
]);
export const composeDomainSchema = z.object({ hostname: z.string().min(1).max(253).toLowerCase().refine(value => value.split('.').every(part => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part))), service: composeName, port: z.number().int().min(1).max(65535), https: z.boolean().default(false), redirectHttps: z.boolean().optional() }).strict().refine(value=>!value.redirectHttps||value.https,{message:'HTTP redirects require HTTPS for the same domain',path:['redirectHttps']});
export const composeBuildSecretSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/),
  value: z.string().min(1).max(32768).optional(),
  hasValue: z.boolean().optional(),
}).strict();
export const composeConfigSchema = z.object({
  source: composeSourceSchema,
  domains: z.array(composeDomainSchema).max(20).default([]),
  buildSecrets: z.array(composeBuildSecretSchema).max(20).optional(),
  sshForwarding: z.boolean().optional(),
}).strict();
export type ComposeConfiguration = z.infer<typeof composeConfigSchema>;
export type ComposeOperationType = 'deploy' | 'start' | 'stop' | 'restart' | 'destroy';
export interface ComposeWorkload { id: string; projectId: string; name: string; revision: number; deployedRevision: number | null; state: 'pending' | 'running' | 'stopped' | 'failed' | 'deleted'; sourceType: 'inline' | 'git'; domains: z.infer<typeof composeDomainSchema>[]; createdAt: string; updatedAt: string; lastError: string | null }
export interface ComposeAction { id: string; workloadId: string; projectId: string; type: ComposeOperationType; status: 'queued' | 'running' | 'succeeded' | 'failed'; revision: number; error: string | null; createdAt: string; updatedAt: string; logs: string }
export interface ComposeApplyRequest { operationId: string; workloadId: string; projectId: string; revision: number; type: ComposeOperationType; configuration: ComposeConfiguration; certificateRetry?: {hostname:string} }
export interface ComposeApplyResult { state: 'running' | 'stopped' | 'deleted'; revision: number; logs: string }
export interface ComposeCertificateStatus { hostname:string;checkedAt:string;status:'not_found'|'active'|'expired'|'not_yet_valid';publicVerified:boolean;eventsAvailable:boolean;notBefore?:string;expiresAt?:string;fingerprint?:string;lastFailure?:{observedAt:string;operation:'issuance'|'renewal';category:'dns'|'rate_limit'|'contact'|'challenge'|'other'} }
export const COMPOSE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS compose_workloads(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),name TEXT NOT NULL,revision INTEGER NOT NULL,deployed_revision INTEGER,state TEXT NOT NULL,configuration TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,last_error TEXT,deleted_at TEXT,UNIQUE(project_id,name));
CREATE TABLE IF NOT EXISTS compose_actions(id TEXT PRIMARY KEY,workload_id TEXT NOT NULL REFERENCES compose_workloads(id),project_id TEXT NOT NULL REFERENCES projects(id),actor_id TEXT NOT NULL REFERENCES users(id),type TEXT NOT NULL,status TEXT NOT NULL,revision INTEGER NOT NULL,snapshot TEXT NOT NULL,request_hash TEXT NOT NULL,idempotency_key TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,lease_until TEXT,worker_id TEXT,error TEXT,logs TEXT NOT NULL DEFAULT '',UNIQUE(actor_id,idempotency_key));
CREATE UNIQUE INDEX IF NOT EXISTS compose_active_workload ON compose_actions(workload_id) WHERE status IN ('queued','running');
CREATE TABLE IF NOT EXISTS compose_domains(hostname TEXT PRIMARY KEY,workload_id TEXT NOT NULL REFERENCES compose_workloads(id));
`;
