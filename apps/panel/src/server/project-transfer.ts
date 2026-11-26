import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ProjectExportBundle, ProjectImportResult } from '../shared/platform-settings.js';
import type { User } from '../shared/types.js';
import { BUILD_INFO } from './generated-build-info.js';
import { nameSchema, normalizeServiceInput } from './configuration.js';
import { AppError } from './errors.js';
import { withAutomaticHostDomain } from './host-domain.js';
import type { Store } from './store.js';
import { readProjectEnvironment, WorkspaceExtras } from './workspace-extras.js';
import type { registerCompose } from './compose.js';

const importBodySchema = z.object({
  targetProjectName: nameSchema.optional(),
  useAutomaticDomains: z.boolean().default(true),
  bundle: z.object({
    schemaVersion: z.literal('servus-project-export/v1'),
    exportedAt: z.string(),
    servusVersion: z.string().optional(),
    secretsIncluded: z.boolean().optional(),
    project: z.object({
      name: nameSchema,
      description: z.string().max(500).default(''),
    }),
    services: z.array(z.object({
      name: nameSchema,
      kind: z.enum(['app', 'postgres', 'redis', 'mariadb', 'mysql', 'mongodb']).default('app'),
      image: z.string().min(1).max(300),
      port: z.number().int().min(1).max(65535).default(80),
      hostname: z.string().max(253).optional(),
      replicas: z.number().int().min(1).max(5).default(1),
      source: z.unknown().optional(),
      environment: z.array(z.object({
        name: z.string().max(128),
        value: z.string().max(32000).optional(),
        secret: z.boolean().optional(),
        redacted: z.boolean().optional(),
      })).max(100).optional(),
      domains: z.array(z.unknown()).max(20).optional(),
      mounts: z.array(z.unknown()).max(20).optional(),
      resources: z.object({ cpu: z.number().min(0.1).max(64), memoryMb: z.number().int().min(32).max(131072) }).optional(),
      database: z.object({ database: z.string().max(63), user: z.string().max(63), password: z.string().max(128).optional() }).optional(),
      ports: z.array(z.unknown()).max(10).optional(),
      endpointMode: z.enum(['vip', 'dnsrr']).optional(),
      healthcheck: z.unknown().optional(),
      deploymentStrategy: z.unknown().optional(),
      notes: z.string().max(4000).optional(),
    })).max(50).default([]),
    composeWorkloads: z.array(z.object({
      name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/),
      configuration: z.unknown(),
    })).max(20).default([]),
    projectEnv: z.array(z.object({
      name: z.string().max(128),
      value: z.string().max(32000).optional(),
      secret: z.boolean().default(false),
      redacted: z.boolean().optional(),
    })).max(100).default([]),
    projectScripts: z.array(z.object({
      name: z.string().min(1).max(80),
      description: z.string().max(300).default(''),
      command: z.string().min(1).max(2000),
      serviceName: z.string().nullable().optional(),
    })).max(50).default([]),
  }),
}).strict();

