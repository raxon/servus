import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium, expect } from '@playwright/test';

const root = fileURLToPath(new URL('../../apps/panel', import.meta.url));
const server = await createServer({ root, server: { port: 0 } });
await server.listen();
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  page.setDefaultTimeout(10_000);
  await page.addInitScript(() => {
    const startViewTransition = document.startViewTransition?.bind(document);
    window.__viewTransitions = 0;
    if (startViewTransition) document.startViewTransition = (...args) => {
      window.__viewTransitions++;
      const transition = startViewTransition(...args);
      window.__latestViewTransitionFinished = transition.finished;
      return transition;
    };
  });
  const service = { id: 'service-1', projectId: 'project-1', name: 'example', kind: 'app', image: 'nginx', state: 'running', revision: 1, deployedRevision: 1, replicas: 1, domains: [] };
  const action = { id: 'action-1', serviceId: service.id, projectId: service.projectId, type: 'deploy', status: 'succeeded', phase: 'done', createdAt: '2026-01-01T00:00:00Z' };
  const failed = { ...action, id: 'failed-1', status: 'failed', phase: 'failed', error: 'docker failed with exit code 1.' };
  const buildOutput = [
    '2026-01-01T00:00:02.000Z [servus] Building immutable source abc',
    '2026-01-01T00:00:03.000Z [output] npm error Missing: vite@8.3.8 from lock file',
    '2026-01-01T00:00:03.000Z [output] ERROR: process "/bin/sh -c npm ci" did not complete successfully',
  ].join('\n');
  let includeFailure = false;
  let canWrite = true;
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  let createdName;
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/v1/projects/project-1/services' && route.request().method() === 'POST') {
      createdName = route.request().postDataJSON().name;
      return route.fulfill({status:201,json:{service,action}});
    }
    const data = path === '/api/v1/auth/session' ? { user: { id: 'user-1', role: 'member', email: 'test@example.com' }, csrfToken: 'test' }
      : path === '/api/v1/projects' ? [{ id: service.projectId, name: 'Project', description: '', createdAt: action.createdAt, serviceCount: 1, canWrite }]
      : path === '/api/v1/projects/project-1/services' ? [{ ...service, id: 'database-1', name: 'mariadb', kind: 'mariadb' }]
      : path === '/api/v1/projects/project-1/compose' ? []
      : path === '/api/v1/services/service-1' ? service
      : path === '/api/v1/services/service-1/metrics' ? { cpuPercent: 0, memoryBytes: 0, memoryLimitBytes: 0, networkRxBytes: 0, networkTxBytes: 0 }
      : path === '/api/v1/services/service-1/logs' ? { lines: [] }
      : path === '/api/v1/services/service-1/actions' || path === '/api/v1/actions' ? includeFailure ? [failed, action] : [action]
      : path === '/api/v1/actions/action-1' ? { action, events: [] }
      : path === '/api/v1/actions/failed-1' ? { action: failed, events: [] }
      : path === '/api/v1/actions/failed-1/build-log' ? { available: true, text: buildOutput, truncated: false }
      : path.endsWith('/build-log') ? { available: false, text: '', truncated: false }
      : {};
    await route.fulfill({ status: 200, json: data });
  });
  const base = `http://127.0.0.1:${server.httpServer.address().port}`;
  await page.goto(`${base}/services/service-1?tab=source`);
  const nav = page.getByRole('navigation', { name: 'Service sections' });
  await nav.getByRole('link', { name: 'Source', exact: true }).waitFor();
  assert.equal(await nav.getByRole('link', { name: 'Source', exact: true }).getAttribute('aria-current'), 'page');
  for (const [name, id] of [['Overview', 'overview'], ['Source', 'source'], ['Deployments', 'deployments'], ['Environment', 'environment'], ['Domains', 'domains'], ['Storage', 'storage'], ['Backups', 'backups'], ['Resources', 'resources'], ['Logs', 'logs'], ['Console', 'console']]) {
    const link = nav.locator(`a[href*="tab=${id}"]`);
    await link.click();
    assert.equal(new URL(page.url()).searchParams.get('tab'), id);
    assert.equal(await page.evaluate(() => window.__viewTransitions), 0, `No page crossfade on ${name}`);
    if (id === 'overview') {
      assert.equal(await page.getByRole('heading', { name: 'Latest operation' }).count(), 0);
      const header = page.locator('.service-heading');
      assert.equal(await header.getByRole('button', { name: 'Restart' }).isVisible(), true);
      assert.equal(await header.getByRole('button', { name: 'Stop' }).isVisible(), true);
    }
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
  assert.equal(await page.evaluate(() => window.__viewTransitions), 0, 'No page crossfade on history back between tabs');
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
  await page.goto(`${base}/projects/project-1`);
  await page.getByRole('button', { name: 'New service', exact: true }).click();
  const create = page.getByRole('dialog', { name: 'Create a service' });
  await create.getByRole('button', { name: /MariaDB/ }).click();
  assert.equal(await create.locator('input[name=name]').getAttribute('placeholder'), 'mariadb-2');
  await create.getByRole('button', { name: 'Create & deploy' }).click();
  await page.locator('[data-position=top-right] .tst-title').getByText('Service created. Deployment queued.').waitFor();
  assert.equal(createdName, 'mariadb-2');
  await page.evaluate(() => window.__latestViewTransitionFinished);

  includeFailure = true;
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${base}/services/service-1?tab=deployments&action=failed-1`);
  await expect(page.getByRole('heading', { name: 'Build stopped at npm ci' })).toBeVisible();
  await expect(page.locator('.deploy-failure')).toContainText('Missing: vite@8.3.8 from lock file');
  await expect(page.locator('.deploy-revision')).toContainText('Last deployed revision 1');
  await expect(page.locator('.build-log-details')).not.toHaveAttribute('open');
  const history = page.locator('.deployment-history');
  const filter = history.getByRole('combobox', { name: 'Filter deployment history by status' });
  await filter.selectOption('failed');
  await expect(history.getByRole('button', { name: /Deploy service/ })).toHaveCount(1);
  await expect(history.getByRole('button', { name: /Deploy service/ })).toHaveAttribute('aria-pressed', 'true');
  await filter.selectOption('queued');
  await expect(history.getByText('No operations match this status.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Build stopped at npm ci' })).toBeVisible();
  const screenshots = process.env.SERVUS_NAV_SCREENSHOTS;
  if (screenshots) {
    await mkdir(screenshots, { recursive: true });
    await filter.selectOption('');
    await page.screenshot({ path: `${screenshots}/deployments-1440.png` });
  }

  for (const width of [375, 768]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(`${base}/services/service-1?tab=overview`);
    const selector = page.getByRole('button', { name: 'Section: Overview' });
    const mobileActions = page.locator('.service-actions-disclosure > summary');
    const sections = page.getByRole('dialog', { name: 'Service sections' });
    await expect(page.getByRole('button', { name: 'Deploy', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Restart', exact: true })).toBeHidden();
    await mobileActions.click();
    await page.getByRole('button', { name: 'Delete service' }).click();
    await expect(page.getByRole('dialog', { name: 'Delete example?' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Delete example?' })).toBeHidden();
    await page.keyboard.press('Escape');
    await expect(mobileActions).toBeFocused();
    await selector.click();
    await expect(sections.getByRole('link')).toHaveCount(10);
    await expect(sections.getByRole('link', { name: 'Overview', exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(sections.getByRole('link', { name: 'Console', exact: true })).toBeInViewport();
    if (screenshots) await page.screenshot({ path: `${screenshots}/sections-${width}.png` });
    await page.keyboard.press('Escape');
    await expect(selector).toBeFocused();
    await selector.click();
    await sections.getByRole('link', { name: 'Logs', exact: true }).click();
    await expect(sections).toBeHidden();
    await expect(page.getByRole('button', { name: 'Section: Logs' })).toBeFocused();
    assert.equal(new URL(page.url()).searchParams.get('tab'), 'logs');
    await page.goBack();
    await expect(selector).toBeVisible();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  }
  canWrite = false;
  await page.reload();
  await expect(page.getByRole('button', { name: 'Section: Overview' })).toBeVisible();
  await expect(page.getByText('Actions', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Deploy', exact: true })).toHaveCount(0);
  assert.deepEqual(errors, []);
  console.log('PASS: desktop and mobile navigation, accessible sections, lifecycle confirmation, deployment filtering and diagnosis, service creation');
} finally {
  await browser.close();
  await server.close();
}
