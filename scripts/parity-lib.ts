import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { request } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';

export { assert, delay };
export const projectRoot = resolve(import.meta.dirname, '..');
export const dataRoot = resolve(projectRoot, '.data/parity');
mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
export const runId = process.env.PARITY_RUN_ID || new Date().toISOString().replace(/\D/g, '').slice(0, 14);
assert(/^[a-z0-9][a-z0-9-]{0,30}$/.test(runId), 'PARITY_RUN_ID must be a short lowercase identifier');
const reportSuffix = process.env.PARITY_REPLAY === '1' ? '-after-restart' : '';
export interface Check { id: string; status: 'passed' | 'failed'; detail?: unknown }
export class Report {
  readonly checks: Check[] = [];
  constructor(readonly target: string, readonly metadata: Record<string, unknown> = {}) {
    const previous = resolve(projectRoot, `artifacts/parity/${runId}/${target}${reportSuffix}.json`);
    if (process.env.PARITY_RESUME === '1' && existsSync(previous)) this.checks.push(...JSON.parse(readFileSync(previous, 'utf8')).checks);
  }
  async check(id: string, execute: () => unknown | Promise<unknown>) {
    if (process.env.PARITY_ONLY && !process.env.PARITY_ONLY.split(',').includes(id)) return;
    const previous = this.checks.findIndex(check => check.id === id); if (previous >= 0) this.checks.splice(previous, 1);
    try { const detail = await execute(); this.checks.push({ id, status: 'passed', ...(detail === undefined ? {} : { detail }) }); console.log(`PASS ${this.target}: ${id}`); }
    catch (error) { this.checks.push({ id, status: 'failed', detail: error instanceof Error ? error.message : String(error) }); throw error; }
    finally { this.save(); }
  }
  save() {
    const output = resolve(projectRoot, `artifacts/parity/${runId}`);
    mkdirSync(output, { recursive: true });
    writeFileSync(resolve(output, `${this.target}${reportSuffix}.json`), JSON.stringify({ runId, target: this.target, phase: reportSuffix ? 'after-restart' : 'initial', checkedAt: new Date().toISOString(), ...this.metadata, checks: this.checks, passed: this.checks.filter(item => item.status === 'passed').length, failed: this.checks.filter(item => item.status === 'failed').length }, null, 2));
  }
}

export function docker(context: string, args: string[], input?: string | Buffer): string {
  return execFileSync('docker', ['--context', context, ...args], { encoding: 'utf8', input, maxBuffer: 8 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}
export function containerId(context: string, name: string) {
  const ids = docker(context, ['ps', '--filter', `label=com.docker.swarm.service.name=${name}`, '--format', '{{.ID}}']).split('\n').filter(Boolean);
  assert.equal(ids.length, 1, `Expected one running container for ${name}`);
  return ids[0]!;
}
export async function eventually<T>(description: string, execute: () => Promise<T> | T, accept: (value: T) => boolean, timeout = 180000): Promise<T> {
  const deadline = Date.now() + timeout;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try { const result = await execute(); if (accept(result)) return result; }
    catch (error) { lastError = error; }
    await delay(500);
  }
  throw new Error(`Timed out: ${description}${lastError instanceof Error ? ` (${lastError.message})` : ''}`);
}
export function route(port: number, hostname: string, path = '/', body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; text: string; json: any; headers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    const req = request({ hostname: '127.0.0.1', port, path, method: data ? 'POST' : 'GET', headers: { host: hostname, ...(data ? { 'content-type': 'application/json', 'content-length': String(data.length) } : {}), ...headers }, timeout: 5000 }, response => {
      let text = ''; response.setEncoding('utf8'); response.on('data', chunk => text += chunk);
      response.on('end', () => { let json; try { json = JSON.parse(text); } catch {} resolve({ status: response.statusCode || 0, text, json, headers: response.headers }); });
    });
    req.on('timeout', () => req.destroy(new Error('HTTP route timed out'))); req.on('error', reject); req.end(data);
  });
}
export async function healthy(port: number, hostname: string) { return eventually(`healthy route ${hostname}`, () => route(port, hostname, '/health'), response => response.status === 200); }

export class PanelApi {
  cookie = ''; csrf = '';
  constructor(readonly base = 'http://localhost:4180') {}
  async call<T = any>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST', key?: string): Promise<T> {
    const response = await fetch(`${this.base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', cookie: this.cookie, 'x-csrf-token': this.csrf, ...(key ? { 'idempotency-key': key } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const cookie = response.headers.get('set-cookie'); if (cookie) this.cookie = cookie.split(';')[0]!;
    const value = await response.json();
    if (!response.ok) throw Object.assign(new Error(value.error?.message || `HTTP ${response.status}`), { status: response.status, code: value.error?.code });
    return value as T;
  }
  async login() {
    const credentials = JSON.parse(readFileSync(resolve(projectRoot, '.data/local-credentials.json'), 'utf8'));
    this.csrf = (await this.call('/auth/login', { email: credentials.email, password: credentials.password })).csrfToken;
  }
  async wait(action: { id: string }, expected = 'succeeded') {
    const result = await eventually(`action ${action.id}`, () => this.call(`/actions/${action.id}`), value => ['succeeded', 'failed', 'cancelled'].includes(value.action.status), 360000);
    assert.equal(result.action.status, expected, result.action.error || 'Unexpected action result');
    return result;
  }
}

/** Adapts the reference HTTP interface without importing its implementation. */
export class ReferenceApi {
  token = '';
  readonly credentials = JSON.parse(readFileSync(process.env.REFERENCE_CREDENTIALS_FILE || resolve(projectRoot, '../local-image/local-credentials.json'), 'utf8'));
  async call(operation: string, data?: unknown, query = false): Promise<any> {
    const suffix = query && data ? `?${new URLSearchParams(data as Record<string, string>)}` : '';
    const response = await fetch(`${this.credentials.url}/api/${operation}${suffix}`, { method: data === undefined || query ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) }, body: data === undefined || query ? undefined : JSON.stringify(data) });
    const text = await response.text(); let value: any; try { value = JSON.parse(text); } catch { value = text; }
    if (!response.ok) throw Object.assign(new Error(`${operation}: ${JSON.stringify(value).slice(0, 700)}`), { status: response.status });
    return value;
  }
  async login() { this.token = (await this.call('login', { email: this.credentials.email, password: this.credentials.password })).token; }
}
