// Test an external nginx TLS multiplexer without altering the existing ingress.
import Docker from 'dockerode';
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ensureLocalTlsForwarder, LOCAL_TLS_FORWARDER } from '../../apps/panel/src/agent/https-local-forwarder.js';

if(process.env.SERVUS_DISPOSABLE_HTTPS_TEST!=='1')throw new Error('Disposable test environment must be explicitly selected.');
const docker=new Docker({socketPath:process.env.HOME+'/.colima/servus-https-e2e/docker.sock'});
assert.equal((await docker.info()).Name,'colima-servus-https-e2e');
assert.equal((await docker.listContainers({all:true,filters:{name:[`^/${LOCAL_TLS_FORWARDER}$`]}})).length,0);
const id=randomUUID().replaceAll('-',''),volumeName=`servus-sni-test-${id}`,temp=mkdtempSync(join(tmpdir(),'servus-sni-'));
const nodeImage=(await docker.getImage('node:24-bookworm-slim').inspect()).Id;
const nginxImage=(await docker.getImage('nginx:alpine').inspect()).Id;
let initializer:Docker.Container|undefined,proxy:Docker.Container|undefined,probe:Docker.Container|undefined,createdForwarder=false;
try {
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(temp,'key.pem'),'-out',join(temp,'cert.pem'),'-subj','/CN=legacy.invalid','-days','1'],{stdio:'ignore'});
  const config=`pid /tmp/nginx.pid; error_log stderr notice; events { worker_connections 128; }
stream { map $ssl_preread_server_name $upstream { legacy.invalid 127.0.0.1:19444; "" 127.0.0.1:19444; default 127.0.0.1:18443; } server { listen 127.0.0.1:19443; ssl_preread on; proxy_pass $upstream; } }
http { server { listen 127.0.0.1:19444 ssl; ssl_certificate /fixture/cert.pem; ssl_certificate_key /fixture/key.pem; location / { return 200 'legacy-panel'; } } }`;
  const files={config,cert:readFileSync(join(temp,'cert.pem'),'utf8'),key:readFileSync(join(temp,'key.pem'),'utf8')};
  await docker.createVolume({Name:volumeName,Labels:{'panel.purpose':'disposable-sni-test'}});
  const setup="const fs=require('node:fs');const v=JSON.parse(Buffer.from(process.env.DATA,'base64'));for(const [n,s] of Object.entries({'nginx.conf':v.config,'cert.pem':v.cert,'key.pem':v.key}))fs.writeFileSync('/fixture/'+n,s,{mode:0o600});";
  initializer=await docker.createContainer({Image:nodeImage,Entrypoint:['node'],Cmd:['-e',setup],Env:[`DATA=${Buffer.from(JSON.stringify(files)).toString('base64')}`],User:'0',HostConfig:{Mounts:[{Type:'volume',Source:volumeName,Target:'/fixture'}]}});
  await initializer.start();assert.equal((await initializer.wait()).StatusCode,0);
  await ensureLocalTlsForwarder(docker,nodeImage);createdForwarder=true;
  proxy=await docker.createContainer({Image:nginxImage,Entrypoint:['nginx'],Cmd:['-c','/fixture/nginx.conf','-g','daemon off;'],HostConfig:{NetworkMode:'host',Mounts:[{Type:'volume',Source:volumeName,Target:'/fixture',ReadOnly:true}]}});
  await proxy.start();
  const script=`const https=require('node:https');async function get(name){return new Promise((resolve,reject)=>{const req=https.get({host:'127.0.0.1',port:19443,servername:name,headers:{Host:name||'legacy.invalid'},rejectUnauthorized:false},r=>{let b='';const c=r.socket.getPeerCertificate();r.on('data',x=>b+=x);r.on('end',()=>resolve({status:r.statusCode,body:b,san:c.subjectaltname,cn:c.subject?.CN}));});req.on('error',reject);req.setTimeout(5000,()=>req.destroy());});} (async()=>{for(let i=0;i<40;i++){try{const app=await get('servus-e2e.invalid'),old=await get('legacy.invalid'),ip=await get('');if(app.status===200&&app.san?.includes('DNS:servus-e2e.invalid')&&old.body==='legacy-panel'&&old.cn==='legacy.invalid'&&ip.body==='legacy-panel'){console.log('SNI application, legacy and no-SNI routes passed');return;}throw Error(JSON.stringify({app,old,ip}));}catch(e){if(i===39)throw e;await new Promise(r=>setTimeout(r,250));}}})().catch(e=>{console.error(e.message);process.exit(1)});`;
  probe=await docker.createContainer({Image:nodeImage,Entrypoint:['node'],Cmd:['-e',script],HostConfig:{NetworkMode:'host'}});
  await probe.start();const result=await probe.wait();
  const output=(await probe.logs({stdout:true,stderr:true})).toString();
  if(result.StatusCode!==0)console.error(output);
  assert.equal(result.StatusCode,0,'SNI routing did not preserve all HTTPS routes');
  console.log('External nginx routed application, legacy and no-SNI traffic correctly.');
} finally {
  if(probe)await probe.remove({force:true});
  if(proxy)await proxy.remove({force:true});
  if(createdForwarder)await docker.getContainer(LOCAL_TLS_FORWARDER).remove({force:true});
  if(initializer)await initializer.remove({force:true});
  try{await docker.getVolume(volumeName).remove();}catch{}
  rmSync(temp,{recursive:true,force:true});
}
