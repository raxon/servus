import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request as httpRequest } from 'node:http';
import { createServer } from 'vite';
import { chromium, expect } from '@playwright/test';
import { createApp } from '../../apps/panel/src/server/app.ts';
import { Store } from '../../apps/panel/src/server/store.ts';
import { totpCode } from '../../apps/panel/src/server/totp.ts';

const root = fileURLToPath(new URL('../../apps/panel', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'servus-two-factor-browser-'));
const screenshots = fileURLToPath(new URL('../../artifacts/two-factor', import.meta.url));
let backend;
const vite = await createServer({ root, plugins: [{
  name: 'isolated-two-factor-api',
  configureServer(server) {
    server.middlewares.use('/api', (incoming, outgoing) => {
      if (!backend) { outgoing.writeHead(503); outgoing.end(); return; }
      const upstream = httpRequest(`${backend}${incoming.originalUrl}`, { method: incoming.method, headers: incoming.headers }, response => {
        outgoing.writeHead(response.statusCode, response.headers); response.pipe(outgoing);
      });
      upstream.on('error', () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); });
      incoming.pipe(upstream);
    });
  },
}], server: { port: 0 } });
let app, store, browser;
try {
  await vite.listen();
  const base = `http://127.0.0.1:${vite.httpServer.address().port}`;
  store = new Store(directory);
  app = await createApp({ dataDir: directory, store, allowedOrigins: [base] });
  await app.listen({ host: '127.0.0.1', port: 0 });
  backend = `http://127.0.0.1:${app.server.address().port}`;
  const email = 'browser@example.test', password = 'isolated-browser-password';
  const created = await app.inject({ method: 'POST', url: '/api/v1/setup', payload: { email, password } });
  assert.equal(created.statusCode, 200);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(15_000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${base}/settings`);
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const section = page.getByRole('region', { name: 'Two-factor authentication', exact: true });
  await expect(section.getByText('Not enabled.', { exact: true })).toBeVisible();
  await section.getByLabel('Current password (required)').fill(password);
  await section.getByRole('button', { name: 'Set up authenticator', exact: true }).click();
  const manual = section.getByLabel('Manual setup key');
  await expect(manual).toBeVisible();
  const secret = await manual.inputValue();
  assert.match(secret, /^[A-Z2-7]{32}$/);
  assert.equal(new URL(await section.getByLabel('Authenticator setup URI').inputValue()).searchParams.get('secret'), secret);
  const otp = section.getByLabel('Six-digit authenticator code (required)');
  await expect(otp).toHaveAttribute('type', 'text');
  await expect(otp).toHaveAttribute('inputmode', 'numeric');
  await expect(otp).toHaveAttribute('autocomplete', 'one-time-code');
  await mkdir(screenshots, { recursive: true });
  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: 1100 });
    await section.scrollIntoViewIfNeeded();
    const bounds = await section.boundingBox();
    assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width + 1, `2FA section fits ${width}px`);
    await section.screenshot({ path: join(screenshots, `enrollment-${width}.png`), mask: [manual, section.getByLabel('Authenticator setup URI')] });
  }
  await section.getByLabel('Current password (required)').fill(password);
  await otp.fill(totpCode(secret, Date.now()));
  await section.getByRole('button', { name: 'Enable authenticator', exact: true }).click();
  const recovery = section.getByRole('textbox', { name: 'Save your recovery codes', exact: true });
  await expect(recovery).toBeVisible();
  const recoveryCodes = (await recovery.inputValue()).split('\n');
  assert.equal(recoveryCodes.length, 10);
  await expect(recovery).toBeFocused();
  await section.getByRole('button', { name: 'I saved my recovery codes', exact: true }).click();
  await expect(recovery).toHaveCount(0);
  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: 1100 });
    await section.scrollIntoViewIfNeeded();
    await section.screenshot({ path: join(screenshots, `enabled-${width}.png`) });
  }
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByLabel('Authenticator or recovery code', { exact: true })).toBeVisible();
  await page.getByLabel('Authenticator or recovery code', { exact: true }).fill(recoveryCodes[0]);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(section.getByText('Enabled. 9 recovery codes remain.', { exact: true })).toBeVisible();
  await section.getByLabel('Current password (required)').fill(password);
  await section.getByLabel('Authenticator or recovery code (required)').fill(recoveryCodes[1]);
  await section.getByRole('button', { name: 'Disable two-factor authentication', exact: true }).click();
  await expect(section.getByText('Not enabled.', { exact: true })).toBeVisible();
  assert.deepEqual(errors, []);
  console.log('PASS local 2FA browser: enrollment, manual setup, recovery display, login challenge, recovery sign-in, disable and responsive screenshots.');
} catch (error) {
  // Matcher snapshots can contain synthetic enrollment secrets and recovery codes.
  // Keep them out of command output even when a UI assertion fails.
  const message = error instanceof Error ? error.message : String(error);
  throw new Error(message.replace(/\b[A-Z2-7]{32}\b/g, '[REDACTED]').replace(/\b[a-f0-9]{5}(?:-[a-f0-9]{5}){3}\b/gi, '[REDACTED]'));
} finally {
  await browser?.close();
  await app?.close();
  store?.close();
  await vite.close();
  await rm(directory, { recursive: true, force: true });
}
