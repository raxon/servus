export interface ProjectEnvVariable {
  name: string;
  value?: string;
  secret: boolean;
  hasValue: boolean;
  updatedAt: string;
}

export interface ProjectEnvInput {
  name: string;
  value?: string;
  secret?: boolean;
}

export interface ProjectScript {
  id: string;
  projectId: string;
  serviceId: string | null;
  name: string;
  description: string;
  command: string;
  createdAt: string;
  updatedAt: string;
}

export interface ScriptExecutionResult {
  exitCode: number;
  output: string;
  truncated: boolean;
  durationMs: number;
}

export interface BuildConcurrencySettings {
  maxConcurrentBuilds: number;
  activeJobs?: number;
  updatedAt: string | null;
}
