import { createConnection } from 'node:net';
import { isAbsolute } from 'node:path';
import { TextDecoder } from 'node:util';
import { z } from 'zod';

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const commit = z.string().regex(/^[0-9a-f]{40}$/);
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const tag = z.string().max(64).regex(/^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/);
const operationSchema = z.strictObject({ operationId: uuid, commit, digest, tag, status: z.enum(['accepted', 'verifying', 'verified', 'verification_failed', 'recovery_required']), createdAt: z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/) });
const errorCode = z.enum(['invalid_request', 'unauthorized', 'idempotency_conflict', 'operation_in_progress', 'not_found', 'recovery_required', 'unavailable']);
const responseSchema = z.union([z.strictObject({ ok: z.literal(true), operation: operationSchema }), z.strictObject({ ok: z.literal(false), error: errorCode })]);
const submitSchema = z.strictObject({ operationId: uuid, commit, digest, tag });
const maxResponseBytes = 4096;

export type UpdateOperation = z.infer<typeof operationSchema>;
export type UpdateSubmission = z.infer<typeof submitSchema>;
export type UpdateErrorCode = z.infer<typeof errorCode> | 'invalid_input' | 'connection_failed' | 'invalid_response' | 'timeout';
export class UpdaterClientError extends Error {
  constructor(readonly code: UpdateErrorCode, readonly certainty: 'definitive' | 'uncertain') {
    super(`Updater request failed (${code}); ${certainty === 'uncertain' ? 'the operation outcome is unknown' : 'no successful result was received'}.`);
    this.name = 'UpdaterClientError';
  }
}
export interface UpdaterClientOptions { socketPath: string; timeoutMs?: number }

// JSON.parse silently accepts duplicate object keys. Reject them before schema validation.
function parseUniqueJson(text: string): unknown {
  let position = 0;
  const whitespace = () => { while (/[\x20\x09\x0a\x0d]/.test(text[position] ?? '\0')) position++; };
  function stringToken(): string {
    const start = position;
    if (text[position++] !== '"') throw new Error('invalid JSON');
    while (position < text.length) {
      const char = text[position++]!;
      if (char === '"') return JSON.parse(text.slice(start, position)) as string;
      if (char === '\\') { if (position >= text.length) throw new Error('invalid JSON'); position++; }
    }
    throw new Error('invalid JSON');
  }
  function value(depth: number): unknown {
    if (depth > 8) throw new Error('invalid JSON');
    whitespace();
    if (text[position] === '"') return stringToken();
    if (text[position] === '{') {
      position++; const result: Record<string, unknown> = Object.create(null); const keys = new Set<string>(); whitespace();
      if (text[position] === '}') { position++; return result; }
      for (;;) {
        whitespace(); const key = stringToken();
        if (keys.has(key)) throw new Error('duplicate key');
        keys.add(key); whitespace(); if (text[position++] !== ':') throw new Error('invalid JSON');
        result[key] = value(depth + 1); whitespace();
        const separator = text[position++]; if (separator === '}') return result; if (separator !== ',') throw new Error('invalid JSON');
      }
    }
    if (text[position] === '[') {
      position++; const result: unknown[] = []; whitespace(); if (text[position] === ']') { position++; return result; }
      for (;;) { result.push(value(depth + 1)); whitespace(); const separator = text[position++]; if (separator === ']') return result; if (separator !== ',') throw new Error('invalid JSON'); }
    }
    const match = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(text.slice(position));
    if (!match) throw new Error('invalid JSON');
    position += match[0].length; return JSON.parse(match[0]) as unknown;
  }
  const parsed = value(0); whitespace(); if (position !== text.length) throw new Error('invalid JSON'); return parsed;
}

async function request(action: 'submit' | 'status' | 'retry', input: UpdateSubmission | { operationId: string }, options: UpdaterClientOptions): Promise<UpdateOperation> {
  const validInput = action === 'submit' ? submitSchema.safeParse(input) : z.strictObject({ operationId: uuid }).safeParse(input);
  const timeout = options.timeoutMs ?? 5000;
  if (!validInput.success || typeof options.socketPath !== 'string' || !isAbsolute(options.socketPath) || options.socketPath.includes('\0') || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120000) throw new UpdaterClientError('invalid_input', 'definitive');
  const payload = Buffer.from(JSON.stringify({ version: 1, action, ...validInput.data }) + '\n');
  return new Promise((resolve, reject) => {
    let dispatched = false, settled = false, length = 0;
    const chunks: Buffer[] = [];
    const socket = createConnection({ path: options.socketPath });
    const finish = (error?: UpdaterClientError, operation?: UpdateOperation) => {
      if (settled) return;
      settled = true; clearTimeout(timer); socket.destroy();
      if (error) reject(error); else resolve(operation!);
    };
    const fail = (code: UpdateErrorCode) => finish(new UpdaterClientError(code, dispatched ? 'uncertain' : 'definitive'));
    const timer = setTimeout(() => fail('timeout'), timeout);
    socket.once('connect', () => { dispatched = true; socket.write(payload); });
    socket.on('data', (chunk: Buffer) => {
      length += chunk.length;
      if (length > maxResponseBytes) { fail('invalid_response'); return; }
      chunks.push(chunk);
    });
    socket.once('end', () => {
      const bytes = Buffer.concat(chunks);
      if (bytes.length === 0 || bytes[bytes.length - 1] !== 10 || bytes.subarray(0, -1).includes(10)) { fail('invalid_response'); return; }
      let data: unknown;
      try { data = parseUniqueJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, -1))); }
      catch { fail('invalid_response'); return; }
      const parsed = responseSchema.safeParse(data);
      if (!parsed.success) { fail('invalid_response'); return; }
      if (!parsed.data.ok) {
        const certainty = parsed.data.error === 'unavailable' ? 'uncertain' : 'definitive';
        finish(new UpdaterClientError(parsed.data.error, certainty)); return;
      }
      const operation = parsed.data.operation;
      if (operation.operationId !== validInput.data.operationId || (action === 'submit' && (operation.commit !== (validInput.data as UpdateSubmission).commit || operation.digest !== (validInput.data as UpdateSubmission).digest || operation.tag !== (validInput.data as UpdateSubmission).tag))) { fail('invalid_response'); return; }
      finish(undefined, operation);
    });
    socket.once('error', () => fail('connection_failed'));
    socket.once('close', () => { if (!settled) fail('connection_failed'); });
  });
}

export function submitUpdate(input: UpdateSubmission, options: UpdaterClientOptions): Promise<UpdateOperation> { return request('submit', input, options); }
export function updateStatus(operationId: string, options: UpdaterClientOptions): Promise<UpdateOperation> { return request('status', { operationId }, options); }
export function retryUpdate(operationId: string, options: UpdaterClientOptions): Promise<UpdateOperation> { return request('retry', { operationId }, options); }
