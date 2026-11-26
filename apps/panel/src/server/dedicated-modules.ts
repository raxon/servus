import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { BoxRuntimePreset, DedicatedBoxResult, DedicatedWordPressResult } from '../shared/platform-settings.js';
import type { User } from '../shared/types.js';
import { hostnameSchema, nameSchema, normalizeServiceInput } from './configuration.js';
import { withAutomaticHostDomain } from './host-domain.js';
import type { Store } from './store.js';
import { WorkspaceExtras } from './workspace-extras.js';

const wordpressModuleSchema = z.object({
  name: nameSchema.default('wordpress'),
  hostname: hostnameSchema.optional(),
  siteTitle: z.string().trim().max(120).optional(),
  phpMemoryLimit: z.enum(['128M', '256M', '512M']).default('256M'),
}).strict();

const boxModuleSchema = z.object({
  name: nameSchema.default('sandbox'),
  preset: z.enum(['node-22', 'python-3.12', 'alpine-tools', 'ubuntu-24']).default('node-22'),
  hostname: hostnameSchema.optional(),
  memoryMb: z.number().int().min(128).max(4096).default(512),
}).strict();

const BOX_PRESETS: Record<BoxRuntimePreset, { image: string; port: number; dockerfileContent: string }> = {
  'node-22': {
    image: 'node:22-alpine',
    port: 3000,
    dockerfileContent: [
      'FROM node:22-alpine',
      'RUN apk add --no-cache git curl bash',
      'WORKDIR /workspace',
      'RUN printf "const http=require(\'http\');http.createServer((q,s)=>{s.writeHead(200,{\'content-type\':\'text/plain\'});s.end(\'Servus Box (Node 22) ready. Open Console to work in /workspace.\\n\');}).listen(process.env.PORT||3000,\'0.0.0.0\');\\n" > /usr/local/bin/box-server.js',
      'EXPOSE 3000',
      'CMD ["node", "/usr/local/bin/box-server.js"]',
    ].join('\n') + '\n',
  },
  'python-3.12': {
    image: 'python:3.12-slim',
    port: 8000,
    dockerfileContent: [
      'FROM python:3.12-slim',
      'WORKDIR /workspace',
      'EXPOSE 8000',
      'CMD ["python3", "-m", "http.server", "8000", "--bind", "0.0.0.0"]',
    ].join('\n') + '\n',
  },
  'alpine-tools': {
    image: 'alpine:3.21',
    port: 8080,
    dockerfileContent: [
      'FROM nginx:alpine',
      'RUN apk add --no-cache curl jq git bash',
      'RUN echo "Servus Box (Alpine Tools) ready." > /usr/share/nginx/html/index.html',
      'WORKDIR /workspace',
      'EXPOSE 80',
    ].join('\n') + '\n',
  },
  'ubuntu-24': {
    image: 'ubuntu:24.04',
    port: 8080,
    dockerfileContent: [
      'FROM python:3.12-slim',
      'RUN apt-get update && apt-get install -y --no-install-recommends curl git && rm -rf /var/lib/apt/lists/*',
      'WORKDIR /workspace',
      'EXPOSE 8080',
      'CMD ["python3", "-m", "http.server", "8080", "--bind", "0.0.0.0"]',
    ].join('\n') + '\n',
  },
};

