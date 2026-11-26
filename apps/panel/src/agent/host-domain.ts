import { existsSync, lstatSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { hostname as containerHostname } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import type Docker from 'dockerode';
import { DockerRuntime, INGRESS_NETWORK, INGRESS_SERVICE, OWNER } from './runtime.js';
import { hostDomainPattern, type HostCertificate } from '../shared/host-domain.js';
import { validateHostCertificate } from './acme/host-certificate-validation.js';
import { supportsManagedHttps } from './https-routing.js';
import { migrateManagedHttps } from './https-migration-run.js';
import { applyHttpsMigration } from './https-migration.js';
import { dockerIngressMigrationDriver } from './https-migration-docker.js';
import type { HttpsMigrationJournal } from './https-migration-journal.js';
import { localAgentImage } from './host-port-probe.js';

const mountTarget='/servus-host';
const providerArgs=['--providers.file.directory=/servus-host/dynamic','--providers.file.watch=true'];

function directory(path:string):void {
  if(!existsSync(path))mkdirSync(path,{mode:0o700});
  const info=lstatSync(path);
  if(!info.isDirectory() || info.isSymbolicLink() || (info.mode&0o022)!==0)throw new Error('Host certificate directory is not trusted.');
}
function atomic(path:string,value:string):void {
  if(existsSync(path) && (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()))throw new Error('Host certificate file is not trusted.');
  const temporary=`${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary,value,{flag:'wx',mode:0o600});
  renameSync(temporary,path);
}

export function hostRoutingConfiguration(hostname:string,fingerprint:string) {
  if(!hostDomainPattern.test(hostname) || !/^[a-f0-9]{64}$/.test(fingerprint))throw new Error('Invalid host routing identity.');
  return {
    tls:{certificates:[{certFile:`${mountTarget}/tls/${fingerprint}.crt`,keyFile:`${mountTarget}/tls/${fingerprint}.key`}]},
    http:{
      routers:{
        'servus-host-http':{entryPoints:['web'],rule:`Host(\`${hostname}\`)`,priority:10000,service:'servus-host-panel',middlewares:['servus-host-redirect']},
        'servus-host-https':{entryPoints:['websecure'],rule:`Host(\`${hostname}\`)`,priority:10000,service:'servus-host-panel',tls:{}},
      },
      middlewares:{'servus-host-redirect':{redirectScheme:{scheme:'https',permanent:true}}},
      services:{'servus-host-panel':{loadBalancer:{passHostHeader:true,servers:[{url:'http://servus-panel-api:4180'}]}}},
    },
  };
}

export function planHostIngress(spec:Docker.ServiceSpec,dataDir:string,hostname:string):Docker.ServiceSpec {
  if(!hostDomainPattern.test(hostname) || !supportsManagedHttps(spec))throw new Error('Managed HTTPS ingress is required for the host domain.');
  const target=structuredClone(spec),task=target.TaskTemplate;
  if(!task || !('ContainerSpec' in task) || !task.ContainerSpec)throw new Error('Ingress task is missing.');
  const container=task.ContainerSpec,args=container.Args??[],mounts=container.Mounts??[];
  const own=spec.Labels?.['panel.host-domain'];
  if(own && own!==hostname)throw new Error('Ingress belongs to another host domain.');
  if(args.some(arg=>arg.startsWith('--providers.file.')&&!providerArgs.includes(arg)))throw new Error('An existing file provider requires manual review.');
  const mount=mounts.find(item=>item.Target===mountTarget);
  if(mount && (mount.Type!=='bind'||mount.Source!==join(dataDir,'host-domain')||mount.ReadOnly!==true))throw new Error('The host certificate mount belongs to another configuration.');
  if(!own && (mount || providerArgs.some(arg=>args.includes(arg))))throw new Error('The host provider ownership cannot be verified.');
  container.Args=[...args,...providerArgs.filter(arg=>!args.includes(arg))];
  container.Mounts=mount?[...mounts]:[...mounts,{Type:'bind',Source:join(dataDir,'host-domain'),Target:mountTarget,ReadOnly:true}];
  target.Labels={...target.Labels,'panel.host-domain':hostname};
  return target;
}

export function installHostCertificateFiles(dataDir:string,value:HostCertificate):void {
  const certificate=validateHostCertificate(value),fingerprint=certificate.fingerprint256.replaceAll(':','').toLowerCase();
  directory(dataDir);
  const root=join(dataDir,'host-domain');directory(root);directory(join(root,'tls'));directory(join(root,'dynamic'));
  atomic(join(root,'tls',`${fingerprint}.crt`),value.certificate);
  atomic(join(root,'tls',`${fingerprint}.key`),value.privateKey);
  // The provider sees one atomic document referencing a complete immutable pair.
  // JSON is a YAML subset; the extension must be recognized by Traefik's file provider.
  atomic(join(root,'dynamic','host.yaml'),JSON.stringify(hostRoutingConfiguration(value.hostname,fingerprint)));
  atomic(join(root,'active.json'),JSON.stringify({hostname:value.hostname,fingerprint,staging:value.staging}));
}

