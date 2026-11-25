import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { agentRequest as defaultAgentRequest, type AgentRequestOptions } from '../agent/client.js';
import type { SecretVault } from '../shared/secrets.js';
import type { User } from '../shared/types.js';
import type { BuildConcurrencySettings, ProjectEnvVariable, ProjectScript, ScriptExecutionResult } from '../shared/workspace-extras.js';
import { AppError } from './errors.js';
import type { Store } from './store.js';

const EXTRAS_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS project_env_vars (
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    is_secret INTEGER NOT NULL DEFAULT 0 CHECK(is_secret IN (0, 1)),
    value_sealed TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(project_id, name)
  );
  CREATE TABLE IF NOT EXISTS project_scripts (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    service_id TEXT,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    command TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS project_scripts_project ON project_scripts(project_id, created_at);
  CREATE TABLE IF NOT EXISTS instance_settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`;

const envNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'Use letters, numbers and underscores starting with a letter or underscore').max(128);
const envPutSchema = z.object({
  variables: z.array(z.object({
    name: envNameSchema,
    value: z.string().max(32000).optional(),
    secret: z.boolean().default(false),
  }).strict()).max(100),
}).strict();

const scriptInputSchema = z.object({
  name: z.string().trim().min(1).max(80).refine(v => !/[\r\n\x00-\x1f\x7f]/.test(v), 'Invalid script name'),
  description: z.string().trim().max(300).refine(v => !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(v), 'Invalid script description').default(''),
  command: z.string().trim().min(1).max(2000).refine(v => !v.includes('\0'), 'Script command cannot contain NUL bytes'),
  serviceId: z.string().uuid().nullable().optional(),
}).strict();

const scriptRunSchema = z.object({
  serviceId: z.string().uuid().optional(),
  timeoutSeconds: z.number().int().min(1).max(60).default(30),
}).strict();

const buildConcurrencySchema = z.object({
  maxConcurrentBuilds: z.number().int().min(1).max(8),
}).strict();

interface EnvRow { project_id: string; name: string; is_secret: number; value_sealed: string; updated_at: string }
interface ScriptRow { id: string; project_id: string; service_id: string | null; name: string; description: string; command: string; created_at: string; updated_at: string }
interface SettingRow { key: string; value_json: string; updated_at: string }

function extrasDbPath(dataDir: string) {
  return join(dataDir, 'workspace-extras.sqlite');
}

export function readProjectEnvironment(dataDir: string | undefined, projectId: string, vault: SecretVault): Array<{ name: string; value: string; secret: boolean }> {
  if (!dataDir) return [];
  const path = extrasDbPath(dataDir);
  if (!existsSync(path)) return [];
  let db: Database.Database | undefined;
  try {
    db = new Database(path, { readonly: true, fileMustExist: true });
    db.pragma('busy_timeout = 3000');
    const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='project_env_vars'").get();
    if (!exists) return [];
    const rows = db.prepare('SELECT name, is_secret, value_sealed FROM project_env_vars WHERE project_id=? ORDER BY name').all(projectId) as Pick<EnvRow, 'name' | 'is_secret' | 'value_sealed'>[];
    return rows.map(row => ({
      name: row.name,
      value: vault.open(row.value_sealed),
      secret: Boolean(row.is_secret),
    }));
  } catch {
    return [];
  } finally {
    db?.close();
  }
}

export function readBuildConcurrency(dataDir: string | undefined): number {
  if (!dataDir) return 1;
  const path = extrasDbPath(dataDir);
  if (!existsSync(path)) return 1;
  let db: Database.Database | undefined;
  try {
    db = new Database(path, { readonly: true, fileMustExist: true });
    db.pragma('busy_timeout = 2000');
    const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='instance_settings'").get();
    if (!exists) return 1;
    const row = db.prepare("SELECT value_json FROM instance_settings WHERE key='build_concurrency'").get() as { value_json: string } | undefined;
    if (!row) return 1;
    const parsed = buildConcurrencySchema.safeParse(JSON.parse(row.value_json));
    return parsed.success ? parsed.data.maxConcurrentBuilds : 1;
  } catch {
    return 1;
  } finally {
    db?.close();
  }
}

export class WorkspaceExtras {
  readonly db: Database.Database;
  constructor(private readonly store: Store) {
    mkdirSync(store.dataDir, { recursive: true, mode: 0o700 });
    const path = extrasDbPath(store.dataDir);
    this.db = new Database(path);
    try { chmodSync(path, 0o600); } catch { /* ignore on unsupported fs */ }
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('journal_mode = WAL');
    this.db.exec(EXTRAS_SCHEMA_SQL);
  }

  close() {
    this.db.close();
  }

  listProjectEnv(projectId: string): ProjectEnvVariable[] {
    const rows = this.db.prepare('SELECT * FROM project_env_vars WHERE project_id=? ORDER BY name').all(projectId) as EnvRow[];
    return rows.map(row => ({
      name: row.name,
      secret: Boolean(row.is_secret),
      hasValue: true,
      ...(row.is_secret ? {} : { value: this.store.vault.open(row.value_sealed) }),
      updatedAt: row.updated_at,
    }));
  }

  saveProjectEnv(projectId: string, actorId: string, input: unknown): ProjectEnvVariable[] {
    const parsed = envPutSchema.parse(input);
    const seen = new Set<string>();
    for (const item of parsed.variables) {
      if (seen.has(item.name)) throw new AppError('DUPLICATE_ENV', `Duplicate project environment variable: ${item.name}`, 400);
      seen.add(item.name);
    }
    const timestamp = new Date().toISOString();
    this.db.transaction(() => {
      const existing = new Map<string, EnvRow>(
        (this.db.prepare('SELECT * FROM project_env_vars WHERE project_id=?').all(projectId) as EnvRow[]).map(r => [r.name, r]),
      );
      this.db.prepare('DELETE FROM project_env_vars WHERE project_id=?').run(projectId);
      const insert = this.db.prepare('INSERT INTO project_env_vars(project_id, name, is_secret, value_sealed, updated_at) VALUES (?, ?, ?, ?, ?)');
      for (const item of parsed.variables) {
        const prior = existing.get(item.name);
        let sealed: string;
        if (item.value !== undefined) {
          sealed = this.store.vault.seal(item.value);
        } else if (item.secret && prior) {
          sealed = prior.value_sealed;
        } else if (!item.secret) {
          sealed = this.store.vault.seal('');
        } else {
          throw new AppError('SECRET_REQUIRED', `Enter a value for secret variable ${item.name}`, 400);
        }
        insert.run(projectId, item.name, item.secret ? 1 : 0, sealed, timestamp);
      }
      this.store.recordAudit(actorId, 'project.env.save', projectId);
    }).immediate();
    return this.listProjectEnv(projectId);
  }

  deleteProjectEnv(projectId: string, name: string, actorId: string): boolean {
    const valid = envNameSchema.parse(name);
    const result = this.db.prepare('DELETE FROM project_env_vars WHERE project_id=? AND name=?').run(projectId, valid);
    if (!result.changes) throw new AppError('NOT_FOUND', 'Project environment variable not found', 404);
    this.store.recordAudit(actorId, 'project.env.delete', `${projectId}:${valid}`);
    return true;
  }

  private toScript(row: ScriptRow): ProjectScript {
    return {
      id: row.id,
      projectId: row.project_id,
      serviceId: row.service_id,
      name: row.name,
      description: row.description,
      command: row.command,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  listScripts(projectId: string): ProjectScript[] {
    const rows = this.db.prepare('SELECT * FROM project_scripts WHERE project_id=? ORDER BY created_at, id').all(projectId) as ScriptRow[];
    return rows.map(row => this.toScript(row));
  }

  getScript(projectId: string, scriptId: string): ProjectScript {
    const id = z.string().uuid().parse(scriptId);
    const row = this.db.prepare('SELECT * FROM project_scripts WHERE id=? AND project_id=?').get(id, projectId) as ScriptRow | undefined;
    if (!row) throw new AppError('NOT_FOUND', 'Saved script not found', 404);
    return this.toScript(row);
  }

  private assertServiceBelongsToProject(projectId: string, serviceId: string | null | undefined) {
    if (!serviceId) return null;
    const service = this.store.getService(serviceId);
    if (!service || service.projectId !== projectId) throw new AppError('NOT_FOUND', 'Target service not found in this project', 404);
    return service.id;
  }

  createScript(projectId: string, actorId: string, input: unknown): ProjectScript {
    const parsed = scriptInputSchema.parse(input);
    const count = (this.db.prepare('SELECT count(*) AS n FROM project_scripts WHERE project_id=?').get(projectId) as { n: number }).n;
    if (count >= 50) throw new AppError('SCRIPT_LIMIT', 'Maximum 50 saved scripts per project', 409);
    const serviceId = this.assertServiceBelongsToProject(projectId, parsed.serviceId);
    const id = randomUUID(), timestamp = new Date().toISOString();
    this.db.prepare('INSERT INTO project_scripts(id, project_id, service_id, name, description, command, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, projectId, serviceId, parsed.name, parsed.description, parsed.command, timestamp, timestamp);
    this.store.recordAudit(actorId, 'project.script.create', id);
    return this.getScript(projectId, id);
  }

  updateScript(projectId: string, scriptId: string, actorId: string, input: unknown): ProjectScript {
    const existing = this.getScript(projectId, scriptId);
    const parsed = scriptInputSchema.parse(input);
    const serviceId = this.assertServiceBelongsToProject(projectId, parsed.serviceId);
    const timestamp = new Date().toISOString();
    this.db.prepare('UPDATE project_scripts SET service_id=?, name=?, description=?, command=?, updated_at=? WHERE id=? AND project_id=?')
      .run(serviceId, parsed.name, parsed.description, parsed.command, timestamp, existing.id, projectId);
    this.store.recordAudit(actorId, 'project.script.update', existing.id);
    return this.getScript(projectId, existing.id);
  }

  deleteScript(projectId: string, scriptId: string, actorId: string): boolean {
    const existing = this.getScript(projectId, scriptId);
    this.db.prepare('DELETE FROM project_scripts WHERE id=? AND project_id=?').run(existing.id, projectId);
    this.store.recordAudit(actorId, 'project.script.delete', existing.id);
    return true;
  }

  getBuildConcurrency(): BuildConcurrencySettings {
    const row = this.db.prepare("SELECT * FROM instance_settings WHERE key='build_concurrency'").get() as SettingRow | undefined;
    const activeJobs = (this.store.db.prepare("SELECT count(*) AS n FROM jobs WHERE status='running'").get() as { n: number }).n;
    if (!row) return { maxConcurrentBuilds: 1, activeJobs, updatedAt: null };
    const parsed = buildConcurrencySchema.safeParse(JSON.parse(row.value_json));
    return {
      maxConcurrentBuilds: parsed.success ? parsed.data.maxConcurrentBuilds : 1,
      activeJobs,
      updatedAt: row.updated_at,
    };
  }

  setBuildConcurrency(actorId: string, input: unknown): BuildConcurrencySettings {
    const parsed = buildConcurrencySchema.parse(input);
    const timestamp = new Date().toISOString();
    this.db.prepare("INSERT INTO instance_settings(key, value_json, updated_at) VALUES ('build_concurrency', ?, ?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at")
      .run(JSON.stringify(parsed), timestamp);
    this.store.recordAudit(actorId, 'settings.build-concurrency.update', String(parsed.maxConcurrentBuilds));
    return this.getBuildConcurrency();
  }
}

export interface WorkspaceExtrasOptions {
  store: Store;
  session: (req: FastifyRequest, mutation?: boolean) => { user: User };
  projectAccess: (user: User, projectId: string, write?: boolean) => unknown;
  administrator: (req: FastifyRequest, mutation?: boolean) => User;
  agentRequest?: typeof defaultAgentRequest;
  agentConnection?: AgentRequestOptions;
}

export function registerWorkspaceExtras(app: FastifyInstance, options: WorkspaceExtrasOptions) {
  const extras = new WorkspaceExtras(options.store);
  const runtimeRequest = options.agentRequest ?? defaultAgentRequest;
  app.addHook('onClose', async () => extras.close());

  // Shared Project Environment Variables
  app.get<{ Params: { id: string } }>('/api/v1/projects/:id/env', async req => {
    const { user } = options.session(req);
    const projectId = z.string().uuid().parse(req.params.id);
    options.projectAccess(user, projectId);
    return { variables: extras.listProjectEnv(projectId) };
  });
  app.put<{ Params: { id: string } }>('/api/v1/projects/:id/env', async req => {
    const { user } = options.session(req, true);
    const projectId = z.string().uuid().parse(req.params.id);
    options.projectAccess(user, projectId, true);
    return { variables: extras.saveProjectEnv(projectId, user.id, req.body) };
  });
  app.delete<{ Params: { id: string; name: string } }>('/api/v1/projects/:id/env/:name', async req => {
    const { user } = options.session(req, true);
    const projectId = z.string().uuid().parse(req.params.id);
    options.projectAccess(user, projectId, true);
    extras.deleteProjectEnv(projectId, req.params.name, user.id);
    return { success: true };
  });

  // Saved Operational Scripts
  app.get<{ Params: { id: string } }>('/api/v1/projects/:id/scripts', async req => {
    const { user } = options.session(req);
    const projectId = z.string().uuid().parse(req.params.id);
    options.projectAccess(user, projectId);
    return { scripts: extras.listScripts(projectId) };
  });
  app.post<{ Params: { id: string } }>('/api/v1/projects/:id/scripts', async (req, reply) => {
    const { user } = options.session(req, true);
    const projectId = z.string().uuid().parse(req.params.id);
    options.projectAccess(user, projectId, true);
    return reply.code(201).send({ script: extras.createScript(projectId, user.id, req.body) });
  });
  app.put<{ Params: { id: string; scriptId: string } }>('/api/v1/projects/:id/scripts/:scriptId', async req => {
    const { user } = options.session(req, true);
    const projectId = z.string().uuid().parse(req.params.id);
    options.projectAccess(user, projectId, true);
    return { script: extras.updateScript(projectId, req.params.scriptId, user.id, req.body) };
  });
  app.delete<{ Params: { id: string; scriptId: string } }>('/api/v1/projects/:id/scripts/:scriptId', async req => {
    const { user } = options.session(req, true);
    const projectId = z.string().uuid().parse(req.params.id);
    options.projectAccess(user, projectId, true);
    extras.deleteScript(projectId, req.params.scriptId, user.id);
    return { success: true };
  });
  app.post<{ Params: { id: string; scriptId: string } }>('/api/v1/projects/:id/scripts/:scriptId/run', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async req => {
    const { user } = options.session(req, true);
    const projectId = z.string().uuid().parse(req.params.id);
    options.projectAccess(user, projectId, true);
    const script = extras.getScript(projectId, req.params.scriptId);
    const input = scriptRunSchema.parse(req.body ?? {});
    const targetServiceId = input.serviceId ?? script.serviceId;
    if (!targetServiceId) throw new AppError('SERVICE_REQUIRED', 'Select a target service to run this script', 400);
    const service = options.store.getService(targetServiceId);
    if (!service || service.projectId !== projectId) throw new AppError('NOT_FOUND', 'Target service not found in this project', 404);
    if (service.state !== 'running' || service.deployedRevision === null) throw new AppError('SERVICE_NOT_RUNNING', 'Deploy and start the target service before running a script', 409);
    options.store.recordAudit(user.id, 'project.script.run', `${script.id}:${service.id}`);
    const result = await runtimeRequest<ScriptExecutionResult>(
      `/services/${service.id}/exec`,
      { command: script.command, timeoutSeconds: input.timeoutSeconds },
      { ...options.agentConnection, timeoutMs: (input.timeoutSeconds + 10) * 1000 },
    );
    return {
      scriptId: script.id,
      serviceId: service.id,
      exitCode: result.exitCode,
      output: options.store.vault.redact(result.output),
      truncated: result.truncated,
      durationMs: result.durationMs,
    };
  });

  // Build Concurrency Limit (Instance Administrator)
  app.get('/api/v1/settings/build-concurrency', async req => {
    options.administrator(req);
    return extras.getBuildConcurrency();
  });
  app.put('/api/v1/settings/build-concurrency', async req => {
    const actor = options.administrator(req, true);
    return extras.setBuildConcurrency(actor.id, req.body);
  });

  return extras;
}
