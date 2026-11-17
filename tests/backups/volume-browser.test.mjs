import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium,expect } from '@playwright/test';

const root=fileURLToPath(new URL('../../apps/panel',import.meta.url));
const server=await createServer({root,server:{port:0},plugins:[{name:'volume-download-fixture',configureServer(vite){vite.middlewares.use((request,response,next)=>{
  if(!request.url?.endsWith('/volume-backups/11111111-1111-4111-8111-111111111111/download'))return next();
  response.setHeader('content-type','application/octet-stream');response.setHeader('content-disposition','attachment; filename="volume-fixture.tar"');response.end('synthetic-volume-archive');
});}}]});await server.listen();
const browser=await chromium.launch({headless:true});
const base=`http://127.0.0.1:${server.httpServer.address().port}`;
const output=process.env.VOLUME_BACKUP_SCREENSHOTS||'/tmp/servus-volume-backup-qa';await mkdir(output,{recursive:true});
const stamp='2026-11-17T12:00:00.000Z',backupId='11111111-1111-4111-8111-111111111111',restoreId='22222222-2222-4222-8222-222222222222';
const service={id:'volume-service',projectId:'volume-project',name:'files',image:'nginx:alpine',kind:'app',source:{type:'image'},hostname:'files.localhost',port:80,replicas:1,state:'running',revision:1,deployedRevision:1,domains:[],environment:[],mounts:[{type:'volume',name:'documents',target:'/data'},{type:'volume',name:'cache',target:'/cache',readOnly:true}],createdAt:stamp,updatedAt:stamp,lastError:null};
const errors=[];
async function fixture(canWrite=true,deletionPending=false){
  const page=await browser.newPage({viewport:{width:1440,height:1100},reducedMotion:'reduce'});page.setDefaultTimeout(10000);page.on('pageerror',error=>errors.push(error.message));
  const calls=[];let backups=deletionPending?[{id:backupId,serviceId:service.id,mountTarget:'/data',name:'Interrupted deletion',status:'succeeded',deletionPending:true,trigger:'manual',createdAt:stamp,finishedAt:stamp,size:2048,sha256:'a'.repeat(64),error:null,destination:'local'}]:[],restores=[],destination={type:'local'},settings={mountTarget:'/data',enabled:false,cron:'0 2 * * *',retention:7,timeZone:'UTC',description:'Every day at 02:00 UTC'};
  await page.route('**/api/v1/**',async route=>{
    const request=route.request(),url=new URL(request.url()),path=url.pathname,method=request.method(),body=request.postDataJSON();
    calls.push({path,method,body});
    if(method!=='GET'){assert.equal(canWrite,true);assert.equal(request.headers()['x-csrf-token'],'volume-csrf');}
    if(path.endsWith('/volume-backups')){
      if(method==='POST'){assert.equal(body.mountTarget,'/data');backups=[{id:backupId,serviceId:service.id,mountTarget:'/data',name:body.name||'Volume backup',status:'succeeded',trigger:'manual',createdAt:stamp,finishedAt:stamp,size:2048,sha256:'a'.repeat(64),error:null,destination:'local'}];return route.fulfill({status:202,json:{backup:backups[0]}});}
      return route.fulfill({json:{backups}});
    }
    if(path.endsWith('/volume-backup-settings')){
      if(method==='PUT'){assert.equal(body.mountTarget,'/data');settings={...settings,...body,description:'Every 5 minutes (UTC)'};return route.fulfill({json:{settings}});}
      return route.fulfill({json:{settings:[settings]}});
    }
    if(path.endsWith('/volume-backup-destination')){
      if(method==='PUT'){assert.equal(body.mountTarget,'/data');destination=body.destination.type==='local'?{type:'local'}:{...body.destination,accessKeyId:undefined,secretAccessKey:undefined};return route.fulfill({json:{destination}});}
      assert.equal(url.searchParams.get('mountTarget'),'/data');return route.fulfill({json:{destination}});
    }
    if(path.endsWith(`/volume-backups/${backupId}/restore`)){
      assert.equal(method,'POST');assert.ok(request.headers()['idempotency-key']);restores=[{id:restoreId,backupId,serviceId:service.id,mountTarget:'/data',phase:'prepared',candidateVolume:'fixture-candidate',previousVolume:'fixture-original',error:null,createdAt:stamp,updatedAt:stamp}];return route.fulfill({status:202,json:{restore:restores[0]}});
    }
    if(path.endsWith('/volume-restores'))return route.fulfill({json:{restores}});
    if(path.endsWith(`/volume-backups/${backupId}`)&&method==='DELETE'){backups=backups.map(backup=>({...backup,status:'deleted',deletionPending:false}));return route.fulfill({json:{success:true}});}
    if(path.endsWith(`/volume-restores/${restoreId}/commit`)||path.endsWith(`/volume-restores/${restoreId}/rollback`)){
      assert.deepEqual(body,{confirm:true});restores=restores.map(restore=>({...restore,phase:path.endsWith('/commit')?'completed':'rolled_back'}));return route.fulfill({status:202,json:{restore:restores[0]}});
    }
    const data=path==='/api/v1/auth/session'?{user:{id:'fixture',role:canWrite?'admin':'member',email:'volume@example.test'},csrfToken:'volume-csrf'}
      :path==='/api/v1/projects'?[{id:service.projectId,name:'Volume fixture',canWrite}]
      :path===`/api/v1/services/${service.id}`?service
      :path.endsWith('/metrics')?{cpuPercent:0,memoryBytes:0,memoryLimitBytes:0,networkRxBytes:0,networkTxBytes:0,containers:1}
      :path.endsWith('/actions')||path==='/api/v1/actions'?[]:{};
    return route.fulfill({json:data});
  });
  await page.goto(`${base}/services/${service.id}?tab=backups`);await expect(page.getByRole('heading',{name:'Volume backups',exact:true})).toBeVisible();return{page,calls};
}
try{
  const{page,calls}=await fixture();
  await expect(page.getByLabel('Application volume')).toHaveValue('/data');await expect(page.getByLabel('Application volume').getByRole('option')).toHaveCount(1);
  const manual=page.getByRole('form',{name:'Manual volume backup',exact:true});await manual.getByLabel('Backup name (optional)').fill('Before file migration');await manual.getByRole('button',{name:'Create volume backup',exact:true}).click();await expect(page.getByText('Before file migration',{exact:true})).toBeVisible();
  const downloading=page.waitForEvent('download');await page.getByRole('link',{name:'Download volume backup',exact:true}).click();assert.equal((await downloading).suggestedFilename(),'volume-fixture.tar');
  const schedule=page.getByRole('form',{name:'Scheduled backups',exact:true});await schedule.getByLabel('Enable scheduled backups').check();await schedule.getByLabel('Cron schedule (UTC)',{exact:true}).fill('*/5 * * * *');await schedule.getByRole('button',{name:'Save backup settings',exact:true}).click();await expect(schedule.getByText('Every 5 minutes (UTC)',{exact:true})).toBeVisible();
  const provider=page.getByRole('form',{name:'Backup destination',exact:true});await provider.getByRole('radio',{name:'Amazon S3 / compatible',exact:true}).check();await provider.getByLabel('S3 endpoint URL',{exact:true}).fill('https://s3.example.test');await provider.getByLabel('Bucket name',{exact:true}).fill('volume-fixture');await provider.getByLabel('Access key ID',{exact:true}).fill('synthetic-access');await provider.getByLabel('Secret access key',{exact:true}).fill('synthetic-secret');await provider.getByRole('button',{name:'Save backup destination',exact:true}).click();await expect(provider.getByLabel('Secret access key',{exact:true})).toHaveValue('');
  await page.getByRole('button',{name:'Prepare restore',exact:true}).click();await expect(page.getByRole('button',{name:'Switch to restored volume',exact:true})).toBeVisible();await page.getByRole('button',{name:'Switch to restored volume',exact:true}).click();
  const confirm=page.getByRole('form',{name:'Confirm volume switch',exact:true});await confirm.getByRole('button',{name:'Confirm switch',exact:true}).click();assert.equal(calls.filter(call=>call.path.endsWith('/commit')).length,0,'Native confirmation is required before changing data');await confirm.getByRole('checkbox').check();await confirm.getByRole('button',{name:'Confirm switch',exact:true}).click();await expect(page.getByRole('button',{name:'Roll back volume',exact:true})).toBeVisible();
  for(const width of[375,768,1440]){await page.setViewportSize({width,height:1100});await page.screenshot({path:`${output}/volume-backups-${width}.png`,fullPage:true});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`No page overflow at ${width}`);}
  await page.getByRole('button',{name:'Roll back volume',exact:true}).click();const rollback=page.getByRole('form',{name:'Confirm volume rollback',exact:true});await rollback.getByRole('checkbox').check();await rollback.getByRole('button',{name:'Confirm rollback',exact:true}).click();await expect(page.getByText('rolled_back',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Delete',exact:true}).click();await expect(page.getByText('Delete this backup archive from its storage destination? This cannot be undone.',{exact:true})).toBeVisible();await page.getByRole('button',{name:'Delete volume backup',exact:true}).click();await expect(page.getByText('deleted',{exact:true})).toBeVisible();
  const viewer=await fixture(false);await expect(viewer.page.getByRole('button',{name:'Create volume backup',exact:true})).toHaveCount(0);await expect(viewer.page.getByRole('button',{name:'Save backup destination',exact:true})).toHaveCount(0);await expect(viewer.page.getByLabel('Enable scheduled backups')).toBeDisabled();await viewer.page.close();
  const pending=await fixture(true,true);await expect(pending.page.getByText('deletion pending',{exact:true})).toBeVisible();await expect(pending.page.getByRole('button',{name:'Prepare restore',exact:true})).toHaveCount(0);await expect(pending.page.getByRole('link',{name:'Download volume backup',exact:true})).toHaveCount(0);await pending.page.getByRole('button',{name:'Retry deletion',exact:true}).click();await pending.page.getByRole('button',{name:'Delete volume backup',exact:true}).click();await expect(pending.page.getByText('deleted',{exact:true})).toBeVisible();await pending.page.close();
  assert.deepEqual(errors,[]);console.log(JSON.stringify({status:'passed',viewports:[375,768,1440],checks:['manual','download','schedule','destination','prepare','confirm','rollback','delete','viewer','interrupted-deletion'],screenshots:output}));
}finally{await browser.close();await server.close();}
