import type Docker from 'dockerode';
import { existsSync, readFileSync } from 'node:fs';
import { databaseAccessSchema, databaseTargetPort, databasePortAllowed } from '../shared/database-access.js';
import type { Service } from '../shared/types.js';
import { hostTcpPortAvailable, hostTcpPortSuggestion, localAgentImage, tcpPortListening } from './host-port-probe.js';

export function databaseEndpoint(service: Service): Docker.EndpointSpec {
  const access = databaseAccessSchema.parse(service.databaseAccess ?? {enabled: false});
  if(access.enabled && !databasePortAllowed(access.publishedPort,Number(process.env.PANEL_PORT??4180)))throw new Error('This TCP port is reserved for the panel API.');
  if (access.enabled) return {Mode: 'vip', Ports: [{Protocol: 'tcp', PublishedPort: access.publishedPort, TargetPort: databaseTargetPort(service.kind), PublishMode: 'host'}]};
  return {Mode: 'vip', Ports: []};
}

export async function databaseHostPortAvailable(docker: Docker, port: number): Promise<boolean> {
  if (process.platform === 'linux' && !existsSync('/.dockerenv')) {
    const tcp = readFileSync('/proc/net/tcp', 'utf8');
    const tcp6 = existsSync('/proc/net/tcp6') ? readFileSync('/proc/net/tcp6', 'utf8') : '';
    return !tcpPortListening(tcp, port) && (!tcp6 || !tcpPortListening(tcp6, port));
  }
  return hostTcpPortAvailable(docker, await localAgentImage(docker), port);
}

export async function assertDatabaseAccessNode(docker: Docker, previous?: Docker.ServiceSpec): Promise<void> {
  if (!previous) return; // New databases receive the local manager's node constraint.
  const swarm = (await docker.info()).Swarm, node = swarm?.NodeID;
  if (node && previous.TaskTemplate?.Placement?.Constraints?.includes(`node.id==${node}`)) return;
  if (node && swarm?.Nodes === 1) return;
  throw new Error('External database access requires placement on this panel server. The existing database placement was preserved.');
}

export async function assertDatabasePortFree(docker: Docker, service: Service, previous: Docker.ServiceSpec | undefined, ingressPort: number, probe = databaseHostPortAvailable): Promise<void> {
  const ports = databaseEndpoint(service).Ports ?? [], port = ports[0]?.PublishedPort;
  if (port === undefined) return;
  if (port === ingressPort) throw new Error('This TCP port is reserved for the HTTP ingress.');
  const targetName = `panel-app-${service.id}`;
  for (const item of await docker.listServices()) {
    if (item.Spec?.Name === targetName && item.Spec.Labels?.['panel.owner'] === 'self-hosted-panel' && item.Spec.Labels?.['panel.service'] === service.id) continue;
    if ([...(item.Spec?.EndpointSpec?.Ports ?? []), ...(item.Endpoint?.Ports ?? [])].some(binding => (binding.Protocol ?? 'tcp') === 'tcp' && binding.PublishedPort === port)) throw new Error('This TCP port is already published by another Swarm service.');
  }
  for (const container of await docker.listContainers()) {
    if (container.Labels?.['panel.owner'] === 'self-hosted-panel' && container.Labels['panel.service'] === service.id && container.Labels['com.docker.swarm.service.name'] === targetName) continue;
    if (container.Ports.some(binding => binding.Type === 'tcp' && binding.PublicPort === port)) throw new Error('This TCP port is already published by a container.');
  }
  const owned = previous?.Labels?.['panel.owner'] === 'self-hosted-panel' && previous.Labels['panel.service'] === service.id && previous.EndpointSpec?.Ports?.some(binding => (binding.Protocol ?? 'tcp') === 'tcp' && binding.PublishedPort === port && binding.TargetPort === databaseTargetPort(service.kind) && binding.PublishMode === 'host');
  if (!owned && !await probe(docker, port)) throw new Error('This TCP port is already used by a host process.');
}

export function databaseEndpointsMatch(expected: Docker.EndpointSpec | undefined, actual: Docker.EndpointSpec | undefined): boolean {
  const normalize = (endpoint: Docker.EndpointSpec | undefined) => JSON.stringify((endpoint?.Ports ?? []).map(port => ({protocol: port.Protocol ?? 'tcp', published: port.PublishedPort, target: port.TargetPort, mode: port.PublishMode ?? 'ingress'})).sort((a,b) => (a.published ?? 0) - (b.published ?? 0)));
  return normalize(expected) === normalize(actual);
}

/** Docker snapshots and host sockets are inspected once per bounded suggestion. */
export async function suggestDatabasePort(docker: Docker, candidates: readonly number[], ingressPort: number, probe = databaseHostPortSuggestion): Promise<number | null> {
  const [services, containers] = await Promise.all([docker.listServices(), docker.listContainers()]);
  const occupied = new Set<number>();
  for (const service of services) for (const port of [...(service.Spec?.EndpointSpec?.Ports ?? []), ...(service.Endpoint?.Ports ?? [])]) {
    if ((port.Protocol ?? 'tcp') === 'tcp' && port.PublishedPort !== undefined) occupied.add(port.PublishedPort);
  }
  for (const container of containers) for (const port of container.Ports) if (port.Type === 'tcp' && port.PublicPort !== undefined) occupied.add(port.PublicPort);
  const available = candidates.filter(port => databasePortAllowed(port, Number(process.env.PANEL_PORT ?? 4180)) && port !== ingressPort && !occupied.has(port));
  return available.length ? probe(docker, available) : null;
}

export async function databaseHostPortSuggestion(docker: Docker, ports: readonly number[]): Promise<number | null> {
  if (process.platform === 'linux' && !existsSync('/.dockerenv')) {
    const tcp = readFileSync('/proc/net/tcp', 'utf8');
    const tcp6 = existsSync('/proc/net/tcp6') ? readFileSync('/proc/net/tcp6', 'utf8') : '';
    return ports.find(port => !tcpPortListening(tcp, port) && (!tcp6 || !tcpPortListening(tcp6, port))) ?? null;
  }
  return hostTcpPortSuggestion(docker, await localAgentImage(docker), ports);
}
