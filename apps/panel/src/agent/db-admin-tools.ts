import { createHash, randomBytes } from 'node:crypto';
import type Docker from 'dockerode';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { EphemeralDbToolKind, EphemeralDbToolSession } from '../shared/db-admin.js';
import type { SecretVault } from '../shared/secrets.js';
import type { AgentMaintenanceGate } from './maintenance.js';

const OWNER = 'self-hosted-panel';
const INGRESS_NETWORK = 'panel-ingress';

const startToolSchema = z.object({
  projectId: z.string().uuid(),
  serviceName: z.string().min(1).max(63),
  kind: z.enum(['postgres', 'mariadb', 'mysql', 'mongodb', 'redis']),
  database: z.string().min(1).max(63),
  user: z.string().min(1).max(63),
  passwordSecretRef: z.string().uuid(),
  ttlMinutes: z.number().int().min(5).max(60).default(15),
  hostDomain: z.string().min(1).max(253).optional(),
  ingressPort: z.number().int().min(1).max(65535).default(18080),
  httpsEnabled: z.boolean().default(false),
}).strict();

function ephemeralServiceName(serviceId: string): string {
  return `panel-dbadmin-${serviceId}`;
}

function htpasswdSha1(username: string, password: string): string {
  return `${username}:{SHA}${createHash('sha1').update(password, 'utf8').digest('base64')}`;
}

function toolForKind(kind: 'postgres' | 'mariadb' | 'mysql' | 'mongodb' | 'redis'): { tool: EphemeralDbToolKind; image: string; port: number } {
  if (kind === 'mongodb') return { tool: 'mongo-express', image: 'mongo-express:1.0.2-20', port: 8081 };
  if (kind === 'redis') return { tool: 'redis-commander', image: 'rediscommander/redis-commander:latest', port: 8081 };
  return { tool: 'adminer', image: 'adminer:4-standalone', port: 8080 };
}

async function pullImageIfMissing(docker: Docker, image: string): Promise<void> {
  try {
    await docker.getImage(image).inspect();
    return;
  } catch { /* pull */ }
  const stream = await docker.pull(image);
  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(stream, (err) => (err ? reject(err) : resolve()));
  });
}

async function removeServiceIfExists(docker: Docker, name: string): Promise<boolean> {
  try {
    const svc = await docker.getService(name).inspect();
    if (svc.Spec.Labels?.['panel.owner'] !== OWNER || svc.Spec.Labels?.['panel.ephemeral'] !== 'db-admin') {
      return false;
    }
    await docker.getService(name).remove();
    return true;
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode === 404) return false;
    throw err;
  }
}

export async function sweepExpiredDbAdminTools(docker: Docker): Promise<number> {
  let removed = 0;
  try {
    const services = await docker.listServices({ filters: { label: ['panel.owner=self-hosted-panel', 'panel.ephemeral=db-admin'] } });
    const now = Date.now();
    for (const svc of services) {
      const expiresAt = svc.Spec?.Labels?.['panel.ephemeral.expiresAt'];
      const name = svc.Spec?.Name;
      if (!name || !expiresAt) continue;
      if (Date.parse(expiresAt) <= now) {
        await docker.getService(name).remove().catch(() => {});
        removed++;
      }
    }
  } catch { /* ignore transient docker errors during sweep */ }
  return removed;
}

