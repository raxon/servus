import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../../src/server/app.js';
import { Store } from '../../src/server/store.js';
import { databaseTargetPort } from '../../src/shared/database-access.js';
import type { agentRequest } from '../../src/agent/client.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), 'servus-p2b-'));
  const store = new Store(dataDir);
  const agentCalls: Array<{ path: string; body: unknown }> = [];
  const agent: typeof agentRequest = async <T>(path, body) => {
    agentCalls.push({ path, body });
    if (path.endsWith('/database/rotate-password')) return { rotated: true } as T;
    if (path.endsWith('/database-network')) return { aliases: ['db'], publishedPort: null, revision: 1 } as T;
    return {} as T;
  };
  const app = await createApp({ dataDir, store, agentRequest: agent });
  cleanup.push(async () => {
    await app.close();
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  const setup = await app.inject({ method: 'POST', url: '/api/v1/setup', payload: { email: 'admin@example.test', password: 'fixture-password' } });
  const user = setup.json().user as { id: string };
  const session = { cookie: `panel_session=${setup.cookies[0]!.value}`, 'x-csrf-token': setup.json().csrfToken };
  const project = store.createProject('db-p2b');
  return { app, store, user, session, project, agentCalls };
}

describe('P2-B managed PostgreSQL 18, MySQL, MongoDB and password rotation', () => {
  it('provisions PostgreSQL 18, MySQL 8.4 and MongoDB 7 with expected defaults and ports', async () => {
    const f = await fixture();
    expect(databaseTargetPort('mysql')).toBe(3306);
    expect(databaseTargetPort('mongodb')).toBe(27017);

    const pg18 = await f.app.inject({
      method: 'POST',
      url: `/api/v1/projects/${f.project.id}/services`,
      headers: { ...f.session, 'idempotency-key': randomUUID() },
      payload: { name: 'pg18', kind: 'postgres', image: 'postgres:18-alpine', replicas: 1, domains: [], database: { database: 'appdb', user: 'appuser' } },
    });
    expect(pg18.statusCode).toBe(202);
    expect(pg18.json().service.image).toBe('postgres:18-alpine');

    const mysql = await f.app.inject({
      method: 'POST',
      url: `/api/v1/projects/${f.project.id}/services`,
      headers: { ...f.session, 'idempotency-key': randomUUID() },
      payload: { name: 'mysql-db', kind: 'mysql', replicas: 1, domains: [] },
    });
    expect(mysql.statusCode).toBe(202);
    expect(mysql.json().service.image).toBe('mysql:8.4');
    expect(mysql.json().service.port).toBe(3306);

    const mongo = await f.app.inject({
      method: 'POST',
      url: `/api/v1/projects/${f.project.id}/services`,
      headers: { ...f.session, 'idempotency-key': randomUUID() },
      payload: { name: 'mongo-db', kind: 'mongodb', replicas: 1, domains: [] },
    });
    expect(mongo.statusCode).toBe(202);
    expect(mongo.json().service.image).toBe('mongo:7');
    expect(mongo.json().service.port).toBe(27017);
  });

  it('rotates managed database passwords atomically via agent and queues runtime secret refresh', async () => {
    const f = await fixture();
    const created = await f.app.inject({
      method: 'POST',
      url: `/api/v1/projects/${f.project.id}/services`,
      headers: { ...f.session, 'idempotency-key': randomUUID() },
      payload: { name: 'pg-rot', kind: 'postgres', image: 'postgres:18-alpine', replicas: 1, domains: [], database: { database: 'app', user: 'app' } },
    });
    const serviceId = created.json().service.id as string;

    // Mark initial deploy succeeded & running
    f.store.db.prepare("UPDATE jobs SET status='succeeded' WHERE service_id=?").run(serviceId);
    f.store.db.prepare("UPDATE actions SET status='succeeded', phase='complete', finished_at=? WHERE service_id=?").run(new Date().toISOString(), serviceId);
    f.store.db.prepare("UPDATE services SET state='running', deployed_revision=1 WHERE id=?").run(serviceId);

    const before = f.store.connectionInfo(serviceId, true).password;
    expect(before).toBeTruthy();

    const rotated = await f.app.inject({
      method: 'POST',
      url: `/api/v1/services/${serviceId}/database/rotate-password`,
      headers: f.session,
      payload: { confirm: true, password: 'NewRotatedPassword1234' },
    });
    expect(rotated.statusCode).toBe(202);
    expect(rotated.body).not.toContain('NewRotatedPassword1234');
    expect(rotated.json().service.revision).toBe(2);
    expect(rotated.json().action.type).toBe('deploy');
    expect(f.agentCalls.some(c => c.path === `/services/${serviceId}/database/rotate-password`)).toBe(true);

    // Simulate worker completing the queued secret-refresh deploy
    const deployJob = f.store.db.prepare("SELECT action_id FROM jobs WHERE service_id=? AND status='queued'").get(serviceId) as { action_id: string };
    f.store.db.prepare("UPDATE jobs SET status='succeeded' WHERE action_id=?").run(deployJob.action_id);
    f.store.db.prepare("UPDATE actions SET status='succeeded', phase='complete', finished_at=? WHERE id=?").run(new Date().toISOString(), deployJob.action_id);
    f.store.db.prepare("UPDATE services SET deployed_revision=2 WHERE id=?").run(serviceId);

    const after = f.store.connectionInfo(serviceId, true).password;
    expect(after).toBe('NewRotatedPassword1234');
    expect(after).not.toBe(before);
  });
});
