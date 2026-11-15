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
  for(const viewport of [{width:1440,height:900},{width:768,height:900},{width:375,height:850}]){
    const page=await browser.newPage({viewport,acceptDownloads:true});
    let operation=null,commits=0,uploads=0,badUpload=false,finishSlowUpload;
    await page.route(`**/api/v1/services/${service.id}/database-restore**`,async route=>{
      const request=route.request(),path=new URL(request.url()).pathname;
      assert(request.headers()['x-csrf-token']);
      if(request.method()==='GET')return route.fulfill({json:{operation}});
      const operationId=path.split('/').at(-2);
      if(path.endsWith('/upload')){
        uploads++;assert.equal(request.headers()['content-type'],'application/octet-stream');
        const contents=request.postDataBuffer().toString();assert(['fixture-export','bad-export','slow-export'].includes(contents));badUpload=contents==='bad-export';
        if(contents==='slow-export'){
          operation={operationId,kind:'postgres',phase:'uploading'};
          await new Promise(resolve=>{finishSlowUpload=resolve;});
          return route.fulfill({status:503,json:{error:{code:'RUNTIME_UNAVAILABLE',message:'Upload interrupted.'}}});
        }
        operation={operationId,kind:'postgres',phase:'reserved'};
        return route.fulfill({json:{operationId,phase:'reserved'}});
      }
      if(path.endsWith('/prepare')){
        if(badUpload){operation.phase='cancelled';return route.fulfill({status:422,json:{error:{code:'RESTORE_IMPORT_FAILED',message:'The export could not be imported. The current database was not changed.'}}});}
        operation.phase='prepared';return route.fulfill({json:{operationId,phase:'prepared'}});
      }
      if(path.endsWith('/cancel')){operation.phase='cancelled';finishSlowUpload();return route.fulfill({json:{operationId,phase:'cancelled'}});}
      if(path.endsWith('/commit')){
        commits++;assert.deepEqual(request.postDataJSON(),{confirm:true});operation.phase='completed';
        if(viewport.width===375)return route.fulfill({status:503,json:{error:{code:'RESTORE_UNCERTAIN',message:'The restore outcome is unknown. Check the operation status.'}}});
        return route.fulfill({json:{operationId,phase:'completed',rolledBack:false}});
      }
      throw new Error(`Unexpected restore request: ${path}`);
    });
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
    await section.getByRole('button',{name:'Restore',exact:true}).click();
    const dialog=page.getByRole('dialog',{name:'Restore database'});
    await dialog.getByLabel('Export file').setInputFiles({name:'fixture.dump',mimeType:'application/octet-stream',buffer:Buffer.from('fixture-export')});
    await dialog.getByRole('button',{name:'Upload export'}).click();
    await dialog.getByRole('button',{name:'Prepare restore'}).click();
    await dialog.getByText('The export is ready.',{exact:false}).waitFor();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
    await page.screenshot({path:`/tmp/servus-restore-${viewport.width}.png`});
    await page.reload();
    await section.getByRole('button',{name:'Restore',exact:true}).click();
    await dialog.getByText('The export is ready.',{exact:false}).waitFor();
    const restore=dialog.getByRole('button',{name:'Restore database'});
    assert.equal(await restore.isDisabled(),true);
    await dialog.getByLabel('I understand that current database data will be replaced.').check();
    await restore.click();
    await dialog.getByText('The database was restored.').waitFor();
    if(viewport.width===375)await dialog.getByText('The restore outcome is unknown. Check the operation status.').waitFor();
    assert.equal(uploads,1);assert.equal(commits,1);
    await dialog.getByLabel('Export file').setInputFiles({name:'bad.dump',mimeType:'application/octet-stream',buffer:Buffer.from('bad-export')});
    await dialog.getByRole('button',{name:'Upload export'}).click();
    await dialog.getByRole('button',{name:'Prepare restore'}).click();
    await dialog.getByText('The export could not be imported. The current database was not changed.').waitFor();
    await dialog.getByText('The restore was cancelled.').waitFor();
    assert.equal(uploads,2);assert.equal(commits,1);
    await dialog.getByLabel('Export file').setInputFiles({name:'slow.dump',mimeType:'application/octet-stream',buffer:Buffer.from('slow-export')});
    await dialog.getByRole('button',{name:'Upload export'}).click();
    await dialog.getByRole('button',{name:'Cancel upload'}).click();
    await dialog.getByText('The restore was cancelled.').waitFor();
    assert.equal(uploads,3);
    operation={operationId:'a'.repeat(32),kind:'postgres',phase:'needs_review',reviewPhase:'importing'};
    await dialog.getByRole('button',{name:'Close dialog'}).click();
    await page.reload();
    await section.getByRole('button',{name:'Restore',exact:true}).click();
    await dialog.getByRole('alert').getByText('The temporary database or its import could not be verified.').waitFor();
    await dialog.getByText('The service is locked for changes. Ask an administrator to review this restore before retrying.').waitFor();
    await dialog.getByText(operation.operationId).waitFor();
    assert.equal(await dialog.getByRole('button',{name:'Finish cleanup'}).count(),0);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
    await page.screenshot({path:`/tmp/servus-restore-review-${viewport.width}.png`});
    await dialog.getByRole('button',{name:'Close dialog'}).click();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
    if(viewport.width===1440)await page.screenshot({path:'/tmp/servus-database-export-ui.png'});
    await page.close();
  }
  console.log('PASS database export and restore interface on desktop and mobile');
} finally {await browser?.close();await app.close();store.close();rmSync(root,{recursive:true,force:true});}
