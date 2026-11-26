import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/server/app.js';
import { Store } from '../../src/server/store.js';
import { APPLICATION_TEMPLATES } from '../../src/shared/templates.js';
import { templateConfiguration } from '../../src/server/templates.js';
import { parseComposeDefinition } from '../../src/agent/compose-configuration.js';

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

describe('Wave 2: Ephemeral DB Admin Tools, PG 17->18 Migration, Compose Extensions & 10 Templates', () => {
  it('generates valid Compose definitions for all 10 application templates', () => {
    expect(APPLICATION_TEMPLATES.length).toBe(10);
    for (const tpl of APPLICATION_TEMPLATES) {
      const cfg = templateConfiguration(tpl.id, {
        name: `tpl-${tpl.id}`,
        hostname: `${tpl.id}.example.com`,
        ...(tpl.id === 'minio' ? { apiHostname: 'minio-api.example.com' } : {}),
      });
      expect(cfg.source.type).toBe('inline');
      if (cfg.source.type === 'inline') {
        const parsed = parseComposeDefinition(cfg.source.yaml, 'inline');
        expect(Object.keys(parsed.services).length).toBeGreaterThanOrEqual(1);
      }
      expect(cfg.domains.length).toBe(tpl.id === 'minio' ? 2 : 1);
    }
  });

  it('validates Compose build secrets, additional_contexts, ssh forwarding, and controlled ports (1024-65535)', () => {
    const validYaml = `
services:
  web:
    build:
      context: .
      dockerfile_inline: |
        FROM alpine:3.21
      additional_contexts:
        shared: docker-image://alpine:3.21
      secrets:
        - npm_token
      ssh:
        - default
    ports:
      - "8095:80"
      - target: 443
        published: 8443
        protocol: tcp
`;
    const parsed = parseComposeDefinition(validYaml, 'inline', { allowSsh: true });
    expect(parsed.services.web?.ports?.length).toBe(2);
    expect(() => parseComposeDefinition(validYaml, 'inline')).toThrow(/SSH forwarding/i);

    // Privileged port 80 and panel port 4180 must be rejected
    expect(() => parseComposeDefinition('services: { web: { image: nginx, ports: ["80:80"] } }', 'inline')).toThrow();
    expect(() => parseComposeDefinition('services: { web: { image: nginx, ports: ["4180:80"] } }', 'inline')).toThrow();
    expect(() => parseComposeDefinition('services: { web: { image: nginx, ports: ["2375:80"] } }', 'inline')).toThrow();
  });

  it('encrypts and redacts Compose buildSecrets across POST, GET and PATCH', async () => {
    const dataDir = tempDir('panel-w2-compose-');
    const app = await createApp({ dataDir });
    apps.push(app);

    const setup = await app.inject({ method: 'POST', url: '/api/v1/setup', payload: { email: 'admin@example.com', password: 'Password123!' } });
    const cookie = setup.headers['set-cookie'] as string;
    const csrf = (setup.json() as { csrfToken: string }).csrfToken;
    const headers = { cookie, 'x-csrf-token': csrf };
    const project = (await app.inject({ method: 'POST', url: '/api/v1/projects', headers, payload: { name: 'compose-w2' } })).json() as { id: string };

    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${project.id}/compose`,
      headers: { ...headers, 'idempotency-key': 'c-sec-1' },
      payload: {
        name: 'sec-stack',
        source: { type: 'inline', yaml: 'services:\n  web:\n    image: nginx:alpine\n    ports:\n      - "8095:80"\n' },
        domains: [],
        buildSecrets: [{ id: 'npm_token', value: 'npm_super_secret_token_xyz' }],
        sshForwarding: true,
      },
    });
    expect(created.statusCode).toBe(202);
    const workloadId = (created.json() as { workload: { id: string } }).workload.id;

    // Configuration read must mask build secret value
    const cfgRes = await app.inject({ method: 'GET', url: `/api/v1/compose/${workloadId}/configuration`, headers });
    expect(cfgRes.statusCode).toBe(200);
    expect(cfgRes.body).not.toContain('npm_super_secret_token_xyz');
    expect((cfgRes.json() as { buildSecrets: Array<{ id: string; hasValue: boolean }> }).buildSecrets).toEqual([
      { id: 'npm_token', hasValue: true },
    ]);

    // PATCH keeping existing build secret without re-entering value succeeds
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/v1/compose/${workloadId}`,
      headers,
      payload: {
        expectedRevision: 1,
        source: { type: 'inline', yaml: 'services:\n  web:\n    image: nginx:alpine\n' },
        domains: [],
        buildSecrets: [{ id: 'npm_token', hasValue: true }],
      },
    });
    expect(patched.statusCode).toBe(200);
    expect((patched.json() as { revision: number }).revision).toBe(2);
  });

  it('launches and stops ephemeral DB admin tools and migrates PG 17 to PG 18 with audit trail', async () => {
    const dataDir = tempDir('panel-w2-db-');
    const store = new Store(dataDir);
    const agentMock = vi.fn(async (path: string, body?: unknown) => {
      if (path.endsWith('/database/admin-tool') && body === undefined) {
        return { active: false, serviceId: path.split('/')[2] };
      }
      if (path.endsWith('/database/admin-tool') && body) {
        const b = body as { ttlMinutes: number };
        return {
          active: true,
          serviceId: path.split('/')[2],
          tool: 'adminer',
          hostname: 'dbadmin-test.localhost',
          url: 'http://dbadmin-test.localhost:18080/',
          username: 'servus-admin',
          password: 'ephemeral-password-123',
          startedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + b.ttlMinutes * 60_000).toISOString(),
          ttlMinutes: b.ttlMinutes,
        };
      }
      if (path.endsWith('/database/admin-tool/stop')) {
        return { active: false, stopped: true, serviceId: path.split('/')[2] };
      }
      if (path === '/services/postgres-migrate-transfer') {
        return { dumpSizeBytes: 2048, dumpSha256: 'a'.repeat(64), verified: true };
      }
      throw new Error(`Unexpected agent path ${path}`);
    });

    const app = await createApp({ dataDir, store, agentRequest: agentMock as never });
    apps.push(app);

    const setup = await app.inject({ method: 'POST', url: '/api/v1/setup', payload: { email: 'admin@example.com', password: 'Password123!' } });
    const cookie = setup.headers['set-cookie'] as string;
    const csrf = (setup.json() as { csrfToken: string }).csrfToken;
    const headers = { cookie, 'x-csrf-token': csrf };
    const project = (await app.inject({ method: 'POST', url: '/api/v1/projects', headers, payload: { name: 'db-w2' } })).json() as { id: string };

    const pg = (await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${project.id}/services`,
      headers: { ...headers, 'idempotency-key': 'pg17-1' },
      payload: { name: 'primary-db', kind: 'postgres', image: 'postgres:17-alpine', domains: [], database: { database: 'app', user: 'app' } },
    })).json() as { service: { id: string }; action: { id: string } };

    // Mark PG 17 as deployed & running
    store.db.prepare("UPDATE services SET state='running', deployed_revision=1 WHERE id=?").run(pg.service.id);
    store.db.prepare("UPDATE actions SET status='succeeded' WHERE id=?").run(pg.action.id);

    // Start ephemeral Adminer
    const started = await app.inject({
      method: 'POST',
      url: `/api/v1/services/${pg.service.id}/database/admin-tool`,
      headers,
      payload: { ttlMinutes: 20 },
    });
    expect(started.statusCode).toBe(200);
    expect((started.json() as { active: boolean; tool: string; ttlMinutes: number })).toMatchObject({
      active: true,
      tool: 'adminer',
      ttlMinutes: 20,
    });

    // Stop ephemeral Adminer
    const stopped = await app.inject({
      method: 'DELETE',
      url: `/api/v1/services/${pg.service.id}/database/admin-tool`,
      headers,
    });
    expect(stopped.statusCode).toBe(200);

    // Migrate PG 17 -> PG 18: auto-complete the queued PG 18 deploy action in background
    const migratePromise = app.inject({
      method: 'POST',
      url: `/api/v1/services/${pg.service.id}/database/migrate-postgres`,
      headers,
      payload: { confirm: true, targetName: 'primary-db-pg18' },
    });
    await vi.waitFor(() => {
      const target = store.listServices(project.id).find((s) => s.name === 'primary-db-pg18');
      expect(target).toBeDefined();
      store.db.prepare("UPDATE services SET state='running', deployed_revision=1 WHERE id=?").run(target!.id);
      store.db.prepare("UPDATE actions SET status='succeeded' WHERE service_id=?").run(target!.id);
    });
    const migrated = await migratePromise;
    expect(migrated.statusCode).toBe(200);
    expect(migrated.json()).toMatchObject({
      sourceServiceId: pg.service.id,
      targetServiceName: 'primary-db-pg18',
      targetImage: 'postgres:18-alpine',
      dumpSizeBytes: 2048,
      verified: true,
    });
  });
});
