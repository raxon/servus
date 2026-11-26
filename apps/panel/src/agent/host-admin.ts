import { spawn } from 'node:child_process';
import type { FastifyInstance } from 'fastify';
import type Docker from 'dockerode';
import { z } from 'zod';
import type { DockerDiskUsage, DockerPruneRequest, DockerPruneResult, HostExecResult } from '../shared/host-admin.js';
import type { SecretVault } from '../shared/secrets.js';
import type { AgentMaintenanceGate } from './maintenance.js';

const pruneSchema = z.object({
  danglingImages: z.boolean().optional(),
  unusedImages: z.boolean().optional(),
  buildCache: z.boolean().optional(),
  stoppedContainers: z.boolean().optional(),
}).strict().refine(
  (v) => Boolean(v.danglingImages || v.unusedImages || v.buildCache || v.stoppedContainers),
  'Select at least one Docker resource category to prune',
);

const hostExecSchema = z.object({
  command: z.string().trim().min(1).max(2000).refine((v) => !v.includes('\0'), 'Invalid command'),
  timeoutSeconds: z.number().int().min(1).max(30).default(15),
}).strict();

const consoleInputSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('input'), data: z.string().max(32768) }).strict(),
  z.object({ type: z.literal('resize'), cols: z.number().int().min(1).max(500), rows: z.number().int().min(1).max(300) }).strict(),
]);

export async function collectDockerDiskUsage(docker: Docker): Promise<DockerDiskUsage> {
  const df = (await docker.df()) as {
    Images?: Array<{ Id?: string; RepoTags?: string[] | null; Size?: number; Containers?: number; Created?: number }>;
    Containers?: Array<{ State?: string; SizeRw?: number }>;
    Volumes?: Array<{ UsageData?: { Size?: number; RefCount?: number } }>;
    BuildCache?: Array<{ Size?: number; InUse?: boolean }>;
  };

  const rawImages = df.Images ?? [];
  let imagesTotal = 0;
  let imagesReclaimable = 0;
  const items = rawImages
    .map((img) => {
      const sizeBytes = Math.max(0, Number(img.Size ?? 0));
      const inUse = Number(img.Containers ?? 0) > 0;
      imagesTotal += sizeBytes;
      if (!inUse) imagesReclaimable += sizeBytes;
      const createdSec = Number(img.Created ?? 0);
      return {
        id: String(img.Id ?? '').replace(/^sha256:/, '').slice(0, 12),
        tags: (img.RepoTags ?? []).filter((t) => t && t !== '<none>:<none>'),
        sizeBytes,
        inUse,
        createdAt: createdSec > 0 ? new Date(createdSec * 1000).toISOString() : new Date().toISOString(),
      };
    })
    .sort((a, b) => b.sizeBytes - a.sizeBytes)
    .slice(0, 25);

  const rawContainers = df.Containers ?? [];
  let runningCount = 0;
  let stoppedCount = 0;
  let containersTotal = 0;
  let containersReclaimable = 0;
  for (const c of rawContainers) {
    const size = Math.max(0, Number(c.SizeRw ?? 0));
    containersTotal += size;
    if (c.State === 'running') runningCount++;
    else {
      stoppedCount++;
      containersReclaimable += size;
    }
  }

  const rawVolumes = df.Volumes ?? [];
  let activeVolumes = 0;
  let volumesTotal = 0;
  for (const v of rawVolumes) {
    const size = Math.max(0, Number(v.UsageData?.Size ?? 0));
    volumesTotal += size;
    if (Number(v.UsageData?.RefCount ?? 0) > 0) activeVolumes++;
  }

  const rawCache = df.BuildCache ?? [];
  let cacheTotal = 0;
  let cacheReclaimable = 0;
  for (const b of rawCache) {
    const size = Math.max(0, Number(b.Size ?? 0));
    cacheTotal += size;
    if (!b.InUse) cacheReclaimable += size;
  }

  return {
    sampledAt: new Date().toISOString(),
    images: { count: rawImages.length, totalSizeBytes: imagesTotal, reclaimableBytes: imagesReclaimable, items },
    containers: { count: rawContainers.length, runningCount, stoppedCount, totalSizeBytes: containersTotal, reclaimableBytes: containersReclaimable },
    volumes: { count: rawVolumes.length, activeCount: activeVolumes, totalSizeBytes: volumesTotal },
    buildCache: { count: rawCache.length, totalSizeBytes: cacheTotal, reclaimableBytes: cacheReclaimable },
    totalBytes: imagesTotal + containersTotal + volumesTotal + cacheTotal,
    totalReclaimableBytes: imagesReclaimable + containersReclaimable + cacheReclaimable,
  };
}

export async function pruneDockerResources(docker: Docker, options: DockerPruneRequest): Promise<DockerPruneResult> {
  let imagesDeleted = 0;
  let containersDeleted = 0;
  let buildCacheReclaimedBytes = 0;
  let totalReclaimedBytes = 0;

  if (options.stoppedContainers) {
    const res = (await docker.pruneContainers()) as { ContainersDeleted?: string[] | null; SpaceReclaimed?: number };
    containersDeleted += res.ContainersDeleted?.length ?? 0;
    totalReclaimedBytes += Math.max(0, Number(res.SpaceReclaimed ?? 0));
  }

  if (options.unusedImages || options.danglingImages) {
    // dangling=false prunes all unused images; dangling=true prunes only untagged dangling layers
    const filters = options.unusedImages ? { dangling: ['false'] } : { dangling: ['true'] };
    const res = (await docker.pruneImages({ filters })) as { ImagesDeleted?: Array<{ Deleted?: string; Untagged?: string }> | null; SpaceReclaimed?: number };
    imagesDeleted += res.ImagesDeleted?.length ?? 0;
    totalReclaimedBytes += Math.max(0, Number(res.SpaceReclaimed ?? 0));
  }

  if (options.buildCache) {
    const res = (await docker.pruneBuilder()) as { SpaceReclaimed?: number };
    const reclaimed = Math.max(0, Number(res.SpaceReclaimed ?? 0));
    buildCacheReclaimedBytes += reclaimed;
    totalReclaimedBytes += reclaimed;
  }

  return {
    imagesDeleted,
    containersDeleted,
    buildCacheReclaimedBytes,
    totalReclaimedBytes,
    completedAt: new Date().toISOString(),
  };
}

