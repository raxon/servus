// Opt-in integration against the dedicated disposable Pebble fixture only.
import Docker from 'dockerode';
import {strict as assert} from 'node:assert';
import {randomUUID,X509Certificate} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync,writeFileSync,mkdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {ComposeRuntime} from '../../apps/panel/src/agent/compose.js';
import {DockerRuntime} from '../../apps/panel/src/agent/runtime.js';
import {inspectManagedCertificate} from '../../apps/panel/src/agent/managed-certificate.js';
import type {ComposeApplyRequest,ComposeConfiguration} from '../../apps/panel/src/shared/compose.js';

if(process.env.SERVUS_DISPOSABLE_HTTPS_TEST!=='1')throw new Error('Select the disposable HTTPS fixture explicitly.');
const socketPath=process.env.HOME+'/.colima/servus-https-e2e/docker.sock',docker=new Docker({socketPath});
assert.equal((await docker.info()).Name,'colima-servus-https-e2e');
const ingress=docker.getService('panel-ingress'),original=structuredClone((await ingress.inspect()).Spec);
assert.equal(original.Labels?.['panel.owner'],'self-hosted-panel');
assert.ok(original.TaskTemplate?.ContainerSpec?.Args?.includes('--certificatesresolvers.servus.acme.caserver=https://pebble:14000/dir'));
const image=(await docker.getImage('node:24-bookworm-slim').inspect()).Id,network=await docker.getNetwork('panel-ingress').inspect();
const work=mkdtempSync(join(tmpdir(),'servus-compose-acme-')),workloadId=randomUUID(),projectId=randomUUID(),runId=randomUUID();
const hostname=`compose-${runId.slice(0,8)}.invalid`,prefix=`servus-compose-${workloadId.replaceAll('-','')}`,proof=`proof-${runId}`;
const previousDockerConfig=process.env.DOCKER_CONFIG;process.env.DOCKER_CONFIG=join(work,'docker-config');mkdirSync(process.env.DOCKER_CONFIG);
writeFileSync(join(process.env.DOCKER_CONFIG,'config.json'),JSON.stringify({cliPluginsExtraDirs:['/opt/homebrew/lib/docker/cli-plugins']}),{mode:0o600});
const core=new DockerRuntime(socketPath,80,'traefik:3.7.13',work);
let vip='',trustedCa='',created=false,runtime:ComposeRuntime|undefined;
async function waitFor<T>(fn:()=>Promise<T|undefined>,message:string,limit=120_000):Promise<T>{const end=Date.now()+limit;do{const result=await fn();if(result)return result;await delay(1000);}while(Date.now()<end);throw new Error(message);}
async function helper(program:string,env:string[]=[],options:{network?:boolean;acme?:boolean;ca?:boolean}={}):Promise<string>{
  const container=await docker.createContainer({Image:image,Entrypoint:['node'],Cmd:['-e',program],Env:env,Tty:true,Labels:{'servus.test-run':runId},HostConfig:{NetworkMode:options.network?network.Id:'none',Mounts:[...(options.acme?[{Type:'volume' as const,Source:'servus-acme',Target:'/cert'}]:[]),...(options.ca?[{Type:'bind' as const,Source:'/tmp/servus-acme-e2e/ca.crt',Target:'/fixture/ca.crt',ReadOnly:true}]:[])]}});
  try{await container.start();const result=await container.wait();if(result.StatusCode!==0)throw new Error('Isolated fixture helper failed.');const output:unknown=await container.logs({stdout:true,stderr:false});return typeof output==='object'&&!Buffer.isBuffer(output)?JSON.stringify(output):String(output).trim();}finally{await container.remove({force:true});}
}
async function dns(action:'add-a'|'clear-a',address=vip){
  await helper("fetch('http://pebble-dns:8055/'+process.env.ACTION,{method:'POST',body:JSON.stringify({host:process.env.HOST,...(process.env.ADDRESS?{addresses:[process.env.ADDRESS]}:{})})}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))",[`ACTION=${action}`,`HOST=${hostname}`,...(action==='add-a'?[`ADDRESS=${address}`]:[])],{network:true});
}
async function proxy(spec:Docker.ServiceSpec){const current=await ingress.inspect();await ingress.update({...spec,version:current.Version.Index});await waitFor(async()=>{
  const tasks=await docker.listTasks({filters:{service:['panel-ingress'],'desired-state':['running']}});
  return spec.Mode?.Replicated?.Replicas===0?!tasks.some(task=>['running','starting','preparing'].includes(task.Status?.State??''))||undefined:tasks.some(task=>task.Status?.State==='running')||undefined;
},'Shared fixture proxy did not reach its requested state.');}
const probeProgram=`const fs=require('fs'),http=require('http'),https=require('https');function request(tls){return new Promise(resolve=>{const q=(tls?https:http).request({host:process.env.ADDRESS,port:tls?8443:8080,path:'/'+process.env.PROOF,servername:process.env.HOST,headers:{Host:process.env.HOST},...(tls?{ca:Buffer.from(process.env.TRUSTED_CA,'base64'),allowPartialTrustChain:true,rejectUnauthorized:true}:{})},r=>{const fingerprint=tls?r.socket.getPeerCertificate().fingerprint256:'';let body='';r.on('data',d=>body+=d);r.on('end',()=>resolve({status:r.statusCode,body,location:r.headers.location??'',fingerprint}));});q.setTimeout(5000,()=>q.destroy());q.on('error',()=>resolve({status:0}));q.end();});}Promise.all([request(false),request(true)]).then(([http,https])=>console.log(JSON.stringify({http,https})));`;
async function probe(){return JSON.parse(await helper(probeProgram,[`ADDRESS=${vip}`,`HOST=${hostname}`,`PROOF=${proof}`,`TRUSTED_CA=${trustedCa}`],{network:true})) as {http:{status:number;body?:string;location?:string};https:{status:number;body?:string;fingerprint?:string}};}
async function certificate(){return inspectManagedCertificate(docker,hostname,async()=>image);}
async function activeCertificate(){return waitFor(async()=>{const value=await certificate();return value.status==='active'?value:undefined;},'Compose ACME certificate was not issued.');}
async function unchangedCertificates(){return helper("const fs=require('fs'),crypto=require('crypto');let s;try{s=JSON.parse(fs.readFileSync('/cert/acme.json','utf8'))}catch(e){if(e.code!=='ENOENT')throw e;s={}};if(s.servus?.Certificates)s.servus.Certificates=s.servus.Certificates.filter(c=>c.domain.main!==process.env.HOST);console.log(crypto.createHash('sha256').update(JSON.stringify(s)).digest('hex'));",[`HOST=${hostname}`],{acme:true});}
async function containerId(){return waitFor(async()=>{const list=await docker.listContainers({filters:{label:[`panel.workload=${workloadId}`]}});return list.find(item=>item.Labels['com.docker.compose.service']==='web')?.Id;},'Compose container did not become ready.');}
async function writeProof(){const id=await containerId(),exec=await docker.getContainer(id).exec({Cmd:['sh','-c',`printf '%s' '${proof}' > /usr/share/nginx/html/${proof}`],AttachStdout:true,AttachStderr:true});await exec.start({Detach:false});await waitFor(async()=>{const state=await exec.inspect();return !state.Running&&state.ExitCode===0||undefined;},'Could not write named-volume proof.');}
async function assertRoute(redirect:boolean){await waitFor(async()=>{const value=await probe();return value.https.status===200&&value.https.body===proof&&(redirect?[301,302,307,308].includes(value.http.status)&&value.http.location===`https://${hostname}/${proof}`:value.http.status===200&&value.http.body===proof)||undefined;},'Trusted HTTPS, redirect or named-volume proof did not become ready.');}
const yaml='services:\n  web:\n    image: nginx:alpine\n    volumes: ["content:/usr/share/nginx/html"]\nvolumes: {content: {}}\n';
let configuration:ComposeConfiguration={source:{type:'inline',yaml},domains:[{hostname,service:'web',port:80,https:true}]};
const request=(type:ComposeApplyRequest['type']='deploy',revision=1):ComposeApplyRequest=>({operationId:randomUUID(),workloadId,projectId,type,revision,configuration});
const before=await unchangedCertificates();
try{
  await core.ensureInfrastructure();
  vip=(await ingress.inspect()).Endpoint?.VirtualIPs?.find(item=>item.NetworkID===network.Id)?.Addr?.split('/')[0]??'';assert.ok(vip);
  await dns('add-a','127.0.0.1'); // Override the fixture DNS server's valid default A record.
  runtime=new ComposeRuntime({dataDir:work,token:'fixture',socketPath:join(work,'agent.sock'),dockerSocket:socketPath,ingressPort:80,ingressImage:'traefik:3.7.13'},{ensureIngress:()=>core.ensureInfrastructure(),inspectCertificate:async()=>certificate(),verifyEndpoints:async(_host,fingerprint)=>{const value=await probe();return value.https.status===200&&value.https.body===proof&&value.https.fingerprint===fingerprint;}});
  created=true;await runtime.apply(request());await writeProof();
  await waitFor(async()=>{const value=await runtime!.certificate(workloadId,projectId,hostname);return value.status==='not_found'&&value.lastFailure?value:undefined;},'Initial ACME failure with incorrect DNS was not observed.',45_000);
  await dns('clear-a');await dns('add-a');await runtime.apply({...request(),certificateRetry:{hostname}});await activeCertificate();
  // Pebble's ACME HTTPS server CA differs from its generated issuance CA. Pin
  // the public issuance intermediate from the locally authenticated ACME store;
  // keep certificate chain, hostname, validity and leaf fingerprint verification on.
  trustedCa=await helper("const fs=require('fs'),{X509Certificate}=require('crypto'),s=JSON.parse(fs.readFileSync('/cert/acme.json','utf8')),c=s.servus.Certificates.find(c=>c.domain.main===process.env.HOST),chain=Buffer.from(c.certificate,'base64').toString().match(/-----BEGIN CERTIFICATE-----[\\s\\S]*?-----END CERTIFICATE-----/g),ca=chain.filter(p=>new X509Certificate(p).ca);if(!ca.length)process.exit(2);console.log(Buffer.from(ca.join('\\n')).toString('base64'));",[`HOST=${hostname}`],{acme:true});
  await assertRoute(false);
  const status=await runtime.certificate(workloadId,projectId,hostname);assert.equal(status.publicVerified,true);
  configuration={...configuration,domains:configuration.domains.map(domain=>({...domain,redirectHttps:true}))};
  await runtime.apply(request('deploy',2));await assertRoute(true);const originalContainer=await containerId();
  console.log('PASS Compose ACME failure with incorrect DNS, explicit retry after DNS repair, trusted TLS response, verified HTTP redirect and named-volume proof.');

  // Replace only this run's leaf certificate while the sole writer is stopped.
  const current=await ingress.inspect();await proxy({...current.Spec,Mode:{Replicated:{Replicas:0}}});
  const key=join(work,'renew-key.pem'),cert=join(work,'renew-cert.pem');
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj',`/CN=${hostname}`,'-addext',`subjectAltName=DNS:${hostname}`,'-addext','basicConstraints=critical,CA:FALSE'],{stdio:'ignore'});
  const expiring=new X509Certificate(readFileSync(cert));
  await helper("const fs=require('fs'),p='/cert/acme.json',s=JSON.parse(fs.readFileSync(p,'utf8')),c=s.servus.Certificates.find(c=>c.domain.main===process.env.HOST);if(!c)process.exit(2);c.certificate=process.env.CERT;c.key=process.env.KEY;fs.writeFileSync(p,JSON.stringify(s),{mode:0o600});",[`HOST=${hostname}`,`CERT=${readFileSync(cert).toString('base64')}`,`KEY=${readFileSync(key).toString('base64')}`],{acme:true});
  await proxy(current.Spec);
  const renewed=await waitFor(async()=>{const value=await certificate();return value.status==='active'&&value.fingerprint!==expiring.fingerprint256?value:undefined;},'Traefik did not renew the expiring Compose certificate.');
  assert.ok(Date.parse(renewed.expiresAt)>Date.now()+30*86400_000);await assertRoute(true);assert.equal(await containerId(),originalContainer);
  console.log('PASS Compose automatic renewal through Pebble with redirect active, unchanged application container and persistent volume data.');

  await proxy({...current.Spec,Mode:{Replicated:{Replicas:0}}});await proxy(current.Spec);await assertRoute(true);assert.equal(await containerId(),originalContainer);
  await runtime.apply(request('restart',2));await assertRoute(true);
  const invalid={...request('deploy',3),configuration:{...configuration,source:{type:'inline' as const,yaml:yaml.replace('nginx:alpine','nonexistent.servus.invalid/missing:fixture')}}};
  await assert.rejects(runtime.apply(invalid));await assertRoute(true);
  assert.equal(runtime.journal.prepare('SELECT state FROM compose_operations WHERE id=?').get(invalid.operationId)?.state,'failed');
  console.log('PASS proxy restart, Compose restart and failed update rollback preserve trusted HTTPS, redirect and named-volume data.');
  const evidence={testedAt:new Date().toISOString(),engine:'colima-servus-https-e2e',ca:'isolated Pebble 2.8.0 issuance intermediate pinned from ACME store',hostname,issuance:true,failedIssuanceRetry:true,publicCa:false,trustedFixtureTls:true,redirect:true,renewal:true,renewalContainerUnchanged:true,proxyRestart:true,composeRestart:true,rollback:true,namedVolumePreserved:true};
  const artifact=join(process.cwd(),'artifacts/compose');mkdirSync(artifact,{recursive:true});writeFileSync(join(artifact,'https-e2e.json'),JSON.stringify(evidence,null,2)+'\n');
}finally{
  let cleanupError:unknown;
  try{
    if(runtime&&created)await runtime.apply(request('destroy',2));
    // Runtime down retains named volumes. Remove only this run's volumes here.
    for(const volume of await docker.listVolumes({filters:{label:[`panel.workload=${workloadId}`]}}).then(value=>value.Volumes??[]))await docker.getVolume(volume.Name).remove();
  }catch(error){cleanupError=error;}
  finally{runtime?.close();}
  try{await dns('clear-a');}catch(error){cleanupError??=error;}
  try{
    const current=await ingress.inspect();await proxy({...current.Spec,Mode:{Replicated:{Replicas:0}}});
    await helper("const fs=require('fs'),p='/cert/acme.json';let s;try{s=JSON.parse(fs.readFileSync(p,'utf8'))}catch(e){if(e.code==='ENOENT')process.exit(0);throw e}if(s.servus?.Certificates)s.servus.Certificates=s.servus.Certificates.filter(c=>c.domain.main!==process.env.HOST);fs.writeFileSync(p,JSON.stringify(s),{mode:0o600});",[`HOST=${hostname}`],{acme:true});
    assert.equal(await unchangedCertificates(),before,'Other certificate/account records changed.');
  }finally{
    try{await proxy(original);}
    finally{process.env.DOCKER_CONFIG=previousDockerConfig;if(previousDockerConfig===undefined)delete process.env.DOCKER_CONFIG;rmSync(work,{recursive:true,force:true});}
  }
  if(cleanupError)throw cleanupError;
}
