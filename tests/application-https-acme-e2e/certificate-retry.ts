// Verify a failed HTTP-01 issuance can be retried without restarting the app.
import Docker from 'dockerode';
import { randomUUID } from 'node:crypto';
import { strict as assert } from 'node:assert';
import { setTimeout as delay } from 'node:timers/promises';
import { httpsRouteLabels, httpsRedirectLabels } from '../../apps/panel/src/agent/https-routing.js';
import { planCertificateRetry } from '../../apps/panel/src/agent/certificate-retry.js';
import { inspectManagedCertificate } from '../../apps/panel/src/agent/managed-certificate.js';
import { inspectAcmeFailure } from '../../apps/panel/src/agent/managed-certificate-events.js';

if(process.env.SERVUS_DISPOSABLE_HTTPS_TEST!=='1')throw new Error('Disposable test environment must be explicitly selected.');
const docker=new Docker({socketPath:process.env.HOME+'/.colima/servus-https-e2e/docker.sock'});
assert.equal((await docker.info()).Name,'colima-servus-https-e2e');
const ingress=await docker.getService('panel-ingress').inspect();
assert.ok(ingress.Spec.TaskTemplate?.ContainerSpec?.Args?.includes('--certificatesresolvers.servus.acme.caserver=https://pebble:14000/dir'));
const network=await docker.getNetwork('panel-ingress').inspect(),vip=ingress.Endpoint?.VirtualIPs?.find(value=>value.NetworkID===network.Id)?.Addr?.split('/')[0];
assert.ok(vip);
const image=(await docker.getImage('node:24-bookworm-slim').inspect()).Id,id=randomUUID(),host=`retry-${id.slice(0,8)}.invalid`,name=`panel-app-${id}`;
let app:Docker.Service|undefined,healthy:Docker.Service|undefined;
async function dns(action:'add-a'|'clear-a',addresses?:string[]) {
  const script="fetch('http://pebble-dns:8055/'+process.env.ACTION,{method:'POST',body:JSON.stringify({host:process.env.HOSTNAME_TO_SET,...(process.env.ADDRESS?{addresses:[process.env.ADDRESS]}:{})})}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))";
  const container=await docker.createContainer({Image:image,Entrypoint:['node'],Cmd:['-e',script],Env:[`ACTION=${action}`,`HOSTNAME_TO_SET=${host}`,...(addresses?.[0]?[`ADDRESS=${addresses[0]}`]:[])],HostConfig:{NetworkMode:network.Id}});
  try{await container.start();assert.equal((await container.wait()).StatusCode,0);}finally{await container.remove({force:true});}
}
async function waitFor<T>(fn:()=>Promise<T|undefined>,limit=45_000):Promise<T> {
  const end=Date.now()+limit;
  do {const value=await fn();if(value)return value;await delay(500);}while(Date.now()<end);
  throw new Error('Timed out waiting for the isolated ACME test.');
}
try {
  const healthyId=randomUUID(),healthyHost=`healthy-${healthyId.slice(0,8)}.invalid`,healthyRoute=healthyId.replaceAll('-','')+'-0';
  healthy=await docker.createService({Name:`panel-app-${healthyId}`,Labels:{'panel.owner':'self-hosted-panel','panel.service':healthyId,'traefik.enable':'true',
    [`traefik.http.routers.${healthyRoute}.rule`]:`Host(\`${healthyHost}\`)`,[`traefik.http.routers.${healthyRoute}.entrypoints`]:'web',
    [`traefik.http.routers.${healthyRoute}.service`]:healthyRoute,[`traefik.http.services.${healthyRoute}.loadbalancer.server.port`]:'80'},
    TaskTemplate:{ContainerSpec:{Image:'nginx:alpine'},Networks:[{Target:network.Id}]},Mode:{Replicated:{Replicas:1}}});
  const healthyResponse=async()=>{
    const program=`require('node:http').get({host:${JSON.stringify(vip)},port:8080,path:'/',headers:{host:${JSON.stringify(healthyHost)}}},r=>{r.resume();process.exitCode=r.statusCode===200?0:1}).on('error',()=>process.exit(1))`;
    const client=await docker.createContainer({Image:image,Entrypoint:['node'],Cmd:['-e',program],HostConfig:{NetworkMode:network.Id}});
    try{await client.start();return (await client.wait()).StatusCode===0?true:undefined;}finally{await client.remove({force:true});}
  };
  await waitFor(healthyResponse,90_000);
  await dns('add-a',['127.0.0.1']);
  const route=id.replaceAll('-','')+'-0';
  app=await docker.createService({Name:name,Labels:{'panel.owner':'self-hosted-panel','panel.service':id,'traefik.enable':'true',
    [`traefik.http.routers.${route}.rule`]:`Host(\`${host}\`)`,[`traefik.http.routers.${route}.entrypoints`]:'web',
    [`traefik.http.routers.${route}.service`]:route,...httpsRouteLabels(id,0,host,80)},
    TaskTemplate:{ContainerSpec:{Image:'nginx:alpine'},Networks:[{Target:network.Id}]},Mode:{Replicated:{Replicas:1}}});
  const task=await waitFor(async()=>{const tasks=await docker.listTasks({filters:{service:[name],'desired-state':['running']}});return tasks.find(task=>task.Status?.State==='running')?.ID;});
  await waitFor(async()=>{const event=await inspectAcmeFailure(docker,host);return event.failure?.operation==='issuance'?event.failure:undefined;},90_000);
  assert.ok(await healthyResponse(),'an unrelated application route must remain available when issuance fails');
  assert.equal((await inspectManagedCertificate(docker,host,async()=>image)).status,'not_found');
  await dns('clear-a');
  await dns('add-a',[vip]);
  const current=await app.inspect(),target=planCertificateRetry(current.Spec,id,host);
  await app.update({...target,version:current.Version.Index});
  await waitFor(async()=>{const cert=await inspectManagedCertificate(docker,host,async()=>image);return cert.status==='active'?cert:undefined;},90_000);
  const tasks=await docker.listTasks({filters:{service:[name],'desired-state':['running']}});
  assert.equal(tasks.find(item=>item.Status?.State==='running')?.ID,task,'retry must not restart the application task');
  const beforeRedirect=await app.inspect();
  await app.update({...beforeRedirect.Spec,Labels:{...beforeRedirect.Spec.Labels,...httpsRedirectLabels(id,0,host,80)},version:beforeRedirect.Version.Index});
  await waitFor(async()=>{
    const script=`require('node:http').get({host:${JSON.stringify(vip)},port:8080,path:'/example?x=1',headers:{host:${JSON.stringify(host)}}},r=>{console.log(r.statusCode,JSON.stringify(r.headers));r.resume();process.exitCode=r.statusCode===301&&r.headers.location===${JSON.stringify(`https://${host}/example?x=1`)}?0:1}).on('error',()=>process.exit(1))`;
    const client=await docker.createContainer({Image:image,Entrypoint:['node'],Cmd:['-e',script],HostConfig:{NetworkMode:network.Id}});
    try {await client.start();return (await client.wait()).StatusCode===0 ? true : undefined;} finally {await client.remove({force:true});}
  },90_000);
  // ACME's internal HTTP-01 router must remain reachable when the app's
  // catch-all HTTP router redirects, otherwise future renewals can fail.
  const challenge=`require('node:http').get({host:${JSON.stringify(vip)},port:8080,path:'/.well-known/acme-challenge/not-a-real-token',headers:{host:${JSON.stringify(host)}}},r=>{r.resume();process.exitCode=r.statusCode===404&&!r.headers.location?0:1}).on('error',()=>process.exit(1))`;
  const challenger=await docker.createContainer({Image:image,Entrypoint:['node'],Cmd:['-e',challenge],HostConfig:{NetworkMode:network.Id}});
  try {await challenger.start();assert.equal((await challenger.wait()).StatusCode,0,'HTTP-01 challenge must bypass the application redirect');} finally {await challenger.remove({force:true});}
  const afterRedirect=await docker.listTasks({filters:{service:[name],'desired-state':['running']}});
  assert.equal(afterRedirect.find(item=>item.Status?.State==='running')?.ID,task,'redirect must not restart the application task');
  console.log('HTTP redirects to HTTPS, while HTTP-01 challenges bypass the redirect and the application task remains running.');
  console.log('Failed issuance retried successfully without restarting the application.');
} finally {
  if(app)await app.remove();
  if(healthy)await healthy.remove();
  try{await dns('clear-a');}catch{}
}
