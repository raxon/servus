import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';
import {chromium,expect} from '@playwright/test';

const root=fileURLToPath(new URL('../../apps/panel',import.meta.url)),server=await createServer({root,server:{port:0}});await server.listen();
const base=`http://127.0.0.1:${server.httpServer.address().port}`,browser=await chromium.launch({headless:true}),errors=[];
await mkdir(new URL('../../artifacts/installation-backups/',import.meta.url),{recursive:true});
try{
  for(const role of['admin','member']){
    const page=await browser.newPage({viewport:{width:1440,height:1100},reducedMotion:'reduce'}),requests=[];let operation;
    page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/api/v1/**',async route=>{
      const request=route.request(),path=new URL(request.url()).pathname;requests.push({path,method:request.method()});let value;
      if(path==='/api/v1/installation-backups'&&request.method()==='POST'){
        assert.equal(role,'admin');assert.equal(request.headers()['x-csrf-token'],'settings-csrf');operation={...request.postDataJSON(),actorId:'12345678-1234-4123-8123-123456789abc',state:'requested',createdAt:1794916800000,updatedAt:1794916800000,errorCode:null};return route.fulfill({status:202,json:{ok:true,operation}});
      }
      if(path==='/api/v1/installation-backups')value={available:true};
      else if(path.startsWith('/api/v1/installation-backups/'))value={ok:true,operation};
      else if(path==='/api/v1/auth/session')value={user:{id:`settings-${role}`,role,email:`${role}@example.test`},csrfToken:'settings-csrf'};
      else if(path==='/api/v1/projects'||path==='/api/v1/actions')value=[];
      else if(path==='/api/v1/users')value={users:[]};
      else if(path==='/api/v1/auth/api-tokens')value={tokens:[]};
      else if(path==='/api/v1/updates')value={applyAvailable:false};
      else if(path==='/api/v1/integrations/github')value={connected:false};
      else if(path==='/api/v1/auth/two-factor')value={available:false,enabled:false,pending:false,recoveryCodesRemaining:0};
      else if(path==='/api/v1/runtime')value={online:true,engineVersion:'fixture',cpus:2,memoryBytes:1073741824,swarmState:'active',ingressPort:18080};
      else value={};
      return route.fulfill({json:value});
    });
    await page.goto(base);await page.getByRole('link',{name:'Settings',exact:true}).waitFor();assert.equal(requests.some(request=>request.path==='/api/v1/installation-backups'),false);
    await page.getByRole('link',{name:'Settings',exact:true}).click();await expect(page.getByRole('heading',{name:'Your instance',exact:true})).toBeVisible();
    if(role==='admin'){
      const section=page.locator('#installation-backups');await expect(section.getByRole('heading',{name:'Installation backup',exact:true})).toBeVisible();await expect(section).toContainText('Application files, volumes and database contents require their own backups.');await section.getByRole('textbox',{name:'Backup name',exact:true}).fill('Settings screen backup');await section.getByRole('button',{name:'Create installation backup',exact:true}).click();await expect(section.getByText('Waiting for the host to begin.',{exact:true})).toBeVisible();
      for(const width of[375,768,1440]){await page.setViewportSize({width,height:1100});await section.scrollIntoViewIfNeeded();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await section.screenshot({path:fileURLToPath(new URL(`../../artifacts/installation-backups/settings-${width}.png`,import.meta.url))});}
      assert.equal(requests.filter(request=>request.path==='/api/v1/installation-backups'&&request.method==='POST').length,1);
    }else{await expect(page.locator('#installation-backups')).toHaveCount(0);assert.equal(requests.some(request=>request.path.startsWith('/api/v1/installation-backups')),false);}
    await page.close();
  }
  assert.deepEqual(errors,[]);console.log('PASS real settings-screen mounting and navigation: admin-only installation backups, actual app CSRF wiring, one submit, member has no panel/capability calls;375/768/1440nooverflow. API mocked; host capture not tested.');
}finally{await browser.close();await server.close();}
