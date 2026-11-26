import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { exportDatabase } from './database-export.js';
import type { DockerRuntime } from './runtime.js';
import type { AgentMaintenanceGate } from './maintenance.js';

const transferSchema = z.object({
  sourceServiceId: z.string().uuid(),
  targetServiceId: z.string().uuid(),
  sourceDatabase: z.string().regex(/^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,62}$/),
  sourceUser: z.string().regex(/^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,62}$/),
  targetDatabase: z.string().regex(/^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,62}$/),
  targetUser: z.string().regex(/^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,62}$/),
}).strict();

export async function transferPostgresDump(options: {
  dockerSocket: string;
  sourceContainerId: string;
  targetContainerId: string;
  sourceDatabase: string;
  sourceUser: string;
  targetDatabase: string;
  targetUser: string;
}): Promise<{ dumpSizeBytes: number; dumpSha256: string; verified: boolean }> {
  const exported = await exportDatabase({
    containerId: options.sourceContainerId,
    dockerSocket: options.dockerSocket,
    kind: 'postgres',
    database: options.sourceDatabase,
    user: options.sourceUser,
  });

  try {
    const hash = createHash('sha256');
    const restoreScript = `set -eu; PGPASSWORD="$(cat /run/secrets/panel-db-password)"; export PGPASSWORD; exec timeout 300 pg_restore -h 127.0.0.1 -U "$1" -d "$2" --exit-on-error --single-transaction --no-owner --no-privileges`;
    const child = spawn(
      'docker',
      ['--host', `unix://${options.dockerSocket}`, 'exec', '-i', options.targetContainerId, 'sh', '-c', restoreScript, 'servus-pg-migrate', options.targetUser, options.targetDatabase],
      { stdio: ['pipe', 'ignore', 'pipe'], env: { ...process.env, PATH: `${process.env.PATH || '/usr/bin:/bin'}:/usr/local/bin` } },
    );

    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-4000); });
    const exit = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    const hasher = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        hash.update(chunk);
        cb(null, chunk);
      },
    });

    const [code] = await Promise.all([exit, pipeline(exported.stream(), hasher, child.stdin)]);
    if (code !== 0) {
      throw new Error(`pg_restore into PostgreSQL 18 target failed (exit ${code}): ${stderr.slice(-500)}`);
    }

    // Verify target database responds to authenticated SELECT 1 after restore
    const verifyScript = `set -eu; PGPASSWORD="$(cat /run/secrets/panel-db-password)"; export PGPASSWORD; exec psql -X -w -h 127.0.0.1 -U "$1" -d "$2" -tA -c "SELECT 1"`;
    const verify = spawn(
      'docker',
      ['--host', `unix://${options.dockerSocket}`, 'exec', options.targetContainerId, 'sh', '-c', verifyScript, 'servus-pg-verify', options.targetUser, options.targetDatabase],
      { stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, PATH: `${process.env.PATH || '/usr/bin:/bin'}:/usr/local/bin` } },
    );
    let out = '';
    verify.stdout.on('data', (chunk: Buffer) => { out += chunk.toString('utf8'); });
    const verifyCode = await new Promise<number | null>((resolve, reject) => {
      verify.once('error', reject);
      verify.once('close', resolve);
    });
    if (verifyCode !== 0 || !out.split('\n').some((line) => line.trim() === '1')) {
      throw new Error('Target PostgreSQL 18 verification query failed after migration.');
    }

    return {
      dumpSizeBytes: exported.size,
      dumpSha256: hash.digest('hex'),
      verified: true,
    };
  } finally {
    exported.close();
  }
}

export function registerPostgresMigrationAgent(
  app: FastifyInstance,
  options: {
    dockerSocket: string;
    consoleContainer?: DockerRuntime['consoleContainer'];
    maintenance?: AgentMaintenanceGate;
  },
) {
  app.post('/services/postgres-migrate-transfer', async (req, reply) => {
    const parsed = transferSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'INVALID_MIGRATION', message: 'Invalid PostgreSQL migration transfer request.' } });
    if (!options.consoleContainer) return reply.code(503).send({ error: { code: 'RUNTIME_UNAVAILABLE', message: 'PostgreSQL migration runtime is unavailable.' } });
    const release = options.maintenance?.admit();
    if (options.maintenance && !release) return reply.code(503).send({ error: { code: 'MAINTENANCE', message: 'Agent is draining.' } });
    try {
      const source = await options.consoleContainer(parsed.data.sourceServiceId);
      const target = await options.consoleContainer(parsed.data.targetServiceId);
      return await transferPostgresDump({
        dockerSocket: options.dockerSocket,
        sourceContainerId: source.id,
        targetContainerId: target.id,
        sourceDatabase: parsed.data.sourceDatabase,
        sourceUser: parsed.data.sourceUser,
        targetDatabase: parsed.data.targetDatabase,
        targetUser: parsed.data.targetUser,
      });
    } catch (error) {
      return reply.code(422).send({ error: { code: 'MIGRATION_FAILED', message: error instanceof Error ? error.message : 'PostgreSQL migration transfer failed.' } });
    } finally {
      release?.();
    }
  });
}
