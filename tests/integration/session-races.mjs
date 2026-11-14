#!/usr/bin/env node
// Requires a built panel and a local Playwright Chromium installation.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { chromium } from '@playwright/test';
import { Store } from '../../apps/panel/dist/server/store.js';
import { hashPassword } from '../../apps/panel/dist/server/auth.js';

const directory = await mkdtemp(join(tmpdir(), 'servus-session-race-'));
const store = new Store(directory);
store.createUser('a@example.test', await hashPassword('first-password'), 'admin');
store.createUser('b@example.test', await hashPassword('second-password'), 'member');
store.close();
const probe = createServer();
await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const server = spawn(process.execPath, ['apps/panel/dist/server/index.js'], {
  env: { ...process.env, PANEL_DATA_DIR: directory, PANEL_HOST: '127.0.0.1', PANEL_PORT: String(port), PANEL_ALLOWED_ORIGINS: `http://127.0.0.1:${port}` },
  stdio: 'ignore',
});
const serverExited = new Promise(resolve => server.once('exit', resolve));
let browser;
try {
  const origin = `http://127.0.0.1:${port}`;
  for (let i=0; i<100; i++) {
    try { if ((await fetch(`${origin}/api/v1/health`)).ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
    if(i === 99) throw new Error('Server did not start');
  }
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? {executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE} : {}) });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(10000);
  await page.goto(origin);
  async function signIn(email, password) {
    await page.getByLabel('Email address').fill(email);
    await page.getByLabel('Password', {exact:true}).fill(password);
    await page.getByRole('button', {name:'Sign in',exact:true}).click();
    await page.getByRole('button', {name:'Sign out'}).waitFor();
  }
  await signIn('a@example.test','first-password');
  let releaseMutation, observedMutation;
  const mutationGate = new Promise(resolve => { releaseMutation = resolve; });
  const mutationSeen = new Promise(resolve => { observedMutation = resolve; });
  await page.route('**/api/v1/projects', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    const response = await route.fetch();
    assert.equal(response.status(),201);
    observedMutation();
    await mutationGate;
    try { await route.fulfill({response}); } catch {}
  });
  await page.getByRole('button',{name:'New project'}).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Project name').fill('old-account-project');
  await dialog.getByRole('button',{name:'Create project'}).click();
  await mutationSeen;
  await dialog.getByRole('button',{name:'Cancel'}).click();
  let releaseSession, observedSession;
  const sessionGate = new Promise(resolve => { releaseSession = resolve; });
  const sessionSeen = new Promise(resolve => { observedSession = resolve; });
  await page.route('**/api/v1/auth/session', async route => {
    const response = await route.fetch();
    assert.equal(response.status(),200);
    observedSession();
    await sessionGate;
    try { await route.fulfill({response}); } catch {}
  });
  await page.waitForTimeout(2200);
  await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));
  let deadline;
  try {
    await Promise.race([sessionSeen, new Promise((_,reject)=>{deadline=setTimeout(()=>reject(new Error('Session refetch did not start')),8000);})]);
  } finally { clearTimeout(deadline); }
  await page.getByRole('button',{name:'Sign out'}).click();
  await page.getByLabel('Email address').waitFor();
  await signIn('b@example.test','second-password');
  releaseSession(); releaseMutation();
  await page.waitForTimeout(500);
  assert.equal(new URL(page.url()).pathname,'/');
  assert.equal(await page.getByText('old-account-project',{exact:true}).count(),0);
  await page.getByRole('button',{name:'Sign out'}).click();
  await page.getByLabel('Email address').waitFor();
  await page.unroute('**/api/v1/auth/session');
  await page.unroute('**/api/v1/projects');

  await signIn('a@example.test','first-password');
  let releaseExpiredMutation, observedExpiredMutation;
  const expiredMutationGate = new Promise(resolve => { releaseExpiredMutation = resolve; });
  const expiredMutationSeen = new Promise(resolve => { observedExpiredMutation = resolve; });
  await page.route('**/api/v1/projects', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    const response = await route.fetch();
    assert.equal(response.status(),201);
    observedExpiredMutation();
    await expiredMutationGate;
    try { await route.fulfill({response}); } catch {}
  });
  await page.getByRole('button',{name:'New project'}).first().click();
  const secondDialog = page.getByRole('dialog');
  await secondDialog.getByLabel('Project name').fill('expired-account-project');
  await secondDialog.getByRole('button',{name:'Create project'}).click();
  await expiredMutationSeen;
  await secondDialog.getByRole('button',{name:'Cancel'}).click();
  await page.route('**/api/v1/auth/session', route => route.fulfill({status:401,contentType:'application/json',body:JSON.stringify({error:{code:'UNAUTHORIZED',message:'Sign in to continue'}})}));
  await page.waitForTimeout(2200);
  await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));
  await page.getByLabel('Email address').waitFor();
  await page.unroute('**/api/v1/auth/session');
  await signIn('b@example.test','second-password');
  releaseExpiredMutation();
  await page.waitForTimeout(500);
  assert.equal(new URL(page.url()).pathname,'/');
  assert.equal(await page.getByText('expired-account-project',{exact:true}).count(),0);
  await page.getByRole('button',{name:'Sign out'}).click();
  await page.getByLabel('Email address').waitFor();
  console.log('Delayed session and mutations from account A did not affect account B after logout or expiry.');
} finally {
  await browser?.close();
  server.kill('SIGTERM');
  await serverExited;
  await rm(directory,{recursive:true,force:true});
}
