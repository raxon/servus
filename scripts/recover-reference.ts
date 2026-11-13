import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { assert, dataRoot, eventually, ReferenceApi, Report, route, runId } from './parity-lib.js';

const api = new ReferenceApi(); await api.login();
const report = new Report('reference-recovery', { reason: 'Measured clean-exit applications did not automatically restart. This is operator recovery, not automatic recovery.' });
await report.check('operator-restores-completed-wordpress-and-existing-nginx-demo', async () => {
  for (const [projectName, serviceName] of [[`parity-${runId}`, 'wordpress'], ['local-check-1', 'web']]) {
    await api.call('restartAppService', { projectName, serviceName });
  }
  await eventually('original Nginx demo restored', () => route(80, 'demo.localhost'), response => response.status === 200 && response.text.includes('Welcome to nginx'));
});
await report.check('wordpress-content-media-and-account-survived-despite-stopped-process', async () => {
  const data = JSON.parse(readFileSync(resolve(dataRoot, `${runId}-reference-wordpress.json`), 'utf8'));
  const authentication = JSON.parse(readFileSync(resolve(dataRoot, `${runId}-reference-wp-auth.json`), 'utf8'));
  const host = `wp-reference-${runId}.localhost:80`;
  await eventually('WordPress restored', () => route(80, host, `/?p=${data.post}`), response => response.status === 200 && response.text.includes(`Parity ${runId}`));
  assert.equal((await route(80, host, data.media)).status, 200);
  const user = await route(80, host, '/?rest_route=/wp/v2/users/me', undefined, { authorization: `Basic ${Buffer.from(`parityadmin:${authentication.password}`).toString('base64')}` });
  assert.equal(user.status, 200); assert.equal(user.json.slug, 'parityadmin');
  const project = await api.call('inspectProject', { projectName: `parity-${runId}` }, true); assert(project.services.some((item: any) => item.name === 'control'));
});
