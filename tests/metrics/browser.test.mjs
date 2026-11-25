import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium, expect } from '@playwright/test';

const server = await createServer({ root: 'apps/panel', server: { host: '127.0.0.1', port: 0, strictPort: false }, logLevel: 'error' });
await server.listen();
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const base = `http://127.0.0.1:${server.httpServer.address().port}`;
  const service = {
    id: '11111111-1111-4111-8111-111111111111',
    projectId: '22222222-2222-4222-8222-222222222222',
    name: 'web',
    kind: 'app',
    image: 'nginx:alpine',
    port: 80,
    hostname: 'web.localhost',
    replicas: 2,
    revision: 1,
    deployedRevision: 1,
    state: 'running',
    lastError: null,
    createdAt: '2026-11-25T00:00:00.000Z',
    updatedAt: '2026-11-25T00:00:00.000Z',
  };
  const project = { id: service.projectId, name: 'metrics-demo', description: '', createdAt: service.createdAt, serviceCount: 1, canWrite: true };
  const samples1h = [
    { sampledAt: '2026-11-25T09:57:00.000Z', status: 'ok', cpuPercent: 132.4, memoryBytes: 128 * 1024 * 1024, memoryLimitBytes: 512 * 1024 * 1024, containers: 2, generation: 'aaaaaaaaaaaaaaaa' },
    { sampledAt: '2026-11-25T09:58:00.000Z', status: 'gap', cpuPercent: null, memoryBytes: null, memoryLimitBytes: null, containers: null, generation: null },
    { sampledAt: '2026-11-25T09:59:00.000Z', status: 'ok', cpuPercent: 48.2, memoryBytes: 96 * 1024 * 1024, memoryLimitBytes: 512 * 1024 * 1024, containers: 2, generation: 'bbbbbbbbbbbbbbbb' },
  ];
  const requestedWindows = [];
  await page.route('**/api/v1/**', async route => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path === '/api/v1/setup') return route.fulfill({ status: 200, json: { required: false } });
    if (path === '/api/v1/auth/session') return route.fulfill({ status: 200, json: { user: { id: '33333333-3333-4333-8333-333333333333', email: 'admin@example.test', role: 'admin', createdAt: service.createdAt }, csrfToken: 'csrf-token' } });
    if (path === '/api/v1/projects') return route.fulfill({ status: 200, json: [project] });
    if (path === `/api/v1/projects/${project.id}`) return route.fulfill({ status: 200, json: project });
    if (path === `/api/v1/services/${service.id}`) return route.fulfill({ status: 200, json: service });
    if (path === `/api/v1/services/${service.id}/actions`) return route.fulfill({ status: 200, json: [] });
    if (path === `/api/v1/services/${service.id}/configuration-changes`) return route.fulfill({ status: 200, json: { status: 'none', sections: [], deployedPrimaryDomain: null } });
    if (path === `/api/v1/services/${service.id}/metrics`) return route.fulfill({ status: 200, json: { cpuPercent: 48.2, memoryBytes: 96 * 1024 * 1024, memoryLimitBytes: 512 * 1024 * 1024, networkRxBytes: 4096, networkTxBytes: 8192, containers: 2 } });
    if (path === `/api/v1/services/${service.id}/metrics/history`) {
      const window = url.searchParams.get('window') || '1h';
      requestedWindows.push(window);
      return route.fulfill({
        status: 200,
        json: {
          serviceId: service.id,
          window,
          intervalSeconds: 60,
          retentionHours: 24,
          earliestAvailableAt: '2026-11-25T09:57:00.000Z',
          truncated: window === '24h',
          samples: samples1h,
        },
      });
    }
    if (path === '/api/v1/runtime') return route.fulfill({ status: 200, json: { online: true, ingressPort: 18080 } });
    if (path === '/api/v1/updates') return route.fulfill({ status: 200, json: { applyAvailable: false } });
    return route.fulfill({ status: 200, json: {} });
  });

  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${base}/services/${service.id}?tab=overview`);
    const region = page.getByRole('region', { name: 'Historical metrics' });
    await expect(region).toBeVisible();
    await expect(region.locator('.metrics-chart-title', { hasText: 'CPU usage (%)' })).toBeVisible();
    await expect(region.locator('.metrics-chart-title', { hasText: 'Memory usage (MiB)' })).toBeVisible();
    await expect(region.locator('.metrics-chart-title', { hasText: 'Running containers (count)' })).toBeVisible();
    await expect(region.getByText('Peak 132.4%')).toBeVisible();
    await expect(region.getByText('1 unavailable interval (gap)')).toBeVisible();
    await expect(region.getByText('Container generation changed (2 generations)')).toBeVisible();
    await expect(region.locator('line[data-gap="true"]')).toHaveCount(3);
    const btn24h = region.getByRole('button', { name: '24h' });
    await btn24h.focus();
    await page.keyboard.press('Enter');
    await expect(btn24h).toHaveAttribute('aria-pressed', 'true');
    await expect(region.getByText('History capped; earliest sample at 09:57 UTC')).toBeVisible();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `No horizontal overflow at ${width}px`);
  }
  assert.ok(requestedWindows.includes('1h') && requestedWindows.includes('24h'));
  console.log('PASS metrics history UI: 1h/6h/24h keyboard switching, units, >100% CPU, visible gaps, generation change, truncation notice and responsive layouts at 375/768/1440px');
} finally {
  await browser?.close();
  await server.close();
}