export function registerDedicatedModules(
  app: FastifyInstance,
  options: {
    store: Store;
    session: (req: FastifyRequest, mutation?: boolean) => { user: User; csrfToken: string };
    projectAccess: (user: User, id: string, write?: boolean) => void;
  },
) {
  const { store, session, projectAccess } = options;

  /** Dedicated managed WordPress module: independent managed MariaDB + WordPress app + operational scripts. */
  app.post<{ Params: { id: string } }>('/api/v1/projects/:id/modules/wordpress', async (req, reply) => {
    const { user } = session(req, true);
    projectAccess(user, req.params.id, true);
    const input = wordpressModuleSchema.parse(req.body ?? {});

    const dbName = `${input.name}-db`.slice(0, 63);
    const dbPassword = randomBytes(24).toString('base64url');
    const authSalt = () => randomBytes(32).toString('base64url');

    const dbInput = normalizeServiceInput({
      name: dbName,
      kind: 'mariadb',
      image: 'mariadb:11.4',
      replicas: 1,
      domains: [],
      resources: { cpu: 1, memoryMb: 512 },
      database: { database: 'wordpress', user: 'wordpress', password: dbPassword },
    });
    const dbCreated = store.createService(req.params.id, dbInput, user.id, `wp-db-${randomUUID()}`);

    const wpPayload: Record<string, unknown> = {
      name: input.name,
      kind: 'app',
      image: 'wordpress:6.8-php8.3-apache',
      port: 80,
      replicas: 1,
      resources: { cpu: 1, memoryMb: 512 },
      mounts: [{ type: 'volume', name: `${input.name}-files`.slice(0, 63), target: '/var/www/html', readOnly: false }],
      environment: [
        { name: 'WORDPRESS_DB_HOST', value: `${dbName}:3306`, secret: false },
        { name: 'WORDPRESS_DB_USER', value: 'wordpress', secret: false },
        { name: 'WORDPRESS_DB_NAME', value: 'wordpress', secret: false },
        { name: 'WORDPRESS_DB_PASSWORD', value: dbPassword, secret: true },
        { name: 'WORDPRESS_AUTH_KEY', value: authSalt(), secret: true },
        { name: 'WORDPRESS_SECURE_AUTH_KEY', value: authSalt(), secret: true },
        { name: 'WORDPRESS_LOGGED_IN_KEY', value: authSalt(), secret: true },
        { name: 'WORDPRESS_NONCE_KEY', value: authSalt(), secret: true },
        { name: 'WORDPRESS_CONFIG_EXTRA', value: `define('WP_MEMORY_LIMIT', '${input.phpMemoryLimit}');`, secret: false },
      ],
      notes: `Dedicated Servus WordPress module${input.siteTitle ? ` (${input.siteTitle})` : ''}. Database service: ${dbName}.`,
      ...(input.hostname ? { hostname: input.hostname } : store.vault.hostConnection()?.hostname ? {} : { hostname: `${input.name}.localhost` }),
    };

    const wpInput = normalizeServiceInput(withAutomaticHostDomain(store, req.params.id, wpPayload));
    const wpCreated = store.createService(req.params.id, wpInput, user.id, `wp-app-${randomUUID()}`);

    // Seed a helpful operational script for this WordPress service
    const extras = new WorkspaceExtras(store);
    try {
      extras.createScript(req.params.id, user.id, {
        name: `${input.name} health & version`,
        description: 'Inspect WordPress PHP version and wp-content directory size',
        command: 'php -v | head -n 1 && du -sh /var/www/html/wp-content',
        serviceId: wpCreated.service.id,
      });
    } catch { /* non-fatal if script already exists */ } finally {
      extras.close();
    }

    store.recordAudit(user.id, 'module.wordpress.create', wpCreated.service.id);
    return reply.code(202).send({
      databaseServiceId: dbCreated.service.id,
      databaseServiceName: dbCreated.service.name,
      appServiceId: wpCreated.service.id,
      appServiceName: wpCreated.service.name,
      hostname: wpCreated.service.hostname,
      actionIds: [dbCreated.action.id, wpCreated.action.id],
    } satisfies DedicatedWordPressResult);
  });

  /** Dedicated Box module: persistent interactive workspace sandbox with Console access and HTTP preview. */
  app.post<{ Params: { id: string } }>('/api/v1/projects/:id/modules/box', async (req, reply) => {
    const { user } = session(req, true);
    projectAccess(user, req.params.id, true);
    const input = boxModuleSchema.parse(req.body ?? {});
    const preset = BOX_PRESETS[input.preset];
    const port = input.preset === 'alpine-tools' ? 80 : preset.port;

    const payload: Record<string, unknown> = {
      name: input.name,
      kind: 'app',
      port,
      replicas: 1,
      resources: { cpu: 1, memoryMb: input.memoryMb },
      source: { type: 'dockerfile', dockerfileContent: preset.dockerfileContent },
      mounts: [{ type: 'volume', name: `${input.name}-workspace`.slice(0, 63), target: '/workspace', readOnly: false }],
      notes: `Servus Box (${input.preset}) persistent sandbox workspace mounted at /workspace.`,
      ...(input.hostname ? { hostname: input.hostname } : store.vault.hostConnection()?.hostname ? {} : { hostname: `${input.name}.localhost` }),
    };

    const normalized = normalizeServiceInput(withAutomaticHostDomain(store, req.params.id, payload));
    const created = store.createService(req.params.id, normalized, user.id, `box-${randomUUID()}`);

    store.recordAudit(user.id, 'module.box.create', created.service.id);
    return reply.code(202).send({
      serviceId: created.service.id,
      serviceName: created.service.name,
      preset: input.preset,
      hostname: created.service.hostname,
      actionId: created.action.id,
    } satisfies DedicatedBoxResult);
  });
}
