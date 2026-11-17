import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {mkdir} from 'node:fs/promises';
import {createServer} from 'vite';
import {chromium,expect} from '@playwright/test';

const root=fileURLToPath(new URL('../../apps/panel',import.meta.url)),server=await createServer({root,server:{port:0}});await server.listen();
const browser=await chromium.launch({headless:true}),page=await browser.newPage({viewport:{width:1440,height:1100}}),errors=[],creates=[],patches=[],operations=[];
let certificateMode="not_found",checks=0,retries=0;
let workloads=[],configuration={source:{type:'inline',yaml:'services:\n  web:\n    image: nginx:alpine\n'},domains:[]};
page.on('pageerror',error=>errors.push(error.message));
try{
  await page.route('**/api/v1/**',async route=>{
    const request=route.request(),path=new URL(request.url()).pathname;
    if(path==='/api/v1/projects/project-1/compose'&&request.method()==='POST'){
      const body=request.postDataJSON();creates.push(body);configuration={source:body.source,domains:body.domains};
      workloads=[{id:'compose-1',projectId:'project-1',name:body.name,revision:1,deployedRevision:1,state:'running',sourceType:body.source.type,domains:body.domains,createdAt:'2026-11-17T10:00:00Z',updatedAt:'2026-11-17T10:00:00Z',lastError:null}];
      return route.fulfill({status:202,json:{workload:workloads[0],action:{id:'create-1'}}});
    }
    if(path==='/api/v1/compose/compose-1'&&request.method()==='PATCH'){
      const body=request.postDataJSON();patches.push(body);assert.equal(body.expectedRevision,workloads[0].revision);configuration={source:body.source,domains:body.domains};workloads[0]={...workloads[0],revision:workloads[0].revision+1,domains:body.domains};return route.fulfill({json:workloads[0]});
    }
    if(path.endsWith('/check-managed-certificate')){
      checks++;assert.equal(request.postDataJSON().hostname,'compose.example.test');
      if(certificateMode==='error')return route.fulfill({status:503,json:{error:{code:'CERTIFICATE_UNAVAILABLE',message:'Certificate status unavailable. Try again.'}}});
      return route.fulfill({json:{hostname:'compose.example.test',checkedAt:new Date().toISOString(),status:certificateMode,publicVerified:certificateMode==='active',eventsAvailable:true,...(certificateMode==='active'?{expiresAt:'2027-01-01T00:00:00Z',notBefore:'2026-11-17T00:00:00Z',fingerprint:Array(32).fill('AA').join(':')}:{})}});
    }
    if(path.endsWith('/retry-certificate')){retries++;return route.fulfill({status:202,json:{id:'certificate-retry'}});}
    if(request.method()==='POST'&&path.startsWith('/api/v1/compose/compose-1/')){
      operations.push(path.split('/').at(-1));if(operations.at(-1)==='destroy'){assert.equal(request.postDataJSON().confirm,true);workloads=[];}return route.fulfill({status:202,json:{id:'action-1'}});
    }
    const data=path==='/api/v1/templates'?{templates:[]}:path==='/api/v1/auth/session'?{user:{id:'user-1',email:'test@example.test',role:'admin'},csrfToken:'test'}
      :path==='/api/v1/projects'?[{id:'project-1',name:'Compose project',canWrite:true,createdAt:'2026-11-17T10:00:00Z'}]
      :path==='/api/v1/projects/project-1/services'||path==='/api/v1/actions'?[]
      :path==='/api/v1/projects/project-1/compose'?workloads
      :path.endsWith('/configuration')?configuration
      :path.endsWith('/logs')?{logs:'fixture runtime output'}
      :path.endsWith('/actions')?[]:{};
    await route.fulfill({json:data});
  });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/projects/project-1`);
  await page.getByRole('button',{name:'New Compose workload'}).click();
  const dialog=page.getByRole('dialog',{name:'New Compose workload'});
  await dialog.getByRole('textbox',{name:'Name',exact:true}).fill('fixture-compose');
  await expect(dialog).toContainText('Inline builds have an empty context');await dialog.getByRole('textbox',{name:'Compose YAML'}).fill('services:\n  web:\n    build:\n      dockerfile_inline: |\n        FROM nginx:alpine\n');
  await dialog.getByRole('radio',{name:'Public Git'}).check();await expect(dialog).toContainText('Build paths are relative to the Compose file');await dialog.getByRole('radio',{name:'Inline YAML'}).check();
  const screenshotDir=fileURLToPath(new URL('../../artifacts/compose/browser/',import.meta.url));await mkdir(screenshotDir,{recursive:true});
  for(const width of[1440,768,375]){await page.setViewportSize({width,height:1100});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`Compose build form overflows at ${width}`);await page.screenshot({path:`${screenshotDir}/compose-build-form-${width}.png`,fullPage:true});}
  await page.setViewportSize({width:1440,height:1100});
  await dialog.getByRole('button',{name:'Create and deploy'}).click();
  await expect(dialog).toHaveCount(0);await expect(page.getByRole('heading',{name:/fixture-compose/})).toBeVisible();assert.equal(creates.length,1);assert.match(creates[0].source.yaml,/dockerfile_inline/);
  await page.getByRole('button',{name:'Details and logs'}).click();await expect(page.getByText('fixture runtime output',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Edit Compose configuration'}).click();const edit=page.getByRole('dialog',{name:'Edit Compose configuration'});
  await edit.getByRole('textbox',{name:'Compose YAML'}).fill(configuration.source.yaml+'    environment: {MODE: production}\n');
  await edit.getByRole('button',{name:'Add domain'}).click();await edit.getByRole('textbox',{name:'Hostname'}).fill('compose.example.test');await edit.getByRole('textbox',{name:'Compose service'}).fill('web');
  await edit.getByRole('checkbox',{name:'Automatic HTTPS (ACME HTTP-01)'}).check();await expect(edit.getByRole('checkbox',{name:'Redirect HTTP to HTTPS after verification'})).toBeDisabled();
  await edit.getByRole('button',{name:'Save configuration'}).click();await expect(edit).toHaveCount(0);assert.equal(patches.length,1);assert.equal(operations.length,0,'Saving must not deploy');
  const certificate=page.getByRole('region',{name:'HTTPS certificate for compose.example.test'});
  await certificate.getByRole('button',{name:'Check HTTPS certificate'}).click();await expect(certificate).toContainText('Certificate not issued yet.');
  await certificate.getByRole('button',{name:'Retry certificate issuance'}).click();await expect.poll(()=>retries).toBe(1);await expect(certificate).toContainText('Certificate retry queued.');
  certificateMode='error';await certificate.getByRole('button',{name:'Check HTTPS certificate'}).click();await expect(certificate).toContainText('Certificate status unavailable. Try again.');
  certificateMode='active';await certificate.getByRole('button',{name:'Check HTTPS certificate'}).click();await expect(certificate).toContainText('Certificate active; public HTTPS verified.');
  await page.getByRole('button',{name:'Edit Compose configuration'}).click();await expect(edit.getByRole('checkbox',{name:'Redirect HTTP to HTTPS after verification'})).toBeEnabled();await edit.getByRole('checkbox',{name:'Redirect HTTP to HTTPS after verification'}).check();await edit.getByRole('button',{name:'Save configuration'}).click();await expect(edit).toHaveCount(0);assert.equal(patches[1].domains[0].redirectHttps,true);assert.equal(checks,3);
  for(const width of[1440,768,375]){await page.setViewportSize({width,height:1100});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`Compose UI overflows at ${width}`);await page.screenshot({path:`${screenshotDir}/compose-${width}.png`,fullPage:true});}
  await page.getByRole('button',{name:'Deploy',exact:true}).click();await expect.poll(()=>operations.length).toBe(1);
  await page.getByRole('button',{name:'Remove workload',exact:true}).click();const remove=page.getByRole('dialog',{name:'Remove Compose workload?'});await expect(remove).toContainText('Named volumes are retained');await remove.getByRole('button',{name:'Remove workload and retain volumes'}).click();await expect(remove).toHaveCount(0);assert.deepEqual(operations,['deploy','destroy']);assert.deepEqual(errors,[]);
  console.log('PASS Compose browser: create, logs, configuration save without deploy, ACME HTTPS, retry and error states, verified redirect, deploy, remove retaining volumes, 375/768/1440px. API mocked; real runtime tested separately.');
}finally{await browser.close();await server.close();}
