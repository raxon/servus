import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Store } from '../apps/panel/src/server/store.js';
import { hashPassword } from '../apps/panel/src/server/auth.js';
import { assert, dataRoot, PanelApi, projectRoot, Report, runId } from './parity-lib.js';

const identity = JSON.parse(readFileSync(resolve(dataRoot, `${runId}-panel-identity.json`), 'utf8'));
const report = new Report('access', { transport: 'Real local HTTP' });
const store = new Store(resolve(projectRoot, '.data'));
const password = randomBytes(24).toString('hex');
const email = `viewer-${runId}-${randomBytes(4).toString('hex')}@localhost.test`;
const user = store.createUser(email, await hashPassword(password));
const api = new PanelApi();
try {
  await report.check('anonymous-access-denied', async () => {
    await assert.rejects(api.call(`/services/${identity.services.control}`), (error: any) => error.status === 401);
  });
  const session = await api.call('/auth/login', { email, password }); api.csrf = session.csrfToken;
  await report.check('nonmember-project-service-and-log-access-denied', async () => {
    for (const path of [`/projects/${identity.projectId}`, `/services/${identity.services.control}`, `/services/${identity.services.control}/logs`]) {
      await assert.rejects(api.call(path), (error: any) => error.status === 404);
    }
  });
  store.addMember(identity.projectId, user.id, 'viewer');
  await report.check('viewer-can-read-but-cannot-mutate-reveal-or-open-console', async () => {
    const service = await api.call(`/services/${identity.services.control}`); assert.equal(service.id, identity.services.control);
    await assert.rejects(api.call(`/services/${service.id}`, { expectedRevision: service.revision, port: 9000 }, 'PATCH'), (error: any) => error.status === 404 || error.status === 403);
    await assert.rejects(api.call(`/services/${identity.services.postgres}/connection/reveal`, {}), (error: any) => error.status === 404 || error.status === 403);
    await assert.rejects(api.call(`/services/${service.id}/console-ticket`, { containerId: 'a'.repeat(64) }), (error: any) => error.status === 404 || error.status === 403);
  });
  await report.check('logout-revokes-the-real-session', async () => {
    await api.call('/auth/logout', {});
    await assert.rejects(api.call('/auth/session'), (error: any) => error.status === 401);
  });
} finally { store.close(); }
