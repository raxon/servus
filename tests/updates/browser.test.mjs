import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from '@playwright/test';
const root=fileURLToPath(new URL('../../apps/panel',import.meta.url));
const server=await createServer({root,server:{port:0,strictPort:false},plugins:[{
 name:'update-settings-browser-fixture',
 resolveId(id){if(id==='/__update-preview.tsx')return id;},
 load(id){if(id==='/__update-preview.tsx')return `import React from 'react';import {createRoot} from 'react-dom/client';import {QueryClient,QueryClientProvider} from '@tanstack/react-query';import {UpdateSettings} from '/src/web/UpdateSettings.tsx';import '/src/web/styles.css';createRoot(document.getElementById('root')).render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><main style={{padding:20,maxWidth:1000,margin:'auto'}}><UpdateSettings/></main></QueryClientProvider>);`;},
 configureServer(s){s.middlewares.use(async(req,res,next)=>{if(req.url!=='/__updates')return next();res.setHeader('Content-Type','text/html');res.end(await s.transformIndexHtml(req.url,'<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__update-preview.tsx"></script></body></html>'));});},
}]});
await server.listen();
const browser=await chromium.launch({headless:true});
try{
 const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 let preferences={automatic:false,channel:'production',installTime:'02:00',timeZone:'Europe/Warsaw',lastAutomaticUpdate:null},submitted=0;
 await page.route('**/api/v1/**',async route=>{
  const req=route.request(),path=new URL(req.url()).pathname;
  let body;
  if(path==='/api/v1/updates/preferences'){
   if(req.method()==='PUT')preferences={...preferences,...req.postDataJSON()};
   body={preferences};
  }else if(path==='/api/v1/updates/release-notes/v1.0.1')body={tag:'v1.0.1',notes:'<img src=x onerror=window.releaseNotesInjected=true>\nChanges: certificate renewal and backup fixes.'};
  else if(path==='/api/v1/updates/discovery')body={discovery:{status:'candidate',tag:'v1.0.1',commit:'a'.repeat(40),digest:'sha256:'+'b'.repeat(64)}};
  else if(path==='/api/v1/updates'&&req.method()==='POST'){submitted++;body={operation:{status:'accepted'}};}
  else if(path==='/api/v1/updates')body={applyAvailable:true};
  else body={operation:{status:'accepted'}};
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
 });
 await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__updates`);
 await page.getByLabel('Automatic updates').waitFor();
 await page.waitForFunction(()=>document.querySelector('input[switch]') && getComputedStyle(document.querySelector('input[switch]')).appearance==='none',null,{timeout:5000}).catch(async e=>{console.log(await page.evaluate(()=>({sheets:document.adoptedStyleSheets.length,control:document.querySelector('input[switch]')?.outerHTML,appearance:getComputedStyle(document.querySelector('input[switch]')).appearance})));throw e;});
 assert.equal(await page.getByLabel('Installation time').inputValue(),'02:00');
 assert.equal(await page.getByRole('radio',{name:/Production/}).isChecked(),true);
 for(const width of [375,768,1440]){
  await page.setViewportSize({width,height:960});
  await page.screenshot({path:`/tmp/servus-update-settings-${width}.png`});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 }
 await page.getByLabel('Automatic updates').check();
 await page.getByRole('radio',{name:/Beta/}).check();
 await page.getByLabel('Installation time').fill('03:30');
 await page.getByRole('button',{name:'Save preferences'}).click();
 await page.getByText('Update preferences saved.').waitFor();
 assert.equal(preferences.automatic,true);assert.equal(preferences.channel,'beta');assert.equal(preferences.installTime,'03:30');
 await page.getByRole('button',{name:'Install update',exact:true}).click();
 await page.getByRole('dialog').waitFor();
 await page.getByText('Changes: certificate renewal and backup fixes.',{exact:false}).waitFor();
 assert.equal(await page.evaluate(()=>window.releaseNotesInjected),undefined);
 assert.equal(await page.getByRole('dialog').locator('img').count(),0);
 for(const width of [375,768,1440]){await page.setViewportSize({width,height:960});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:`/tmp/servus-update-confirm-${width}.png`});}
 assert.equal(submitted,0);
 await page.keyboard.press('Escape');
 assert.equal(await page.getByRole('dialog').count(),0);assert.equal(submitted,0);
 await page.getByRole('button',{name:'Install update',exact:true}).click();
 await page.screenshot({path:'/tmp/servus-update-confirmation.png'});
 await page.getByRole('button',{name:'Confirm installation'}).click();
 await page.waitForFunction(()=>localStorage.getItem('servus.update.operation.v1')!==null);
 await page.getByText('Checking the release signature...').waitFor();
 assert.equal(submitted,1);assert.deepEqual(errors,[]);
 const stale=await browser.newPage();
 await stale.addInitScript(()=>localStorage.setItem('servus.update.operation.v1',JSON.stringify({operationId:'12345678-1234-4123-8123-123456789abc',tag:'v1.0.1',commit:'a'.repeat(40),digest:'sha256:'+'b'.repeat(64),stage:'applying'})));
 let retries=0;
 await stale.route('**/api/v1/**',async route=>{
   const path=new URL(route.request().url()).pathname;
   if(path.endsWith('/apply')){if(route.request().method()==='POST')retries++;await route.fulfill({status:404,contentType:'application/json',body:JSON.stringify({error:{code:'NOT_FOUND',message:'Update operation not found'}})});return;}
   const body=path.endsWith('/preferences')?{preferences}:path.endsWith('/discovery')?{discovery:{status:'candidate',tag:'v1.0.1',commit:'a'.repeat(40),digest:'sha256:'+'b'.repeat(64)}}: {applyAvailable:true};
   await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
 });
 await stale.goto(`http://127.0.0.1:${server.httpServer.address().port}/__updates`);
 await stale.getByRole('button',{name:'Clear saved progress'}).waitFor();
 assert.equal(retries,1);
 await stale.getByRole('button',{name:'Clear saved progress'}).click();
 await stale.getByRole('button',{name:'Install update',exact:true}).waitFor();
 assert.equal(await stale.evaluate(()=>localStorage.getItem('servus.update.operation.v1')),null);
 await stale.close();
 const saved={operationId:'12345678-1234-4123-8123-123456789abc',tag:'v1.0.1',commit:'a'.repeat(40),digest:'sha256:'+'b'.repeat(64),stage:'applying'};
 for(const source of ['capability','health','discovery']){
  const recovered=await browser.newPage();
  await recovered.addInitScript(value=>localStorage.setItem('servus.update.operation.v1',JSON.stringify(value)),saved);
  let posts=0;
  await recovered.route('**/api/v1/**',async route=>{
   const req=route.request(),path=new URL(req.url()).pathname;
   if(path.endsWith('/apply')){if(req.method()==='POST')posts++;return route.fulfill({status:404,json:{error:{code:'NOT_FOUND',message:'Not found'}}});}
   const body=path.endsWith('/preferences')?{preferences}:path.endsWith('/health')&&source==='health'?{status:'ok',version:'1.0.2'}:path.endsWith('/discovery')?{discovery:source==='discovery'?{status:'no_newer_version',current:'v1.0.2',latest:'v1.0.2'}:{status:'candidate',tag:'v1.0.3',commit:'a'.repeat(40),digest:'sha256:'+'b'.repeat(64)}}:{applyAvailable:true,...(source==='capability'?{currentVersion:'v1.0.2'}:{})};
   return route.fulfill({status:200,json:body});
  });
  await recovered.goto(`http://127.0.0.1:${server.httpServer.address().port}/__updates`);
  await recovered.getByText('Version v1.0.2 is already installed.',{exact:false}).waitFor();
  assert.equal(posts,0);assert.equal(await recovered.evaluate(()=>localStorage.getItem('servus.update.operation.v1')),null);
  await recovered.close();
 }
 const active=await browser.newPage();
 await active.addInitScript(value=>localStorage.setItem('servus.update.operation.v1',JSON.stringify(value)),saved);
 await active.route('**/api/v1/**',async route=>{
  const path=new URL(route.request().url()).pathname;
  const body=path.endsWith('/apply')?{operation:{status:'awaiting_completion'}}:path.endsWith('/preferences')?{preferences}:path.endsWith('/discovery')?{discovery:{status:'no_newer_version',current:'v1.0.2',latest:'v1.0.2'}}:{applyAvailable:true,currentVersion:'v1.0.2'};
  return route.fulfill({status:200,json:body});
 });
 await active.goto(`http://127.0.0.1:${server.httpServer.address().port}/__updates`);
 await active.getByText('Installing the update.',{exact:false}).waitFor();
 assert.notEqual(await active.evaluate(()=>localStorage.getItem('servus.update.operation.v1')),null);
 await active.close();
 const legacy=await browser.newPage();
 await legacy.addInitScript(value=>localStorage.setItem('servus.update.operation.v1',JSON.stringify(value)),saved);
 await legacy.route('**/api/v1/**',async route=>{
  const req=route.request(),path=new URL(req.url()).pathname;
  if(path.endsWith('/apply'))return req.method()==='GET'?route.fulfill({status:404,json:{error:{code:'NOT_FOUND',message:'Not found'}}}):route.fulfill({status:400,json:{error:{code:'INVALID_UPDATE',message:'The release must be newer than this installation'}}});
  const body=path.endsWith('/preferences')?{preferences}:path.endsWith('/discovery')?{discovery:{status:'candidate',tag:'v1.0.3',commit:'a'.repeat(40),digest:'sha256:'+'b'.repeat(64)}}:{applyAvailable:true};
  return route.fulfill({status:200,json:body});
 });
 await legacy.goto(`http://127.0.0.1:${server.httpServer.address().port}/__updates`);
 await legacy.getByText('The saved update cannot be resumed.',{exact:false}).waitFor();
 await legacy.getByRole('button',{name:'Clear saved progress'}).click();
 await legacy.getByRole('button',{name:'Install update',exact:true}).waitFor();
 assert.equal(await legacy.evaluate(()=>localStorage.getItem('servus.update.operation.v1')),null);
 await legacy.close();
 console.log('PASS: defaults, save automatic/channel/time, responsive layouts, working switch polyfill, modal cancellation and explicit confirmation, no JS errors');
}finally{await browser.close();await server.close();}
