import Database from 'better-sqlite3';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { agentRequest as defaultAgentRequest, type AgentRequestOptions } from '../agent/client.js';
import { METRICS_WINDOW_MS, type MetricsWindow, type ServiceMetricPoint, type ServiceMetricsHistory } from '../shared/metrics.js';
import type { Service, ServiceMetrics, SessionResponse } from '../shared/types.js';
import type { MaintenanceGate } from './maintenance.js';
import type { Store } from './store.js';

const METRICS_CACHE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS service_metrics_samples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    service_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    sampled_at INTEGER NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('ok', 'gap')),
    cpu_percent REAL,
    memory_bytes INTEGER,
    memory_limit_bytes INTEGER,
    containers INTEGER,
    generation TEXT,
    deployed_revision INTEGER
  );
  CREATE INDEX IF NOT EXISTS service_metrics_service_time ON service_metrics_samples(service_id, sampled_at DESC);
  CREATE INDEX IF NOT EXISTS service_metrics_time ON service_metrics_samples(sampled_at);
  CREATE TABLE IF NOT EXISTS metrics_cache_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

const metricSampleSchema = z.object({
  cpuPercent: z.number().finite().min(0),
  memoryBytes: z.number().finite().min(0),
  memoryLimitBytes: z.number().finite().min(0),
  networkRxBytes: z.number().finite().min(0),
  networkTxBytes: z.number().finite().min(0),
  containers: z.number().int().min(0),
  sampledAt: z.string().datetime().optional(),
  generation: z.string().min(1).max(64).nullable().optional(),
});

const windowSchema = z.enum(['1h', '6h', '24h']).default('1h');

interface SampleRow {
  sampled_at: number;
  status: 'ok' | 'gap';
  cpu_percent: number | null;
  memory_bytes: number | null;
  memory_limit_bytes: number | null;
  containers: number | null;
  generation: string | null;
}

export interface MetricsHistoryOptions {
  store: Store;
  serviceAccess: (req: FastifyRequest, id: string, write?: boolean) => { auth: SessionResponse; service: Service };
  agentRequest?: typeof defaultAgentRequest;
  agentConnection?: AgentRequestOptions;
  maintenance?: MaintenanceGate;
  now?: () => Date;
  intervalMs?: number;
  retentionMs?: number;
  maxRows?: number;
  maxConcurrency?: number;
  requestTimeoutMs?: number;
  startCollector?: boolean;
}

/**
 * Disposable telemetry cache stored separately from panel.sqlite so schema v9
 * and installation snapshot semantics remain untouched. Restored installations
 * start with an empty cache.
 */
export class MetricsHistory {
  readonly db: Database.Database;
  private readonly intervalMs: number;
  private readonly retentionMs: number;
  private readonly maxRows: number;
  private readonly maxConcurrency: number;
  private readonly requestTimeoutMs: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private activeTick: Promise<void> | null = null;
  private closing = false;
  private closed = false;

  constructor(private readonly options: MetricsHistoryOptions) {
    mkdirSync(options.store.dataDir, { recursive: true, mode: 0o700 });
    const dbPath = join(options.store.dataDir, 'metrics.sqlite');
    this.db = new Database(dbPath);
    if (existsSync(dbPath)) chmodSync(dbPath, 0o600);
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('journal_mode = WAL');
    this.db.exec(METRICS_CACHE_SCHEMA_SQL);
    this.intervalMs = options.intervalMs ?? 60_000;
    this.retentionMs = options.retentionMs ?? 24 * 60 * 60_000;
    this.maxRows = options.maxRows ?? 50_000;
    this.maxConcurrency = Math.max(1, options.maxConcurrency ?? 4);
    this.requestTimeoutMs = options.requestTimeoutMs ?? 5_000;
  }

  private now(): Date {
    return (this.options.now ?? (() => new Date()))();
  }

