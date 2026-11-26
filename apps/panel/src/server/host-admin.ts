import { randomBytes } from 'node:crypto';
import { connect } from 'node:net';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { WebSocket } from 'ws';
import { z } from 'zod';
import { agentConfig } from '../agent/config.js';
import type { agentRequest } from '../agent/client.js';
import type { DockerDiskUsage, DockerPruneResult, HostAuditEvent, HostExecResult } from '../shared/host-admin.js';
import type { User } from '../shared/types.js';
import { AppError } from './errors.js';
import type { MaintenanceGate } from './maintenance.js';
import { hashToken, type Store } from './store.js';

interface HostAdminOptions {
  store: Store;
  administrator: (req: FastifyRequest, mutation?: boolean) => User;
  allowedOrigins: Set<string>;
  agentConnection?: { socketPath: string; token: string };
  runtimeRequest: typeof agentRequest;
  maintenance?: MaintenanceGate;
  onUpgrade?: (req: FastifyRequest) => void;
}

const pruneBodySchema = z.object({
  danglingImages: z.boolean().optional(),
  unusedImages: z.boolean().optional(),
  buildCache: z.boolean().optional(),
  stoppedContainers: z.boolean().optional(),
}).strict().refine(
  (v) => Boolean(v.danglingImages || v.unusedImages || v.buildCache || v.stoppedContainers),
  'Select at least one Docker resource category to prune',
);

const hostExecBodySchema = z.object({
  command: z.string().trim().min(1).max(2000).refine((v) => !v.includes('\0'), 'Invalid command'),
  timeoutSeconds: z.number().int().min(1).max(30).default(15),
}).strict();

const consoleTicketBodySchema = z.object({
  shell: z.enum(['/bin/sh', '/bin/bash']).default('/bin/sh'),
}).strict();

const consoleAuthSchema = z.object({
  type: z.literal('authenticate'),
  ticket: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

const terminalInputSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('input'), data: z.string().max(32768) }).strict(),
  z.object({ type: z.literal('resize'), cols: z.number().int().min(1).max(500), rows: z.number().int().min(1).max(300) }).strict(),
]);

interface HostConsoleTicket {
  shell: string;
  sessionToken: string;
  expiresAt: number;
}

