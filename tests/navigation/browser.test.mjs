import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from '@playwright/test';

const root = fileURLToPath(new URL('../../apps/panel', import.meta.url));
const server = await createServer({ root, server: { port: 0 } });
await server.listen();
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const service = { id: 'service-1', projectId: 'project-1', name: 'example', kind: 'app', image: 'nginx', state: 'running', revision: 1, deployedRevision: 1, replicas: 1, domains: [] };
  const action = { id: 'action-1', serviceId: service.id, projectId: service.projectId, type: 'deploy', status: 'succeeded', phase: 'done', createdAt: '2026-01-01T00:00:00Z' };
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const data = path === '/api/v1/auth/session' ? { user: { id: 'user-1', role: 'member', email: 'test@example.com' }, csrfToken: 'test' }
      : path === '/api/v1/projects' ? [{ id: service.projectId, name: 'Project', canWrite: true }]
      : path === '/api/v1/services/service-1' ? service
      : path === '/api/v1/services/service-1/metrics' ? { cpuPercent: 0, memoryBytes: 0, memoryLimitBytes: 0, networkRxBytes: 0, networkTxBytes: 0 }
      : path === '/api/v1/services/service-1/actions' || path === '/api/v1/actions' ? [action]
      : path === '/api/v1/actions/action-1' ? { action, events: [] }
      : path.endsWith('/build-log') ? { available: false, text: '', truncated: false }
      : {};
    await route.fulfill({ status: 200, json: data });
  });
  const base = `http://127.0.0.1:${server.httpServer.address().port}`;
  await page.goto(`${base}/services/service-1?tab=source`);
  const nav = page.getByRole('navigation', { name: 'Service sections' });
  await nav.getByRole('link', { name: 'Source', exact: true }).waitFor();
  assert.equal(await nav.getByRole('link', { name: 'Source', exact: true }).getAttribute('aria-current'), 'page');
  for (const [name, id] of [['Overview', 'overview'], ['Source', 'source'], ['Deployments', 'deployments'], ['Environment', 'environment'], ['Domains', 'domains'], ['Storage', 'storage'], ['Resources', 'resources'], ['Logs', 'logs'], ['Console', 'console']]) {
    const link = nav.locator(`a[href*="tab=${id}"]`);
    await link.click();
    assert.equal(new URL(page.url()).searchParams.get('tab'), id);
    await page.reload();
    assert.equal(await link.getAttribute('aria-current'), 'page', name);
  }
  await nav.getByRole('link', { name: 'Deployments' }).click();
  assert.equal(new URL(page.url()).searchParams.get('tab'), 'deployments');
  await page.getByRole('button', { name: /Deploy service/ }).click();
  assert.equal(new URL(page.url()).searchParams.get('action'), 'action-1');
  const saved = page.url();
  await page.reload();
  assert.equal(new URL(page.url()).searchParams.get('action'), 'action-1');
  await nav.getByRole('link', { name: 'Source', exact: true }).click();
  await page.goBack();
  assert.equal(page.url(), saved);
  assert.equal(await nav.getByRole('link', { name: 'Deployments' }).getAttribute('aria-current'), 'page');
  const deleteButton = page.getByRole('button', { name: 'Delete service' });
  assert.equal(await deleteButton.innerText(), '');
  await deleteButton.click();
  await page.getByRole('dialog').waitFor();
  await page.goto(`${base}/activity`);
  await page.getByRole('button', { name: /Deploy service/ }).click();
  assert.equal(new URL(page.url()).searchParams.get('action'), 'action-1');
  await page.reload();
  await page.getByText('Deploy output').waitFor();
  console.log('PASS: direct links, tab navigation, operation selection, reload, history and delete dialog');
} finally {
  await browser.close();
  await server.close();
}
