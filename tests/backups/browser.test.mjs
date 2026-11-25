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
const stamp='2026-11-17T01:00:00Z',r2Id='22222222-2222-4222-8222-222222222222';
const remote={type:'s3',provider:'s3',endpoint:'https://s3.example.test',region:'us-east-1',bucket:'backup-fixture',prefix:'backups',storageClass:'STANDARD',credentialsConfigured:true};
const errors=[];
async function fixture(canWrite=true) {
  const page=await browser.newPage({viewport:{width:1440,height:1100},reducedMotion:'reduce'});page.setDefaultTimeout(10_000);page.on('pageerror',error=>errors.push(error.message));
  let backups=[],settings={enabled:false,cron:'0 2 * * *',retention:7,timeZone:'UTC',description:'Every day at 02:00 UTC',encrypted:false,retentionPolicy:{mode:'count'}},selection={destination:{type:'local'},profileId:null,profileName:null,legacy:false};
  let profiles=[{id:'33333333-3333-4333-8333-333333333333',name:'Production S3',destination:remote,updatedAt:stamp},{id:r2Id,name:'Recovery R2',destination:{...remote,provider:'r2',endpoint:'https://fixture.r2.cloudflarestorage.com',region:'auto'},updatedAt:stamp}];const calls=[];
  await page.context().route('**/api/v1/**',async route=>{
    const request=route.request(),path=new URL(request.url()).pathname,method=request.method(),body=request.postDataJSON();calls.push({path,method,body});
    if(method!=='GET'){assert.equal(canWrite,true);assert.equal(request.headers()['x-csrf-token'],'backup-csrf');}
    if(path==='/api/v1/backup-storage'){
      if(method==='POST'){
        assert.equal(body.destination.accessKeyId,'synthetic-access');assert.equal(body.destination.secretAccessKey,'synthetic-secret');
        const {accessKeyId:_access,secretAccessKey:_secret,...destination}=body.destination,profile={id:'44444444-4444-4444-8444-444444444444',name:body.name,destination:{...destination,credentialsConfigured:true},updatedAt:stamp};profiles=[...profiles,profile];return route.fulfill({status:201,json:{profile}});
      }
      return route.fulfill({json:{profiles}});
    }
    if(path.startsWith('/api/v1/backup-storage/')&&method==='PUT'){
      const profile=profiles.find(profile=>path.endsWith(profile.id));assert(profile);assert.equal(body.destination.accessKeyId,undefined);assert.equal(body.destination.secretAccessKey,undefined);
      const updated={...profile,name:body.name,destination:{...body.destination,credentialsConfigured:true}};profiles=profiles.map(profile=>profile.id===updated.id?updated:profile);return route.fulfill({json:{profile:updated}});
    }
    if(path.endsWith('/backup-destination')) {
      if(method==='PUT'){assert.deepEqual(Object.keys(body),['profileId']);const profile=profiles.find(profile=>profile.id===body.profileId);selection={destination:profile?.destination??{type:'local'},profileId:profile?.id??null,profileName:profile?.name??null,legacy:false};}
      return route.fulfill({json:selection});
    }
    if(path.endsWith('/backup-settings')) {
      if(method==='PUT'){
        if(body.cron==='invalid')return route.fulfill({status:400,json:{error:{code:'BACKUP_SCHEDULE',message:'Use five cron fields: minute, hour, day, month, weekday.'}}});
        settings={...body,timeZone:'UTC',description:'Saved schedule'};
      }
      return route.fulfill({json:{settings}});
    }
    if(path.endsWith('/backups')) {
      if(method==='POST'){
        assert.match(request.headers()['idempotency-key'],/^[a-f0-9-]{36}$/);
        const backup={id:'11111111-1111-4111-8111-111111111111',serviceId:service.id,name:body.name,status:'succeeded',trigger:'manual',createdAt:stamp,finishedAt:stamp,size:1024,sha256:'a'.repeat(64),extension:'dump',error:null,destination:selection.destination.type,encrypted:settings.encrypted};backups=[backup];return route.fulfill({status:202,json:{backup}});
      }
      return route.fulfill({json:{backups}});
    }
    if(path.endsWith('/download'))return route.fulfill({status:200,headers:{'content-type':'application/octet-stream','content-disposition':'attachment; filename="fixture.dump"'},body:'synthetic-dump'});
    if(method==='DELETE'&&path.includes('/backups/')){backups=backups.map(backup=>({...backup,status:'deleted'}));return route.fulfill({json:{success:true}});}
    const data=path==='/api/v1/auth/session'?{user:{id:'fixture',role:canWrite?'admin':'member',email:'backup@example.test'},csrfToken:'backup-csrf'}
      :path==='/api/v1/projects'?[{id:service.projectId,name:'Backups fixture',canWrite}]
      :path===`/api/v1/services/${service.id}`?service
      :path.endsWith('/metrics')?{cpuPercent:0,memoryBytes:0,memoryLimitBytes:0,networkRxBytes:0,networkTxBytes:0,containers:1}
      :path.endsWith('/actions')||path==='/api/v1/actions'?[]:undefined;
    return route.fulfill(data===undefined?{status:404,json:{error:{message:'Fixture endpoint unavailable'}}}:{json:data});
  });
  await page.goto(`${base}/services/${service.id}?tab=backups`);await expect(page.getByRole('heading',{name:'Database backups',exact:true})).toBeVisible();
  return {page,calls};
}
try {
  const {page,calls}=await fixture(),schedule=page.getByRole('form',{name:'Schedule & retention',exact:true});
  assert((await schedule.getByRole('radio',{name:'Custom cron',exact:true}).boundingBox()).width<=20,'Native radio stays compact inside global label styles');
  await schedule.getByRole('radio',{name:'Custom cron',exact:true}).check();await schedule.getByLabel('Cron schedule (UTC)',{exact:true}).fill('invalid');
  await schedule.getByRole('button',{name:'Save backup settings',exact:true}).click();await expect(schedule.getByRole('alert')).toContainText('Use five cron fields');
  await schedule.getByLabel('Cron schedule (UTC)',{exact:true}).fill('*/5 * * * *');await schedule.getByRole('switch',{name:/Automatic backups/}).check();
  await schedule.getByRole('spinbutton',{name:'Completed backups to keep'}).fill('');await schedule.getByRole('button',{name:'Save backup settings',exact:true}).click();
  assert.equal(calls.filter(call=>call.method==='PUT').length,1,'Native required validation prevents empty retention submission');
  await schedule.getByRole('spinbutton',{name:'Completed backups to keep'}).fill('3');await schedule.getByRole('checkbox',{name:'Encrypt new backup files',exact:true}).check();
  await schedule.getByRole('button',{name:'Save backup settings',exact:true}).click();await expect(schedule.getByText('Backup settings saved.',{exact:true})).toBeVisible();
  assert.deepEqual(calls.filter(call=>call.path.endsWith('/backup-settings')&&call.method==='PUT').at(-1).body,{enabled:true,cron:'*/5 * * * *',retention:3,encrypted:true,retentionPolicy:{mode:'count'}});
  await schedule.getByRole('radio',{name:'Daily',exact:true}).check();await schedule.getByLabel('Backup time (UTC)',{exact:true}).fill('03:45');
  await schedule.getByLabel('Retention policy',{exact:true}).selectOption('age');await schedule.getByLabel('Days to keep',{exact:true}).fill('14');await schedule.getByRole('button',{name:'Save backup settings',exact:true}).click();await expect(schedule.getByText('Backup settings saved.',{exact:true})).toBeVisible();
  assert.deepEqual(calls.filter(call=>call.path.endsWith('/backup-settings')&&call.method==='PUT').at(-1).body.retentionPolicy,{mode:'age',days:14});
  await schedule.getByLabel('Retention policy',{exact:true}).selectOption('gfs');await schedule.getByLabel('Hourly copies',{exact:true}).fill('2');await schedule.getByLabel('Yearly copies',{exact:true}).fill('1');await schedule.getByRole('button',{name:'Save backup settings',exact:true}).click();await expect(schedule.getByText('Backup settings saved.',{exact:true})).toBeVisible();
  assert.deepEqual(calls.filter(call=>call.path.endsWith('/backup-settings')&&call.method==='PUT').at(-1).body,{enabled:true,cron:'45 3 * * *',retention:3,encrypted:true,retentionPolicy:{mode:'gfs',hourly:2,daily:7,weekly:4,monthly:12,yearly:1}});
  const provider=page.getByRole('form',{name:'Where backups are stored',exact:true});await provider.getByLabel('Storage profile',{exact:true}).selectOption(r2Id);await provider.getByRole('button',{name:'Save destination',exact:true}).click();await expect(provider.getByText('Backup destination saved.',{exact:true})).toBeVisible();
  await expect(provider.locator('input[type=password]')).toHaveCount(0);await provider.getByLabel('Storage profile',{exact:true}).focus();await expect(provider.getByLabel('Storage profile',{exact:true})).toBeFocused();
  const manual=page.getByRole('form',{name:'Manual backup',exact:true});await manual.getByLabel('Backup name (optional)',{exact:true}).fill('Before application upgrade');await manual.getByRole('button',{name:'Create backup',exact:true}).click();await expect(page.getByText('Before application upgrade',{exact:true})).toBeVisible();
  const download=page.waitForEvent('download');await page.getByRole('link',{name:'Download',exact:true}).click();assert.equal((await download).suggestedFilename(),'fixture.dump');
  for(const width of [375,768,1440]){await page.setViewportSize({width,height:1100});await page.evaluate(()=>document.fonts.ready);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth===innerWidth),true,`${width}: no horizontal overflow`);await page.screenshot({path:`${output}/backups-${width}.png`,fullPage:true});}
  await page.getByRole('button',{name:'Delete',exact:true}).click();await expect(page.getByText('Delete this backup file from its storage destination? This cannot be undone.',{exact:true})).toBeVisible();await page.getByRole('button',{name:'Keep backup',exact:true}).click();assert.equal(calls.filter(call=>call.method==='DELETE').length,0);
  await page.getByRole('button',{name:'Delete',exact:true}).click();await page.getByRole('button',{name:'Delete backup',exact:true}).click();await expect(page.getByRole('link',{name:'Download',exact:true})).toHaveCount(0);
  await provider.getByRole('link',{name:'Manage storage',exact:true}).click();await expect(page).toHaveURL(/\/settings#backup-storage$/);
  const global=page.locator('#backup-storage');await expect(global.getByRole('heading',{name:'Backup storage',exact:true})).toBeVisible();
  const addStorage=global.getByRole('button',{name:'Add storage',exact:true});
  const storageDialog=page.getByRole('dialog',{name:'New storage profile',exact:true});
  await expect(storageDialog).toHaveCount(0);
  await addStorage.click();const storageForm=storageDialog.getByRole('form',{name:'New storage profile',exact:true});
  await expect(storageForm.getByLabel('Profile name',{exact:true})).toBeFocused();
  await page.keyboard.press('Escape');await expect(storageDialog).toHaveCount(0);await expect(addStorage).toBeFocused();
  await addStorage.click();
  await storageForm.getByLabel('Profile name',{exact:true}).fill('Test offsite');await storageForm.getByLabel('Endpoint URL',{exact:true}).fill('https://s3.example.test');await storageForm.getByLabel('Bucket',{exact:true}).fill('backup-fixture');await storageForm.getByLabel('Access key ID',{exact:true}).fill('synthetic-access');await storageForm.getByLabel('Secret access key',{exact:true}).fill('synthetic-secret');await storageForm.getByRole('button',{name:'Save storage profile',exact:true}).click();await expect(global.getByText('Test offsite',{exact:true})).toBeVisible();
  await global.getByRole('button',{name:'Edit Test offsite',exact:true}).click();const editing=global.getByRole('form',{name:'Edit storage profile',exact:true});await expect(editing.getByLabel('Secret access key (leave blank to keep)',{exact:true})).toHaveValue('');await editing.getByLabel('Profile name',{exact:true}).fill('Renamed offsite');await editing.getByRole('button',{name:'Save storage profile',exact:true}).click();await expect(global.getByText('Renamed offsite',{exact:true})).toBeVisible();
  await global.getByRole('button',{name:'Edit Renamed offsite',exact:true}).click();await editing.getByLabel('Endpoint URL',{exact:true}).fill('https://different.example.test');await expect(editing.getByLabel('Access key ID',{exact:true})).toHaveAttribute('required','');await expect(editing.getByLabel('Secret access key',{exact:true})).toHaveAttribute('required','');await editing.getByRole('button',{name:'Cancel',exact:true}).click();
  for(const width of [375,768,1440]){
    await page.setViewportSize({width,height:width===375?812:1000});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth===innerWidth),true);
    await global.screenshot({path:`${output}/backup-storage-${width}.png`});
    await addStorage.click();
    assert.equal(await storageDialog.evaluate(dialog=>dialog.scrollWidth<=dialog.clientWidth),true);
    await expect(storageDialog.getByRole('button',{name:'Save storage profile',exact:true})).toBeInViewport();
    await page.screenshot({path:`${output}/storage-modal-${width}.png`,animations:'disabled'});
    await page.keyboard.press('Escape');
  }
  const viewer=await fixture(false);await expect(viewer.page.getByRole('form',{name:'Manual backup',exact:true})).toHaveCount(0);await expect(viewer.page.getByRole('button',{name:'Save backup settings',exact:true})).toHaveCount(0);await expect(viewer.page.getByRole('radio',{name:'Daily',exact:true})).toBeDisabled();await expect(viewer.page.getByRole('switch',{name:/Automatic backups/})).toBeDisabled();await expect(viewer.page.getByLabel('Storage profile',{exact:true})).toBeDisabled();
  assert.deepEqual(errors,[]);console.log(`PASS backup UI: global profiles, credential preservation/host-change validation, schedule presets/time, count/age/GFS retention, encryption, manual/download/delete, viewer restrictions and responsive screenshots at ${output}`);
}finally{await browser.close();await server.close();}