export async function execHostCommand(command: string, timeoutSeconds: number, dockerSocket: string, vault: SecretVault): Promise<HostExecResult> {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', command], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        HOME: '/tmp',
        TERM: 'xterm-256color',
        DOCKER_HOST: `unix://${dockerSocket}`,
      },
      detached: process.platform !== 'win32',
    });

    const maxBytes = 128 * 1024;
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    let timedOut = false;

    const collect = (chunk: Buffer) => {
      if (size >= maxBytes) {
        truncated = true;
        return;
      }
      const remaining = maxBytes - size;
      if (chunk.length > remaining) {
        chunks.push(chunk.subarray(0, remaining));
        size = maxBytes;
        truncated = true;
      } else {
        chunks.push(chunk);
        size += chunk.length;
      }
    };

    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    const killTree = () => {
      try {
        if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch { /* process already exited */ }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, timeoutSeconds * 1000);
    timer.unref();

    child.once('error', (error) => {
      clearTimeout(timer);
      resolve({
        exitCode: 1,
        output: vault.redact(error.message),
        truncated: false,
        durationMs: Date.now() - startedAt,
      });
    });

    child.once('close', (code) => {
      clearTimeout(timer);
      const raw = Buffer.concat(chunks).toString('utf8');
      const output = timedOut ? `${raw}\n[Timed out after ${timeoutSeconds}s]`.trim() : raw;
      resolve({
        exitCode: timedOut ? 124 : (code ?? 1),
        output: vault.redact(output),
        truncated,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

export function registerHostAdminAgent(
  app: FastifyInstance,
  options: {
    getDocker: () => Docker | undefined;
    dockerSocket: string;
    vault: SecretVault;
    maintenance?: AgentMaintenanceGate;
  },
) {
  app.get('/host/docker/usage', async (_req, reply) => {
    const docker = options.getDocker();
    if (!docker) return reply.code(503).send({ error: { code: 'RUNTIME_UNAVAILABLE', message: 'Docker runtime is unavailable.' } });
    return collectDockerDiskUsage(docker);
  });

  app.post('/host/docker/prune', async (req, reply) => {
    const parsed = pruneSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: { code: 'INVALID_PRUNE', message: 'Select at least one Docker resource category to prune.' } });
    const docker = options.getDocker();
    if (!docker) return reply.code(503).send({ error: { code: 'RUNTIME_UNAVAILABLE', message: 'Docker runtime is unavailable.' } });
    const release = options.maintenance?.admit();
    if (options.maintenance && !release) return reply.code(503).send({ error: { code: 'MAINTENANCE', message: 'Agent is draining.' } });
    try {
      return await pruneDockerResources(docker, parsed.data);
    } finally {
      release?.();
    }
  });

  app.post('/host/console/exec', async (req, reply) => {
    const parsed = hostExecSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: { code: 'INVALID_EXEC', message: 'Invalid host command.' } });
    const release = options.maintenance?.admit();
    if (options.maintenance && !release) return reply.code(503).send({ error: { code: 'MAINTENANCE', message: 'Agent is draining.' } });
    try {
      return await execHostCommand(parsed.data.command, parsed.data.timeoutSeconds, options.dockerSocket, options.vault);
    } finally {
      release?.();
    }
  });

  app.get('/host/console', { websocket: true }, (socket, req) => {
    const release = options.maintenance?.admit();
    if (options.maintenance && !release) {
      socket.close(1012, 'Agent is draining');
      return;
    }
    const query = new URL(req.url ?? '/host/console', 'http://localhost').searchParams;
    const shell = query.get('shell') === '/bin/bash' ? '/bin/bash' : '/bin/sh';
    const child = spawn(shell, ['-i'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        HOME: '/tmp',
        TERM: 'xterm-256color',
        PS1: 'servus-host# ',
        DOCKER_HOST: `unix://${options.dockerSocket}`,
      },
      detached: process.platform !== 'win32',
    });
    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      try {
        if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch { /* exited */ }
      release?.();
      if (socket.readyState === 1) socket.close(1000, 'Host console ended');
    };
    const sendChunk = (chunk: Buffer) => {
      if (closed || socket.readyState !== 1) return;
      const text = options.vault.redact(chunk.toString('utf8'));
      socket.send(JSON.stringify({ type: 'output', data: text }));
    };
    child.stdout.on('data', sendChunk);
    child.stderr.on('data', sendChunk);
    child.once('error', cleanup);
    child.once('close', cleanup);
    socket.on('close', cleanup);
    socket.on('error', cleanup);
    socket.on('message', (raw, isBinary) => {
      if (closed || isBinary) return;
      try {
        const parsed = consoleInputSchema.safeParse(JSON.parse(raw.toString('utf8')));
        if (!parsed.success) return;
        if (parsed.data.type === 'input') child.stdin.write(parsed.data.data);
      } catch { /* ignore malformed frame */ }
    });
  });
}
