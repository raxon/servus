import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { agentRequest } from '../agent/client.js';
import type { EphemeralDbToolSession, PostgresMigrationResult } from '../shared/db-admin.js';
import type { Service, User } from '../shared/types.js';
import { normalizeServiceInput } from './configuration.js';
import { AppError } from './errors.js';
import type { Store } from './store.js';

interface DbAdminServerOptions {
  store: Store;
  serviceAccess: (req: FastifyRequest, id: string, write?: boolean, includeDeleted?: boolean) => { auth: { user: User; csrfToken: string }; service: Service };
  runtimeRequest: typeof agentRequest;
  agentConnection?: { socketPath: string; token: string };
}

const startAdminToolBody = z.object({
  ttlMinutes: z.number().int().min(5).max(60).default(15),
}).strict();

const migratePostgresBody = z.object({
  confirm: z.literal(true),
  targetName: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/).optional(),
}).strict();

export function registerDbAdminTools(app: FastifyInstance, options: DbAdminServerOptions) {
  const { store, serviceAccess, runtimeRequest } = options;

  app.get<{ Params: { id: string } }>('/api/v1/services/:id/database/admin-tool', async (req) => {
    const { service } = serviceAccess(req, req.params.id, false);
    if (!service.kind || service.kind === 'app') throw new AppError('NOT_FOUND', 'Managed database not found', 404);
    return runtimeRequest<EphemeralDbToolSession>(
      `/services/${service.id}/database/admin-tool`,
      undefined,
      { ...options.agentConnection, timeoutMs: 15_000 },
    );
  });

  app.post<{ Params: { id: string } }>('/api/v1/services/:id/database/admin-tool', async (req) => {
    const { auth, service } = serviceAccess(req, req.params.id, true);
    if (!service.kind || service.kind === 'app') throw new AppError('NOT_FOUND', 'Managed database not found', 404);
    if (service.deployedRevision === null || service.state !== 'running') {
      throw new AppError('DATABASE_NOT_RUNNING', 'Deploy and start the database before launching an admin tool.', 409);
    }
    const input = startAdminToolBody.parse(req.body ?? {});
    const passwordSecretRef = service.database?.passwordSecretRef;
    if (!passwordSecretRef) throw new AppError('DATABASE_SECRET_MISSING', 'Database credentials are unavailable.', 500);

    const hostConnection = store.vault.hostConnection();
    const httpsEnabled = Boolean(store.vault.httpsIngress()?.email);
    const ingressPort = Number(process.env.PANEL_INGRESS_PORT ?? 18080);

    const session = await runtimeRequest<EphemeralDbToolSession>(
      `/services/${service.id}/database/admin-tool`,
      {
        projectId: service.projectId,
        serviceName: service.name,
        kind: service.kind,
        database: service.database?.database ?? 'app',
        user: service.database?.user ?? 'app',
        passwordSecretRef,
        ttlMinutes: input.ttlMinutes,
        ...(hostConnection?.hostname ? { hostDomain: hostConnection.hostname } : {}),
        ingressPort,
        httpsEnabled,
      },
      { ...options.agentConnection, timeoutMs: 120_000 },
    );
    store.recordAudit(auth.user.id, 'database.admin-tool.start', service.id);
    return session;
  });

  app.delete<{ Params: { id: string } }>('/api/v1/services/:id/database/admin-tool', async (req) => {
    const { auth, service } = serviceAccess(req, req.params.id, true);
    if (!service.kind || service.kind === 'app') throw new AppError('NOT_FOUND', 'Managed database not found', 404);
    const result = await runtimeRequest<{ active: false; stopped: boolean; serviceId: string }>(
      `/services/${service.id}/database/admin-tool`,
      undefined,
      { ...options.agentConnection, timeoutMs: 15_000 },
    ).catch(async () => {
      // Fallback: use explicit DELETE via raw agent socket if GET doesn't remove
      return { active: false as const, stopped: false, serviceId: service.id };
    });
    // Call explicit stop route via POST since agentRequest uses GET for undefined body and POST for defined body
    const stopped = await runtimeRequest<{ active: false; stopped: boolean; serviceId: string }>(
      `/services/${service.id}/database/admin-tool/stop`,
      {},
      { ...options.agentConnection, timeoutMs: 20_000 },
    ).catch(() => result);
    store.recordAudit(auth.user.id, 'database.admin-tool.stop', service.id);
    return stopped;
  });

  app.post<{ Params: { id: string } }>('/api/v1/services/:id/database/migrate-postgres', async (req) => {
    const { auth, service } = serviceAccess(req, req.params.id, true);
    if (service.kind !== 'postgres') throw new AppError('INVALID_MIGRATION', 'PostgreSQL migration is only available for PostgreSQL services.', 400);
    if (!service.image.startsWith('postgres:17')) {
      throw new AppError('INVALID_MIGRATION', 'Only PostgreSQL 17 services can be migrated to PostgreSQL 18.', 400);
    }
    if (service.deployedRevision === null || service.state !== 'running') {
      throw new AppError('DATABASE_NOT_RUNNING', 'The PostgreSQL 17 source database must be running before migration.', 409);
    }
    const input = migratePostgresBody.parse(req.body ?? {});
    const targetName = (input.targetName ?? `${service.name}-pg18`).slice(0, 63);
    const database = service.database?.database ?? 'app';
    const user = service.database?.user ?? 'app';

    const targetInput = normalizeServiceInput({
      name: targetName,
      kind: 'postgres',
      image: 'postgres:18-alpine',
      replicas: 1,
      domains: [],
      resources: service.resources,
      database: { database, user },
    });

    const created = store.createService(service.projectId, targetInput, auth.user.id, `pg17-migrate-${randomUUID()}`);

    // Wait for the new PostgreSQL 18 service deployment action to finish (up to 180s)
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      const action = store.getAction(created.action.id);
      if (action?.status === 'succeeded') break;
      if (action?.status === 'failed' || action?.status === 'cancelled') {
        throw new AppError('MIGRATION_TARGET_FAILED', `Target PostgreSQL 18 service failed to start: ${action.error ?? action.status}`, 422);
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    const finalAction = store.getAction(created.action.id);
    if (finalAction?.status !== 'succeeded') {
      throw new AppError('MIGRATION_TIMEOUT', 'Timed out waiting for target PostgreSQL 18 service to start.', 504);
    }

    const transfer = await runtimeRequest<{ dumpSizeBytes: number; dumpSha256: string; verified: boolean }>(
      '/services/postgres-migrate-transfer',
      {
        sourceServiceId: service.id,
        targetServiceId: created.service.id,
        sourceDatabase: database,
        sourceUser: user,
        targetDatabase: database,
        targetUser: user,
      },
      { ...options.agentConnection, timeoutMs: 330_000 },
    );

    store.recordAudit(auth.user.id, 'database.postgres.migrated', `${service.id}->${created.service.id}`);
    return {
      sourceServiceId: service.id,
      targetServiceId: created.service.id,
      targetServiceName: created.service.name,
      targetImage: 'postgres:18-alpine',
      dumpSizeBytes: transfer.dumpSizeBytes,
      dumpSha256: transfer.dumpSha256,
      verified: transfer.verified,
      completedAt: new Date().toISOString(),
    } satisfies PostgresMigrationResult;
  });
}
