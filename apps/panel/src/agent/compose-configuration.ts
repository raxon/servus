import { parseDocument } from 'yaml';
import { z } from 'zod';
import { composeName, type ComposeConfiguration } from '../shared/compose.js';
import { httpsRouteLabels, httpsRedirectLabels } from './https-routing.js';

const target = z.string().min(2).max(255).refine(value => value.startsWith('/') && !/[\\\x00-\x1f]/.test(value) && !value.split('/').includes('..') && !['/proc','/sys','/dev','/run','/var/run'].some(path => value === path || value.startsWith(path + '/')));
const mount = z.union([z.string().max(512), z.object({ type: z.literal('volume'), source: composeName, target, read_only: z.boolean().optional() }).strict()]);
const environment = z.union([z.array(z.string().max(32768).regex(/^[A-Za-z_][A-Za-z0-9_]*=/)).max(100), z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.union([z.string().max(32768), z.number(), z.boolean()]))]);
const healthcheck = z.object({ test: z.union([z.string().max(4096), z.array(z.string().max(4096)).max(30)]), interval: z.string().regex(/^\d+(ms|s|m|h)$/).optional(), timeout: z.string().regex(/^\d+(ms|s|m|h)$/).optional(), start_period: z.string().regex(/^\d+(ms|s|m|h)$/).optional(), retries: z.number().int().min(1).max(100).optional() }).strict();
const buildPath=z.string().min(1).max(255).regex(/^[A-Za-z0-9_.\/-]+$/).refine(value=>!value.startsWith('/'),'Build paths must be relative to the pinned checkout');
const additionalContextValue = z.string().min(1).max(300).refine(
  value => value.startsWith('docker-image://') ? /^docker-image:\/\/[a-zA-Z0-9][a-zA-Z0-9._/:@-]+$/.test(value) : buildPath.safeParse(value).success,
  'Additional build contexts must be a relative path inside the checkout or a docker-image:// reference',
);
const secretIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/);
const RESERVED_COMPOSE_PORTS = new Set([22, 80, 443, 2375, 2376, 2377, 4789, 7946, 4180, 18080]);
function parseControlledComposePort(entry: string | { target: number; published: number; protocol?: 'tcp' | 'udp' }): { published: number; target: number; protocol: 'tcp' | 'udp' } | null {
  if (typeof entry === 'string') {
    const match = /^(\d{1,5}):(\d{1,5})(?:\/(tcp|udp))?$/.exec(entry.trim());
    if (!match) return null;
    const published = Number(match[1]);
    const targetPort = Number(match[2]);
    const protocol = (match[3] as 'tcp' | 'udp' | undefined) ?? 'tcp';
    if (published < 1024 || published > 65535 || targetPort < 1 || targetPort > 65535 || RESERVED_COMPOSE_PORTS.has(published)) return null;
    return { published, target: targetPort, protocol };
  }
  const { published, target: targetPort, protocol = 'tcp' } = entry;
  if (!Number.isInteger(published) || published < 1024 || published > 65535 || !Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535 || RESERVED_COMPOSE_PORTS.has(published)) return null;
  return { published, target: targetPort, protocol };
}
const controlledPortEntry = z.union([
  z.string().max(32),
  z.object({ target: z.number().int().min(1).max(65535), published: z.number().int().min(1024).max(65535), protocol: z.enum(['tcp', 'udp']).optional() }).strict(),
]).refine(value => parseControlledComposePort(value) !== null, 'Published Compose ports must use an unprivileged host port (1024-65535) outside reserved panel and Swarm ports');
const buildOptions=z.object({context:buildPath.default('.'),dockerfile:buildPath.optional(),dockerfile_inline:z.string().min(1).max(65536).optional(),args:z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(128),z.union([z.string().max(4096),z.number().finite(),z.boolean()])).optional(),target:z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/).optional(),additional_contexts:z.record(secretIdSchema,additionalContextValue).optional(),secrets:z.array(secretIdSchema).max(20).optional(),ssh:z.array(z.enum(['default'])).max(1).optional()}).strict().refine(value=>!(value.dockerfile&&value.dockerfile_inline),'Use dockerfile or dockerfile_inline, not both').refine(value=>Buffer.byteLength(JSON.stringify(value.args??{}))<=16384,'Build arguments exceed 16 KiB');
const build=z.union([buildPath,buildOptions]);
const service = z.object({ image: z.string().min(1).max(300).regex(/^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/).optional(), build:build.optional(), command: z.union([z.string().max(8192), z.array(z.string().max(8192)).max(100)]).optional(), entrypoint: z.union([z.string().max(8192), z.array(z.string().max(8192)).max(100)]).optional(), environment: environment.optional(), volumes: z.array(mount).max(20).optional(), networks: z.array(composeName).max(20).optional(), restart: z.enum(['no','always','on-failure','unless-stopped']).optional(), depends_on: z.array(composeName).max(20).optional(), healthcheck: healthcheck.optional(), expose: z.array(z.union([z.number().int().min(1).max(65535), z.string().regex(/^\d{1,5}(?:\/(?:tcp|udp))?$/)])).max(20).optional(), ports: z.array(controlledPortEntry).max(10).optional(), user: z.string().max(128).regex(/^[A-Za-z0-9_.:-]+$/).optional(), working_dir: target.optional(), cpus: z.number().positive().max(64).optional(), mem_limit: z.string().regex(/^[1-9]\d{0,5}[kKmMgG]$/).optional(), init: z.boolean().optional(), read_only: z.boolean().optional() }).strict().refine(value=>Boolean(value.image||value.build),'A service requires image or build');
const definition = z.object({ version: z.string().optional(), services: z.record(composeName, service).refine(value => Object.keys(value).length > 0 && Object.keys(value).length <= 20), volumes: z.record(composeName, z.object({}).strict().nullable()).optional(), networks: z.record(composeName, z.object({ internal: z.boolean().optional() }).strict().nullable()).optional() }).strict();
export type ComposeDefinition = z.infer<typeof definition>;

