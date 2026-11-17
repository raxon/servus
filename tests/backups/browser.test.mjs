import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium, expect } from '@playwright/test';

const root=fileURLToPath(new URL('../../apps/panel',import.meta.url));
const server=await createServer({root,server:{port:0},plugins:[{name:'backup-download-fixture',configureServer(vite){vite.middlewares.use((req,res,next)=>{
  // Chromium download requests bypass Playwright route interception.
  if(!req.url?.endsWith('/backups/11111111-1111-4111-8111-111111111111/download'))return next();
  res.setHeader('content-type','application/octet-stream');res.setHeader('content-disposition','attachment; filename="fixture.dump"');res.end('synthetic-dump');
});}}]});await server.listen();
const browser=await chromium.launch({headless:true}),base=`http://127.0.0.1:${server.httpServer.address().port}`;
const output=process.env.BACKUP_SCREENSHOTS||'/tmp/servus-backup-qa';await mkdir(output,{recursive:true});
const service={id:'backup-service',projectId:'backup-project',name:'database',kind:'postgres',image:'postgres:17-alpine',source:{type:'image'},state:'running',revision:1,deployedRevision:1,replicas:1,domains:[],environment:[],mounts:[],createdAt:'2026-11-17T01:00:00Z',updatedAt:'2026-11-17T01:00:00Z',lastError:null};
const errors=[];
async function fixture(canWrite=true) {
  const page=await browser.newPage({viewport:{width:1440,height:1100},reducedMotion:'reduce'});page.setDefaultTimeout(10_000);page.on('pageerror',error=>errors.push(error.message));
  let backups=[],settings={enabled:false,cron:'0 2 * * *',retention:7,timeZone:'UTC',description:'Every day at 02:00 UTC'},destination={type:'local'};const calls=[];
  await page.context().route('**/api/v1/**',async route=>{
    const request=route.request(),path=new URL(request.url()).pathname;calls.push({path,method:request.method()});
    if(path.endsWith('/backup-destination')) {
      if(request.method()==='PUT') {const body=request.postDataJSON();assert.equal(request.headers()['x-csrf-token'],'backup-csrf');
        if(body.type==='s3'){assert.equal(body.accessKeyId,'synthetic-access');assert.equal(body.secretAccessKey,'synthetic-secret');const {accessKeyId,secretAccessKey,...safe}=body;destination={...safe,credentialsConfigured:true};}else destination={type:'local'};
      }
      return route.fulfill({json:{destination}});
    }
    if(path.endsWith('/backup-settings')) {
      if(request.method()==='PUT') {const body=request.postDataJSON();assert.equal(request.headers()['x-csrf-token'],'backup-csrf');
        if(body.cron==='invalid')return route.fulfill({status:400,json:{error:{code:'BACKUP_SCHEDULE',message:'Use five cron fields: minute, hour, day, month, weekday.'}}});
        settings={...body,timeZone:'UTC',description:body.cron==='*/5 * * * *'?'Every 5 minutes (UTC)':'Every day at 02:00 UTC'};
      }
      return route.fulfill({json:{settings}});
    }
    if(path.endsWith('/backups')) {
      if(request.method()==='POST') {assert.equal(canWrite,true);assert.equal(request.headers()['x-csrf-token'],'backup-csrf');assert.match(request.headers()['idempotency-key'],/^[a-f0-9-]{36}$/);
        const backup={id:'11111111-1111-4111-8111-111111111111',serviceId:service.id,name:request.postDataJSON().name,status:'succeeded',trigger:'manual',createdAt:'2026-11-17T01:00:00Z',finishedAt:'2026-11-17T01:00:01Z',size:1024,sha256:'a'.repeat(64),extension:'dump',error:null};backups=[backup];return route.fulfill({status:202,json:{backup}});
      }
      return route.fulfill({json:{backups}});
    }
    if(path.endsWith('/download'))return route.fulfill({status:200,headers:{'content-type':'application/octet-stream','content-disposition':'attachment; filename="fixture.dump"'},body:'synthetic-dump'});
    if(request.method()==='DELETE'&&path.includes('/backups/')) {assert.equal(canWrite,true);backups=backups.map(backup=>({...backup,status:'deleted'}));return route.fulfill({json:{success:true}});}
    const data=path==='/api/v1/auth/session'?{user:{id:'fixture',role:canWrite?'admin':'member',email:'backup@example.test'},csrfToken:'backup-csrf'}
      :path==='/api/v1/projects'?[{id:service.projectId,name:'Backups fixture',canWrite}]
      :path===`/api/v1/services/${service.id}`?service
      :path.endsWith('/metrics')?{cpuPercent:0,memoryBytes:0,memoryLimitBytes:0,networkRxBytes:0,networkTxBytes:0,containers:1}
      :path.endsWith('/actions')||path==='/api/v1/actions'?[]:{};
    return route.fulfill({json:data});
  });
  await page.goto(`${base}/services/${service.id}?tab=backups`);await expect(page.getByRole('heading',{name:'Database backups',exact:true})).toBeVisible();
  return {page,calls};
}
try {
  const {page,calls}=await fixture(),schedule=page.getByRole('form',{name:'Scheduled backups',exact:true});
  await schedule.getByRole('textbox',{name:'Cron schedule (UTC)',exact:true}).fill('invalid');
  await schedule.getByRole('button',{name:'Save backup settings',exact:true}).click();
  await expect(schedule.getByRole('alert')).toContainText('Use five cron fields');
  await schedule.getByRole('textbox',{name:'Cron schedule (UTC)',exact:true}).fill('*/5 * * * *');await schedule.getByLabel('Enable scheduled backups').check();
  await schedule.getByRole('spinbutton',{name:'Completed backups to keep'}).fill('');await schedule.getByRole('button',{name:'Save backup settings',exact:true}).click();
  assert.equal(calls.filter(call=>call.method==='PUT').length,1,'Native required validation prevents empty retention submission');
  await schedule.getByRole('spinbutton',{name:'Completed backups to keep'}).fill('3');await schedule.getByRole('button',{name:'Save backup settings',exact:true}).click();
  await expect(schedule.getByText('Every 5 minutes (UTC)',{exact:true})).toBeVisible();
  const manual=page.getByRole('form',{name:'Manual backup',exact:true});await manual.getByRole('textbox',{name:'Backup name (optional)'}).fill('Before application upgrade');await manual.getByRole('button',{name:'Create backup',exact:true}).click();
  await expect(page.getByText('Before application upgrade',{exact:true})).toBeVisible();
  const download=page.waitForEvent('download');await page.getByRole('link',{name:'Download',exact:true}).click();assert.equal((await download).suggestedFilename(),'fixture.dump');
  const provider=page.getByRole('form',{name:'Backup destination',exact:true});await provider.getByRole('radio',{name:'Amazon S3 / compatible',exact:true}).check();
  await provider.getByLabel('S3 endpoint URL',{exact:true}).fill('https://s3.example.test');await provider.getByLabel('Bucket name',{exact:true}).fill('backup-fixture');
  await provider.getByLabel('Access key ID',{exact:true}).fill('synthetic-access');await provider.getByLabel('Secret access key',{exact:true}).fill('synthetic-secret');
  await provider.getByRole('button',{name:'Save backup destination',exact:true}).click();
  await expect(provider.getByText('Backup destination saved.',{exact:true})).toBeVisible();await expect(provider.getByLabel('Access key ID',{exact:true})).toHaveValue('');await expect(provider.getByLabel('Secret access key',{exact:true})).toHaveValue('');
  for(const width of [375,768,1440]) {await page.setViewportSize({width,height:1100});await page.evaluate(()=>document.fonts.ready);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth===innerWidth),true,`${width}: no horizontal overflow`);await page.screenshot({path:`${output}/backups-${width}.png`,fullPage:true});}
  await page.getByRole('button',{name:'Delete',exact:true}).click();await expect(page.getByText('Delete this backup file from the server? This cannot be undone.',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Keep backup',exact:true}).click();assert.equal(calls.filter(call=>call.method==='DELETE').length,0);
  await page.getByRole('button',{name:'Delete',exact:true}).click();await page.getByRole('button',{name:'Delete backup',exact:true}).click();await expect(page.getByRole('link',{name:'Download',exact:true})).toHaveCount(0);
  const viewer=await fixture(false);await expect(viewer.page.getByRole('form',{name:'Manual backup',exact:true})).toHaveCount(0);await expect(viewer.page.getByRole('button',{name:'Save backup settings',exact:true})).toHaveCount(0);await expect(viewer.page.getByRole('textbox',{name:'Cron schedule (UTC)',exact:true})).toBeDisabled();
  assert.deepEqual(errors,[]);console.log(`PASS backup UI validation, named backup, download, S3 destination/credential masking, deletion confirmation, viewer restrictions and responsive screenshots at ${output}`);
} finally {await browser.close();await server.close();}
