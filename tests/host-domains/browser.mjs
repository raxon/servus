import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { chromium, expect } from '@playwright/test';
import { Store } from '../../apps/panel/dist/server/store.js';
import { createApp } from '../../apps/panel/dist/server/app.js';

const directory=await mkdtemp(join(tmpdir(),'servus-host-browser-'));
const screenshots=await mkdtemp(join(tmpdir(),'servus-host-screenshots-'));
const store=new Store(directory);
const hostname='1234567890abcdef.host.servus.run';
const reservation=createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));
const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
const base=`http://127.0.0.1:${port}`;
store.vault.setHostConnection({kind:'servus-host-v1',machineId:randomUUID(),token:randomBytes(32).toString('base64url'),apiOrigin:'https://api.servus.run',enabled:true,ready:true,hostname,ip:'8.8.8.8',dnsStatus:'ready',certificateExpiresAt:new Date(Date.now()+60*86_400_000).toISOString(),staging:false});
const app=await createApp({dataDir:directory,store,allowedOrigins:[base],webDir:resolve('apps/panel/dist/web'),runtimeStatus:async()=>({online:true,httpsConfigured:true,engineVersion:'browser fixture',ingressPort:80}),agentRequest:async()=>({})});
const browser=await chromium.launch({headless:true});
const errors=[];
try {
  await app.listen({host:'127.0.0.1',port});
  const context=await browser.newContext({baseURL:base,reducedMotion:'reduce'});
  const setup=await context.request.post('/api/v1/setup',{data:{email:'browser@example.test',password:'browser-fixture-password'}});assert.equal(setup.status(),200);
  const {csrfToken}=await setup.json();
  const project=await context.request.post('/api/v1/projects',{headers:{'x-csrf-token':csrfToken},data:{name:'browser-project',description:''}});assert.equal(project.status(),201);
  const saved=await project.json();
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  for(const width of [375,768,1440]) {
    await page.setViewportSize({width,height:1000});await page.goto('/settings');
    const section=page.locator('#host-domain');await expect(section.getByRole('heading',{name:'Servus domain'})).toBeVisible();
    await expect(section.getByRole('link',{name:hostname})).toHaveAttribute('href',`https://${hostname}`);
    await section.scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`Horizontal overflow at ${width}px`);
    await section.screenshot({path:join(screenshots,`host-domain-${width}.png`)});
  }
  await page.goto(`/projects/${saved.id}`);
  await page.getByRole('button',{name:'New service',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Create a service'})).toBeVisible();
  await page.getByRole('textbox',{name:/^Service name/}).fill('api');
  await page.getByRole('textbox',{name:/^Docker image/}).fill('nginx:alpine');
  const hostnameInput=page.getByRole('textbox',{name:/^Hostname/});
  await expect(hostnameInput).toHaveValue('');await expect(hostnameInput).toHaveAttribute('placeholder','Leave blank for an automatic HTTPS address');
  await page.getByRole('button',{name:'Create & deploy',exact:true}).click();
  await expect(page).toHaveURL(/\/services\//);
  const response=await context.request.get(`/api/v1/projects/${saved.id}/services`),services=await response.json();
  assert.equal(services[0].hostname,`browser-project-api.${hostname}`);assert.equal(services[0].domains[0].https,true);
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({status:'passed',viewports:[375,768,1440],automaticServiceHostname:services[0].hostname,screenshots}));
} finally {await browser.close();await app.close();store.close();await rm(directory,{recursive:true,force:true});}
