import type Docker from 'dockerode';
import { PassThrough } from 'node:stream';
import type { ContainerInfo, ServiceMetrics } from '../shared/types.js';
import { decodeDockerLogs } from './configuration.js';

export async function ownedContainer(docker: Docker, serviceId: string, containerId: string) {
  const container = await docker.getContainer(containerId).inspect();
  const labels = container.Config.Labels || {};
  if (labels['panel.owner'] !== 'self-hosted-panel' || labels['panel.service'] !== serviceId || labels['com.docker.swarm.service.name'] !== `panel-app-${serviceId}`) throw new Error('The container does not belong to this service.');
  return container;
}
export async function serviceContainers(docker: Docker, serviceId: string): Promise<ContainerInfo[]> {
  const containers = await docker.listContainers({ all: true, filters: { label: ['panel.owner=self-hosted-panel', `panel.service=${serviceId}`, `com.docker.swarm.service.name=panel-app-${serviceId}`] } });
  return containers.map(container => ({ id: container.Id, name: (container.Names[0] || container.Id).replace(/^\//, ''), state: container.State }));
}
export async function serviceMetrics(docker: Docker, serviceId: string): Promise<ServiceMetrics> {
  const containers = (await serviceContainers(docker, serviceId)).filter(container => container.state === 'running');
  const total: ServiceMetrics = { cpuPercent: 0, memoryBytes: 0, memoryLimitBytes: 0, networkRxBytes: 0, networkTxBytes: 0, containers: containers.length };
  for (const container of containers) {
    const stats = await docker.getContainer(container.id).stats({ stream: false });
    const cpuDelta = (stats.cpu_stats.cpu_usage?.total_usage || 0) - (stats.precpu_stats?.cpu_usage?.total_usage || 0);
    const previousSystem = stats.precpu_stats?.system_cpu_usage || 0;
    const systemDelta = (stats.cpu_stats.system_cpu_usage || 0) - previousSystem;
    const cpus = stats.cpu_stats.online_cpus || stats.cpu_stats.cpu_usage.percpu_usage?.length || 1;
    total.cpuPercent += previousSystem > 0 && systemDelta > 0 && cpuDelta >= 0 ? cpuDelta / systemDelta * cpus * 100 : 0;
    const cache = (stats.memory_stats.stats as Record<string, number> | undefined)?.inactive_file || 0;
    total.memoryBytes += Math.max(0, (stats.memory_stats.usage || 0) - cache);
    total.memoryLimitBytes += stats.memory_stats.limit || 0;
    for (const network of Object.values(stats.networks || {})) { total.networkRxBytes += network.rx_bytes; total.networkTxBytes += network.tx_bytes; }
  }
  return total;
}
export async function outputBuffer(value: unknown, maxBytes = 2 * 1024 * 1024): Promise<Buffer> {
  if (Buffer.isBuffer(value)) return value.subarray(-maxBytes);
  if (typeof value === 'string') return Buffer.from(value).subarray(-maxBytes);
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const item of value as AsyncIterable<Buffer>) { const chunk = Buffer.from(item); bytes += chunk.length; if (bytes > maxBytes) throw new Error('Container output exceeds the supported size.'); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
export async function execOutput(docker: Docker, id: string, command: string[]): Promise<{ code: number | null; output: string }> {
  const exec = await docker.getContainer(id).exec({ Cmd: command, AttachStderr: true, AttachStdout: true });
  const stream = await exec.start({ Detach: false });
  const timer = setTimeout(() => stream.destroy(new Error('Container command timed out.')), 10000);
  try {
    const output = decodeDockerLogs(await outputBuffer(stream, 65536));
    const inspected = await exec.inspect();
    return { code: inspected.ExitCode, output };
  } finally { clearTimeout(timer); }
}

export async function ingressStatus(docker: Docker, id: string, hostname: string): Promise<number> {
  const exec = await docker.getContainer(id).exec({ Cmd: ['nc', '-w', '4', '127.0.0.1', '8080'], AttachStdin: true, AttachStdout: true, AttachStderr: true });
  const stream = await exec.start({ hijack: true, stdin: true });
  const stdout = new PassThrough(), stderr = new PassThrough();
  try {
    return await new Promise<number>((resolvePromise, reject) => {
      let headers = '';
      const timer = setTimeout(() => reject(new Error('Ingress HTTP response timed out.')), 5000);
      const cleanup = () => clearTimeout(timer);
      stdout.on('data', chunk => {
        headers += chunk.toString();
        const status = headers.match(/^HTTP\/1\.[01] (\d{3}) /)?.[1];
        if (status) { cleanup(); resolvePromise(Number(status)); }
        else if (headers.length > 8192) { cleanup(); reject(new Error('Invalid ingress HTTP response.')); }
      });
      stderr.resume();
      stream.on('error', error => { cleanup(); reject(error); });
      stream.on('end', () => { cleanup(); reject(new Error('Ingress closed before sending an HTTP status.')); });
      docker.modem.demuxStream(stream, stdout, stderr);
      stream.write(`GET / HTTP/1.1\r\nHost: ${hostname}\r\nConnection: close\r\n\r\n`);
    });
  } finally { stream.end(); stream.destroy(); stdout.destroy(); stderr.destroy(); }
}
