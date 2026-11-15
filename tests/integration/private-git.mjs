#!/usr/bin/env node
// Runs the private Git form against a disposable local panel database.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { chromium } from '@playwright/test';
import { Store } from '../../apps/panel/dist/server/store.js';
import { hashPassword } from '../../apps/panel/dist/server/auth.js';

const directory=await mkdtemp(join(tmpdir(),'servus-private-ui-'));
const store=new Store(directory);store.createUser('admin@example.test',await hashPassword('testing-password'),'admin');const project=store.createProject('Private Git');store.close();
const probe=createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
const origin=`http://127.0.0.1:${port}`;
const server=spawn(process.execPath,['apps/panel/dist/server/index.js'],{env:{...process.env,PANEL_DATA_DIR:directory,PANEL_HOST:'127.0.0.1',PANEL_PORT:String(port),PANEL_ALLOWED_ORIGINS:origin},stdio:'ignore'});
const exited=new Promise(resolve=>server.once('exit',resolve));let browser;
try {
  for(let i=0;i<100;i++){try{if((await fetch(`${origin}/api/v1/health`)).ok)break;}catch{}await new Promise(resolve=>setTimeout(resolve,50));if(i===99)throw new Error('Panel did not start');}
  browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{})});
  const page=await browser.newPage({viewport:{width:375,height:850}});page.setDefaultTimeout(10000);await page.goto(`${origin}/projects/${project.id}`);
  await page.getByLabel('Email address').fill('admin@example.test');await page.getByLabel('Password',{exact:true}).fill('testing-password');await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await page.getByRole('button',{name:'New service'}).click();const dialog=page.getByRole('dialog');
  await dialog.getByLabel('Service name').fill('private-app');await dialog.getByText('Git',{exact:true}).click();
  await dialog.getByLabel('Repository URL').fill('https://git.example.com/team/app.git');
  await dialog.getByText('GitHub',{exact:true}).click();
  await dialog.getByLabel('GitHub repository').fill('example/private.git');await dialog.getByLabel('Private repository').check();
  await dialog.getByLabel('Git username').fill('git-user');await dialog.getByLabel('Access token').fill('test-git-token');
  assert.equal(await dialog.getByLabel('Access token').getAttribute('type'),'password');
  const created=page.waitForResponse(response=>response.url().endsWith('/services')&&response.request().method()==='POST');
  await dialog.getByRole('button',{name:'Create & deploy'}).click();const response=await created;assert.equal(response.status(),202);const value=await response.json();
  assert.equal(value.service.source.repository,'https://github.com/example/private.git');
  assert.equal(value.service.source.credential.username,'git-user');assert.equal(value.service.source.credential.token,undefined);assert.ok(value.service.source.credential.secretRef);
  await page.getByRole('tab',{name:'Source',exact:true}).click();await page.getByLabel('Access token').waitFor();assert.equal(await page.getByLabel('Access token').inputValue(),'');
  await page.getByLabel('Access token').fill('test-rotated-token');const saved=page.waitForResponse(response=>response.url().endsWith(`/services/${value.service.id}`)&&response.request().method()==='PATCH');
  await page.getByRole('button',{name:'Save configuration'}).click();const update=await saved;assert.equal(update.status(),200);const rotated=await update.json();assert.notEqual(rotated.source.credential.secretRef,value.service.source.credential.secretRef);assert.equal(rotated.source.credential.token,undefined);
  await page.waitForFunction(()=>document.documentElement.scrollWidth<=window.innerWidth);
  console.log('Private Git form created and rotated credentials on a disposable panel.');
} finally {await browser?.close();server.kill('SIGTERM');await exited;await rm(directory,{recursive:true,force:true});}

await import("./github-connection.mjs");
