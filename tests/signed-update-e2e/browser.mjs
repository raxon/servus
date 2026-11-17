// Exercise the real update button against a disposable VM without request mocks.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants, closeSync, fchmodSync, fstatSync, openSync, writeFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { chromium } from '@playwright/test';

const [origin, baseVersion, targetVersion, baseRevision, targetRevision] = process.argv.slice(2);
const target = `v${targetVersion}`;
assert.match(origin,/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/);
assert.ok(Number(new URL(origin).port)<=65535);
assert.match(baseVersion,/^\d+\.\d+\.\d+$/);
assert.match(targetVersion,/^\d+\.\d+\.\d+$/);
assert.match(baseRevision,/^[0-9a-f]{40}$/);
if (targetRevision !== undefined) assert.match(targetRevision,/^[0-9a-f]{40}$/);
const browser = await chromium.launch({headless:true});
const page = await browser.newPage();
page.setDefaultTimeout(20000);
const syntheticSecret = randomBytes(32).toString('hex');
const marker = randomBytes(32).toString('hex');
const markerFile = `${marker}\n`;
const runSuffix = randomUUID().replaceAll('-', '').slice(0, 8);
const projectName = `update-e2e-${runSuffix}`;
const serviceName = `update-terminal-${runSuffix}`;
const serviceHostname = `${serviceName}.localhost`;
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
  const createAdmin = page.getByRole('button', {name:'Create administrator',exact:true});
  if (await createAdmin.isVisible()) await createAdmin.click();
  else await page.getByRole('button', {name:'Sign in',exact:true}).click();
  const setup = await page.evaluate(async ({secret,key,projectName,serviceName,serviceHostname}) => {
    let session;
    for (let attempt=0;attempt<40;attempt++) {
      const response=await fetch('/api/v1/auth/session');
      if(response.ok){const value=await response.json();if(value?.user?.id&&value?.csrfToken){session=value;break;}}
      await new Promise(resolve=>setTimeout(resolve,250));
    }
    if(!session)throw new Error('Administrator session was not established');
    const result = await fetch('/api/v1/projects', {method:'POST',headers:{'content-type':'application/json','x-csrf-token':session.csrfToken},body:JSON.stringify({name:projectName,description:'Update test'})});
    if (!result.ok) throw new Error(`Project creation failed: ${result.status}`);
    const project=await result.json();
    if(!project.id)throw new Error('Project response did not include an ID');
    const serviceResult = await fetch(`/api/v1/projects/${project.id}/services`, {
      method:'POST', headers:{'content-type':'application/json','x-csrf-token':session.csrfToken,'idempotency-key':key},
      body:JSON.stringify({name:serviceName,kind:'app',image:'nginx:alpine',port:80,hostname:serviceHostname,replicas:1,resources:{cpu:0.2,memoryMb:128},mounts:[{type:'volume',name:'update-proof-data',target:'/usr/share/nginx/html'}],environment:[{name:'SYNTHETIC_UPGRADE_SECRET',value:secret,secret:true}]})
    });
    if (!serviceResult.ok) throw new Error(`Service creation failed: ${serviceResult.status}`);
    const created=await serviceResult.json();
    if(!created.service?.id||!created.action?.id)throw new Error('Service response did not include an action');
    const preferenceResponse=await fetch('/api/v1/updates/preferences');
    if(!preferenceResponse.ok)throw new Error(`Update preference read failed: ${preferenceResponse.status}`);
    const current=(await preferenceResponse.json()).preferences;
    if(!current||typeof current.installTime!=='string'||typeof current.timeZone!=='string')throw new Error('Update preferences are incomplete');
    const preferenceInput={automatic:false,channel:'beta',installTime:current.installTime,timeZone:current.timeZone};
    const savedResponse=await fetch('/api/v1/updates/preferences',{method:'PUT',headers:{'content-type':'application/json','x-csrf-token':session.csrfToken},body:JSON.stringify(preferenceInput)});
    if(!savedResponse.ok)throw new Error(`Beta update preference save failed: ${savedResponse.status}`);
    const saved=(await savedResponse.json()).preferences;
    if(saved.automatic!==false||saved.channel!=='beta'||saved.installTime!==current.installTime||saved.timeZone!==current.timeZone)throw new Error('Update preference change was not preserved');
    return {projectId:project.id,projectName,serviceId:created.service.id,actionId:created.action.id,userId:session.user.id,email:session.user.email};
  },{secret:syntheticSecret,key:randomUUID(),projectName,serviceName,serviceHostname});
  const {projectId,serviceId,userId}=setup;
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
    },{actionId:setup.actionId,serviceId});
    if (state.container) { runningContainer=state.container;break; }
    await page.waitForTimeout(1000);
  }
  assert.ok(runningContainer?.id,'Service container did not start');
  const terminalOutput=await page.evaluate(async ({id,containerId,proof}) => {
    const session = await (await fetch('/api/v1/auth/session')).json();
    const grant = await fetch(`/api/v1/services/${id}/console-ticket`, {
      method:'POST',headers:{'content-type':'application/json','x-csrf-token':session.csrfToken},
      body:JSON.stringify({containerId,shell:'/bin/sh'})
    });
    if (!grant.ok) throw new Error(`Terminal ticket failed: ${grant.status}`);
    const {ticket} = await grant.json();
    const output=await new Promise((resolve,reject) => {
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
          ready=true;socket.send(JSON.stringify({type:'input',data:`printf '%s\\n' '${proof}' > /usr/share/nginx/html/update-proof && test -n "$SYNTHETIC_UPGRADE_SECRET" && printf 'SERVUS_UPDATE_MARKER:${proof}\\nSERVUS_UPDATE_SECRET_PRESENT\\n'\nexit\n`}));
        } else output+=typeof event.data==='string' ? event.data : new TextDecoder().decode(event.data);
      };
      socket.onerror=()=>{clearTimeout(timer);reject(new Error('Terminal connection failed'));};
      socket.onclose=()=>{clearTimeout(timer);output.includes(`SERVUS_UPDATE_MARKER:${proof}`)&&output.includes('SERVUS_UPDATE_SECRET_PRESENT') ? resolve(output) : reject(new Error('Terminal proof output missing'));};
    });
    return output;
  },{id:serviceId,containerId:runningContainer.id,proof:marker});
  assert.ok(terminalOutput.includes(`SERVUS_UPDATE_MARKER:${marker}`));
  assert.ok(terminalOutput.includes('SERVUS_UPDATE_SECRET_PRESENT'));
  console.log('PASS deployed service terminal exited before update');
  const beforeProof=await page.evaluate(async ({projectId,serviceId,secret,expectedUserId})=>{
    const sessionResponse=await fetch('/api/v1/auth/session');
    if(!sessionResponse.ok)throw new Error('Administrator session was lost before update');
    const session=await sessionResponse.json();
    if(session.user.id!==expectedUserId)throw new Error('Administrator identity changed before update');
    const response=await fetch(`/api/v1/projects/${projectId}/services`);
    if(!response.ok)throw new Error(`Service API lookup failed: ${response.status}`);
    const services=await response.json(),service=services.find(item=>item.id===serviceId);
    const environment=service?.environment?.find(item=>item.name==='SYNTHETIC_UPGRADE_SECRET');
    if(!environment?.secret||environment.value!==undefined||JSON.stringify(service).includes(secret))throw new Error('Environment secret was not redacted by the service API');
    return {userId:session.user.id};
  },{projectId,serviceId,secret:syntheticSecret,expectedUserId:userId});
  assert.equal(beforeProof.userId,userId);
  const proofPath=process.env.SERVUS_SIGNED_UPDATE_PROOF;
  if(proofPath){
    assert.ok(isAbsolute(proofPath),'SERVUS_SIGNED_UPDATE_PROOF must be an absolute path');
    const proof={projectId,serviceId,containerId:runningContainer.id,userId,hostname:serviceHostname,
      markerSha256:createHash('sha256').update(markerFile).digest('hex'),
      secretSha256:createHash('sha256').update(syntheticSecret).digest('hex'),
      checks:['pre-upgrade-service-running','terminal-marker-written','environment-secret-redacted-by-api','beta-channel-selected']};
    const descriptor=openSync(proofPath,constants.O_WRONLY|constants.O_CREAT|constants.O_TRUNC|constants.O_NOFOLLOW|constants.O_NONBLOCK,0o600);
    try{
      fchmodSync(descriptor,0o600);
      if(!fstatSync(descriptor).isFile())throw new Error('Proof path must be a regular file');
      writeFileSync(descriptor,JSON.stringify(proof)+'\n');
      assert.equal(fstatSync(descriptor).mode&0o777,0o600,'Proof file must have mode 0600');
    }finally{closeSync(descriptor);}
  }
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
  const confirmButton=page.getByRole('dialog').getByRole('button',{name:'Confirm installation',exact:true});
  if(targetRevision!==undefined) await confirmButton.click();
  else if(await confirmButton.isVisible().catch(()=>false)) await confirmButton.click();
  console.log('STARTED: browser requested update');
  const completionDeadline=Date.now()+20*60*1000;
  while (Date.now()<completionDeadline) {
    if (await page.getByText('Update installed.',{exact:true}).isVisible()) break;
    if (await page.getByText('Update needs attention.',{exact:true}).isVisible()) throw new Error('Update needs attention');
    if (await page.getByText('Release verification failed.',{exact:true}).isVisible()) throw new Error('Release verification failed');
    await page.waitForTimeout(3000);
  }
  assert.ok(await page.getByText('Update installed.',{exact:true}).isVisible(),'Update did not complete');
  const result = await page.evaluate(async ({id,projectName,serviceId,secret,expectedUserId,expectedContainerId}) => {
    const health = await (await fetch('/api/v1/health')).json();
    const session = await (await fetch('/api/v1/auth/session')).json();
    const projects = await (await fetch('/api/v1/projects')).json();
    const services = await (await fetch(`/api/v1/projects/${id}/services`)).json();
    const service=services.find(item=>item.id===serviceId);
    const environment=service?.environment?.find(item=>item.name==='SYNTHETIC_UPGRADE_SECRET');
    if(!environment?.secret||environment.value!==undefined||JSON.stringify(service).includes(secret))throw new Error('Environment secret was exposed by the service API after update');
    const response=await fetch(`/api/v1/services/${serviceId}/containers`);
    if(!response.ok)throw new Error(`Container lookup failed after update: ${response.status}`);
    const containers=await response.json();
    const sameContainer=containers.find(item=>item.id===expectedContainerId&&item.state==='running');
    return {health,session,found:projects.some(project=>project.id===id&&project.name===projectName),serviceFound:Boolean(service),sameContainer:Boolean(sameContainer),userPreserved:session.user.id===expectedUserId};
  },{id:projectId,projectName:setup.projectName,serviceId,secret:syntheticSecret,expectedUserId:userId,expectedContainerId:runningContainer.id});
  assert.equal(result.health.version, targetVersion);
  if(targetRevision !== undefined) assert.equal(result.health.revision,targetRevision);
  assert.equal(result.session.user.id,userId);
  assert.equal(result.session.user.email,setup.email);
  assert.equal(result.found, true);
  assert.equal(result.serviceFound, true);
  assert.equal(result.sameContainer,true,'The existing service container restarted during the panel update');
  assert.equal(result.userPreserved,true);
  assert.equal(await page.evaluate(()=>localStorage.getItem('servus.update.operation.v1')),null);
  console.log('PASS browser update preserved the account, session and project');
} catch (error) {
  try { console.error('Page state:', (await page.locator('body').innerText()).slice(0,4000)); } catch {}
  throw error;
} finally { await browser.close(); }
