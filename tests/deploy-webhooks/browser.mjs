import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium, expect } from '@playwright/test';

const root = fileURLToPath(new URL('../../apps/panel', import.meta.url));
const server = await createServer({ root, server: { port: 0 } });
let browser;
try {
  await server.listen();
  const base = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, reducedMotion: 'reduce' });
  const errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  const service = { id: '11111111-1111-4111-8111-111111111111', projectId: '22222222-2222-4222-8222-222222222222', name: 'web', kind: 'app', image: 'fixture', source: { type: 'git', repository: 'https://github.com/example/repo', branch: 'main', context: '.', dockerfile: 'Dockerfile' }, state: 'running', revision: 1, deployedRevision: 1, replicas: 1, domains: [] };
  let enabled = false, failStatus = false, writer = true, version = 0, held;
  await page.route('**/api/v1/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path.endsWith('/deploy-webhook')) {
      requests.push(request.method());
      if (request.method() === 'POST') {
        assert.equal(request.headers()['x-csrf-token'], 'fixture-csrf');
        if (held) await held;
        enabled = true; version++;
        return route.fulfill({ status: 200, json: { enabled: true, path: `/api/v1/hooks/deploy/${String(version).repeat(64)}`, secret: 'f'.repeat(64), rotatedAt: '2026-11-17T00:00:00.000Z' } });
      }
      if (request.method() === 'DELETE') { assert.equal(request.headers()['x-csrf-token'], 'fixture-csrf'); enabled = false; return route.fulfill({ status: 200, json: { enabled: false } }); }
      return route.fulfill(failStatus ? { status: 503, json: { error: { code: 'UNAVAILABLE', message: 'Webhook status unavailable' } } } : { status: 200, json: { enabled, rotatedAt: enabled ? '2026-11-17T00:00:00.000Z' : null } });
    }
    const data = path === '/api/v1/auth/session' ? { user: { id: 'user', role: writer ? 'admin' : 'member', email: 'fixture@example.test' }, csrfToken: 'fixture-csrf' }
      : path === '/api/v1/projects' ? [{ id: service.projectId, name: 'Fixture', canWrite: writer }]
      : path === `/api/v1/projects/${service.projectId}` ? { id: service.projectId, name: 'Fixture', canWrite: writer }
      : path === `/api/v1/services/${service.id}` ? service
      : path.endsWith('/actions') || path === '/api/v1/actions' ? []
      : path.endsWith('/metrics') ? { cpuPercent: 0, memoryBytes: 0, memoryLimitBytes: 0, networkRxBytes: 0, networkTxBytes: 0 }
      : {};
    return route.fulfill({ status: 200, json: data });
  });
  await page.goto(`${base}/services/${service.id}?tab=deployments`);
  const section = page.getByRole('region', { name: 'Deployment webhook', exact: true });
  await expect(section.getByText('Webhook disabled', { exact: true })).toBeVisible();
  await section.getByRole('button', { name: 'Enable webhook', exact: true }).click();
  await expect(section.getByText('Webhook enabled', { exact: true })).toBeVisible();
  const url = section.getByRole('textbox', { name: 'Payload URL', exact: true });
  const secret = section.getByRole('textbox', { name: 'GitHub secret', exact: true });
  await expect(url).toHaveValue(`${base}/api/v1/hooks/deploy/${'1'.repeat(64)}`);
  await expect(secret).toHaveValue('f'.repeat(64));
  const output = fileURLToPath(new URL('../../artifacts/deploy-webhooks', import.meta.url));
  await mkdir(output, { recursive: true });
  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: 1100 });
    const bounds = await section.boundingBox();
    assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width + 1, `Webhook section fits ${width}px`);
    await section.screenshot({ path: `${output}/webhook-${width}.png`, mask: [url, secret] });
  }
  await section.getByRole('button', { name: 'Hide webhook credentials', exact: true }).click();
  await expect(url).toHaveCount(0);
  let release;
  held = new Promise(resolve => { release = resolve; });
  await section.getByRole('button', { name: 'Rotate webhook secret', exact: true }).click();
  await expect(section.getByRole('button', { name: 'Rotate webhook secret', exact: true })).toBeDisabled();
  await expect(section.getByRole('button', { name: 'Disable webhook', exact: true })).toBeDisabled();
  release(); held = undefined;
  await expect(url).toHaveValue(`${base}/api/v1/hooks/deploy/${'2'.repeat(64)}`);
  await section.getByRole('button', { name: 'Disable webhook', exact: true }).click();
  await expect(section.getByText('Webhook disabled', { exact: true })).toBeVisible();
  await expect(url).toHaveCount(0);
  failStatus = true;
  await page.reload();
  await expect(section.getByText('Webhook status unavailable', { exact: true }).first()).toBeVisible();
  await expect(section.getByRole('button', { name: 'Enable webhook', exact: true })).toBeDisabled();
  failStatus = false;
  await section.getByRole('button', { name: 'Retry webhook status', exact: true }).click();
  await expect(section.getByRole('button', { name: 'Enable webhook', exact: true })).toBeEnabled();
  writer = false;
  const before = requests.length;
  await page.reload();
  await expect(page.getByRole('navigation', { name: 'Service sections' })).toBeVisible();
  await expect(section).toHaveCount(0);
  assert.equal(requests.length, before);
  assert.deepEqual(errors, []);
  console.log('PASS webhook browser: enable, hidden credentials, rotation, serialized mutations, disable, failed status retry, viewer access and responsive screenshots.');
} catch (error) {
  throw new Error((error instanceof Error ? error.message : String(error)).replace(/\b[a-f0-9]{64}\b/gi, '[REDACTED]'));
} finally {
  await browser?.close();
  await server.close();
}