export function registerHostAdmin(app: FastifyInstance, options: HostAdminOptions) {
  const { store, administrator, runtimeRequest } = options;
  const tickets = new Map<string, HostConsoleTicket>();
  const closers = new Set<() => void>();
  const stopAll = () => {
    for (const close of [...closers]) close();
    tickets.clear();
  };
  options.maintenance?.registerCloser(stopAll);
  app.addHook('onClose', async () => stopAll());

  app.get('/api/v1/host/docker/usage', async (req) => {
    administrator(req);
    return runtimeRequest<DockerDiskUsage>('/host/docker/usage', undefined, { ...options.agentConnection, timeoutMs: 20_000 });
  });

  app.post('/api/v1/host/docker/prune', async (req) => {
    const actor = administrator(req, true);
    const input = pruneBodySchema.parse(req.body ?? {});
    const result = await runtimeRequest<DockerPruneResult>('/host/docker/prune', input, { ...options.agentConnection, timeoutMs: 120_000 });
    store.recordAudit(actor.id, 'host.docker.prune', 'host');
    return result;
  });

  app.get<{ Querystring: { limit?: string; q?: string } }>('/api/v1/host/events', async (req) => {
    administrator(req);
    const limit = z.coerce.number().int().min(1).max(250).default(100).parse(req.query.limit);
    const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 120).toLowerCase() : '';
    const rows = store.db.prepare(`
      SELECT e.id, e.operation, e.resource_id AS resourceId, e.actor_id AS actorId, u.email AS actorEmail, e.created_at AS createdAt
      FROM audit_events e
      LEFT JOIN users u ON u.id = e.actor_id
      ORDER BY e.created_at DESC
      LIMIT ?
    `).all(q ? 500 : limit) as HostAuditEvent[];
    const filtered = q
      ? rows.filter((r) =>
          r.operation.toLowerCase().includes(q) ||
          r.resourceId.toLowerCase().includes(q) ||
          (r.actorEmail ?? '').toLowerCase().includes(q),
        ).slice(0, limit)
      : rows;
    return { events: filtered };
  });

  app.post('/api/v1/host/console/exec', async (req) => {
    const actor = administrator(req, true);
    const input = hostExecBodySchema.parse(req.body ?? {});
    store.recordAudit(actor.id, 'host.console.exec', 'host');
    const result = await runtimeRequest<HostExecResult>('/host/console/exec', input, { ...options.agentConnection, timeoutMs: (input.timeoutSeconds + 10) * 1000 });
    return { ...result, output: store.vault.redact(result.output) };
  });

  app.post('/api/v1/host/console-ticket', async (req) => {
    const actor = administrator(req, true);
    const input = consoleTicketBodySchema.parse(req.body ?? {});
    for (const [key, item] of tickets) if (item.expiresAt < Date.now()) tickets.delete(key);
    if (tickets.size >= 100) throw new AppError('CONSOLE_LIMIT', 'Too many pending host console grants', 429);
    const ticket = randomBytes(32).toString('hex');
    tickets.set(hashToken(ticket), {
      shell: input.shell,
      sessionToken: req.cookies.panel_session!,
      expiresAt: Date.now() + 30_000,
    });
    store.recordAudit(actor.id, 'host.console.grant', 'host');
    return { ticket };
  });

  app.get('/api/v1/host/console', {
    websocket: true,
    preValidation: async (req) => {
      if (!req.headers.origin || !options.allowedOrigins.has(req.headers.origin)) throw new AppError('ORIGIN_DENIED', 'This console origin is not allowed', 403);
      if (req.raw.url?.includes('?')) throw new AppError('INVALID_CONSOLE', 'Console URL must not contain query parameters', 400);
      const session = req.cookies.panel_session ? store.getSession(req.cookies.panel_session) : null;
      if (!session) throw new AppError('UNAUTHORIZED', 'Sign in to continue', 401);
      if (session.user.role !== 'admin') throw new AppError('FORBIDDEN', 'Administrator role required', 403);
    },
  }, (socket, req) => {
    options.onUpgrade?.(req);
    if (options.maintenance?.isDraining) {
      socket.close(1012, 'Service is temporarily unavailable');
      return;
    }
    let phase: 'authentication' | 'connecting' | 'ready' = 'authentication';
    let closed = false;
    let ticket: HostConsoleTicket | undefined;
    let upstream: WebSocket | undefined;
    let checkSession: ReturnType<typeof setInterval> | undefined;
    const timeout = setTimeout(() => {
      socket.close(1008, 'Console connection timed out');
      close();
    }, 5000);
    timeout.unref();

    const close = () => {
      if (closed) return;
      closed = true;
      clearTimeout(timeout);
      if (checkSession) clearInterval(checkSession);
      closers.delete(close);
      if (socket.readyState === WebSocket.OPEN) socket.close(1000, 'Host console ended');
      if (upstream?.readyState === WebSocket.OPEN) upstream.close();
      else if (upstream?.readyState === WebSocket.CONNECTING) upstream.terminate();
    };
    const isAdminActive = () => {
      if (!ticket) return false;
      const current = store.getSession(ticket.sessionToken);
      return Boolean(current && current.user.role === 'admin');
    };
    closers.add(close);
    socket.on('error', close);
    socket.on('close', close);
    socket.on('message', (data, isBinary) => {
      try {
        if (closed || isBinary) {
          socket.close(1008, 'Send terminal commands as JSON');
          return;
        }
        const payload = Array.isArray(data) ? Buffer.concat(data) : data instanceof ArrayBuffer ? Buffer.from(data) : data;
        let parsed: unknown;
        try { parsed = JSON.parse(payload.toString('utf8')); } catch { socket.close(1008, 'Invalid terminal command'); return; }
        if (phase === 'connecting') { socket.close(1008, 'Console is not ready'); return; }
        if (phase === 'authentication') {
          const auth = consoleAuthSchema.safeParse(parsed);
          if (!auth.success) { socket.close(1008, 'Console authentication required'); return; }
          const key = hashToken(auth.data.ticket);
          ticket = tickets.get(key);
          tickets.delete(key);
          if (!ticket || ticket.expiresAt <= Date.now() || !req.cookies.panel_session || hashToken(ticket.sessionToken) !== hashToken(req.cookies.panel_session) || !isAdminActive()) {
            socket.close(1008, 'Console grant is missing or expired');
            return;
          }
          phase = 'connecting';
          const config = options.agentConnection ?? agentConfig();
          const query = new URLSearchParams({ shell: ticket.shell });
          upstream = new WebSocket(`ws://localhost/host/console?${query}`, {
            createConnection: () => connect(config.socketPath),
            headers: { authorization: `Bearer ${config.token}` },
            handshakeTimeout: 5000,
            maxPayload: 65536,
          });
          checkSession = setInterval(() => {
            if (!closed && !isAdminActive()) close();
          }, 1000);
          checkSession.unref();
          const upstreamFailed = () => {
            if (socket.readyState === WebSocket.OPEN) socket.close(1011, 'Host console is unavailable');
            close();
          };
          upstream.on('error', upstreamFailed);
          upstream.on('close', (code) => {
            if (phase === 'ready' && code === 1000) close();
            else upstreamFailed();
          });
          upstream.on('open', () => {
            if (closed || !isAdminActive() || socket.readyState !== WebSocket.OPEN) { close(); return; }
            phase = 'ready';
            clearTimeout(timeout);
            socket.send(JSON.stringify({ type: 'ready' }), (err) => { if (err) close(); });
          });
          upstream.on('message', (chunk, binary) => {
            if (closed || !isAdminActive()) { close(); return; }
            if (socket.readyState === WebSocket.OPEN) socket.send(chunk, { binary });
          });
          return;
        }
        const valid = terminalInputSchema.safeParse(parsed);
        if (!valid.success) { socket.close(1008, 'Invalid terminal command'); return; }
        if (!isAdminActive()) { close(); return; }
        if (upstream?.readyState === WebSocket.OPEN) upstream.send(JSON.stringify(valid.data));
        else socket.close(1008, 'Console is not ready');
      } catch {
        if (socket.readyState === WebSocket.OPEN) socket.close(1011, 'Host console is unavailable');
        close();
      }
    });
  });
}