/** Parse before invoking Compose, which otherwise resolves local includes and env files. */
export function parseComposeDefinition(yaml: string, sourceType: 'inline' | 'git' = 'inline', options: { allowSsh?: boolean } = {}): ComposeDefinition {
  if (Buffer.byteLength(yaml) > 256 * 1024) throw new Error('Compose source exceeds 256 KiB.');
  const document = parseDocument(yaml, { strict: true, uniqueKeys: true, merge: false, prettyErrors: false });
  if (document.errors.length || document.warnings.length) throw new Error('Invalid Compose YAML.');
  let value: unknown;
  try { value = document.toJS({ maxAliasCount: 0 }); } catch { throw new Error('Compose aliases are unsupported.'); }
  const result = definition.safeParse(value);
  if (!result.success) throw new Error('Unsupported Compose configuration. Use images or bounded Dockerfile builds, named volumes, private networks and explicit values. Host mounts, privileged ports, includes, external resources and privileged settings are unsupported.');
  const config = result.data;
  for (const item of Object.values(config.services)) {
    if (item.build && typeof item.build !== 'string' && item.build.ssh?.length && !options.allowSsh) {
      throw new Error('Compose build SSH forwarding requires sshForwarding to be explicitly enabled.');
    }
    if(sourceType==='inline'&&item.build&&(typeof item.build==='string'||!item.build.dockerfile_inline||!['.','./'].includes(item.build.context)))throw new Error('Inline Compose builds require dockerfile_inline and an empty context (.). File-based build contexts require a Git source.');
    for (const entry of item.volumes ?? []) {
      const parts = typeof entry === 'string' ? entry.split(':') : undefined;
      const name = parts ? parts[0]! : (entry as { source: string }).source;
      const path = parts ? parts[1] : (entry as { target: string }).target;
      if (!composeName.safeParse(name).success || !target.safeParse(path).success || parts && (parts.length < 2 || parts.length > 3 || parts[2] !== undefined && !['ro','rw'].includes(parts[2]))) throw new Error('Only named volume mounts with safe container targets are supported.');
      if (!Object.hasOwn(config.volumes ?? {}, name)) throw new Error('Declare every named volume in the volumes section.');
    }
    for (const name of item.networks ?? []) if (!Object.hasOwn(config.networks ?? {}, name)) throw new Error('Declare every network in the networks section.');
    for (const dependency of item.depends_on ?? []) if (!Object.hasOwn(config.services, dependency)) throw new Error('Compose dependency does not exist.');
  }
  return config;
}