export function registerDbAdminToolsAgent(
  app: FastifyInstance,
  options: {
    getDocker: () => Docker | undefined;
    vault: SecretVault;
    maintenance?: AgentMaintenanceGate;
  },
) {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const sweeper = setInterval(() => {
    const docker = options.getDocker();
    if (docker) void sweepExpiredDbAdminTools(docker);
  }, 30_000);
  sweeper.unref();

  app.addHook('onClose', async () => {
    clearInterval(sweeper);
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
  });

  app.get<{ Params: { id: string } }>('/services/:id/database/admin-tool', async (req, reply) => {
    if (!z.string().uuid().safeParse(req.params.id).success) return reply.code(400).send({ error: { code: 'INVALID_ID', message: 'Invalid service identity.' } });
    const docker = options.getDocker();
    if (!docker) return reply.code(503).send({ error: { code: 'RUNTIME_UNAVAILABLE', message: 'Docker runtime is unavailable.' } });
    const name = ephemeralServiceName(req.params.id);
    try {
      const svc = await docker.getService(name).inspect();
      const labels = svc.Spec.Labels ?? {};
      const expiresAt = labels['panel.ephemeral.expiresAt'];
      if (expiresAt && Date.parse(expiresAt) <= Date.now()) {
        await removeServiceIfExists(docker, name);
        return { active: false, serviceId: req.params.id } satisfies EphemeralDbToolSession;
      }
      return {
        active: true,
        serviceId: req.params.id,
        tool: labels['panel.ephemeral.tool'] as EphemeralDbToolKind,
        hostname: labels['panel.ephemeral.hostname'],
        url: labels['panel.ephemeral.url'],
        username: labels['panel.ephemeral.username'],
        startedAt: labels['panel.ephemeral.startedAt'],
        expiresAt,
        ttlMinutes: Number(labels['panel.ephemeral.ttlMinutes'] ?? 15),
      } satisfies EphemeralDbToolSession;
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode === 404) {
        return { active: false, serviceId: req.params.id } satisfies EphemeralDbToolSession;
      }
      throw err;
    }
  });

  app.post<{ Params: { id: string } }>('/services/:id/database/admin-tool', async (req, reply) => {
    if (!z.string().uuid().safeParse(req.params.id).success) return reply.code(400).send({ error: { code: 'INVALID_ID', message: 'Invalid service identity.' } });
    const parsed = startToolSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'INVALID_REQUEST', message: 'Invalid ephemeral database admin tool request.' } });
    const docker = options.getDocker();
    if (!docker) return reply.code(503).send({ error: { code: 'RUNTIME_UNAVAILABLE', message: 'Docker runtime is unavailable.' } });
    const release = options.maintenance?.admit();
    if (options.maintenance && !release) return reply.code(503).send({ error: { code: 'MAINTENANCE', message: 'Agent is draining.' } });

    try {
      const data = parsed.data;
      const name = ephemeralServiceName(req.params.id);
      await removeServiceIfExists(docker, name);

      const { tool, image, port } = toolForKind(data.kind);
      await pullImageIfMissing(docker, image);

      const dbPassword = options.vault.getServiceSecret(data.passwordSecretRef, req.params.id, 'database');
      const authUser = 'servus-admin';
      const authPass = randomBytes(18).toString('base64url');
      const shortId = req.params.id.replaceAll('-', '').slice(0, 10);
      const nonce = randomBytes(3).toString('hex');
      const hostname = data.hostDomain ? `dbadmin-${shortId}-${nonce}.${data.hostDomain}` : `dbadmin-${shortId}.localhost`;
      const useHttps = Boolean(data.hostDomain && data.httpsEnabled);
      const url = useHttps ? `https://${hostname}/` : `http://${hostname}${data.ingressPort === 80 ? '' : `:${data.ingressPort}`}/`;

      const startedAt = new Date().toISOString();
      const expiresAt = new Date(Date.now() + data.ttlMinutes * 60_000).toISOString();

      const env: string[] = [];
      if (tool === 'adminer') {
        env.push(`ADMINER_DEFAULT_SERVER=${data.serviceName}`);
      } else if (tool === 'mongo-express') {
        env.push(
          `ME_CONFIG_MONGODB_SERVER=${data.serviceName}`,
          'ME_CONFIG_MONGODB_PORT=27017',
          `ME_CONFIG_MONGODB_ADMINUSERNAME=${data.user}`,
          `ME_CONFIG_MONGODB_ADMINPASSWORD=${dbPassword}`,
          'ME_CONFIG_BASICAUTH=false',
        );
      } else if (tool === 'redis-commander') {
        env.push(`REDIS_HOSTS=local:${data.serviceName}:6379:0:${dbPassword}`);
      }

      const routeKey = `dbadmin-${req.params.id.replaceAll('-', '')}`;
      const authMiddleware = `${routeKey}-auth`;
      const labels: Record<string, string> = {
        'panel.owner': OWNER,
        'panel.ephemeral': 'db-admin',
        'panel.service': req.params.id,
        'panel.project': data.projectId,
        'panel.ephemeral.tool': tool,
        'panel.ephemeral.hostname': hostname,
        'panel.ephemeral.url': url,
        'panel.ephemeral.username': authUser,
        'panel.ephemeral.startedAt': startedAt,
        'panel.ephemeral.expiresAt': expiresAt,
        'panel.ephemeral.ttlMinutes': String(data.ttlMinutes),
        'traefik.enable': 'true',
        'traefik.docker.network': INGRESS_NETWORK,
        [`traefik.http.middlewares.${authMiddleware}.basicauth.users`]: htpasswdSha1(authUser, authPass),
        [`traefik.http.services.${routeKey}.loadbalancer.server.port`]: String(port),
        [`traefik.http.routers.${routeKey}.rule`]: `Host(\`${hostname}\`)`,
        [`traefik.http.routers.${routeKey}.entrypoints`]: useHttps ? 'websecure' : 'web',
        [`traefik.http.routers.${routeKey}.middlewares`]: authMiddleware,
        [`traefik.http.routers.${routeKey}.service`]: routeKey,
        ...(useHttps ? { [`traefik.http.routers.${routeKey}.tls`]: 'true' } : {}),
      };

      const projectNetwork = `panel-project-${data.projectId}`;
      await docker.createService({
        Name: name,
        Labels: labels,
        Mode: { Replicated: { Replicas: 1 } },
        TaskTemplate: {
          ContainerSpec: {
            Image: image,
            Env: env,
            Labels: { 'panel.owner': OWNER, 'panel.ephemeral': 'db-admin', 'panel.service': req.params.id },
          },
          Networks: [{ Target: projectNetwork }, { Target: INGRESS_NETWORK }],
          RestartPolicy: { Condition: 'on-failure', MaxAttempts: 2 },
          Resources: { Limits: { MemoryBytes: 256 * 1024 * 1024, NanoCPUs: 500_000_000 } },
        },
      } as never);

      const prevTimer = timers.get(req.params.id);
      if (prevTimer) clearTimeout(prevTimer);
      const timer = setTimeout(() => {
        timers.delete(req.params.id);
        void removeServiceIfExists(docker, name);
      }, data.ttlMinutes * 60_000);
      timer.unref();
      timers.set(req.params.id, timer);

      return {
        active: true,
        serviceId: req.params.id,
        tool,
        hostname,
        url,
        username: authUser,
        password: authPass,
        startedAt,
        expiresAt,
        ttlMinutes: data.ttlMinutes,
      } satisfies EphemeralDbToolSession;
    } finally {
      release?.();
    }
  });

  const handleStop = async (req: { params: { id: string } }, reply: import('fastify').FastifyReply) => {
    if (!z.string().uuid().safeParse(req.params.id).success) return reply.code(400).send({ error: { code: 'INVALID_ID', message: 'Invalid service identity.' } });
    const docker = options.getDocker();
    if (!docker) return reply.code(503).send({ error: { code: 'RUNTIME_UNAVAILABLE', message: 'Docker runtime is unavailable.' } });
    const prevTimer = timers.get(req.params.id);
    if (prevTimer) {
      clearTimeout(prevTimer);
      timers.delete(req.params.id);
    }
    const stopped = await removeServiceIfExists(docker, ephemeralServiceName(req.params.id));
    return { active: false, stopped, serviceId: req.params.id };
  };

  app.delete<{ Params: { id: string } }>('/services/:id/database/admin-tool', handleStop);
  app.post<{ Params: { id: string } }>('/services/:id/database/admin-tool/stop', handleStop);
}
