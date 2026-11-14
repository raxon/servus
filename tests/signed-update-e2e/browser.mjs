// Exercise the real update button against a disposable VM without request mocks.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chromium } from '@playwright/test';

const [origin, baseVersion, targetVersion, baseRevision] = process.argv.slice(2);
const target = `v${targetVersion}`;
assert.match(origin,/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/);
assert.ok(Number(new URL(origin).port)<=65535);
assert.match(baseVersion,/^\d+\.\d+\.\d+$/);
assert.match(targetVersion,/^\d+\.\d+\.\d+$/);
assert.match(baseRevision,/^[0-9a-f]{40}$/);
const browser = await chromium.launch({headless:true});
const page = await browser.newPage();
page.setDefaultTimeout(20000);
try {
  let health;
  for (let attempt=0;attempt<40;attempt++) {
    try { health=await (await fetch(origin + '/api/v1/health')).json(); break; }
    catch { await new Promise(resolve=>setTimeout(resolve,500)); }
  }
  assert.ok(health, 'VM port did not become available');
  assert.equal(health.version, baseVersion);
  assert.equal(health.revision, baseRevision);
  await page.goto(origin);
  await page.getByLabel('Email address').fill('update-e2e@example.test');
  await page.getByLabel('Password', {exact:true}).fill('update-e2e-password');
  await page.getByRole('button', {name:'Create administrator'}).click();
  await page.getByRole('button', {name:'Sign out'}).waitFor();
  const project = await page.evaluate(async () => {
    const session = await (await fetch('/api/v1/auth/session')).json();
    const result = await fetch('/api/v1/projects', {method:'POST',headers:{'content-type':'application/json','x-csrf-token':session.csrfToken},body:JSON.stringify({name:'update-e2e',description:'Update test'})});
    if (!result.ok) throw new Error(`Project creation failed: ${result.status}`);
    return result.json();
  });
  assert.ok(project.id);
  const service = await page.evaluate(async ({projectId,key}) => {
    const session = await (await fetch('/api/v1/auth/session')).json();
    const result = await fetch(`/api/v1/projects/${projectId}/services`, {
      method:'POST', headers:{'content-type':'application/json','x-csrf-token':session.csrfToken,'idempotency-key':key},
      body:JSON.stringify({name:'update-terminal',kind:'app',image:'nginx:alpine',port:80,hostname:'update-terminal.localhost',replicas:1,resources:{cpu:0.2,memoryMb:128}})
    });
    if (!result.ok) throw new Error(`Service creation failed: ${result.status}`);
    return result.json();
  },{projectId:project.id,key:randomUUID()});
  assert.ok(service.service?.id && service.action?.id);
  let runningContainer;
  const deployDeadline=Date.now()+180000;
  while (Date.now()<deployDeadline) {
    const state=await page.evaluate(async ({actionId,serviceId}) => {
      const result=await fetch(`/api/v1/actions/${actionId}`);
      if (!result.ok) throw new Error(`Action lookup failed: ${result.status}`);
      const {action}=await result.json();
      if (action.status==='failed' || action.status==='cancelled') throw new Error(`Service deployment ${action.status}`);
      if (action.status!=='succeeded') return {};
      const response=await fetch(`/api/v1/services/${serviceId}/containers`);
      if (!response.ok) throw new Error(`Container lookup failed: ${response.status}`);
      return {container:(await response.json()).find(item=>item.state==='running')};
    },{actionId:service.action.id,serviceId:service.service.id});
    if (state.container) { runningContainer=state.container;break; }
    await page.waitForTimeout(1000);
  }
  assert.ok(runningContainer?.id,'Service container did not start');
  await page.evaluate(async ({id,containerId}) => {
    const session = await (await fetch('/api/v1/auth/session')).json();
    const grant = await fetch(`/api/v1/services/${id}/console-ticket`, {
      method:'POST',headers:{'content-type':'application/json','x-csrf-token':session.csrfToken},
      body:JSON.stringify({containerId,shell:'/bin/sh'})
    });
    if (!grant.ok) throw new Error(`Terminal ticket failed: ${grant.status}`);
    const {ticket} = await grant.json();
    await new Promise((resolve,reject) => {
      const url = new URL(`/api/v1/services/${id}/console`,location.href);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(url);
      socket.binaryType='arraybuffer';
      let ready=false,output='';
      const timer=setTimeout(()=>{socket.close();reject(new Error('Terminal timed out'));},20000);
      socket.onopen=()=>socket.send(JSON.stringify({type:'authenticate',ticket}));
      socket.onmessage=event=>{
        if (!ready) {
          const message=JSON.parse(event.data);
          if (message.type!=='ready') { clearTimeout(timer);socket.close();reject(new Error('Terminal authentication failed'));return; }
          ready=true;socket.send(JSON.stringify({type:'input',data:"printf 'SERVUS_UPDATE_TERMINAL_OK\\n'\nexit\n"}));
        } else output+=typeof event.data==='string' ? event.data : new TextDecoder().decode(event.data);
      };
      socket.onerror=()=>{clearTimeout(timer);reject(new Error('Terminal connection failed'));};
      socket.onclose=()=>{clearTimeout(timer);output.split(/\r?\n/).some(line=>line.trim()==='SERVUS_UPDATE_TERMINAL_OK') ? resolve() : reject(new Error('Terminal output missing'));};
    });
  },{id:service.service.id,containerId:runningContainer.id});
  console.log('PASS deployed service terminal exited before update');
  await page.goto(origin + '/settings');
  await page.getByRole('heading', {name:'Updates'}).waitFor();
  console.log(`READY: v${baseVersion} installed, waiting for ${target} release`);
  const deadline=Date.now()+20*60*1000;
  while (Date.now()<deadline) {
    const check=page.getByRole('button',{name:'Check for updates'});
    await check.waitFor({state:'visible'});
    if (await check.isEnabled()) await check.click();
    try { await page.getByText(`Version ${target} is available.`,{exact:false}).waitFor({timeout:12000}); break; }
    catch { await page.waitForTimeout(15000); }
  }
  assert.ok(await page.getByText(`Version ${target} is available.`,{exact:false}).isVisible(), 'Target release was not discovered');
  await page.getByRole('button',{name:'Install update'}).click();
  console.log('STARTED: browser requested update');
  const completionDeadline=Date.now()+20*60*1000;
  while (Date.now()<completionDeadline) {
    if (await page.getByText('Update installed.',{exact:true}).isVisible()) break;
    if (await page.getByText('Update needs attention.',{exact:true}).isVisible()) throw new Error('Update needs attention');
    if (await page.getByText('Release verification failed.',{exact:true}).isVisible()) throw new Error('Release verification failed');
    await page.waitForTimeout(3000);
  }
  assert.ok(await page.getByText('Update installed.',{exact:true}).isVisible(),'Update did not complete');
  const result = await page.evaluate(async ({id,serviceId}) => {
    const health = await (await fetch('/api/v1/health')).json();
    const session = await (await fetch('/api/v1/auth/session')).json();
    const projects = await (await fetch('/api/v1/projects')).json();
    const services = await (await fetch(`/api/v1/projects/${id}/services`)).json();
    return {health,session,found:projects.some(project=>project.id===id && project.name==='update-e2e'),serviceFound:services.some(service=>service.id===serviceId)};
  },{id:project.id,serviceId:service.service.id});
  assert.equal(result.health.version, targetVersion);
  assert.equal(result.session.user.email, 'update-e2e@example.test');
  assert.equal(result.found, true);
  assert.equal(result.serviceFound, true);
  assert.equal(await page.evaluate(()=>localStorage.getItem('servus.update.operation.v1')),null);
  console.log('PASS browser update preserved the account, session and project');
} catch (error) {
  try { console.error('Page state:', (await page.locator('body').innerText()).slice(0,4000)); } catch {}
  throw error;
} finally { await browser.close(); }
