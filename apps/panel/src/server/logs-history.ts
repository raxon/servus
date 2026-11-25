import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { agentRequest as defaultAgentRequest, type AgentRequestOptions } from '../agent/client.js';
import {
  classifyLogLevel,
  LOG_WINDOW_MS,
  type ArchivedLogEntry,
  type LogLevel,
  type LogWindow,
  type ServiceLogHistory,
} from '../shared/logs.js';
import type { Service, ServiceLogs, SessionResponse } from '../shared/types.js';
import type { MaintenanceGate } from './maintenance.js';
import type { Store } from './store.js';

const LOGS_CACHE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS service_log_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    service_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    observed_at INTEGER NOT NULL,
    level TEXT NOT NULL CHECK(level IN ('error', 'warn', 'info')),
    line_hash TEXT NOT NULL,
    line TEXT NOT NULL,
    UNIQUE(service_id, observed_at, line_hash)
  );
  CREATE INDEX IF NOT EXISTS service_log_service_time ON service_log_entries(service_id, observed_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS service_log_time ON service_log_entries(observed_at);
  CREATE TABLE IF NOT EXISTS service_log_watermarks (
    service_id TEXT PRIMARY KEY,
    last_observed_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS logs_cache_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

const querySchema = z.object({
  window: z.enum(['1h', '6h', '24h', '7d']).default('24h'),
  q: z.string().max(200).default(''),
  level: z.enum(['all', 'error', 'warn', 'info']).default('all'),
  limit: z.coerce.number().int().min(1).max(500).default(200),
}).strict();

interface LogRow {
  id: number;
  observed_at: number;
  level: LogLevel;
  line: string;
}

export interface LogsHistoryOptions {
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

function parseLineTimestamp(line: string, fallbackMs: number): number {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))\s/.exec(line);
  if (!match) return fallbackMs;
  const parsed = Date.parse(match[1]!);
  return Number.isFinite(parsed) ? parsed : fallbackMs;
}

/**
 * Disposable historical log archive stored separately from panel.sqlite so
 * schema migrations and installation snapshot boundaries stay unaffected.
 */
export class LogsHistory {
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

  constructor(private readonly options: LogsHistoryOptions) {
    mkdirSync(options.store.dataDir, { recursive: true, mode: 0o700 });
    const dbPath = join(options.store.dataDir, 'logs.sqlite');
    this.db = new Database(dbPath);
    if (existsSync(dbPath)) chmodSync(dbPath, 0o600);
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('journal_mode = WAL');
    this.db.exec(LOGS_CACHE_SCHEMA_SQL);
    this.intervalMs = options.intervalMs ?? 60_000;
    this.retentionMs = options.retentionMs ?? 7 * 24 * 60 * 60_000;
    this.maxRows = options.maxRows ?? 200_000;
    this.maxConcurrency = Math.max(1, options.maxConcurrency ?? 4);
    this.requestTimeoutMs = options.requestTimeoutMs ?? 5_000;
  }

  private now(): Date {
    return (this.options.now ?? (() => new Date()))();
  }

  private prune(nowMs: number) {
    const cutoff = nowMs - this.retentionMs;
    this.db.prepare('DELETE FROM service_log_entries WHERE observed_at < ?').run(cutoff);
    const countRow = this.db.prepare('SELECT COUNT(*) AS total FROM service_log_entries').get() as { total: number };
    if (countRow.total > this.maxRows) {
      const excess = countRow.total - this.maxRows;
      this.db.prepare(
        'DELETE FROM service_log_entries WHERE id IN (SELECT id FROM service_log_entries ORDER BY observed_at ASC, id ASC LIMIT ?)',
      ).run(excess);
      this.db.prepare("INSERT OR REPLACE INTO logs_cache_meta(key, value) VALUES ('truncated', '1')").run();
    }
  }

  private ingest(service: Service, lines: string[], tickMs: number) {
    const latest = this.options.store.getService(service.id);
    if (!latest || latest.projectId !== service.projectId) return;
    const redactedLines = lines
      .map(line => this.options.store.vault.redact(line).slice(0, 4096))
      .filter(Boolean);
    if (!redactedLines.length) return;
    let maxObserved = tickMs;
    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO service_log_entries (service_id, project_id, observed_at, level, line_hash, line) VALUES (?, ?, ?, ?, ?, ?)',
    );
    this.db.transaction(() => {
      for (const line of redactedLines) {
        const observedAt = parseLineTimestamp(line, tickMs);
        if (observedAt > maxObserved) maxObserved = observedAt;
        const hash = createHash('sha256').update(line).digest('hex').slice(0, 24);
        insert.run(service.id, service.projectId, observedAt, classifyLogLevel(line), hash, line);
      }
      this.db.prepare(
        'INSERT INTO service_log_watermarks (service_id, last_observed_at) VALUES (?, ?) ON CONFLICT(service_id) DO UPDATE SET last_observed_at = MAX(last_observed_at, excluded.last_observed_at)',
      ).run(service.id, maxObserved);
    }).immediate();
  }

  private async collectOne(service: Service, tickMs: number): Promise<void> {
    if (this.closing || this.closed || this.options.maintenance?.isDraining) return;
    const request = this.options.agentRequest ?? defaultAgentRequest;
    const watermark = this.db.prepare('SELECT last_observed_at FROM service_log_watermarks WHERE service_id = ?').get(service.id) as { last_observed_at: number } | undefined;
    const sinceParam = watermark ? `&since=${encodeURIComponent(new Date(Math.max(0, watermark.last_observed_at - 1000)).toISOString())}` : '';
    try {
      const raw = await request<ServiceLogs>(
        `/services/${service.id}/logs?tail=200${sinceParam}`,
        undefined,
        { ...this.options.agentConnection, timeoutMs: this.requestTimeoutMs },
      );
      if (this.closing || this.closed) return;
      if (Array.isArray(raw?.lines)) {
        this.ingest(service, raw.lines.filter((item): item is string => typeof item === 'string'), tickMs);
      }
    } catch {
      // Log archive collection is best-effort and never blocks live requests.
    }
  }

  async tick(): Promise<void> {
    if (this.closing || this.closed || this.activeTick || this.options.maintenance?.isDraining) return;
    const release = this.options.maintenance?.admit();
    if (this.options.maintenance && !release) return;
    const run = (async () => {
      try {
        const nowMs = this.now().getTime();
        const rows = this.options.store.db.prepare(
          "SELECT id FROM services WHERE deleted_at IS NULL AND deployed_revision IS NOT NULL AND state IN ('running', 'deploying')",
        ).all() as { id: string }[];
        const services = rows
          .map(row => this.options.store.getService(row.id))
          .filter((service): service is Service => Boolean(service));
        const queue = [...services];
        const workers = Array.from({ length: Math.min(this.maxConcurrency, queue.length) }, async () => {
          while (queue.length > 0 && !this.closing && !this.closed && !this.options.maintenance?.isDraining) {
            const next = queue.shift();
            if (next) await this.collectOne(next, nowMs);
          }
        });
        await Promise.all(workers);
        if (!this.closed) this.prune(nowMs);
      } finally {
        release?.();
      }
    })();
    this.activeTick = run;
    try {
      await run;
    } finally {
      if (this.activeTick === run) this.activeTick = null;
    }
  }

  query(service: Service, rawQuery: unknown): ServiceLogHistory {
    const parsed = querySchema.parse(rawQuery ?? {});
    const nowMs = this.now().getTime();
    const fromMs = nowMs - LOG_WINDOW_MS[parsed.window];
    const conditions = ['service_id = ?', 'project_id = ?', 'observed_at >= ?'];
    const params: unknown[] = [service.id, service.projectId, fromMs];
    if (parsed.level !== 'all') {
      conditions.push('level = ?');
      params.push(parsed.level);
    }
    const needle = parsed.q.trim();
    if (needle) {
      conditions.push('INSTR(LOWER(line), LOWER(?)) > 0');
      params.push(needle);
    }
    const rows = this.db.prepare(
      `SELECT id, observed_at, level, line FROM service_log_entries WHERE ${conditions.join(' AND ')} ORDER BY observed_at DESC, id DESC LIMIT ?`,
    ).all(...params, parsed.limit) as LogRow[];
    const earliest = this.db.prepare(
      'SELECT MIN(observed_at) AS earliest FROM service_log_entries WHERE service_id = ? AND project_id = ?',
    ).get(service.id, service.projectId) as { earliest: number | null } | undefined;
    const meta = this.db.prepare("SELECT value FROM logs_cache_meta WHERE key = 'truncated'").get() as { value: string } | undefined;
    const entries: ArchivedLogEntry[] = rows.reverse().map(row => ({
      id: row.id,
      observedAt: new Date(row.observed_at).toISOString(),
      level: row.level,
      line: row.line,
    }));
    return {
      serviceId: service.id,
      window: parsed.window as LogWindow,
      query: needle,
      level: parsed.level,
      retentionDays: Math.round(this.retentionMs / (24 * 60 * 60_000)),
      earliestAvailableAt: earliest?.earliest !== null && earliest?.earliest !== undefined ? new Date(earliest.earliest).toISOString() : null,
      truncated: meta?.value === '1',
      entries,
    };
  }

  start() {
    if (this.timer || this.closing || this.closed) return;
    this.timer = setInterval(() => { void this.tick(); }, this.intervalMs);
    this.timer.unref();
  }

  async close() {
    this.closing = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.activeTick) await this.activeTick;
    if (!this.closed) {
      this.closed = true;
      this.db.close();
    }
  }
}

export function registerLogsHistory(app: FastifyInstance, options: LogsHistoryOptions) {
  const history = new LogsHistory(options);
  app.get<{ Params: { id: string } }>('/api/v1/services/:id/logs/history', async req => {
    const { service } = options.serviceAccess(req, req.params.id);
    const result = history.query(service, req.query);
    options.serviceAccess(req, req.params.id);
    return result;
  });
  if (options.startCollector !== false) {
    app.addHook('onReady', async () => { history.start(); });
  }
  app.addHook('onClose', async () => { await history.close(); });
  return history;
}
