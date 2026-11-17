import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium, expect } from '@playwright/test';

const root=fileURLToPath(new URL('../../apps/panel',import.meta.url)),server=await createServer({root,server:{port:0}});await server.listen();const browser=await chromium.launch({headless:true}),base=`http://127.0.0.1:${server.httpServer.address().port}`,output='/tmp/servus-redis-restore-qa';await mkdir(output,{recursive:true});const errors=[];
const service={id:'redis-fixture',projectId:'redis-project',name:'Redis fixture',kind:'redis',image:'redis:7-alpine',source:{type:'image'},state:'running',revision:1,deployedRevision:1,replicas:1,port:6379,hostname:'',domains:[],environment:[],mounts:[],createdAt:'2026-11-17T01:00:00Z',updatedAt:'2026-11-17T01:00:00Z',lastError:null};
async function fixture({canWrite=true,initial=null,refuseRollback=false}={}) {
  const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'});page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(10_000);let operation=initial;const calls=[];
  await page.context().route('**/api/v1/**',async route=>{
    const request=route.request(),path=new URL(request.url()).pathname;calls.push({path,method:request.method()});
    if(path.includes('/database-restore')) {
      if(request.method()==='GET')return route.fulfill({json:{operation}});
      assert.equal(canWrite,true);assert.equal(request.headers()['x-csrf-token'],'redis-csrf');const id=path.split('/').at(-2),action=path.split('/').at(-1);
      if(action==='upload'){operation={operationId:id,kind:'redis',phase:'reserved'};return route.fulfill({json:{operationId:id,phase:'reserved',size:request.postDataBuffer().length,sha256:'a'.repeat(64)}});}
      if(action==='prepare'){operation={...operation,phase:'prepared'};return route.fulfill({json:{operationId:id,phase:'prepared'}});}
      if(action==='commit'){assert.equal(request.postDataJSON().confirm,true);operation={...operation,phase:'completed',canRollback:true};return route.fulfill({json:{operationId:id,phase:'completed',rolledBack:false}});}
      if(action==='rollback'){assert.equal(request.postDataJSON().confirm,true);if(refuseRollback)return route.fulfill({status:409,json:{error:{code:'RESTORE_BUSY',message:'Redis changed after restoration. Rollback was refused.'}}});operation={...operation,phase:'cancelled',rolledBack:true,canRollback:undefined};return route.fulfill({json:{operationId:id,phase:'cancelled',rolledBack:true}});}
      if(action==='recover'){operation={...operation,phase:'cancelled',recoveryReason:undefined};return route.fulfill({json:{operationId:id,phase:'cancelled',rolledBack:false}});}
      throw new Error(`Unexpected restore fixture action: ${action}`);
    }
    const data=path==='/api/v1/auth/session'?{user:{id:'fixture',role:canWrite?'admin':'member',email:'redis@example.test'},csrfToken:'redis-csrf'}
      :path==='/api/v1/projects'?[{id:service.projectId,name:'Redis restores',canWrite}]
      :path===`/api/v1/services/${service.id}`?service
      :path.endsWith('/connection')?{host:'redis.internal',port:6379,database:'app',user:'app',passwordConfigured:true}
      :path.endsWith('/metrics')?{cpuPercent:0,memoryBytes:0,memoryLimitBytes:0,networkRxBytes:0,networkTxBytes:0,containers:1}
      :path.endsWith('/actions')||path==='/api/v1/actions'?[]:{};
    return route.fulfill({json:data});
  });
  await page.goto(`${base}/services/${service.id}`);await expect(page.getByRole('heading',{name:'Database connection',exact:true})).toBeVisible();return {page,calls};
}
try {
  const {page,calls}=await fixture();await page.getByRole('button',{name:'Restore',exact:true}).click();const dialog=page.getByRole('dialog',{name:'Restore database',exact:true});await expect(dialog).toBeVisible();await expect(dialog.getByText(/\.rdb export to this Redis 7/)).toBeVisible();await expect(dialog.getByRole('button',{name:'Upload export',exact:true})).toBeDisabled();
  await dialog.getByLabel('Export file',{exact:true}).setInputFiles({name:'fixture.rdb',mimeType:'application/octet-stream',buffer:Buffer.from('REDIS0011-browser-fixture')});await dialog.getByRole('button',{name:'Upload export',exact:true}).click();await dialog.getByRole('button',{name:'Prepare restore',exact:true}).click();await expect(dialog.getByRole('button',{name:'Restore database',exact:true})).toBeDisabled();assert.equal(calls.filter(call=>call.path.endsWith('/commit')).length,0);
  await dialog.getByRole('checkbox',{name:'I understand that current database data will be replaced.'}).check();await dialog.getByRole('button',{name:'Restore database',exact:true}).click();await expect(dialog.getByText('The database was restored.',{exact:true})).toBeVisible();await expect(dialog.getByRole('button',{name:'Roll back Redis restore',exact:true})).toBeDisabled();
  for(const width of [375,768,1440]){await page.setViewportSize({width,height:1000});await page.evaluate(()=>document.fonts.ready);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth===innerWidth),true);assert((await dialog.boundingBox()).width<=width);await page.screenshot({path:`${output}/redis-restore-${width}.png`,fullPage:true});}
  await dialog.getByRole('checkbox',{name:'I understand that Redis will use the previous data.'}).check();await dialog.getByRole('button',{name:'Roll back Redis restore',exact:true}).click();await expect(dialog.getByText('The restore was rolled back. The previous database is running.',{exact:true})).toBeVisible();await page.keyboard.press('Escape');await expect(dialog).toHaveCount(0);await expect(page.getByRole('button',{name:'Restore',exact:true})).toBeFocused();
  await page.getByRole('button',{name:'Restore',exact:true}).click();await dialog.getByRole('button',{name:'Close dialog',exact:true}).click();await expect(dialog).toHaveCount(0);await expect(page.getByRole('button',{name:'Restore',exact:true})).toBeFocused();
  const recovery=await fixture({initial:{operationId:'a'.repeat(32),kind:'redis',phase:'importing',recoveryReason:'preparation_unverified'}});await recovery.page.getByRole('button',{name:'Restore',exact:true}).click();await recovery.page.getByRole('button',{name:'Recover Redis restore',exact:true}).click();await expect(recovery.page.getByText('The restore was cancelled.',{exact:true})).toBeVisible();
  const drift=await fixture({initial:{operationId:'b'.repeat(32),kind:'redis',phase:'completed',canRollback:true},refuseRollback:true});await drift.page.getByRole('button',{name:'Restore',exact:true}).click();await drift.page.getByRole('checkbox',{name:'I understand that Redis will use the previous data.'}).check();await drift.page.getByRole('button',{name:'Roll back Redis restore',exact:true}).click();await expect(drift.page.getByRole('alert').filter({hasText:'Rollback was refused.'})).toBeVisible();
  const viewer=await fixture({canWrite:false});await expect(viewer.page.getByRole('button',{name:'Restore',exact:true})).toHaveCount(0);assert.deepEqual(errors,[]);console.log(`PASS Redis restore UI confirmation, RDB upload, prepare, commit, rollback, interruption recovery, drift error, viewer denial and375/768/1440 screenshots at${output}`);
} finally {await browser.close();await server.close();}
