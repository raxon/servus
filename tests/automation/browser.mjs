import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium, expect } from '@playwright/test';

const root=fileURLToPath(new URL('../../apps/panel',import.meta.url));
const server=await createServer({root,server:{port:0},plugins:[{
  name:'automation-browser-fixture',resolveId(id){if(id==='/__automation.tsx')return id;},
  load(id){if(id==='/__automation.tsx')return `import React from 'react';import {createRoot} from 'react-dom/client';import {QueryClient,QueryClientProvider} from '@tanstack/react-query';import {ApiTokenSettings} from '/src/web/ApiTokenSettings.tsx';import {setCsrfToken} from '/src/web/api.ts';import '/src/web/styles.css';setCsrfToken('fixture');createRoot(document.getElementById('root')).render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><main style={{padding:16,maxWidth:900,margin:'auto'}}><ApiTokenSettings/></main></QueryClientProvider>);`;},
  configureServer(s){s.middlewares.use(async(req,res,next)=>{if(req.url!=='/__automation')return next();res.setHeader('Content-Type','text/html');res.end(await s.transformIndexHtml(req.url,'<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__automation.tsx"></script></body></html>'));});},
}]});
await server.listen();const browser=await chromium.launch({headless:true});
const id='11111111-1111-4111-8111-111111111111',tokenId='22222222-2222-4222-8222-222222222222',secret=`srv_${'a'.repeat(64)}`;
try {
  const page=await browser.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
  let tokens=[],writes=0,canWrite=true;
  await page.route('**/api/v1/**',async route=>{
    const request=route.request(),path=new URL(request.url()).pathname;
    if(path==='/api/v1/projects')return route.fulfill({json:[{id,name:'Production',canWrite}]});
    if(path==='/api/v1/auth/api-tokens'&&request.method()==='POST'){
      assert.equal(request.headers()['x-csrf-token'],'fixture');writes++;
      assert.equal(request.postDataJSON().scope,'deploy');
      tokens=[{id:tokenId,projectId:id,name:request.postDataJSON().name,scope:'deploy',expiresAt:'2027-01-01T00:00:00.000Z',revokedAt:null}];
      return route.fulfill({status:201,json:{...tokens[0],token:secret}});
    }
    if(path.endsWith(tokenId)&&request.method()==='DELETE'){tokens[0].revokedAt='2026-11-17T12:00:00.000Z';return route.fulfill({json:{success:true}});}
    if(path==='/api/v1/auth/api-tokens')return route.fulfill({json:{tokens}});
    return route.fulfill({json:{}});
  });
  const origin=`http://127.0.0.1:${server.httpServer.address().port}`;
  await page.goto(`${origin}/__automation`);
  await page.getByLabel('Name',{exact:true}).fill('CI deploy');
  await page.getByRole('radio',{name:'Read and deploy, start, stop or restart services'}).check();
  await page.getByRole('button',{name:'Create token',exact:true}).click();
  await expect(page.getByLabel('New API token')).toHaveValue(secret);assert.equal(writes,1);
  await page.getByRole('button',{name:'Hide token'}).click();await expect(page.getByLabel('New API token')).toHaveCount(0);
  await page.getByRole('button',{name:'Revoke CI deploy'}).click();await expect(page.getByText('Revoked',{exact:true})).toBeVisible();
  await mkdir('artifacts/automation',{recursive:true});
  for(const width of [375,768,1440]){
    await page.setViewportSize({width,height:1000});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await page.screenshot({path:`artifacts/automation/tokens-${width}.png`,fullPage:true});
  }
  canWrite=false;await page.reload();
  await expect(page.getByRole('radio',{name:'Read and deploy, start, stop or restart services'})).toBeDisabled();
  assert.deepEqual(errors,[]);process.stdout.write('PASS API token form, CSRF, one-time reveal, revocation, viewer access and responsive layouts\n');
}finally {await browser.close();await server.close();}
