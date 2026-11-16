#!/usr/bin/env node
// Exercises the update interface against a local panel with a simulated updater.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { chromium } from '@playwright/test';
import { Store } from '../../apps/panel/dist/server/store.js';
import { hashPassword } from '../../apps/panel/dist/server/auth.js';

const directory = await mkdtemp(join(tmpdir(), 'servus-update-ui-'));
const store = new Store(directory);
store.createUser('admin@example.test', await hashPassword('test-password'), 'admin');
store.close();
const probe = createServer();
await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const server = spawn(process.execPath, ['apps/panel/dist/server/index.js'], {
  env: { ...process.env, PANEL_DATA_DIR: directory, PANEL_HOST: '127.0.0.1', PANEL_PORT: String(port), PANEL_ALLOWED_ORIGINS: `http://127.0.0.1:${port}` }, stdio: 'ignore',
});
const exited = new Promise(resolve => server.once('exit', resolve));
let browser;
try {
  const origin = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${origin}/api/v1/health`)).ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
    if (i === 99) throw new Error('Server did not start');
  }
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
  const page = await browser.newPage();
  page.setDefaultTimeout(15000);
  let applyCount = 0, applied = false, complete = false, discovered = 0, retried = false;
  const candidate = { status: 'candidate', verified: false, tag: 'v0.1.6', commit: 'a'.repeat(40), digest: `sha256:${'b'.repeat(64)}` };
  let operationId;
  await page.route('**/api/v1/updates**', async route => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();
    const ok = data => route.fulfill({ status: 200, json: data });
    if (path.endsWith('/updates') && method === 'GET') return ok({ applyAvailable: true });
    if (path.endsWith('/preferences')) return ok({ preferences: { automatic: false, channel: 'production', installTime: '02:00', timeZone: 'Europe/Warsaw', lastAutomaticUpdate: null } });
    if (path.endsWith('/discovery')) return ok({ discovery: ++discovered === 1 ? { status: 'checking' } : candidate });
    if (path.endsWith('/updates') && method === 'POST') {
      operationId = route.request().postDataJSON().operationId;
      return ok({ operation: { operationId, status: 'accepted' } });
    }
    if (path.endsWith('/retry')) { retried = true; return ok({ operation: { operationId, status: 'accepted' } }); }
    if (path.endsWith('/prepare')) return ok({ operation: { operationId, status: 'prepared' } });
    if (path.endsWith('/apply') && method === 'GET') {
      if (!applied) return route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: 'Not found' } } });
      return ok({ operation: { operationId, status: complete ? 'completed' : 'awaiting_completion' } });
    }
    if (path.endsWith('/apply') && method === 'POST') { applied = true; applyCount++; return ok({ operation: { operationId, status: 'requested' } }); }
    return ok({ operation: { operationId, status: retried ? 'verified' : 'verification_failed' } });
  });
  await page.goto(origin);
  await page.getByLabel('Email address').fill('admin@example.test');
  await page.getByLabel('Password', { exact: true }).fill('test-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('button', { name: 'Sign out' }).waitFor();
  await page.goto(`${origin}/settings`);
  await page.getByRole('button', { name: 'Check for updates' }).click();
  await page.getByText('Version v0.1.6 is available.', { exact: false }).waitFor();
  assert.ok(discovered >= 2);
  await page.getByRole('link', { name: 'Update available: v0.1.6' }).waitFor();
  await page.getByRole('button', { name: 'Install update' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm installation' }).click();
  await page.getByText('Release verification failed.').waitFor();
  await page.reload();
  await page.getByRole('button', { name: 'Retry verification' }).click();
  await page.getByText('Installing the update.', { exact: false }).waitFor();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('servus.update.operation.v1') || '{}').stage === 'applying');
  await page.waitForTimeout(500);
  assert.equal(applyCount, 1);
  complete = true;
  await page.reload();
  await page.getByText('Update installed.').waitFor();
  assert.equal(applyCount, 1);
  assert.equal(await page.evaluate(() => localStorage.getItem('servus.update.operation.v1')), null);
  assert.equal(await page.getByRole('button', { name: 'Install update' }).count(), 0);
  await page.getByRole('button', { name: 'Check for updates' }).click();
  await page.getByRole('button', { name: 'Install update' }).waitFor();
  console.log('Update settings: discovery, verification retry, installation and recovery after reload passed');
} finally {
  await browser?.close(); server.kill('SIGTERM'); await exited; await rm(directory, { recursive: true, force: true });
}
