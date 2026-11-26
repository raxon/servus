import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import * as tar from 'tar';
import { createApp } from '../../src/server/app.js';
import { extractSourceArchive, generateBuilderDockerfile } from '../../src/agent/builders.js';
import { execHostCommand } from '../../src/agent/host-admin.js';
import { SecretVault } from '../../src/shared/secrets.js';
import { Store } from '../../src/server/store.js';

const dirs: string[] = [];
const apps: Array<Awaited<ReturnType<typeof createApp>>> = [];

afterEach(async () => {
  for (const app of apps.splice(0).reverse()) await app.close();
  for (const dir of dirs.splice(0).reverse()) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

async function createTarGzBuffer(files: Record<string, string>, rootFolder?: string): Promise<Buffer> {
  const src = tempDir('tar-src-');
  const out = join(tempDir('tar-out-'), 'archive.tar.gz');
  const base = rootFolder ? join(src, rootFolder) : src;
  mkdirSync(base, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const target = join(base, name);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, content, 'utf8');
  }
  await tar.create({ gzip: true, file: out, cwd: src }, rootFolder ? [rootFolder] : Object.keys(files));
  return readFileSync(out);
}

describe('Wave 1: Auto-builders, inline Dockerfile, code uploads, Remote MCP, and Host Admin', () => {
  it('auto-detects Node, Python, Go, Rust, PHP and Static stacks for railpack/nixpacks/buildpacks/auto', () => {
    const cases: Array<{ name: string; files: Record<string, string>; expectedStack: string; expectedFrom: string; builder: 'auto' | 'railpack' | 'nixpacks' | 'buildpacks' }> = [
      { name: 'node', files: { 'package.json': JSON.stringify({ name: 'demo', scripts: { start: 'node index.js' } }), 'index.js': 'console.log(1);' }, expectedStack: 'node', expectedFrom: 'FROM node:22-alpine', builder: 'railpack' },
      { name: 'python', files: { 'requirements.txt': 'fastapi\nuvicorn\n', 'main.py': 'app = None' }, expectedStack: 'python', expectedFrom: 'FROM python:3.12-slim', builder: 'nixpacks' },
      { name: 'go', files: { 'go.mod': 'module demo\ngo 1.23\n', 'main.go': 'package main' }, expectedStack: 'go', expectedFrom: 'FROM golang:1.23-alpine', builder: 'buildpacks' },
      { name: 'rust', files: { 'Cargo.toml': '[package]\nname="demo"\nversion="0.1.0"\n' }, expectedStack: 'rust', expectedFrom: 'FROM rust:1.83-alpine', builder: 'auto' },
      { name: 'php', files: { 'index.php': '<?php echo "ok";' }, expectedStack: 'php', expectedFrom: 'FROM php:8.3-apache', builder: 'railpack' },
      { name: 'static', files: { 'index.html': '<h1>Hello</h1>' }, expectedStack: 'static', expectedFrom: 'FROM nginx:alpine', builder: 'auto' },
    ];

    for (const c of cases) {
      const ctx = tempDir(`builder-${c.name}-`);
      const ws = tempDir(`builder-ws-${c.name}-`);
      for (const [f, content] of Object.entries(c.files)) writeFileSync(join(ctx, f), content, 'utf8');
      const plan = generateBuilderDockerfile(ctx, ws, c.builder, 3000);
      expect(plan.stack).toBe(c.expectedStack);
      expect(plan.builder).toBe(c.builder);
      expect(plan.dockerfileContent).toContain(c.expectedFrom);
      expect(existsSync(plan.dockerfilePath)).toBe(true);
    }
  });

  it('safely extracts valid .tar.gz archives, unwraps single top folder, and rejects invalid gzip', async () => {
    const buf = await createTarGzBuffer({ 'index.html': '<h1>Uploaded</h1>' }, 'my-app-main');
    const archivePath = join(tempDir('upload-file-'), 'app.tar.gz');
    writeFileSync(archivePath, buf);
    const dest = tempDir('upload-dest-');
    await extractSourceArchive(archivePath, dest);
    expect(readFileSync(join(dest, 'index.html'), 'utf8')).toBe('<h1>Uploaded</h1>');

    const badPath = join(tempDir('bad-file-'), 'bad.tar.gz');
    writeFileSync(badPath, Buffer.from('not a gzip file'));
    await expect(extractSourceArchive(badPath, tempDir('bad-dest-'))).rejects.toThrow(/valid \.tar\.gz/i);
  });

  it('supports inline Dockerfile and code upload APIs with strict cross-project isolation', async () => {
    const dataDir = tempDir('panel-w1-');
    const app = await createApp({ dataDir });
    apps.push(app);

    const setup = await app.inject({ method: 'POST', url: '/api/v1/setup', payload: { email: 'admin@example.com', password: 'Password123!' } });
    expect(setup.statusCode).toBe(200);
    const cookie = setup.headers['set-cookie'] as string;
    const csrf = (setup.json() as { csrfToken: string }).csrfToken;
    const headers = { cookie, 'x-csrf-token': csrf };

    const p1 = (await app.inject({ method: 'POST', url: '/api/v1/projects', headers, payload: { name: 'proj-one' } })).json() as { id: string };
    const p2 = (await app.inject({ method: 'POST', url: '/api/v1/projects', headers, payload: { name: 'proj-two' } })).json() as { id: string };

    // Inline Dockerfile validation (must contain FROM)
    const badDf = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${p1.id}/services`,
      headers: { ...headers, 'idempotency-key': 'df-bad' },
      payload: { name: 'bad-df', hostname: 'bad.localhost', port: 80, source: { type: 'dockerfile', dockerfileContent: 'RUN echo hi' } },
    });
    expect(badDf.statusCode).toBe(400);

    // Valid Inline Dockerfile service
    const goodDf = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${p1.id}/services`,
      headers: { ...headers, 'idempotency-key': 'df-good' },
      payload: { name: 'inline-web', hostname: 'inline.localhost', port: 80, source: { type: 'dockerfile', dockerfileContent: 'FROM nginx:alpine\nEXPOSE 80\n' } },
    });
    expect(goodDf.statusCode).toBe(202);
    expect((goodDf.json() as { service: { source: { type: string } } }).service.source.type).toBe('dockerfile');

    // Upload archive via binary stream
    const archiveBuf = await createTarGzBuffer({ 'index.html': '<h1>Hi</h1>' });
    const uploaded = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${p1.id}/source-uploads`,
      headers: { ...headers, 'content-type': 'application/gzip', 'x-upload-filename': 'site.tar.gz' },
      payload: archiveBuf,
    });
    expect(uploaded.statusCode).toBe(201);
    const rec = uploaded.json() as { id: string; filename: string; sha256: string };
    expect(rec.filename).toBe('site.tar.gz');

    // Cross-project upload reuse must fail with 404
    const cross = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${p2.id}/services`,
      headers: { ...headers, 'idempotency-key': 'cross-up' },
      payload: { name: 'stolen', hostname: 'stolen.localhost', port: 80, source: { type: 'upload', uploadId: rec.id, builder: 'railpack' } },
    });
    expect(cross.statusCode).toBe(404);

    // Same-project upload succeeds with builder railpack
    const same = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${p1.id}/services`,
      headers: { ...headers, 'idempotency-key': 'same-up' },
      payload: { name: 'uploaded-web', hostname: 'uploaded.localhost', port: 80, source: { type: 'upload', uploadId: rec.id, builder: 'railpack' } },
    });
    expect(same.statusCode).toBe(202);
    expect((same.json() as { service: { source: { type: string; builder: string; sha256: string } } }).service.source).toMatchObject({
      type: 'upload',
      builder: 'railpack',
      sha256: rec.sha256,
    });

    // Reject non-gzip upload
    const nonGzip = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${p1.id}/source-uploads`,
      headers: { ...headers, 'content-type': 'application/json' },
      payload: { filename: 'fake.tar.gz', contentBase64: Buffer.from('not-a-gzip-archive-1234567890').toString('base64') },
    });
    expect(nonGzip.statusCode).toBe(400);
  });

  it('serves remote Streamable HTTP MCP at /api/v1/mcp with strict project token scoping', async () => {
    const dataDir = tempDir('panel-mcp-');
    const app = await createApp({ dataDir });
    apps.push(app);

    const setup = await app.inject({ method: 'POST', url: '/api/v1/setup', payload: { email: 'admin@example.com', password: 'Password123!' } });
    const cookie = setup.headers['set-cookie'] as string;
    const csrf = (setup.json() as { csrfToken: string }).csrfToken;
    const headers = { cookie, 'x-csrf-token': csrf };

    const p1 = (await app.inject({ method: 'POST', url: '/api/v1/projects', headers, payload: { name: 'mcp-proj' } })).json() as { id: string };
    const readTok = (await app.inject({ method: 'POST', url: '/api/v1/auth/api-tokens', headers, payload: { projectId: p1.id, name: 'mcp-read', scope: 'read' } })).json() as { token: string };

    // Unauthenticated MCP request fails
    const unauth = await app.inject({
      method: 'POST',
      url: '/api/v1/mcp',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
    });
    expect(unauth.statusCode).toBe(401);

    // tools/list succeeds with read token
    const listRes = await app.inject({
      method: 'POST',
      url: '/api/v1/mcp',
      headers: { authorization: `Bearer ${readTok.token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      payload: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    });
    expect(listRes.statusCode).toBe(200);
    const listBody = listRes.json() as { result: { tools: Array<{ name: string }> } };
    expect(listBody.result.tools.some((t) => t.name === 'list_projects')).toBe(true);

    // tools/call list_projects returns authorized project
    const callRes = await app.inject({
      method: 'POST',
      url: '/api/v1/mcp',
      headers: { authorization: `Bearer ${readTok.token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      payload: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_projects', arguments: {} } },
    });
    expect(callRes.statusCode).toBe(200);
    const callBody = callRes.json() as { result: { isError?: boolean; content: Array<{ text: string }> } };
    expect(callBody.result.isError).not.toBe(true);
    expect(callBody.result.content[0]?.text).toContain('mcp-proj');

    // Mutation tool via read-only token must fail closed with isError: true
    const mutateRes = await app.inject({
      method: 'POST',
      url: '/api/v1/mcp',
      headers: { authorization: `Bearer ${readTok.token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      payload: { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'create_compose', arguments: { projectId: p1.id, name: 'x', yaml: 'services:\n  a:\n    image: nginx:alpine\n', idempotencyKey: 'k1' } } },
    });
    expect(mutateRes.statusCode).toBe(200);
    expect((mutateRes.json() as { result: { isError?: boolean } }).result.isError).toBe(true);
  });

  it('enforces admin-only host administration APIs, audit events, and secret redaction in host exec', async () => {
    const dataDir = tempDir('panel-host-');
    const store = new Store(dataDir);
    const agentMock = vi.fn(async (path: string, body?: unknown) => {
      if (path === '/host/docker/usage') {
        return {
          sampledAt: new Date().toISOString(),
          images: { count: 2, totalSizeBytes: 500, reclaimableBytes: 200, items: [] },
          containers: { count: 1, runningCount: 1, stoppedCount: 0, totalSizeBytes: 50, reclaimableBytes: 0 },
          volumes: { count: 1, activeCount: 1, totalSizeBytes: 100 },
          buildCache: { count: 1, totalSizeBytes: 300, reclaimableBytes: 300 },
          totalBytes: 950,
          totalReclaimableBytes: 500,
        };
      }
      if (path === '/host/docker/prune') {
        return { imagesDeleted: 1, containersDeleted: 0, buildCacheReclaimedBytes: 300, totalReclaimedBytes: 500, completedAt: new Date().toISOString() };
      }
      if (path === '/host/console/exec') {
        const req = body as { command: string };
        return execHostCommand(req.command, 5, '/var/run/docker.sock', store.vault);
      }
      throw new Error(`Unexpected agent path ${path}`);
    });

    const app = await createApp({ dataDir, store, agentRequest: agentMock as never });
    apps.push(app);

    const setup = await app.inject({ method: 'POST', url: '/api/v1/setup', payload: { email: 'admin@example.com', password: 'Password123!' } });
    const cookie = setup.headers['set-cookie'] as string;
    const csrf = (setup.json() as { csrfToken: string }).csrfToken;
    const headers = { cookie, 'x-csrf-token': csrf };

    // Store a secret in vault and ensure host exec redacts it
    store.vault.setGithubConnection('bot', 'ghp_super_secret_host_console_token_999');

    const usage = await app.inject({ method: 'GET', url: '/api/v1/host/docker/usage', headers });
    expect(usage.statusCode).toBe(200);
    expect((usage.json() as { totalReclaimableBytes: number }).totalReclaimableBytes).toBe(500);

    // Empty prune payload must be rejected with 400
    const badPrune = await app.inject({ method: 'POST', url: '/api/v1/host/docker/prune', headers, payload: {} });
    expect(badPrune.statusCode).toBe(400);

    const prune = await app.inject({ method: 'POST', url: '/api/v1/host/docker/prune', headers, payload: { danglingImages: true, buildCache: true } });
    expect(prune.statusCode).toBe(200);
    expect((prune.json() as { totalReclaimedBytes: number }).totalReclaimedBytes).toBe(500);

    const exec = await app.inject({
      method: 'POST',
      url: '/api/v1/host/console/exec',
      headers,
      payload: { command: 'echo "ok ghp_super_secret_host_console_token_999"', timeoutSeconds: 5 },
    });
    expect(exec.statusCode).toBe(200);
    const execJson = exec.json() as { exitCode: number; output: string };
    expect(execJson.exitCode).toBe(0);
    expect(execJson.output).toContain('ok');
    expect(execJson.output).not.toContain('ghp_super_secret_host_console_token_999');

    const events = await app.inject({ method: 'GET', url: '/api/v1/host/events?q=host.', headers });
    expect(events.statusCode).toBe(200);
    const ops = (events.json() as { events: Array<{ operation: string }> }).events.map((e) => e.operation);
    expect(ops).toContain('host.docker.prune');
    expect(ops).toContain('host.console.exec');

    // Member cannot access host admin endpoints
    const memberUser = store.createUser('member@example.com', 'hash', 'member');
    const memberSession = store.createSession(memberUser.id, false)!;
    const memberRes = await app.inject({
      method: 'GET',
      url: '/api/v1/host/docker/usage',
      headers: { cookie: `panel_session=${memberSession.token}` },
    });
    expect(memberRes.statusCode).toBe(403);

    // Unused gzipSync reference check
    expect(gzipSync(Buffer.from('ok'))[0]).toBe(0x1f);
  });
});
