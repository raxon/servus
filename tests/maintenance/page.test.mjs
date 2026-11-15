import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
const html=readFileSync(new URL('../../deployment/maintenance/maintenance.html',import.meta.url));
let ready=false, polls=0, navigations=0;
const server=createServer((req,res)=>{
 if(req.url==='/api/v1/auth/session'){
  polls++;res.writeHead(ready?401:503,{'Content-Type':'application/json'});
  res.end(JSON.stringify({error:{code:ready?'UNAUTHORIZED':'MAINTENANCE'}}));return;
 }
 navigations++;res.writeHead(503,{'Content-Type':'text/html'});res.end(html);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({headless:true});
try{
 const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const url=`http://127.0.0.1:${server.address().port}/services/example`;
 await page.goto(url);
 for(const width of [375,768,1440]){
  await page.setViewportSize({width,height:900});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.screenshot({path:`/tmp/servus-maintenance-${width}.png`});
 }
 await page.emulateMedia({reducedMotion:'reduce'});
 assert.equal(await page.locator('progress').evaluate(e=>getComputedStyle(e).animationDuration),'6s');
 await page.getByRole('button',{name:'Sprawdź teraz'}).click();
 await page.waitForFunction(()=>document.getElementById('status').textContent==='Oczekiwanie na panel…');
 assert.ok(polls>0);
 assert.equal(navigations,1);
 ready=true;
 const reloaded=page.waitForEvent('load');
 await page.getByRole('button',{name:'Sprawdź teraz'}).click();
 await reloaded;
 assert.equal(new URL(page.url()).pathname,'/services/example');
 assert.ok(navigations>=2);
 assert.deepEqual(errors,[]);
 console.log('PASS: maintenance persists while unavailable; reloads on API readiness; responsive at 375/768/1440; reduced motion; no JS errors');
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
