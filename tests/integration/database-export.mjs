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
const agentRequest=async (path,payload)=>{
  if(path.includes('/metrics'))return {cpuPercent:0,memoryBytes:0,memoryLimitBytes:0,networkRxBytes:0,networkTxBytes:0,containers:1};
  if(path.includes('/containers'))return [];
  if(path.includes('/logs'))return {lines:[]};
  if(path.endsWith('/database-network'))return {aliases:[service.name],publishedPort:null,revision:service.deployedRevision??1};
  if(path.endsWith('/database-port-suggestion'))return {port:payload.candidates[0]};
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
    let operation=null,recovery=null,recoveryRequests=0,commits=0,uploads=0,badUpload=false,finishSlowUpload;
    await page.route(`**/api/v1/services/${service.id}/database-restore**`,async route=>{
      const request=route.request(),path=new URL(request.url()).pathname;
      assert(request.headers()['x-csrf-token']);
      if(path.endsWith('/legacy-recovery')){
        if(request.method()==='GET')return recovery?route.fulfill({json:{operation:recovery}}):route.fulfill({status:404,json:{error:{code:'NOT_FOUND',message:'Not found'}}});
        recoveryRequests++;recovery={status:'requested'};return route.fulfill({json:{operation:recovery}});
      }
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
    await page.getByRole('heading',{name:'Database connection'}).waitFor();
    const connection=page.locator('section').filter({has:page.getByRole('heading',{name:'Database connection',exact:true})});
    await connection.getByText('database',{exact:true}).waitFor();
    const access=connection.getByRole('region',{name:'External access',exact:true});
    await access.getByText('Private',{exact:true}).waitFor();
    const toggle=access.getByRole('switch',{name:'Expose database over TCP',exact:true});
    const portInput=access.getByRole('spinbutton',{name:'External port',exact:true});
    if (viewport.width === 1440) {
      assert.equal(await portInput.count(),0);
      await toggle.focus();
      await toggle.press('Space');
      await portInput.waitFor();
      assert.equal(store.getService(service.id).databaseAccess,undefined);
      await portInput.fill('4180');
      await access.getByRole('button',{name:'Save access'}).click();
      assert.equal(await portInput.evaluate(input=>input.validity.customError),true);
      assert.equal(store.getService(service.id).databaseAccess,undefined);
      const suggestion=page.waitForResponse(response=>response.url().endsWith('/database-port-suggestion'));
      await access.getByRole('button',{name:'Suggest free port'}).click();
      const suggested=await suggestion;
      assert.equal(suggested.status(),200);
      const {port: available}=await suggested.json();
      await access.getByText(`Port ${available} was free when checked.`,{exact:true}).waitFor();
      assert.equal(await portInput.inputValue(),String(available));
      assert.equal(store.getService(service.id).databaseAccess,undefined);
      await access.getByRole('button',{name:'Save access'}).click();
      await access.getByText(`TCP port ${available} saved. Deploy to apply the change.`).waitFor();
      assert.equal(store.getService(service.id).databaseAccess.publishedPort,available);
      assert.equal(store.getService(service.id).deployedRevision,1);
    }
    await portInput.waitFor();
    const savedPort=await portInput.inputValue();
    await toggle.press('Space');
    await portInput.waitFor({state:'hidden'});
    await access.getByRole('button',{name:'Discard',exact:true}).click();
    await portInput.waitFor();
    assert.equal(await portInput.inputValue(),savedPort);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await access.screenshot({path:`/tmp/servus-external-access-${viewport.width}.png`});
    assert.equal(await page.getByText('Database export',{exact:true}).count(),0);
    if (viewport.width <= 768) {
      await page.getByRole('button',{name:/^Section:/}).click();
      await page.getByRole('dialog',{name:'Service sections'}).getByRole('link',{name:'Backups',exact:true}).click();
    } else {
      await page.getByRole('navigation',{name:'Service sections'}).getByRole('link',{name:'Backups',exact:true}).click();
    }
    const section=page.getByRole('region',{name:'Export and restore'});
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
    operation={operationId:'b'.repeat(32),kind:'postgres',phase:'needs_review'};
    await page.reload();
    await section.getByRole('button',{name:'Restore',exact:true}).click();
    await dialog.getByRole('alert').getByText('The restore state could not be verified.').waitFor();
    await dialog.getByText(operation.operationId).waitFor();
    await dialog.getByRole('button',{name:'Close dialog'}).click();
    operation={operationId:'c'.repeat(32),kind:'postgres',phase:'uploading',recoveryReason:'legacy_upload_unverified'};
    await page.reload();
    await section.getByRole('button',{name:'Restore',exact:true}).click();
    await dialog.getByRole('alert').getByText('This older upload has no recorded process lock, so its writer cannot be verified as stopped.').waitFor();
    await dialog.getByText(operation.operationId).waitFor();
    assert.equal(await dialog.getByRole('button',{name:'Cancel upload'}).count(),0);
    await dialog.getByRole('button',{name:'Recover interrupted upload'}).click();
    await dialog.getByText('Recovery is in progress.',{exact:false}).waitFor();
    assert.equal(recoveryRequests,1);
    assert.equal(await dialog.getByRole('button',{name:'Recover interrupted upload'}).count(),0);
    operation={...operation,phase:'cancelled'};delete operation.recoveryReason;
    recovery={status:'completed'};
    await dialog.getByRole('button',{name:'Check recovery status'}).click();
    await dialog.getByText('The restore was cancelled.').waitFor();
    await dialog.getByLabel('Export file').waitFor();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
    await dialog.getByRole('button',{name:'Close dialog'}).click();
    operation={operationId:'d'.repeat(32),kind:'postgres',phase:'importing',recoveryReason:'preparation_unverified'};
    await page.reload();
    await section.getByRole('button',{name:'Restore',exact:true}).click();
    await dialog.getByRole('alert').getByText('Preparation may have been interrupted. The temporary database and its import cannot yet be verified as stopped.').waitFor();
    await dialog.getByText(operation.operationId).waitFor();
    assert.equal(await dialog.getByRole('button',{name:'Cancel restore'}).count(),0);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
    await dialog.getByRole('button',{name:'Close dialog'}).click();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
    if(viewport.width===1440)await page.screenshot({path:'/tmp/servus-database-export-ui.png'});
    await page.close();
  }
  console.log('PASS database export and restore interface on desktop and mobile');
} finally {await browser?.close();await app.close();store.close();rmSync(root,{recursive:true,force:true});}
