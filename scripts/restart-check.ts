import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { assert, dataRoot, eventually, healthy, PanelApi, ReferenceApi, Report, route, runId } from './parity-lib.js';

const selected = process.env.PARITY_RESTART_TARGET || 'both';
assert(['panel', 'reference', 'both'].includes(selected), 'Select panel, reference or both');
assert(process.env.PARITY_RUN_ID, 'Set PARITY_RUN_ID to a completed fixture run before restarting its VMs');
for (const name of ['panel', 'reference'] as const) {
  if (selected !== 'both' && selected !== name) continue;
  const profile = name === 'panel' ? 'panel-dev' : 'panel-local';
  const port = name === 'panel' ? 18080 : 80;
  const hostname = `${name}-${runId}.localhost`;
  const host = `wp-${hostname}:${port}`;
  const content = JSON.parse(readFileSync(resolve(dataRoot, `${runId}-${name}-wordpress.json`), 'utf8'));
  const authorization = JSON.parse(readFileSync(resolve(dataRoot, `${runId}-${name}-wp-auth.json`), 'utf8'));
  const report = new Report(`${name}-restart`, { profile, scope: 'Existing dedicated local VM only' });
  const counterFile = resolve(dataRoot, `${runId}-${name}-counter.json`);
  const expectedCounter = existsSync(counterFile) ? JSON.parse(readFileSync(counterFile, 'utf8')).value : 1;
  await report.check('pre-restart-fixtures-ready', async () => {
    await healthy(port, hostname);
    assert.equal((await route(port, hostname, '/version')).json.version, 'v2');
    assert.equal((await route(port, hostname, '/record')).json.records[0].value, 'persisted');
    assert.equal((await route(port, hostname, '/counter')).json.counter, expectedCounter);
    assert.equal((await route(port, hostname, '/file')).json.value, 'persistent-marker');
  });
  await report.check('dedicated-vm-stop-start', async () => {
    execFileSync('colima', ['stop', profile], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 });
    execFileSync('colima', ['start', profile, '--activate=false'], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 240000 });
    await healthy(port, hostname);
  });
  await report.check('application-databases-domains-and-files-after-restart', async () => {
    assert.equal((await route(port, hostname, '/version')).json.version, 'v2');
    assert.equal((await route(port, `alias-${hostname}`, '/version')).json.version, 'v2');
    assert.equal((await route(port, hostname, '/record')).json.records[0].value, 'persisted');
    assert.equal((await route(port, hostname, '/counter')).json.counter, expectedCounter);
    assert.equal((await route(port, hostname, '/file')).json.value, 'persistent-marker');
  });
  await report.check('wordpress-post-media-and-authentication-after-restart', async () => {
    await eventually('WordPress recovered', () => route(port, host, `/?p=${content.post}`), value => value.status === 200 && value.text.includes(`Parity ${runId}`));
    assert.equal((await route(port, host, content.media)).status, 200);
    const response = await route(port, host, '/?rest_route=/wp/v2/users/me', undefined, { authorization: `Basic ${Buffer.from(`parityadmin:${authorization.password}`).toString('base64')}` });
    assert.equal(response.status, 200); assert.equal(response.json.slug, 'parityadmin');
  });
  await report.check('control-plane-project-and-session-after-restart', async () => {
    if (name === 'panel') {
      const api = new PanelApi(); await api.login();
      const identity = JSON.parse(readFileSync(resolve(dataRoot, `${runId}-panel-identity.json`), 'utf8'));
      assert.equal((await api.call(`/projects/${identity.projectId}`)).name, identity.project);
      const service = await api.call(`/services/${identity.services.control}`); assert.equal(service.state, 'running');
    } else {
      const api = new ReferenceApi(); await eventually('reference API ready', () => api.login(), () => true);
      const project = await api.call('inspectProject', { projectName: `parity-${runId}` }, true); assert(project.services.some((item: any) => item.name === 'control'));
    }
  });
}
