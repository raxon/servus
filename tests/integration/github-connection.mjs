#!/usr/bin/env node
// Exercises shared GitHub credentials using a disposable panel database.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { chromium } from '@playwright/test';
import { Store } from '../../apps/panel/dist/server/store.js';
import { hashPassword } from '../../apps/panel/dist/server/auth.js';

const directory = await mkdtemp(join(tmpdir(),'servus-github-ui-'));
const store = new Store(directory);
store.createUser('admin@example.test',await hashPassword('testing-password'),'admin');
const first = store.createProject('First');
const second = store.createProject('Second');
store.close();
const probe = createServer();
await new Promise(resolve => probe.listen(0,'127.0.0.1',resolve));
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath,['apps/panel/dist/server/index.js'],{env:{...process.env,PANEL_DATA_DIR:directory,PANEL_HOST:'127.0.0.1',PANEL_PORT:String(port),PANEL_ALLOWED_ORIGINS:origin},stdio:'ignore'});
const exited = new Promise(resolve => server.once('exit',resolve));
let browser;
try {
  for (let i=0;i<100;i++) { try { if ((await fetch(`${origin}/api/v1/health`)).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve,50)); if (i===99) throw new Error('Panel did not start'); }
  browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{})});
  const page=await browser.newPage({viewport:{width:375,height:850}});
  page.setDefaultTimeout(10000);
  await page.goto(`${origin}/settings`);
  await page.getByLabel('Email address').fill('admin@example.test');
  await page.getByLabel('Password',{exact:true}).fill('testing-password');
  await page.getByRole('button',{name:'Sign in',exact:true}).click();
  const connection=page.locator('#github-connection');
  await connection.getByLabel('Access token').fill('synthetic-github-token');
  const saveResponse=page.waitForResponse(response=>response.url().endsWith('/integrations/github') && response.request().method()==='PUT');
  await connection.getByRole('button',{name:'Save connection'}).click();
  const saved=await saveResponse; assert.equal(saved.status(),200); assert.ok(!(await saved.text()).includes('synthetic-github-token'));
  await connection.getByText('GitHub token saved.',{exact:false}).waitFor();
  assert.equal(await connection.getByLabel('Access token').inputValue(),'');
  for (const width of [375,768,1440]) {
    await page.setViewportSize({width,height:850});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  }
  await page.setViewportSize({width:375,height:850});
  for (const [project,name] of [[first,'web-one'],[second,'web-two']]) {
    await page.goto(`${origin}/projects/${project.id}`);
    await page.getByRole('button',{name:'New service'}).click();
    const dialog=page.getByRole('dialog');
    await dialog.getByLabel('Service name').fill(name);
    await dialog.getByText('GitHub',{exact:true}).click();
    await dialog.getByLabel('GitHub repository').fill(`example/${name}`);
    await dialog.getByLabel('Use shared GitHub connection',{exact:false}).check();
    const created=page.waitForResponse(response=>response.url().endsWith('/services') && response.request().method()==='POST');
    await dialog.getByRole('button',{name:'Create & deploy'}).click();
    const response=await created;assert.equal(response.status(),202);const value=await response.json();
    assert.equal(value.service.source.sharedGithub,true);
    assert.equal(value.service.source.credential.token,undefined);
    await page.getByRole('tab',{name:'Source',exact:true}).click();
    const sourceForm=page.getByRole('form',{name:'Application source'});
    await sourceForm.getByText('GitHub connection configured',{exact:true}).waitFor();
    assert.equal(await sourceForm.getByRole('radio',{name:'GitHub',exact:true}).isChecked(),true);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  }
  await page.goto(`${origin}/settings`);
  await connection.getByLabel('Access token').fill('synthetic-replacement-token');
  await connection.getByRole('button',{name:'Replace token'}).click();
  await connection.getByText('Connection saved.',{exact:false}).waitFor();
  await connection.getByRole('button',{name:'Disconnect GitHub'}).click();
  const confirmation=page.getByRole('dialog');
  await confirmation.getByText('Running services and queued deployments are unchanged.',{exact:false}).waitFor();
  await confirmation.getByRole('button',{name:'Disconnect',exact:true}).click();
  await connection.getByText('No GitHub token saved.').waitFor();
  console.log('Shared GitHub connection: save, two projects, rotation and disconnect passed.');
} finally { await browser?.close(); server.kill('SIGTERM'); await exited; await rm(directory,{recursive:true,force:true}); }