  private writeSample(sample: {
    serviceId: string;
    projectId: string;
    sampledAt: number;
    status: 'ok' | 'gap';
    cpuPercent: number | null;
    memoryBytes: number | null;
    memoryLimitBytes: number | null;
    containers: number | null;
    generation: string | null;
    deployedRevision: number | null;
  }) {
    this.db.prepare(
      `INSERT INTO service_metrics_samples
       (service_id, project_id, sampled_at, status, cpu_percent, memory_bytes, memory_limit_bytes, containers, generation, deployed_revision)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      sample.serviceId,
      sample.projectId,
      sample.sampledAt,
      sample.status,
      sample.cpuPercent,
      sample.memoryBytes,
      sample.memoryLimitBytes,
      sample.containers,
      sample.generation,
      sample.deployedRevision,
    );
  }

  prune(nowMs = this.now().getTime()): { deletedByAge: number; deletedByCap: number } {
    const cutoff = nowMs - this.retentionMs;
    const byAge = this.db.prepare('DELETE FROM service_metrics_samples WHERE sampled_at < ?').run(cutoff).changes;
    const countRow = this.db.prepare('SELECT COUNT(*) AS count FROM service_metrics_samples').get() as { count: number };
    let byCap = 0;
    if (countRow.count > this.maxRows) {
      const excess = countRow.count - this.maxRows;
      byCap = this.db.prepare(
        `DELETE FROM service_metrics_samples WHERE id IN (
           SELECT id FROM service_metrics_samples ORDER BY sampled_at ASC, id ASC LIMIT ?
         )`,
      ).run(excess).changes;
      if (byCap > 0) {
        const earliest = this.db.prepare('SELECT MIN(sampled_at) AS min_at FROM service_metrics_samples').get() as { min_at: number | null };
        if (earliest.min_at !== null) {
          this.db.prepare(
            `INSERT INTO metrics_cache_meta(key, value) VALUES ('capacity_truncated_at', ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
          ).run(String(earliest.min_at));
        }
      }
    }
    return { deletedByAge: byAge, deletedByCap: byCap };
  }

  private async sampleService(captured: Service, sampledAtMs: number): Promise<void> {
    if (this.closing || this.options.maintenance?.isDraining) return;
    const request = this.options.agentRequest ?? defaultAgentRequest;
    let metrics: ServiceMetrics | null = null;
    try {
      const raw = await request<ServiceMetrics>(`/services/${captured.id}/metrics`, undefined, {
        ...this.options.agentConnection,
        timeoutMs: this.requestTimeoutMs,
      });
      metrics = metricSampleSchema.parse(raw);
    } catch {
      metrics = null;
    }
    if (this.closing || this.options.maintenance?.isDraining) return;
    // Reload live service identity after awaiting the agent and discard stale observations.
    const latest = this.options.store.getService(captured.id);
    if (!latest || latest.deletedAt || latest.projectId !== captured.projectId || latest.deployedRevision !== captured.deployedRevision || latest.state !== 'running') {
      return;
    }
    if (metrics) {
      this.writeSample({
        serviceId: latest.id,
        projectId: latest.projectId,
        sampledAt: sampledAtMs,
        status: 'ok',
        cpuPercent: metrics.cpuPercent,
        memoryBytes: Math.round(metrics.memoryBytes),
        memoryLimitBytes: Math.round(metrics.memoryLimitBytes),
        containers: metrics.containers,
        generation: metrics.generation ?? null,
        deployedRevision: latest.deployedRevision,
      });
    } else {
      this.writeSample({
        serviceId: latest.id,
        projectId: latest.projectId,
        sampledAt: sampledAtMs,
        status: 'gap',
        cpuPercent: null,
        memoryBytes: null,
        memoryLimitBytes: null,
        containers: null,
        generation: null,
        deployedRevision: latest.deployedRevision,
      });
    }
  }

  async tick(): Promise<void> {
    if (this.closing || this.closed || this.activeTick || this.options.maintenance?.isDraining) return;
    const release = this.options.maintenance?.admit();
    if (this.options.maintenance && !release) return;
    const run = (async () => {
      try {
        const sampledAtMs = this.now().getTime();
        const targets = this.options.store.listServices().filter(
          service => !service.deletedAt && service.deployedRevision !== null && service.state === 'running',
        );
        let cursor = 0;
        const worker = async () => {
          while (!this.closing && !this.options.maintenance?.isDraining) {
            const index = cursor++;
            if (index >= targets.length) break;
            await this.sampleService(targets[index]!, sampledAtMs);
          }
        };
        const workers = Array.from({ length: Math.min(this.maxConcurrency, Math.max(1, targets.length)) }, () => worker());
        await Promise.all(workers);
        if (!this.closing && !this.options.maintenance?.isDraining) {
          this.prune(sampledAtMs);
        }
      } finally {
        this.activeTick = null;
        release?.();
      }
    })();
    this.activeTick = run;
    return run;
  }

  query(service: Service, window: MetricsWindow): ServiceMetricsHistory {
    const nowMs = this.now().getTime();
    const windowMs = METRICS_WINDOW_MS[window];
    const sinceMs = Math.max(nowMs - windowMs, nowMs - this.retentionMs);
    const rows = this.db.prepare(
      `SELECT sampled_at, status, cpu_percent, memory_bytes, memory_limit_bytes, containers, generation
       FROM service_metrics_samples
       WHERE service_id = ? AND project_id = ? AND sampled_at >= ?
       ORDER BY sampled_at ASC, id ASC`,
    ).all(service.id, service.projectId, sinceMs) as SampleRow[];
    const earliestService = this.db.prepare(
      'SELECT MIN(sampled_at) AS min_at FROM service_metrics_samples WHERE service_id = ? AND project_id = ?',
    ).get(service.id, service.projectId) as { min_at: number | null };
    const truncatedMeta = this.db.prepare("SELECT value FROM metrics_cache_meta WHERE key = 'capacity_truncated_at'").get() as { value: string } | undefined;
    const truncatedAtMs = truncatedMeta ? Number(truncatedMeta.value) : null;
    const truncated = truncatedAtMs !== null && Number.isFinite(truncatedAtMs) && truncatedAtMs > sinceMs;
    const samples: ServiceMetricPoint[] = rows.map(row => ({
      sampledAt: new Date(row.sampled_at).toISOString(),
      status: row.status,
      cpuPercent: row.cpu_percent,
      memoryBytes: row.memory_bytes,
      memoryLimitBytes: row.memory_limit_bytes,
      containers: row.containers,
      generation: row.generation,
    }));
    return {
      serviceId: service.id,
      window,
      intervalSeconds: Math.round(this.intervalMs / 1000),
      retentionHours: Math.round(this.retentionMs / 3_600_000),
      earliestAvailableAt: earliestService.min_at !== null ? new Date(earliestService.min_at).toISOString() : null,
      truncated,
      samples,
    };
  }

  start() {
    if (this.timer || this.closing || this.closed) return;
    this.timer = setInterval(() => {
      void this.tick().catch(() => { /* Keep the background collector alive on transient errors. */ });
    }, this.intervalMs);
    this.timer.unref();
  }

  async close() {
    this.closing = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.activeTick) await this.activeTick.catch(() => {});
    if (!this.closed) {
      this.closed = true;
      this.db.close();
    }
  }
}

export function registerMetricsHistory(app: FastifyInstance, options: MetricsHistoryOptions) {
  const history = new MetricsHistory(options);
  app.get<{ Params: { id: string }; Querystring: { window?: string } }>('/api/v1/services/:id/metrics/history', async req => {
    const { service } = options.serviceAccess(req, req.params.id);
    const window = windowSchema.parse(req.query.window);
    const result = history.query(service, window);
    // Re-verify live authorization before returning historical data.
    options.serviceAccess(req, req.params.id);
    return result;
  });
  if (options.startCollector !== false) app.addHook('onReady', async () => history.start());
  app.addHook('onClose', async () => history.close());
  return history;
}