export interface ComposeCertificateRetryHint { requestedAt:string; explicitDomain:boolean }

export function composeHttpsLabels(workloadId:string,index:number,hostname:string,port:number,redirect=false):Record<string,string> {
  const base=`${workloadId.replaceAll('-','')}-${index}`;
  const labels={...httpsRouteLabels(workloadId,index,hostname,port),...(redirect?httpsRedirectLabels(workloadId,index,hostname,port):{})};
  return Object.fromEntries(Object.entries(labels).map(([key,value])=>[
    key.replace(`.${base}`,`.compose-${base}`),
    key.endsWith('.service')||key.endsWith('.middlewares')?`compose-${value}`:value,
  ]));
}

export function compileComposeDefinition(config: ComposeDefinition, configuration: ComposeConfiguration, workloadId: string, projectId: string, retries:Record<string,ComposeCertificateRetryHint>={},images:Record<string,string>={}) {
  const prefix = `servus-compose-${workloadId.replaceAll('-', '')}`;
  const labels = { 'panel.owner': 'self-hosted-panel', 'panel.compose': 'true', 'panel.workload': workloadId, 'panel.project': projectId };
  const compiled: any = structuredClone(config); delete compiled.version;
  compiled.volumes = Object.fromEntries(Object.keys(config.volumes ?? {}).map(name => [name, { name: `${prefix}_${name}`, labels }]));
  compiled.networks = Object.fromEntries(Object.entries(config.networks ?? { default: {} }).map(([name, item]) => [name, { ...item, name: `${prefix}_${name}`, labels }]));
  if (!compiled.networks.default) compiled.networks.default = { name: `${prefix}_default`, labels };
  for (const [name, item] of Object.entries(compiled.services) as [string, any][]) {
    if(item.build){if(!/^sha256:[a-f0-9]{64}$/.test(images[name]??''))throw new Error('The Compose build image has not been resolved.');item.image=images[name];delete item.build;}
    item.labels = { ...labels, 'traefik.enable': 'false' };
    item.networks ??= ['default']; item.restart ??= 'unless-stopped'; item.cpus ??= 1; item.mem_limit ??= '512m';
    item.logging = { driver: 'json-file', options: { 'max-size': '10m', 'max-file': '3' } };
    for (const [index, domain] of configuration.domains.entries()) {
      if (domain.service !== name) continue;
      const route = `compose-${workloadId.replaceAll('-', '')}-${index}`;
      Object.assign(item.labels, { 'traefik.enable': 'true', 'traefik.docker.network': 'panel-ingress', [`traefik.http.routers.${route}.rule`]: `Host(\`${domain.hostname}\`)`, [`traefik.http.routers.${route}.entrypoints`]: 'web', [`traefik.http.routers.${route}.service`]: route, [`traefik.http.services.${route}.loadbalancer.server.port`]: String(domain.port) });
      if (domain.https) {
        Object.assign(item.labels,composeHttpsLabels(workloadId,index,domain.hostname,domain.port,domain.redirectHttps));
        const retry=retries[domain.hostname];
        if(retry) {
          item.labels[`panel.compose-acme-retry-${index}`]=retry.requestedAt;
          if(retry.explicitDomain)item.labels[`traefik.http.routers.${route}-https.tls.domains[0].main`]=domain.hostname;
        }
      }
      if (!item.networks.includes('servus-ingress')) item.networks.push('servus-ingress');
    }
  }
  for (const domain of configuration.domains) if (!Object.hasOwn(config.services, domain.service)) throw new Error('The domain target is not a Compose service.');
  if (configuration.domains.length) compiled.networks['servus-ingress'] = { external: true, name: 'panel-ingress' };
  // Compose expands dollar signs even in JSON; preserve submitted values literally.
  const literal = (item: any): any => typeof item === 'string' ? item.replaceAll('$', () => '$$') : Array.isArray(item) ? item.map(literal) : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, literal(entry)])) : item;
  return { prefix, definition: literal(compiled) };
}
