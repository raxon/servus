import Database from 'better-sqlite3';
import { createHmac, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { createConnection, isIP } from 'node:net';
import { join } from 'node:path';
import { connect as tlsConnect } from 'node:tls';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { agentRequest as defaultAgentRequest, type AgentRequestOptions } from '../agent/client.js';
import type { AlertChannelSummary, AlertChannelType, AlertDelivery, AlertMetric, AlertRule } from '../shared/alerts.js';
import type { HostMetrics } from '../shared/metrics.js';
import { isPrivateAddress } from '../shared/network-address.js';
import type { User } from '../shared/types.js';
import { AppError } from './errors.js';
import type { MaintenanceGate } from './maintenance.js';
import type { MetricsHistory } from './metrics-history.js';
import type { Store } from './store.js';

const ALERTS_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS alert_channels (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('webhook', 'discord', 'slack', 'telegram', 'smtp')),
    enabled INTEGER NOT NULL DEFAULT 1,
    target_summary TEXT NOT NULL,
    has_secret INTEGER NOT NULL DEFAULT 0,
    config_sealed TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS alert_rules (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    metric TEXT NOT NULL CHECK(metric IN ('service_cpu_percent', 'service_memory_percent', 'service_down', 'host_disk_percent', 'host_memory_percent')),
    service_id TEXT,
    threshold REAL NOT NULL,
    cooldown_minutes INTEGER NOT NULL DEFAULT 15,
    max_per_hour INTEGER NOT NULL DEFAULT 4,
    channel_ids_json TEXT NOT NULL,
    last_triggered_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS alert_deliveries (
    id TEXT PRIMARY KEY,
    rule_id TEXT,
    rule_name TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    channel_name TEXT NOT NULL,
    metric TEXT NOT NULL,
    severity TEXT NOT NULL CHECK(severity IN ('info', 'warning', 'critical')),
    message TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('sent', 'failed', 'suppressed')),
    attempts INTEGER NOT NULL DEFAULT 1,
    error TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS alert_deliveries_rule_time ON alert_deliveries(rule_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS alert_deliveries_created ON alert_deliveries(created_at DESC);
`;

const noHeaderBreaks = (value: string) => !/[\r\n\x00-\x1f\x7f]/.test(value);

const channelInputSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('webhook'),
    name: z.string().trim().min(1).max(80).refine(noHeaderBreaks),
    enabled: z.boolean().default(true),
    url: z.string().url().max(1000),
    secret: z.string().min(8).max(512).refine(noHeaderBreaks).optional(),
  }).strict(),
  z.object({
    type: z.literal('discord'),
    name: z.string().trim().min(1).max(80).refine(noHeaderBreaks),
    enabled: z.boolean().default(true),
    webhookUrl: z.string().url().max(1000),
  }).strict(),
  z.object({
    type: z.literal('slack'),
    name: z.string().trim().min(1).max(80).refine(noHeaderBreaks),
    enabled: z.boolean().default(true),
    webhookUrl: z.string().url().max(1000),
  }).strict(),
  z.object({
    type: z.literal('telegram'),
    name: z.string().trim().min(1).max(80).refine(noHeaderBreaks),
    enabled: z.boolean().default(true),
    botToken: z.string().min(10).max(256).refine(noHeaderBreaks),
    chatId: z.string().trim().min(1).max(64).regex(/^-?[0-9A-Za-z_@]+$/),
  }).strict(),
  z.object({
    type: z.literal('smtp'),
    name: z.string().trim().min(1).max(80).refine(noHeaderBreaks),
    enabled: z.boolean().default(true),
    host: z.string().trim().min(1).max(253).regex(/^[A-Za-z0-9.-]+$/),
    port: z.number().int().min(1).max(65535).default(587),
    secure: z.boolean().default(false),
    username: z.string().max(254).refine(noHeaderBreaks).optional(),
    password: z.string().max(512).refine(noHeaderBreaks).optional(),
    from: z.string().email().max(254).refine(noHeaderBreaks),
    to: z.string().email().max(254).refine(noHeaderBreaks),
  }).strict(),
]);

type ChannelConfig = z.infer<typeof channelInputSchema>;

const ruleCreateSchema = z.object({
  name: z.string().trim().min(1).max(100).refine(noHeaderBreaks),
  enabled: z.boolean().default(true),
  metric: z.enum(['service_cpu_percent', 'service_memory_percent', 'service_down', 'host_disk_percent', 'host_memory_percent']),
  serviceId: z.string().uuid().nullable().default(null),
  threshold: z.number().finite().min(0).max(10000),
  cooldownMinutes: z.number().int().min(1).max(1440).default(15),
  maxPerHour: z.number().int().min(1).max(60).default(4),
  channelIds: z.array(z.string().uuid()).min(1).max(10),
}).strict();

const rulePatchSchema = z.object({
  name: z.string().trim().min(1).max(100).refine(noHeaderBreaks).optional(),
  enabled: z.boolean().optional(),
  threshold: z.number().finite().min(0).max(10000).optional(),
  cooldownMinutes: z.number().int().min(1).max(1440).optional(),
  maxPerHour: z.number().int().min(1).max(60).optional(),
  channelIds: z.array(z.string().uuid()).min(1).max(10).optional(),
}).strict();

interface ChannelRow {
  id: string;
  name: string;
  type: AlertChannelType;
  enabled: number;
  target_summary: string;
  has_secret: number;
  config_sealed: string;
  created_at: string;
  updated_at: string;
}

interface RuleRow {
  id: string;
  name: string;
  enabled: number;
  metric: AlertMetric;
  service_id: string | null;
  threshold: number;
  cooldown_minutes: number;
  max_per_hour: number;
  channel_ids_json: string;
  last_triggered_at: string | null;
  created_at: string;
  updated_at: string;
}

interface DeliveryRow {
  id: string;
  rule_id: string | null;
  rule_name: string;
  channel_id: string;
  channel_name: string;
  metric: AlertMetric | 'test';
  severity: 'info' | 'warning' | 'critical';
  message: string;
  status: 'sent' | 'failed' | 'suppressed';
  attempts: number;
  error: string | null;
  created_at: string;
}

export interface AlertsOptions {
  store: Store;
  administrator: (req: FastifyRequest, mutation?: boolean) => User;
  metricsHistory?: MetricsHistory;
  agentRequest?: typeof defaultAgentRequest;
  agentConnection?: AgentRequestOptions;
  maintenance?: MaintenanceGate;
  fetch?: typeof fetch;
  now?: () => Date;
  intervalMs?: number;
  retryDelayMs?: number;
  startEvaluator?: boolean;
}

async function assertSafeOutboundHost(hostname: string): Promise<void> {
  const clean = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const allowed = (process.env.PANEL_ALERT_ALLOW_HOSTS ?? '').split(',').map(item => item.trim().toLowerCase()).filter(Boolean);
  if (allowed.includes(clean)) return;
  if (clean === 'localhost' || clean.endsWith('.localhost') || clean === 'metadata.google.internal') {
    throw new AppError('INVALID_ALERT_TARGET', 'Notification endpoints cannot target local or private network addresses.', 400);
  }
  const literal = isIP(clean);
  const addresses = literal ? [{ address: clean }] : await lookup(clean, { all: true }).catch(() => []);
  if (!addresses.length || addresses.some(item => isPrivateAddress(item.address))) {
    throw new AppError('INVALID_ALERT_TARGET', 'Notification endpoints cannot target local or private network addresses.', 400);
  }
}

async function assertSafeOutboundUrl(rawUrl: string, allowHttp = false): Promise<URL> {
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new AppError('INVALID_ALERT_TARGET', 'Enter a valid notification URL.', 400); }
  const allowed = (process.env.PANEL_ALERT_ALLOW_HOSTS ?? '').split(',').map(item => item.trim().toLowerCase()).filter(Boolean);
  const protocolOk = url.protocol === 'https:' || ((allowHttp || allowed.includes(url.hostname.toLowerCase())) && url.protocol === 'http:');
  if (!protocolOk || url.username || url.password) {
    throw new AppError('INVALID_ALERT_TARGET', 'Notification URLs must use HTTPS without embedded credentials.', 400);
  }
  await assertSafeOutboundHost(url.hostname);
  return url;
}

function summarizeTarget(config: ChannelConfig): { targetSummary: string; hasSecret: boolean } {
  if (config.type === 'webhook') return { targetSummary: new URL(config.url).host, hasSecret: Boolean(config.secret) };
  if (config.type === 'discord' || config.type === 'slack') return { targetSummary: new URL(config.webhookUrl).host, hasSecret: true };
  if (config.type === 'telegram') return { targetSummary: `chat ${config.chatId}`, hasSecret: true };
  return { targetSummary: `${config.host}:${config.port} -> ${config.to}`, hasSecret: Boolean(config.password) };
}

async function sendSmtpMessage(config: Extract<ChannelConfig, { type: 'smtp' }>, subject: string, body: string): Promise<void> {
  await assertSafeOutboundHost(config.host);
  await new Promise<void>((resolvePromise, reject) => {
    const socket = config.secure
      ? tlsConnect({ host: config.host, port: config.port, servername: config.host, timeout: 10_000 })
      : createConnection({ host: config.host, port: config.port, timeout: 10_000 });
    let buffer = '';
    const queue: ((line: string) => void)[] = [];
    const fail = (error: Error) => { socket.destroy(); reject(error); };
    socket.setTimeout(10_000, () => fail(new Error('SMTP connection timed out')));
    socket.on('error', err => fail(err));
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      let idx: number;
      while ((idx = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (/^\d{3}-/.test(line)) continue;
        queue.shift()?.(line);
      }
    });
    const readCode = () => new Promise<number>((res, rej) => {
      queue.push(line => {
        const code = Number(line.slice(0, 3));
        if (!Number.isFinite(code)) rej(new Error('Invalid SMTP response'));
        else res(code);
      });
    });
    const cmd = async (line: string, expected: number[]) => {
      socket.write(`${line}\r\n`);
      const code = await readCode();
      if (!expected.includes(code)) throw new Error(`SMTP rejected command with code ${code}`);
    };
    void (async () => {
      try {
        const banner = await readCode();
        if (banner !== 220) throw new Error(`Unexpected SMTP banner ${banner}`);
        await cmd('EHLO servus.local', [250]);
        if (config.username && config.password) {
          const token = Buffer.from(`\0${config.username}\0${config.password}`).toString('base64');
          await cmd(`AUTH PLAIN ${token}`, [235]);
        }
        await cmd(`MAIL FROM:<${config.from}>`, [250]);
        await cmd(`RCPT TO:<${config.to}>`, [250, 251]);
        await cmd('DATA', [354]);
        const safeSubject = subject.replace(/[\r\n]+/g, ' ').slice(0, 200);
        const safeBody = body.replace(/\r?\n\./g, '\r\n..').replace(/\r?\n/g, '\r\n');
        socket.write(`From: <${config.from}>\r\nTo: <${config.to}>\r\nSubject: ${safeSubject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${safeBody}\r\n.\r\n`);
        const dataCode = await readCode();
        if (dataCode !== 250) throw new Error(`SMTP rejected message body (${dataCode})`);
        await cmd('QUIT', [221, 250]);
        socket.end();
        resolvePromise();
      } catch (err) {
        fail(err instanceof Error ? err : new Error('SMTP delivery failed'));
      }
    })();
  });
}

export class AlertsManager {
  readonly db: Database.Database;
  private timer: ReturnType<typeof setInterval> | undefined;
  private activeTick: Promise<void> | null = null;
  private closing = false;
  private closed = false;
  private readonly intervalMs: number;
  private readonly retryDelayMs: number;

  constructor(private readonly options: AlertsOptions) {
    mkdirSync(options.store.dataDir, { recursive: true, mode: 0o700 });
    const dbPath = join(options.store.dataDir, 'alerts.sqlite');
    this.db = new Database(dbPath);
    if (existsSync(dbPath)) chmodSync(dbPath, 0o600);
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('journal_mode = WAL');
    this.db.exec(ALERTS_SCHEMA_SQL);
    this.intervalMs = options.intervalMs ?? 60_000;
    this.retryDelayMs = options.retryDelayMs ?? 150;
  }

  private now(): Date { return (this.options.now ?? (() => new Date()))(); }

  private toChannelSummary(row: ChannelRow): AlertChannelSummary {
    return {
      id: row.id,
      name: row.name,
      type: row.type,
      enabled: Boolean(row.enabled),
      targetSummary: row.target_summary,
      hasSecret: Boolean(row.has_secret),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private toRule(row: RuleRow): AlertRule {
    return {
      id: row.id,
      name: row.name,
      enabled: Boolean(row.enabled),
      metric: row.metric,
      serviceId: row.service_id,
      threshold: row.threshold,
      cooldownMinutes: row.cooldown_minutes,
      maxPerHour: row.max_per_hour,
      channelIds: JSON.parse(row.channel_ids_json) as string[],
      lastTriggeredAt: row.last_triggered_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private toDelivery(row: DeliveryRow): AlertDelivery {
    return {
      id: row.id,
      ruleId: row.rule_id,
      ruleName: row.rule_name,
      channelId: row.channel_id,
      channelName: row.channel_name,
      metric: row.metric,
      severity: row.severity,
      message: row.message,
      status: row.status,
      attempts: row.attempts,
      error: row.error,
      createdAt: row.created_at,
    };
  }

  listChannels(): AlertChannelSummary[] {
    return (this.db.prepare('SELECT * FROM alert_channels ORDER BY created_at DESC').all() as ChannelRow[]).map(r => this.toChannelSummary(r));
  }

  async createChannel(raw: unknown, actorId: string): Promise<AlertChannelSummary> {
    const input = channelInputSchema.parse(raw);
    if (input.type === 'webhook') await assertSafeOutboundUrl(input.url);
    else if (input.type === 'discord' || input.type === 'slack') await assertSafeOutboundUrl(input.webhookUrl);
    else if (input.type === 'smtp') await assertSafeOutboundHost(input.host);
    const { targetSummary, hasSecret } = summarizeTarget(input);
    const id = randomUUID();
    const ts = this.now().toISOString();
    const sealed = this.options.store.vault.seal(JSON.stringify(input));
    this.db.prepare(
      'INSERT INTO alert_channels (id, name, type, enabled, target_summary, has_secret, config_sealed, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(id, input.name, input.type, input.enabled ? 1 : 0, targetSummary, hasSecret ? 1 : 0, sealed, ts, ts);
    this.options.store.recordAudit(actorId, 'alert.channel.create', id);
    return this.toChannelSummary(this.db.prepare('SELECT * FROM alert_channels WHERE id = ?').get(id) as ChannelRow);
  }

  deleteChannel(id: string, actorId: string) {
    z.string().uuid().parse(id);
    const changed = this.db.prepare('DELETE FROM alert_channels WHERE id = ?').run(id).changes;
    if (!changed) throw new AppError('NOT_FOUND', 'Notification channel not found', 404);
    // Remove deleted channel from any referencing rules
    for (const rule of this.db.prepare('SELECT id, channel_ids_json FROM alert_rules').all() as { id: string; channel_ids_json: string }[]) {
      const ids = (JSON.parse(rule.channel_ids_json) as string[]).filter(item => item !== id);
      this.db.prepare('UPDATE alert_rules SET channel_ids_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(ids), this.now().toISOString(), rule.id);
    }
    this.options.store.recordAudit(actorId, 'alert.channel.delete', id);
  }

  listRules(): AlertRule[] {
    return (this.db.prepare('SELECT * FROM alert_rules ORDER BY created_at DESC').all() as RuleRow[]).map(r => this.toRule(r));
  }

  createRule(raw: unknown, actorId: string): AlertRule {
    const input = ruleCreateSchema.parse(raw);
    const needsService = input.metric.startsWith('service_');
    if (needsService && !input.serviceId) throw new AppError('INVALID_ALERT_RULE', 'Service alert rules require a target service.', 400);
    if (!needsService && input.serviceId) throw new AppError('INVALID_ALERT_RULE', 'Host alert rules cannot target a specific service.', 400);
    if (input.serviceId && !this.options.store.getService(input.serviceId)) throw new AppError('NOT_FOUND', 'Target service not found.', 404);
    for (const channelId of input.channelIds) {
      if (!this.db.prepare('SELECT 1 FROM alert_channels WHERE id = ?').get(channelId)) {
        throw new AppError('NOT_FOUND', 'Notification channel not found.', 404);
      }
    }
    const id = randomUUID(), ts = this.now().toISOString();
    this.db.prepare(
      'INSERT INTO alert_rules (id, name, enabled, metric, service_id, threshold, cooldown_minutes, max_per_hour, channel_ids_json, last_triggered_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)',
    ).run(id, input.name, input.enabled ? 1 : 0, input.metric, input.serviceId, input.threshold, input.cooldownMinutes, input.maxPerHour, JSON.stringify([...new Set(input.channelIds)]), ts, ts);
    this.options.store.recordAudit(actorId, 'alert.rule.create', id);
    return this.toRule(this.db.prepare('SELECT * FROM alert_rules WHERE id = ?').get(id) as RuleRow);
  }

  updateRule(id: string, raw: unknown, actorId: string): AlertRule {
    z.string().uuid().parse(id);
    const existing = this.db.prepare('SELECT * FROM alert_rules WHERE id = ?').get(id) as RuleRow | undefined;
    if (!existing) throw new AppError('NOT_FOUND', 'Alert rule not found', 404);
    const patch = rulePatchSchema.parse(raw);
    if (patch.channelIds) {
      for (const channelId of patch.channelIds) {
        if (!this.db.prepare('SELECT 1 FROM alert_channels WHERE id = ?').get(channelId)) {
          throw new AppError('NOT_FOUND', 'Notification channel not found.', 404);
        }
      }
    }
    const ts = this.now().toISOString();
    this.db.prepare(
      'UPDATE alert_rules SET name = ?, enabled = ?, threshold = ?, cooldown_minutes = ?, max_per_hour = ?, channel_ids_json = ?, updated_at = ? WHERE id = ?',
    ).run(
      patch.name ?? existing.name,
      patch.enabled === undefined ? existing.enabled : patch.enabled ? 1 : 0,
      patch.threshold ?? existing.threshold,
      patch.cooldownMinutes ?? existing.cooldown_minutes,
      patch.maxPerHour ?? existing.max_per_hour,
      patch.channelIds ? JSON.stringify([...new Set(patch.channelIds)]) : existing.channel_ids_json,
      ts,
      id,
    );
    this.options.store.recordAudit(actorId, 'alert.rule.update', id);
    return this.toRule(this.db.prepare('SELECT * FROM alert_rules WHERE id = ?').get(id) as RuleRow);
  }

  deleteRule(id: string, actorId: string) {
    z.string().uuid().parse(id);
    const changed = this.db.prepare('DELETE FROM alert_rules WHERE id = ?').run(id).changes;
    if (!changed) throw new AppError('NOT_FOUND', 'Alert rule not found', 404);
    this.options.store.recordAudit(actorId, 'alert.rule.delete', id);
  }

  listDeliveries(limit = 50): AlertDelivery[] {
    const safeLimit = Math.max(1, Math.min(200, limit));
    return (this.db.prepare('SELECT * FROM alert_deliveries ORDER BY created_at DESC LIMIT ?').all(safeLimit) as DeliveryRow[]).map(r => this.toDelivery(r));
  }

  private async deliverOnce(config: ChannelConfig, deliveryId: string, payload: { ruleName: string; metric: AlertMetric | 'test'; severity: 'info' | 'warning' | 'critical'; message: string; timestamp: string }): Promise<void> {
    const httpFetch = this.options.fetch ?? fetch;
    if (config.type === 'smtp') {
      await sendSmtpMessage(config, `[Servus ${payload.severity.toUpperCase()}] ${payload.ruleName}`, `${payload.message}\n\nTimestamp: ${payload.timestamp}\nDelivery ID: ${deliveryId}`);
      return;
    }
    let url: string;
    let body: string;
    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'User-Agent': 'Servus-Alerts/1.0' };
    if (config.type === 'webhook') {
      await assertSafeOutboundUrl(config.url);
      url = config.url;
      body = JSON.stringify({ event: 'servus.alert', deliveryId, ...payload });
      headers['X-Servus-Event'] = 'servus.alert';
      headers['X-Servus-Delivery-Id'] = deliveryId;
      headers['X-Servus-Timestamp'] = payload.timestamp;
      if (config.secret) {
        headers['X-Servus-Signature-256'] = `sha256=${createHmac('sha256', config.secret).update(body).digest('hex')}`;
      }
    } else if (config.type === 'discord') {
      await assertSafeOutboundUrl(config.webhookUrl);
      url = config.webhookUrl;
      body = JSON.stringify({ content: `[Servus ${payload.severity.toUpperCase()}] **${payload.ruleName}**: ${payload.message}` });
    } else if (config.type === 'slack') {
      await assertSafeOutboundUrl(config.webhookUrl);
      url = config.webhookUrl;
      body = JSON.stringify({ text: `[Servus ${payload.severity.toUpperCase()}] *${payload.ruleName}*: ${payload.message}` });
    } else {
      const telegramBase = process.env.PANEL_TELEGRAM_API_BASE ?? 'https://api.telegram.org';
      await assertSafeOutboundUrl(telegramBase);
      url = `${telegramBase.replace(/\/+$/, '')}/bot${config.botToken}/sendMessage`;
      body = JSON.stringify({ chat_id: config.chatId, text: `[Servus ${payload.severity.toUpperCase()}] ${payload.ruleName}: ${payload.message}` });
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    timer.unref();
    try {
      const response = await httpFetch(url, { method: 'POST', headers, body, redirect: 'error', signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    } finally {
      clearTimeout(timer);
    }
  }

  private async dispatch(channel: ChannelRow, info: { ruleId: string | null; ruleName: string; metric: AlertMetric | 'test'; severity: 'info' | 'warning' | 'critical'; message: string }): Promise<AlertDelivery> {
    const config = channelInputSchema.parse(JSON.parse(this.options.store.vault.open(channel.config_sealed)));
    const deliveryId = randomUUID();
    const ts = this.now().toISOString();
    let attempts = 0;
    let lastError: string | null = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      attempts = attempt;
      try {
        await this.deliverOnce(config, deliveryId, { ruleName: info.ruleName, metric: info.metric, severity: info.severity, message: info.message, timestamp: ts });
        lastError = null;
        break;
      } catch (error) {
        lastError = this.options.store.vault.redact(error instanceof Error ? error.message : 'Delivery failed').slice(0, 400);
        if (attempt < 3 && this.retryDelayMs > 0) {
          await new Promise(resolve => setTimeout(resolve, this.retryDelayMs * attempt));
        }
      }
    }
    const status = lastError === null ? 'sent' : 'failed';
    this.db.prepare(
      'INSERT INTO alert_deliveries (id, rule_id, rule_name, channel_id, channel_name, metric, severity, message, status, attempts, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(deliveryId, info.ruleId, info.ruleName, channel.id, channel.name, info.metric, info.severity, info.message, status, attempts, lastError, ts);
    // Keep delivery history bounded
    this.db.prepare('DELETE FROM alert_deliveries WHERE id NOT IN (SELECT id FROM alert_deliveries ORDER BY created_at DESC LIMIT 2000)').run();
    return this.toDelivery(this.db.prepare('SELECT * FROM alert_deliveries WHERE id = ?').get(deliveryId) as DeliveryRow);
  }

  async testChannel(id: string, actorId: string): Promise<AlertDelivery> {
    z.string().uuid().parse(id);
    const channel = this.db.prepare('SELECT * FROM alert_channels WHERE id = ?').get(id) as ChannelRow | undefined;
    if (!channel) throw new AppError('NOT_FOUND', 'Notification channel not found', 404);
    this.options.store.recordAudit(actorId, 'alert.channel.test', id);
    return this.dispatch(channel, {
      ruleId: null,
      ruleName: 'Test notification',
      metric: 'test',
      severity: 'info',
      message: `Test notification from Servus for channel "${channel.name}".`,
    });
  }

  async evaluate(overrideHostMetrics?: HostMetrics): Promise<void> {
    if (this.closing || this.closed || this.activeTick || this.options.maintenance?.isDraining) return;
    const release = this.options.maintenance?.admit();
    if (this.options.maintenance && !release) return;
    const run = (async () => {
      try {
        const rules = this.db.prepare('SELECT * FROM alert_rules WHERE enabled = 1').all() as RuleRow[];
        if (!rules.length) return;
        let hostMetrics = overrideHostMetrics;
        const needsHost = rules.some(rule => rule.metric === 'host_disk_percent' || rule.metric === 'host_memory_percent');
        if (needsHost && !hostMetrics) {
          try {
            const req = this.options.agentRequest ?? defaultAgentRequest;
            hostMetrics = await req<HostMetrics>('/host/metrics', undefined, { ...this.options.agentConnection, timeoutMs: 5_000 });
          } catch {
            hostMetrics = undefined;
          }
        }
        const now = this.now();
        const nowMs = now.getTime();
        const oneHourAgo = new Date(nowMs - 60 * 60_000).toISOString();

        for (const rule of rules) {
          if (this.closing || this.closed) break;
          let breached = false;
          let message = '';
          let severity: 'warning' | 'critical' = 'warning';

          if (rule.metric === 'host_disk_percent' && hostMetrics && hostMetrics.diskTotalBytes > 0) {
            const pct = (hostMetrics.diskUsedBytes / hostMetrics.diskTotalBytes) * 100;
            if (pct >= rule.threshold) {
              breached = true;
              severity = pct >= 90 ? 'critical' : 'warning';
              message = `Host disk usage is ${pct.toFixed(1)}% (threshold ${rule.threshold}%).`;
            }
          } else if (rule.metric === 'host_memory_percent' && hostMetrics && hostMetrics.memoryTotalBytes > 0) {
            const pct = (hostMetrics.memoryUsedBytes / hostMetrics.memoryTotalBytes) * 100;
            if (pct >= rule.threshold) {
              breached = true;
              severity = pct >= 90 ? 'critical' : 'warning';
              message = `Host memory usage is ${pct.toFixed(1)}% (threshold ${rule.threshold}%).`;
            }
          } else if (rule.service_id) {
            const service = this.options.store.getService(rule.service_id);
            if (!service) continue;
            const latest = this.options.metricsHistory?.query(service, '1h').samples.filter(s => s.status === 'ok').at(-1);
            if (rule.metric === 'service_down') {
              if (service.state === 'failed' || (latest && latest.containers === 0)) {
                breached = true;
                severity = 'critical';
                message = `Service "${service.name}" is down or has 0 running containers (state: ${service.state}).`;
              }
            } else if (rule.metric === 'service_cpu_percent' && latest?.cpuPercent !== null && latest?.cpuPercent !== undefined) {
              if (latest.cpuPercent >= rule.threshold) {
                breached = true;
                message = `Service "${service.name}" CPU is ${latest.cpuPercent.toFixed(1)}% (threshold ${rule.threshold}%).`;
              }
            } else if (rule.metric === 'service_memory_percent' && latest?.memoryBytes !== null && latest?.memoryBytes !== undefined && latest.memoryLimitBytes && latest.memoryLimitBytes > 0) {
              const pct = (latest.memoryBytes / latest.memoryLimitBytes) * 100;
              if (pct >= rule.threshold) {
                breached = true;
                severity = pct >= 90 ? 'critical' : 'warning';
                message = `Service "${service.name}" memory is ${pct.toFixed(1)}% (threshold ${rule.threshold}%).`;
              }
            }
          }

          if (!breached) continue;

          // Deduplication cooldown check
          if (rule.last_triggered_at && nowMs - Date.parse(rule.last_triggered_at) < rule.cooldown_minutes * 60_000) {
            continue;
          }
          // Per-hour rate limit check
          const sentHour = this.db.prepare(
            "SELECT COUNT(*) AS count FROM alert_deliveries WHERE rule_id = ? AND status = 'sent' AND created_at >= ?",
          ).get(rule.id, oneHourAgo) as { count: number };
          const channelIds = JSON.parse(rule.channel_ids_json) as string[];
          if (sentHour.count >= rule.max_per_hour) {
            const firstChannelId = channelIds[0] ?? 'rate-limited';
            this.db.prepare(
              "INSERT INTO alert_deliveries (id, rule_id, rule_name, channel_id, channel_name, metric, severity, message, status, attempts, error, created_at) VALUES (?, ?, ?, ?, 'rate-limit', ?, ?, ?, 'suppressed', 0, 'Hourly alert rate limit reached', ?)",
            ).run(randomUUID(), rule.id, rule.name, firstChannelId, rule.metric, severity, message, now.toISOString());
            this.db.prepare('UPDATE alert_rules SET last_triggered_at = ? WHERE id = ?').run(now.toISOString(), rule.id);
            continue;
          }

          this.db.prepare('UPDATE alert_rules SET last_triggered_at = ? WHERE id = ?').run(now.toISOString(), rule.id);
          for (const channelId of channelIds) {
            const channel = this.db.prepare('SELECT * FROM alert_channels WHERE id = ? AND enabled = 1').get(channelId) as ChannelRow | undefined;
            if (channel) {
              await this.dispatch(channel, { ruleId: rule.id, ruleName: rule.name, metric: rule.metric, severity, message });
            }
          }
        }
      } finally {
        release?.();
      }
    })();
    this.activeTick = run;
    try { await run; } finally { if (this.activeTick === run) this.activeTick = null; }
  }

  start() {
    if (this.timer || this.closing || this.closed) return;
    this.timer = setInterval(() => { void this.evaluate(); }, this.intervalMs);
    this.timer.unref();
  }

  async close() {
    this.closing = true;
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    if (this.activeTick) await this.activeTick;
    if (!this.closed) { this.closed = true; this.db.close(); }
  }
}

export function registerAlerts(app: FastifyInstance, options: AlertsOptions) {
  const manager = new AlertsManager(options);
  app.get('/api/v1/alerts/channels', async req => { options.administrator(req); return { channels: manager.listChannels() }; });
  app.post('/api/v1/alerts/channels', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const actor = options.administrator(req, true);
    const channel = await manager.createChannel(req.body, actor.id);
    return reply.code(201).send({ channel });
  });
  app.delete<{ Params: { id: string } }>('/api/v1/alerts/channels/:id', async req => {
    const actor = options.administrator(req, true);
    manager.deleteChannel(req.params.id, actor.id);
    return { success: true };
  });
  app.post<{ Params: { id: string } }>('/api/v1/alerts/channels/:id/test', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async req => {
    const actor = options.administrator(req, true);
    const delivery = await manager.testChannel(req.params.id, actor.id);
    return { delivery };
  });
  app.get('/api/v1/alerts/rules', async req => { options.administrator(req); return { rules: manager.listRules() }; });
  app.post('/api/v1/alerts/rules', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const actor = options.administrator(req, true);
    const rule = manager.createRule(req.body, actor.id);
    return reply.code(201).send({ rule });
  });
  app.patch<{ Params: { id: string } }>('/api/v1/alerts/rules/:id', async req => {
    const actor = options.administrator(req, true);
    const rule = manager.updateRule(req.params.id, req.body, actor.id);
    return { rule };
  });
  app.delete<{ Params: { id: string } }>('/api/v1/alerts/rules/:id', async req => {
    const actor = options.administrator(req, true);
    manager.deleteRule(req.params.id, actor.id);
    return { success: true };
  });
  app.get<{ Querystring: { limit?: string } }>('/api/v1/alerts/history', async req => {
    options.administrator(req);
    const limit = z.coerce.number().int().min(1).max(200).default(50).parse(req.query.limit);
    return { deliveries: manager.listDeliveries(limit) };
  });
  if (options.startEvaluator !== false) {
    app.addHook('onReady', async () => { manager.start(); });
  }
  app.addHook('onClose', async () => { await manager.close(); });
  return manager;
}
