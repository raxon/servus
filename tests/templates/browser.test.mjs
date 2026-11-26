import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium, expect } from '@playwright/test';

const root=fileURLToPath(new URL('../../apps/panel',import.meta.url)),server=await createServer({root,server:{port:0}});await server.listen();
const browser=await chromium.launch({headless:true}),base=`http://127.0.0.1:${server.httpServer.address().port}`,output=process.env.TEMPLATE_SCREENSHOTS||'/tmp/servus-template-qa';await mkdir(output,{recursive:true});
const catalog=[['wordpress','WordPress'],['n8n','n8n'],['uptime-kuma','Uptime Kuma'],['grafana','Grafana'],['minio','MinIO']].map(([id,name])=>({id,name,description:`${name} with persistent storage.`,version:'2026-11-17.1',images:[`${id}:1.2.3`],setup:'Finish application setup after deployment.',publisher:id==='minio'?'coollabsio community image':'Official publisher',supportsApiDomain:id==='minio'}));
const errors=[];
async function fixture(canWrite=true) {
  const page=await browser.newPage({viewport:{width:1440,height:1100},reducedMotion:'reduce'}),requests=[];page.setDefaultTimeout(10000);page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/api/v1/**',async route=>{
    const request=route.request(),path=new URL(request.url()).pathname;
    if(path==='/api/v1/templates')return route.fulfill({json:{templates:catalog}});
    if(request.method()==='POST'&&path.includes('/templates/')) {
      assert.equal(canWrite,true);assert.equal(request.headers()['x-csrf-token'],'template-csrf');assert.match(request.headers()['idempotency-key'],/^[a-f0-9-]{36}$/);
      const input=request.postDataJSON();requests.push({path,input});
      if(input.hostname==='invalid')return route.fulfill({status:400,json:{error:{code:'TEMPLATE_DOMAIN',message:'Enter a valid public hostname.'}}});
      return route.fulfill({status:202,json:{workload:{id:'template-workload',projectId:'template-project',name:input.name,state:'pending',sourceType:'inline',domains:[],revision:1,deployedRevision:null},action:{id:'template-action',type:'deploy',status:'queued'}}});
    }
    const data=path==='/api/v1/auth/session'?{user:{id:'fixture',role:canWrite?'admin':'member',email:'templates@example.test'},csrfToken:'template-csrf'}
      :path==='/api/v1/projects'?[{id:'template-project',name:'Template fixture',description:'',canWrite,serviceCount:0,createdAt:'2026-11-17T01:00:00Z'}]
      :path==='/api/v1/projects/template-project'?{id:'template-project',name:'Template fixture',description:'',canWrite,serviceCount:0,createdAt:'2026-11-17T01:00:00Z'}
      :path.endsWith('/services')||path.endsWith('/compose')||path.endsWith('/actions')||path==='/api/v1/actions'?[]:{};
    return route.fulfill({json:data});
  });
  await page.goto(`${base}/projects/template-project?tab=templates`);const form=page.getByRole('form',{name:'Application templates',exact:true});await expect(form).toBeVisible();return {page,form,requests};
}
try {
  const {page,form,requests}=await fixture();await expect(form.getByRole('combobox',{name:'Application',exact:true})).toHaveValue('wordpress');
  await form.getByRole('textbox',{name:'Workload name',exact:true}).fill('Invalid name');await form.getByRole('button',{name:'Deploy template',exact:true}).click();assert.equal(requests.length,0);
  await form.getByRole('textbox',{name:'Workload name',exact:true}).fill('private-site');await form.getByRole('button',{name:'Deploy template',exact:true}).click();await expect(form.getByRole('status')).toContainText('Deployment queued');assert.deepEqual(requests[0].input,{name:'private-site'});
  await form.getByRole('combobox',{name:'Application',exact:true}).selectOption('minio');await expect(form.getByRole('textbox',{name:'S3 API domain (optional)',exact:true})).toBeVisible();await expect(form.getByText(/coollabsio community image/)).toBeVisible();
  await form.getByRole('textbox',{name:'Workload name',exact:true}).fill('object-store');await form.getByRole('textbox',{name:'Application domain (optional)',exact:true}).fill('invalid');await form.getByRole('button',{name:'Deploy template',exact:true}).click();await expect(page.getByRole('region',{name:'Application templates',exact:true}).getByRole('alert')).toContainText('valid public hostname');
  await form.getByRole('textbox',{name:'Application domain (optional)',exact:true}).fill('console.example.test');await form.getByRole('textbox',{name:'S3 API domain (optional)',exact:true}).fill('s3.example.test');await form.getByRole('button',{name:'Deploy template',exact:true}).click();await expect(form.getByRole('status')).toContainText('Deployment queued');assert.equal(requests.at(-1).input.apiHostname,'s3.example.test');
  await form.getByRole('combobox',{name:'Application',exact:true}).selectOption('grafana');await expect(form.getByRole('textbox',{name:'S3 API domain (optional)',exact:true})).toHaveCount(0);
  for(const width of [375,768,1440]) {await page.setViewportSize({width,height:1100});await page.evaluate(()=>document.fonts.ready);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth===innerWidth),true,`${width}: no horizontal overflow`);await page.screenshot({path:`${output}/templates-${width}.png`,fullPage:true});}
  const viewer=await fixture(false);await expect(viewer.form.getByRole('combobox',{name:'Application',exact:true})).toBeDisabled();await expect(viewer.form.getByRole('button',{name:'Deploy template',exact:true})).toHaveCount(0);assert.equal(viewer.requests.length,0);
  assert.deepEqual(errors,[]);console.log(`PASS template private defaults, validation, optional MinIO API domain, supplier disclosure, viewer restrictions and screenshots at ${output}`);
} finally {await browser.close();await server.close();}
