// Real ACME renewal with a disposable Traefik service and Pebble CA.
import Docker from 'dockerode';
import { randomUUID, X509Certificate } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strict as assert } from 'node:assert';
import { setTimeout as delay } from 'node:timers/promises';
import { httpsRouteLabels, httpsRedirectLabels } from '../../apps/panel/src/agent/https-routing.js';

if(process.env.SERVUS_DISPOSABLE_HTTPS_TEST!=='1')throw new Error('Disposable test environment must be explicitly selected.');
const docker=new Docker({socketPath:process.env.HOME+'/.colima/servus-https-e2e/docker.sock'});
assert.equal((await docker.info()).Name,'colima-servus-https-e2e');
const network=await docker.getNetwork('panel-ingress').inspect();
const token=randomUUID().replaceAll('-',''),id=randomUUID(),host=`renew-${token.slice(0,8)}.invalid`;
const route=id.replaceAll('-','')+'-0',appName=`renew-app-${token}`,ingressName=`renew-proxy-${token}`,volumeName=`renew-acme-${token}`;
const image=(await docker.getImage('node:24-bookworm-slim').inspect()).Id;
const work=mkdtempSync(join(tmpdir(),'servus-renew-'));
let app:Docker.Service|undefined,ingress:Docker.Service|undefined,volume:Docker.Volume|undefined;
async function waitFor<T>(fn:()=>Promise<T|undefined>,limit=100_000):Promise<T>{const end=Date.now()+limit;do{const value=await fn();if(value)return value;await delay(1000);}while(Date.now()<end);throw new Error('Timed out waiting for isolated renewal.');}
async function helper(program:string,env:string[]=[]):Promise<string>{
  const c=await docker.createContainer({Image:image,Entrypoint:['node'],Cmd:['-e',program],Env:env,Tty:true,HostConfig:{NetworkMode:'none',Mounts:[{Type:'volume',Source:volumeName,Target:'/cert'}]}});
  try{await c.start();assert.equal((await c.wait()).StatusCode,0);return String(await c.logs({stdout:true,stderr:true}));}finally{await c.remove({force:true});}
}
async function dns(action:'add-a'|'clear-a',vip?:string){
  const c=await docker.createContainer({Image:image,Entrypoint:['node'],Cmd:['-e',"fetch('http://pebble-dns:8055/'+process.env.ACTION,{method:'POST',body:JSON.stringify({host:process.env.HOST_TO_SET,...(process.env.ADDRESS?{addresses:[process.env.ADDRESS]}:{})})}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"],Env:[`ACTION=${action}`,`HOST_TO_SET=${host}`,...(vip?[`ADDRESS=${vip}`]:[])],HostConfig:{NetworkMode:network.Id}});
  try{await c.start();assert.equal((await c.wait()).StatusCode,0);}finally{await c.remove({force:true});}
}
async function certificate(){const text=await helper("const fs=require('fs');try{const s=JSON.parse(fs.readFileSync('/cert/acme.json','utf8')).servus;const c=s.Certificates.find(x=>x.domain.main===process.env.HOST_TO_SET);console.log(c?c.certificate:'')}catch{console.log('')}",[`HOST_TO_SET=${host}`]);const encoded=text.trim();return encoded?new X509Certificate(Buffer.from(encoded,'base64')):undefined;}
try {
  volume=await docker.createVolume({Name:volumeName,Labels:{'servus.fixture':token}});
  ingress=await docker.createService({Name:ingressName,Labels:{'servus.fixture':token},Mode:{Replicated:{Replicas:1}},TaskTemplate:{ContainerSpec:{Image:'traefik:3.7.13',Env:['LEGO_CA_CERTIFICATES=/fixture/ca.crt'],Args:['--providers.swarm.endpoint=unix:///var/run/docker.sock','--providers.swarm.exposedbydefault=false','--providers.swarm.network=panel-ingress',`--providers.swarm.constraints=Label(\`servus.fixture\`,\`${token}\`)`,'--entrypoints.web.address=:8080','--entrypoints.websecure.address=:8443','--log.level=WARN','--certificatesresolvers.servus.acme.email=ops@example.com','--certificatesresolvers.servus.acme.storage=/letsencrypt/acme.json','--certificatesresolvers.servus.acme.httpchallenge.entrypoint=web','--certificatesresolvers.servus.acme.caserver=https://pebble:14000/dir'],Mounts:[{Type:'bind',Source:'/var/run/docker.sock',Target:'/var/run/docker.sock',ReadOnly:true},{Type:'bind',Source:'/tmp/servus-acme-e2e/ca.crt',Target:'/fixture/ca.crt',ReadOnly:true},{Type:'volume',Source:volumeName,Target:'/letsencrypt'}]},Networks:[{Target:network.Id}]}});
  const vip=await waitFor(async()=>{const data=await ingress!.inspect();return data.Endpoint?.VirtualIPs?.find(v=>v.NetworkID===network.Id)?.Addr?.split('/')[0];});
  await dns('add-a',vip);
  app=await docker.createService({Name:appName,Labels:{'servus.fixture':token,'traefik.enable':'true',[`traefik.http.routers.${route}.rule`]:`Host(\`${host}\`)`,[`traefik.http.routers.${route}.entrypoints`]:'web',[`traefik.http.routers.${route}.service`]:route,...httpsRouteLabels(id,0,host,80),...httpsRedirectLabels(id,0,host,80)},Mode:{Replicated:{Replicas:1}},TaskTemplate:{ContainerSpec:{Image:'nginx:alpine'},Networks:[{Target:network.Id}]}});
  const task=await waitFor(async()=>(await docker.listTasks({filters:{service:[appName],'desired-state':['running']}})).find(t=>t.Status?.State==='running')?.ID);
  await waitFor(async()=>await certificate());
  const current=await ingress.inspect();await ingress.update({...current.Spec,Mode:{Replicated:{Replicas:0}},version:current.Version.Index});
  await waitFor(async()=>!(await docker.listTasks({filters:{service:[ingressName],'desired-state':['running']}})).some(t=>['running','starting','preparing'].includes(t.Status?.State??''))?true:undefined);
  const key=join(work,'key.pem'),cert=join(work,'cert.pem');
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj',`/CN=${host}`,'-addext',`subjectAltName=DNS:${host}`,'-addext','basicConstraints=critical,CA:FALSE'],{stdio:'ignore'});
  const expiredSoon=new X509Certificate(readFileSync(cert));
  await helper("const fs=require('fs');const p='/cert/acme.json',s=JSON.parse(fs.readFileSync(p,'utf8')),c=s.servus.Certificates.find(x=>x.domain.main===process.env.HOST_TO_SET);if(!c)process.exit(2);c.certificate=process.env.CERT;c.key=process.env.KEY;fs.writeFileSync(p,JSON.stringify(s),{mode:0o600})",[`HOST_TO_SET=${host}`,`CERT=${readFileSync(cert).toString('base64')}`,`KEY=${readFileSync(key).toString('base64')}`]);
  const stopped=await ingress.inspect();await ingress.update({...stopped.Spec,Mode:{Replicated:{Replicas:1}},version:stopped.Version.Index});
  const renewed=await waitFor(async()=>{const c=await certificate();return c&&c.fingerprint256!==expiredSoon.fingerprint256?c:undefined;},120_000);
  assert.ok(renewed.checkHost(host));assert.ok(Date.parse(renewed.validTo)>Date.now()+30*86400_000);
  const tasks=await docker.listTasks({filters:{service:[appName],'desired-state':['running']}});assert.equal(tasks.find(t=>t.Status?.State==='running')?.ID,task);
  console.log('Traefik renewed an expiring certificate through Pebble HTTP-01 with redirect enabled; the application task remained running.');
} finally {
  if(app)await app.remove();if(ingress)await ingress.remove();
  try{await dns('clear-a');}catch{}
  if(volume)await waitFor(async()=>{try{await volume!.remove();return true;}catch{return undefined;}},30_000);
  rmSync(work,{recursive:true,force:true});
}
