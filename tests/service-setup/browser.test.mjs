import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';
import {chromium} from '@playwright/test';

const dir = (await mkdtemp(join(tmpdir(),'servus-service-setup-'))) + '/';
const root = fileURLToPath(new URL('../../apps/panel',import.meta.url));
const t = '2026-11-18T11:42:00Z';
const d = {hostname:'storefront.example.test',port:80,primary:true,https:true};
const frontend = {id:'storefront',projectId:'commerce',name:'storefront',kind:'app',image:'nginx:alpine',source:{type:'image'},port:80,replicas:1,revision:3,deployedRevision:3,state:'running',hostname:d.hostname,domains:[d],createdAt:t,updatedAt:t};
const project = {id:'commerce',name:'Commerce',description:'',createdAt:t,serviceCount:1,canWrite:true};
const fixture = {
  '/auth/session':{user:{id:'fixture-admin',email:'operator@example.test',role:'admin',createdAt:t},csrfToken:'fixture'},
  '/projects':[project],'/projects/commerce':project,'/projects/commerce/services':[frontend],'/projects/commerce/compose':[],
  '/services/storefront':frontend,'/services/storefront/actions':[],
  '/services/storefront/metrics':{cpuPercent:0,memoryBytes:0,memoryLimitBytes:0,networkRxBytes:0,networkTxBytes:0},
  '/runtime':{online:true,httpsConfigured:true,httpsAccess:'direct'},'/actions':[],
  '/services/storefront/check-domain-dns':{hostname:d.hostname,checkedAt:t,ipv4:[],ipv6:[],status:'not_found'},
  '/services/storefront/check-domain-tls':{hostname:d.hostname,checkedAt:t,status:'dns_unavailable'},
  '/services/storefront/check-managed-certificate':{hostname:d.hostname,checkedAt:t,status:'not_found',eventsAvailable:true},
  '/host-domain':{enabled:false,ready:false},'/integrations/github':{connected:false},'/templates':{templates:[]}
};
const server = await createServer({root,server:{port:0}});
await server.listen();
const origin = 'http://127.0.0.1:'+server.httpServer.address().port;
const browser = await chromium.launch({headless:true});
const errors=[];
try {
  const ctx=await browser.newContext({reducedMotion:'reduce',timezoneId:'Europe/Warsaw',locale:'en-GB'});
  await ctx.route('**/api/v1/**',async route=>{
    const request=route.request(),key=new URL(request.url()).pathname.slice('/api/v1'.length);
    assert.ok(request.method()==='GET'||key.includes('/check-'),'Fixture only allows reads and diagnostics');
    await route.fulfill({json:fixture[key]??{}});
  });
  const page=await ctx.newPage();
  page.setDefaultTimeout(7500);
  page.on('pageerror',error=>errors.push(error.message));
  const go=path=>page.goto(origin+path);
  for (const width of [375,768,1440]) {
    await page.setViewportSize({width,height:900});
    await go('/projects/commerce');
    await page.getByRole('button',{name:'New service',exact:true}).click();
    const create = page.getByRole('dialog',{name:'Create a service'});
    await create.getByPlaceholder('nginx:alpine',{exact:true}).fill('nginx:alpine');
    const preview=create.getByRole('complementary',{name:'Service preview'});
    await preview.getByText('nginx:alpine',{exact:true}).waitFor();
    for (const [kind,port] of [['PostgreSQL','5432'],['Redis','6379'],['MariaDB','3306']]) {
      await create.getByRole('button',{name:new RegExp(kind)}).click();
      await preview.getByText(port,{exact:true}).waitFor();
      await preview.getByText('Private project network',{exact:true}).waitFor();
    }
    await create.getByRole('button',{name:/Application/}).click();
    await create.locator('input[name=name]').fill('store');
    await preview.getByText('store.localhost (local use)',{exact:true}).waitFor();
    await create.locator('.source-choice-content').getByText('Git',{exact:true}).click();
    await create.getByLabel('Repository URL').fill('https://git.example.test/app.git');
    await preview.getByText('https://git.example.test/app.git · main',{exact:true}).waitFor();
    await create.getByLabel('Private repository',{exact:true}).check();
    await create.getByLabel('Git username',{exact:true}).fill('operator');
    await create.getByLabel('Access token',{exact:false}).fill('fixture');
    await create.getByLabel('Repository URL').fill('ssh://git@git.example.test/app.git');
    await create.getByLabel('Verified known_hosts entry').waitFor();
    await create.locator('.source-choice-content').getByText('GitHub',{exact:true}).click();
    await create.getByLabel('GitHub repository',{exact:false}).fill('organization/app');
    await preview.getByText('organization/app · main',{exact:true}).waitFor();
    await create.locator('.source-choice-content').getByText('Docker image',{exact:true}).click();
    const submit=create.getByRole('button',{name:'Create & deploy',exact:true});
    const bounds=await submit.boundingBox();
    assert.ok(bounds.y>=0 && bounds.y+bounds.height<=900, 'Visible submit at '+width);
    await create.getByText('Private registry access',{exact:true}).click();
    await create.getByLabel('Authenticate to a private registry').check();
    await create.getByLabel('Registry username').fill('user');
    await create.getByLabel('Registry password or token').fill('token');
    const focus=await create.getByLabel('Registry password or token').boundingBox();
    const footer=await create.locator('.service-create-footer').boundingBox();
    assert.ok(focus.y+focus.height <= footer.y, 'Focus above footer at '+width);
    await page.screenshot({path:dir+'create-after-'+width+'.png'});
    await create.getByRole('button',{name:'Cancel',exact:true}).click();
    await go('/services/storefront?tab=domains');
    await page.getByRole('button',{name:'Run diagnostics',exact:true}).click();
    await page.getByText('Next step: add an A or AAAA record',{exact:false}).waitFor();
    await page.getByText('No stored certificate',{exact:true}).waitFor();
    assert.equal(await page.locator('.domain-diagnostics-results small').filter({hasText:'Checked'}).count(),3);
    await page.screenshot({path:dir+'domains-after-'+width+'.png'});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'No horizontal overflow '+width);
  }
  fixture['/services/storefront/check-domain-tls']={hostname:d.hostname,checkedAt:t,status:'untrusted'};
  fixture['/services/storefront/check-managed-certificate']={hostname:d.hostname,checkedAt:t,status:'active',expiresAt:'2027-01-01T00:00:00Z',eventsAvailable:true};
  await page.getByRole('button',{name:'Run diagnostics',exact:true}).click();
  await page.getByText('Stored certificate valid',{exact:true}).waitFor();
  await page.getByText('Next step: check the certificate and hostname',{exact:false}).waitFor();
  await page.getByText('Edit hostname and port',{exact:true}).click();
  await page.getByLabel('Hostname',{exact:true}).fill('changed.example.test');
  assert.equal(await page.getByText('Stored certificate valid',{exact:true}).count(),0,'Edited hostname invalidates observations');
  await page.getByRole('button',{name:'Add domain',exact:true}).click();
  const added=page.locator('.domain-editor-group').last();
  await added.getByLabel('Hostname',{exact:true}).fill('second.example.test');
  assert.equal(await added.getByLabel('Hostname',{exact:true}).isVisible(),true,'New domain editor remains expanded');
  fixture['/auth/session'].user.role='member';
  fixture['/projects'][0].canWrite=false;
  await page.reload();
  assert.equal(await page.getByRole('button',{name:'Run diagnostics',exact:true}).isDisabled(),true,'Viewer cannot run write-authorized checks');
  assert.equal(await page.getByRole('button',{name:'Save configuration',exact:true}).isDisabled(),true,'Viewer cannot save');
  assert.deepEqual(errors,[]);
  console.log('PASS: Docker, Git, GitHub, SSH, database defaults, preview, private registry, visible footer/focus and independent diagnostics at 375/768/1440; viewer permissions and hostname invalidation. Screenshots: '+dir);
} finally { await browser.close(); await server.close(); }
