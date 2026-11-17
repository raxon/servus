import type Docker from 'dockerode';
import type { SecretVault } from '../shared/secrets.js';
import { canonicalRegistry, imageRegistry, registryRecordSchema, type RegistryCredential } from '../shared/source-credentials.js';

interface RegistryService {id:string;registry?:RegistryCredential|null}
const referenceLabel='panel.registry.reference',serverLabel='panel.registry.server',userLabel='panel.registry.username';

function repositoryIdentity(value:string):{repository:string;digest?:string} {
  const at=value.indexOf('@'),digest=at<0?undefined:value.slice(at+1),withoutDigest=at<0?value:value.slice(0,at),colon=withoutDigest.lastIndexOf(':'),slash=withoutDigest.lastIndexOf('/');
  if(digest!==undefined&&!/^sha256:[a-f0-9]{64}$/.test(digest))throw new Error('The image digest is invalid.');
  const repository=colon>slash?withoutDigest.slice(0,colon):withoutDigest,firstSlash=repository.indexOf('/'),first=firstSlash<0?repository:repository.slice(0,firstSlash);
  const explicit=firstSlash>=0&&(first.includes('.')||first.includes(':')||first==='localhost'),server=explicit?canonicalRegistry(first):'docker.io';
  let path=explicit?repository.slice(firstSlash+1):repository;
  if(server==='docker.io'&&!path.includes('/'))path=`library/${path}`;
  if(!path||path.split('/').some(part=>!part||part==='.'||part==='..'))throw new Error('The image repository is invalid.');
  return{repository:`${server}/${path}`,...(digest?{digest}:{})};
}

/** An image ID may have multiple repository digests; pin the requested repository. */
export function imageDigestForReference(image:string,details:{RepoDigests?:string[];Id:string}):string {
  const expected=repositoryIdentity(image);
  for(const candidate of details.RepoDigests??[]){
    let actual;try{actual=repositoryIdentity(candidate);}catch{continue;}
    if(actual.repository===expected.repository&&actual.digest&&(!expected.digest||actual.digest===expected.digest))return candidate;
  }
  if(!expected.digest&&process.env.PANEL_ALLOW_LOCAL_IMAGES==='1'&&/^sha256:[a-f0-9]{64}$/.test(details.Id))return details.Id;
  throw new Error('The pulled image does not have a verified digest for the requested repository.');
}

/** Registry credentials remain separate from Docker specifications and their journals. */
export function registryAuth(service:RegistryService,image:string,vault:SecretVault):Docker.AuthConfigObject|undefined {
  const credential=service.registry;
  if(!credential)return undefined;
  if(!credential.secretRef||credential.password!==undefined)throw new Error('Registry credentials must use an immutable secret reference.');
  const server=canonicalRegistry(credential.server);
  if(imageRegistry(image)!==server)throw new Error('Registry credentials do not match the image registry.');
  let record;
  try{record=registryRecordSchema.parse(JSON.parse(vault.getServiceSecret(credential.secretRef,service.id,'registry')));}catch{throw new Error('The registry credential is unavailable for this service.');}
  if(record.serviceId!==service.id||canonicalRegistry(record.server)!==server||record.server!==server||record.username!==credential.username)throw new Error('The registry credential does not match this service and registry.');
  return{username:record.username,password:record.password,serveraddress:server==='docker.io'?'https://index.docker.io/v1/':server};
}

export function registryLabels(service:RegistryService):Record<string,string> {
  const credential=service.registry;
  return credential?.secretRef?{[referenceLabel]:credential.secretRef,[serverLabel]:canonicalRegistry(credential.server),[userLabel]:credential.username}:{};
}

/** Restoring a previous runtime uses its original credential, including after rotation. */
export function registryAuthFromSpec(serviceId:string,spec:Docker.ServiceSpec,vault:SecretVault):Docker.AuthConfigObject|undefined {
  const labels=spec.Labels??{},reference=labels[referenceLabel];
  if(!reference)return undefined;
  if(labels['panel.service']!==serviceId||labels['panel.owner']!=='self-hosted-panel')throw new Error('Registry rollback ownership cannot be verified.');
  const task=spec.TaskTemplate,container=task&&'ContainerSpec'in task?task.ContainerSpec:undefined;
  if(!container?.Image||!labels[serverLabel]||!labels[userLabel])throw new Error('Registry rollback identity is incomplete.');
  return registryAuth({id:serviceId,registry:{server:labels[serverLabel]!,username:labels[userLabel]!,secretRef:reference}},container.Image,vault);
}

export async function applyRegistryService(docker:Docker,spec:Docker.ServiceSpec,existingVersion:number|undefined,auth:Docker.AuthConfigObject|undefined,serviceName?:string) {
  if(existingVersion===undefined){if(auth)return docker.createService(auth,spec);return docker.createService(spec);}
  const name=spec.Name??serviceName;
  if(!name)throw new Error('A service name is required for an authenticated update.');
  const service=docker.getService(name),options={...spec,version:existingVersion};
  if(auth)return(service.update as unknown as (auth:Docker.AuthConfigObject,input:typeof options)=>Promise<void>).call(service,auth,options);
  return service.update(options);
}
