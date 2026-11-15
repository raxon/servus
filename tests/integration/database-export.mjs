// Exercise the database export download in a disposable local panel.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { createServer } from 'node:net';
import { chromium } from '@playwright/test';
import { createApp } from '../../apps/panel/dist/server/app.js';
import { Store } from '../../apps/panel/dist/server/store.js';
import { hashPassword } from '../../apps/panel/dist/server/auth.js';
import { normalizeServiceInput } from '../../apps/panel/dist/server/configuration.js';

const root=mkdtempSync(join(tmpdir(),'servus-export-ui-')),store=new Store(root);
const user=store.createUser('fixture@example.test',await hashPassword('fixture-password'),'admin');
const project=store.createProject('fixture');
const {service}=store.createService(project.id,normalizeServiceInput({name:'database',kind:'postgres',database:{database:'app',user:'app'}}),user.id);
const job=store.claimNextJob('worker',60000);assert(job);store.completeAction(job.actionId,'worker',{state:'running',deployedRevision:job.snapshot.revision});
const agentRequest=async path=>{
  if(path.includes('/metrics'))return {cpuPercent:0,memoryBytes:0,memoryLimitBytes:0,networkRxBytes:0,networkTxBytes:0,containers:1};
  if(path.includes('/containers'))return [];
  if(path.includes('/logs'))return {lines:[]};
  throw new Error('Unexpected agent request');
};
const databaseExport=async()=>Object.assign(Readable.from([Buffer.from('fixture-export')]),{headers:{'content-length':'14','x-export-extension':'dump'}});
const probe=createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));
const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
const origin=`http://127.0.0.1:${port}`;
const app=await createApp({dataDir:root,store,webDir:resolve('apps/panel/dist/web'),agentRequest,databaseExport,allowedOrigins:[origin]});
await app.listen({host:'127.0.0.1',port});
let browser;
try {
  browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{})});
  for(const viewport of [{width:1280,height:900},{width:375,height:850}]){
    const page=await browser.newPage({viewport,acceptDownloads:true});
    await page.goto(`${origin}/services/${service.id}`);
    await page.getByLabel('Email address').fill('fixture@example.test');
    await page.getByLabel('Password',{exact:true}).fill('fixture-password');
    await page.getByRole('button',{name:'Sign in',exact:true}).click();
    const section=page.locator('section').filter({has:page.getByRole('heading',{name:'Database connection'})});
    await section.getByText('Database export').waitFor();
    const downloadPromise=page.waitForEvent('download');
    await section.getByRole('button',{name:'Download',exact:true}).click();
    const download=await downloadPromise;assert.equal(download.suggestedFilename(),`servus-${service.id}.dump`);
    const path=join(root,`download-${viewport.width}`);await download.saveAs(path);assert.equal(readFileSync(path,'utf8'),'fixture-export');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
    if(viewport.width===1280)await page.screenshot({path:'/tmp/servus-database-export-ui.png'});
    await page.close();
  }
  console.log('PASS database export download on desktop and mobile');
} finally {await browser?.close();await app.close();store.close();rmSync(root,{recursive:true,force:true});}
