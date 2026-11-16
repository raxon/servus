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
  }else if(path==='/api/v1/updates/discovery')body={discovery:{status:'candidate',tag:'v1.0.1',commit:'a'.repeat(40),digest:'sha256:'+'b'.repeat(64)}};
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
 console.log('PASS: defaults, save automatic/channel/time, responsive layouts, working switch polyfill, modal cancellation and explicit confirmation, no JS errors');
}finally{await browser.close();await server.close();}
