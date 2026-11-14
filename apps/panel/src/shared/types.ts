export type ServiceState = 'pending' | 'running' | 'stopped' | 'deploying' | 'failed' | 'unknown';
export type ActionType = 'deploy' | 'start' | 'stop' | 'restart' | 'destroy';
export type ActionStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface User { id: string; email: string; role: 'admin' | 'member'; createdAt: string }
export interface SessionResponse { user: User; csrfToken: string }
export interface Project { id: string; name: string; description: string; createdAt: string; serviceCount: number }
export type ServiceKind = 'app' | 'postgres' | 'redis' | 'mariadb';
export interface GitCredential { username: string; token?: string; secretRef?: string }
export type SourceConfig = { type: 'image' } | { type: 'git'; repository: string; branch: string; context: string; dockerfile: string; credential?: GitCredential };
export interface EnvironmentVariable { name: string; value?: string; secret?: boolean; secretRef?: string }
export interface DomainConfig { hostname: string; port: number; primary?: boolean }
export interface MountConfig { type: 'volume' | 'file' | 'bind'; name: string; target: string; readOnly?: boolean; content?: string; source?: string }
export interface ResourceConfig { cpu: number; memoryMb: number }
export interface DatabaseConfig { database: string; user: string; password?: string; passwordSecretRef?: string }
export interface ServiceConfiguration {
  kind?: ServiceKind; source?: SourceConfig; environment?: EnvironmentVariable[];
  domains?: DomainConfig[]; mounts?: MountConfig[]; resources?: ResourceConfig; database?: DatabaseConfig;
}
export interface Service extends ServiceConfiguration {
  id: string; projectId: string; name: string; image: string; port: number; hostname: string;
  replicas: number; revision: number; deployedRevision: number | null; state: ServiceState;
  createdAt: string; updatedAt: string; lastError: string | null;
  deletedAt?: string | null;
  sourceCommit?: string | null; imageDigest?: string | null;
}
export interface Action {
  id: string; projectId: string; serviceId: string; type: ActionType; status: ActionStatus;
  phase: string; error: string | null; createdAt: string; updatedAt: string; finishedAt: string | null;
}
export interface ActionEvent {
  id: string; actionId: string; sequence: number; level: 'info' | 'warn' | 'error'; message: string; createdAt: string;
}
export interface RuntimeStatus {
  online: boolean; engineVersion?: string; cpus?: number; memoryBytes?: number; swarmState?: string;
  ingressPort?: number; error?: string;
}
export interface ActionDetail { action: Action; events: ActionEvent[] }
export interface ApiError { error: { code: string; message: string } }
export interface ServiceInput extends ServiceConfiguration { name: string; image: string; port: number; hostname: string; replicas?: number }
export interface ServicePatch extends ServiceConfiguration { expectedRevision: number; image?: string; port?: number; hostname?: string; replicas?: number }
export interface ContainerInfo { id: string; name: string; state: string }
export interface ServiceMetrics { cpuPercent: number; memoryBytes: number; memoryLimitBytes: number; networkRxBytes: number; networkTxBytes: number; containers: number }
export interface ServiceLogs { lines: string[] }
export interface ConnectionInfo { host: string; port: number; database: string; user: string; password?: string }
export interface ClaimedJob {
  id: string; actionId: string; serviceId: string; type: ActionType; snapshot: Service;
  attempts: number; recovered: boolean; workerId: string; leaseUntil: string;
}