export function registerProjectTransfer(
  app: FastifyInstance,
  options: {
    dataDir: string;
    store: Store;
    session: (req: FastifyRequest, mutation?: boolean) => { user: User; csrfToken: string };
    projectAccess: (user: User, id: string, write?: boolean) => void;
    administrator: (req: FastifyRequest, mutation?: boolean) => User;
    createComposeWorkload: ReturnType<typeof registerCompose>['createWorkload'];
  },
) {
  const { store, session, projectAccess, administrator } = options;

  app.get<{ Params: { id: string }; Querystring: { includeSecrets?: string } }>('/api/v1/projects/:id/export', async (req) => {
    const { user } = session(req);
    projectAccess(user, req.params.id, false);
    const includeSecrets = req.query.includeSecrets === 'true';
    if (includeSecrets && user.role !== 'admin') {
      throw new AppError('FORBIDDEN', 'Only administrators can export unredacted secrets', 403);
    }

    const project = store.getProject(req.params.id);
    if (!project) throw new AppError('NOT_FOUND', 'Project not found', 404);

    const services = store.listServices(project.id);
    const serviceById = new Map(services.map((s) => [s.id, s]));

    const exportedServices: ProjectExportBundle['services'] = services.map((svc) => {
      const env = (svc.environment ?? []).map((item) => {
        if (item.secret && item.secretRef) {
          if (includeSecrets) {
            try {
              return { name: item.name, value: store.vault.getServiceSecret(item.secretRef, svc.id, 'environment'), secret: true };
            } catch {
              return { name: item.name, secret: true, redacted: true };
            }
          }
          return { name: item.name, secret: true, redacted: true };
        }
        return { name: item.name, value: item.value ?? '', secret: false };
      });

      let dbExport: { database: string; user: string; password?: string } | undefined;
      if (svc.database) {
        dbExport = { database: svc.database.database, user: svc.database.user };
        if (includeSecrets && svc.database.passwordSecretRef) {
          try {
            dbExport.password = store.vault.getServiceSecret(svc.database.passwordSecretRef, svc.id, 'database');
          } catch { /* leave undefined */ }
        }
      }

      // Strip internal credential secretRefs from source
      let cleanSource: unknown = svc.source;
      if (svc.source?.type === 'git') {
        const { credential: _cred, ssh: _ssh, ...rest } = svc.source;
        cleanSource = rest;
      }

      return {
        name: svc.name,
        kind: svc.kind ?? 'app',
        image: svc.image,
        port: svc.port,
        hostname: svc.hostname,
        replicas: svc.replicas,
        source: cleanSource,
        environment: env,
        domains: svc.domains,
        mounts: svc.mounts,
        resources: svc.resources,
        database: dbExport,
        ports: svc.ports,
        endpointMode: svc.endpointMode,
        healthcheck: svc.healthcheck,
        deploymentStrategy: svc.deploymentStrategy,
        notes: svc.notes,
      };
    });

    const composeRows = store.db
      .prepare('SELECT name, configuration FROM compose_workloads WHERE project_id=? AND deleted_at IS NULL ORDER BY name')
      .all(project.id) as Array<{ name: string; configuration: string }>;
    const composeWorkloads = composeRows.map((row) => {
      const parsed = JSON.parse(store.vault.open(row.configuration)) as Record<string, unknown>;
      if (!includeSecrets && Array.isArray(parsed.buildSecrets)) {
        parsed.buildSecrets = parsed.buildSecrets.map((s: { id: string }) => ({ id: s.id, hasValue: true }));
      }
      return { name: row.name, configuration: parsed };
    });

    const rawProjectEnv = readProjectEnvironment(options.dataDir, project.id, store.vault);
    const projectEnv = rawProjectEnv.map((item) =>
      item.secret && !includeSecrets
        ? { name: item.name, secret: true, redacted: true }
        : { name: item.name, value: item.value, secret: item.secret },
    );

    const extras = new WorkspaceExtras(store);
    const scripts = extras.listScripts(project.id).map((sc) => ({
      name: sc.name,
      description: sc.description,
      command: sc.command,
      serviceName: sc.serviceId ? serviceById.get(sc.serviceId)?.name ?? null : null,
    }));
    extras.close();

    store.recordAudit(user.id, 'project.export', project.id);

    return {
      schemaVersion: 'servus-project-export/v1',
      exportedAt: new Date().toISOString(),
      servusVersion: BUILD_INFO.version,
      secretsIncluded: includeSecrets,
      project: { name: project.name, description: project.description },
      services: exportedServices,
      composeWorkloads,
      projectEnv,
      projectScripts: scripts,
    } satisfies ProjectExportBundle;
  });

  app.post('/api/v1/projects/import', async (req, reply) => {
    const actor = administrator(req, true);
    const parsed = importBodySchema.parse(req.body ?? {});
    const { bundle, useAutomaticDomains } = parsed;
    const projectName = parsed.targetProjectName ?? bundle.project.name;

    const project = store.createProject(projectName, bundle.project.description, actor.id);
    const warnings: string[] = [];
    const importedServices: string[] = [];
    const importedCompose: string[] = [];
    const serviceNameToId = new Map<string, string>();

    const extras = new WorkspaceExtras(store);
    let importedEnvCount = 0;
    let importedScriptCount = 0;

    try {
      // 1. Project shared env vars
      const validEnv = bundle.projectEnv.filter((item) => !item.redacted && item.value !== undefined);
      const skippedEnv = bundle.projectEnv.length - validEnv.length;
      if (skippedEnv > 0) warnings.push(`Skipped ${skippedEnv} redacted project environment secret(s); re-enter them after import.`);
      if (validEnv.length > 0) {
        extras.saveProjectEnv(project.id, actor.id, {
          variables: validEnv.map((v) => ({ name: v.name, value: v.value!, secret: v.secret })),
        });
        importedEnvCount = validEnv.length;
      }

      // 2. Services
      for (const svc of bundle.services) {
        const env = (svc.environment ?? [])
          .filter((item) => !item.redacted && item.value !== undefined)
          .map((item) => ({ name: item.name, value: item.value!, secret: Boolean(item.secret) }));
        const skippedSvcSecrets = (svc.environment?.length ?? 0) - env.length;
        if (skippedSvcSecrets > 0) warnings.push(`Service ${svc.name}: ${skippedSvcSecrets} redacted secret(s) must be re-entered.`);

        const rawPayload: Record<string, unknown> = {
          name: svc.name,
          kind: svc.kind,
          image: svc.image,
          port: svc.port,
          replicas: svc.replicas,
          ...(svc.source ? { source: svc.source } : {}),
          ...(env.length ? { environment: env } : {}),
          ...(svc.mounts?.length ? { mounts: svc.mounts } : {}),
          ...(svc.resources ? { resources: svc.resources } : {}),
          ...(svc.database ? { database: svc.database } : {}),
          ...(svc.ports?.length ? { ports: svc.ports } : {}),
          ...(svc.endpointMode ? { endpointMode: svc.endpointMode } : {}),
          ...(svc.healthcheck ? { healthcheck: svc.healthcheck } : {}),
          ...(svc.deploymentStrategy ? { deploymentStrategy: svc.deploymentStrategy } : {}),
          ...(svc.notes ? { notes: svc.notes } : {}),
        };

        if (svc.kind !== 'app') {
          rawPayload.domains = [];
        } else if (useAutomaticDomains) {
          // Allow Servus automatic host domain if configured, otherwise fallback to unique .localhost
          if (!store.vault.hostConnection()?.hostname) {
            rawPayload.hostname = `${projectName}-${svc.name}.localhost`;
          }
        } else if (svc.domains?.length) {
          rawPayload.domains = svc.domains;
        } else if (svc.hostname) {
          rawPayload.hostname = svc.hostname;
        }

        const normalized = normalizeServiceInput(withAutomaticHostDomain(store, project.id, rawPayload));
        const created = store.createService(project.id, normalized, actor.id, `import-${randomUUID()}`);
        importedServices.push(created.service.name);
        serviceNameToId.set(created.service.name, created.service.id);
      }

      // 3. Compose workloads
      for (const cw of bundle.composeWorkloads) {
        try {
          const cfg = cw.configuration as Record<string, unknown>;
          const cleaned = { ...cfg, domains: useAutomaticDomains ? [] : cfg.domains ?? [] };
          const res = options.createComposeWorkload({
            projectId: project.id,
            user: actor,
            name: cw.name,
            configuration: cleaned,
            key: `import-compose-${randomUUID()}`,
          });
          importedCompose.push(res.workload.name);
        } catch (err) {
          warnings.push(`Compose workload ${cw.name} could not be imported: ${err instanceof Error ? err.message : 'invalid config'}`);
        }
      }

      // 4. Project scripts
      for (const sc of bundle.projectScripts) {
        try {
          extras.createScript(project.id, actor.id, {
            name: sc.name,
            description: sc.description,
            command: sc.command,
            serviceId: sc.serviceName ? serviceNameToId.get(sc.serviceName) ?? null : null,
          });
          importedScriptCount++;
        } catch (err) {
          warnings.push(`Script ${sc.name} skipped: ${err instanceof Error ? err.message : 'invalid'}`);
        }
      }
    } finally {
      extras.close();
    }

    store.recordAudit(actor.id, 'project.import', project.id);
    return reply.code(201).send({
      projectId: project.id,
      projectName: project.name,
      importedServices,
      importedCompose,
      importedEnvCount,
      importedScriptCount,
      warnings,
    } satisfies ProjectImportResult);
  });
}