/** Join only this agent's Compose API container to the owned attachable ingress. */
async function connectPanelApi(runtime:DockerRuntime):Promise<string> {
  const self=await runtime.docker.getContainer(containerHostname()).inspect();
  const project=self.Config?.Labels?.['com.docker.compose.project'];
  if(self.Config?.Labels?.['com.docker.compose.service']!=='agent'||!project)throw new Error('Host routing requires the managed Compose installation.');
  const list=await runtime.docker.listContainers({filters:{label:[`com.docker.compose.project=${project}`,'com.docker.compose.service=api']}});
  if(list.length!==1)throw new Error('The panel API container cannot be identified uniquely.');
  const api=await runtime.docker.getContainer(list[0]!.Id).inspect();
  const shared=api.Mounts?.find(mount=>mount.Destination===runtime.dataDir);
  const agentMount=self.Mounts?.find(mount=>mount.Destination===runtime.dataDir);
  if(!api.State.Running || shared?.Type!=='bind' || shared.Source!==runtime.dataDir || agentMount?.Source!==shared.Source || api.Config?.Labels?.['com.docker.compose.project']!==project || api.Config?.Labels?.['com.docker.compose.service']!=='api')throw new Error('The panel API ownership or shared data directory cannot be verified.');
  const network=await runtime.docker.getNetwork(INGRESS_NETWORK).inspect();
  if(network.Labels?.['panel.owner']!==OWNER || network.Driver!=='overlay' || network.Attachable!==true)throw new Error('The managed ingress network cannot be verified.');
  const existing=api.NetworkSettings.Networks[INGRESS_NETWORK];
  if(existing) {
    if(existing.NetworkID!==network.Id || !existing.Aliases?.includes('servus-panel-api'))throw new Error('The panel API has an unexpected ingress attachment.');
  } else await runtime.docker.getNetwork(network.Id).connect({Container:api.Id,EndpointConfig:{Aliases:['servus-panel-api']}});
  return network.Id;
}

async function verifyHostRoute(runtime:DockerRuntime,network:string,value:HostCertificate):Promise<void> {
  const image=await localAgentImage(runtime.docker),fingerprint=validateHostCertificate(value).fingerprint256;
  // A staging chain is permitted only here: the peer must match the validated certificate exactly.
  const script=`const https=require('node:https');const r=https.get({hostname:'panel-ingress',port:8443,servername:${JSON.stringify(value.hostname)},path:'/api/v1/health',headers:{host:${JSON.stringify(value.hostname)}},rejectUnauthorized:false,timeout:10000},s=>{const peer=s.socket.getPeerCertificate().fingerprint256;let b='';s.on('data',c=>{b+=c;if(b.length>8192)process.exit(2)});s.on('end',()=>{try{process.exit(s.statusCode===200&&peer===${JSON.stringify(fingerprint)}&&JSON.parse(b).status==='ok'?0:2)}catch{process.exit(2)}})});r.on('error',()=>process.exit(2));r.on('timeout',()=>process.exit(2));`;
  const helper=await runtime.docker.createContainer({Image:image,Entrypoint:['/usr/local/bin/node'],Cmd:['-e',script],User:'65534:65534',Labels:{'panel.owner':OWNER,'panel.purpose':'host-route-probe'},HostConfig:{NetworkMode:network,ReadonlyRootfs:true,CapDrop:['ALL'],SecurityOpt:['no-new-privileges'],PidsLimit:32,Memory:64*1024*1024}});
  let timer:ReturnType<typeof setTimeout>|undefined;
  try {
    await helper.start();
    const result=await Promise.race([helper.wait(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Host route verification timed out.')),15_000);})]);
    if(result.StatusCode!==0)throw new Error('The ingress did not serve the expected panel and host certificate.');
  } finally {if(timer)clearTimeout(timer);try{await helper.remove({force:true});}catch{}}
}

export function hasActiveHostDomain(dataDir:string):boolean {
  const path=join(dataDir,'host-domain','active.json');
  try {return existsSync(path) && lstatSync(path).isFile();}
  catch {return false;}
}

/** Reattach the managed Compose API container to panel-ingress after container recreation. */
export async function ensureHostDomainIngress(runtime:DockerRuntime):Promise<boolean> {
  if(!runtime.vault.hostConnection()?.hostname && !hasActiveHostDomain(runtime.dataDir))return false;
  await connectPanelApi(runtime);
  return true;
}

export async function configureHostDomain(runtime:DockerRuntime,journal:HttpsMigrationJournal,assertQuiescent:()=>void,value:HostCertificate):Promise<void> {
  validateHostCertificate(value);
  if(runtime.vault.hostConnection()?.hostname!==value.hostname)throw new Error('The host domain is not registered to this installation.');
  assertQuiescent();
  await runtime.ensureInfrastructure();
  const driver=dockerIngressMigrationDriver(runtime.docker,INGRESS_SERVICE);
  if(!supportsManagedHttps((await driver.inspect()).spec))await migrateManagedHttps(runtime,journal,assertQuiescent);
  const current=await driver.inspect();
  const target=planHostIngress(current.spec,runtime.dataDir,value.hostname);
  const network=await connectPanelApi(runtime);
  assertQuiescent();
  installHostCertificateFiles(runtime.dataDir,value);
  if(!isDeepStrictEqual(current.spec,target))await applyHttpsMigration(journal,driver,current.spec,target,current.version);
  let lastError:unknown;
  for(let attempt=0;attempt<3;attempt++) {
    try {await verifyHostRoute(runtime,network,value);return;}
    catch(error){lastError=error;await delay(2000);}
  }
  throw lastError;
}
