import type Docker from 'dockerode';
import { canonicalDnsName } from './acme/dns01.js';
import { supportsManagedHttps } from './https-routing.js';
import { composeProviderArguments } from './compose-ingress.js';
import { inspectManagedCertificate, type ManagedCertificate } from './managed-certificate.js';
import { inspectAcmeFailure } from './managed-certificate-events.js';
import { verifyRedirectEndpoints, verifyPublicHttpsRoute } from '../server/domain-tls.js';
import type { ComposeConfiguration } from '../shared/compose.js';

export class ComposeTlsError extends Error {
  constructor(readonly code:'HTTPS_NOT_CONFIGURED'|'CERTIFICATE_DOMAIN'|'CERTIFICATE_UNAVAILABLE'|'RETRY_UNAVAILABLE'|'RETRY_COOLDOWN'|'HTTPS_REDIRECT_UNVERIFIED',message:string) {super(message);}
}
export interface ComposeTlsOptions {
  ensureIngress?:()=>Promise<void>;
  verifyEndpoints?:(hostname:string,fingerprint:string)=>Promise<boolean>;
  inspectCertificate?:(docker:Docker,hostname:string)=>Promise<ManagedCertificate>;
}

/** Reuse the App ingress and ACME store; never create a separate proxy. */
export async function assertComposeHttpsIngress(docker:Docker):Promise<void> {
  try {
    const ingress=await docker.getService('panel-ingress').inspect(),network=await docker.getNetwork('panel-ingress').inspect();
    const spec=ingress.Spec as Docker.ServiceSpec;
    const volume=await docker.getVolume('servus-acme').inspect(),args=spec.TaskTemplate&&'ContainerSpec' in spec.TaskTemplate?spec.TaskTemplate.ContainerSpec?.Args??[]:[];
    const ports=spec.EndpointSpec?.Ports??[];
    if(!supportsManagedHttps(spec)||!ports.some(port=>port.Protocol==='tcp'&&port.PublishedPort===80&&port.TargetPort===8080&&port.PublishMode==='host')||
      composeProviderArguments.some(argument=>!args.includes(argument))||network.Labels?.['panel.owner']!=='self-hosted-panel'||network.Driver!=='overlay'||network.Attachable!==true||
      volume.Driver!=='local'||volume.Labels?.['panel.owner']!=='self-hosted-panel'||volume.Labels?.['panel.purpose']!=='acme')throw new Error('Unverified ingress');
  } catch {throw new ComposeTlsError('HTTPS_NOT_CONFIGURED','Configure and verify the shared application HTTPS ingress before deploying Compose HTTPS. Existing Compose routes were not changed.');}
}

export function configuredComposeHttps(configuration:ComposeConfiguration,hostname:string) {
  let host:string;
  try {host=canonicalDnsName(hostname);} catch {throw new ComposeTlsError('CERTIFICATE_DOMAIN','Enter a canonical public hostname.');}
  if(host!==hostname||host.endsWith('.localhost'))throw new ComposeTlsError('CERTIFICATE_DOMAIN','Enter a canonical public hostname.');
  const index=configuration.domains.findIndex(domain=>domain.hostname===host&&domain.https);
  if(index===-1)throw new ComposeTlsError('CERTIFICATE_DOMAIN','Deploy this domain with automatic HTTPS before checking or retrying its certificate.');
  return {domain:configuration.domains[index]!,index};
}

export async function assertComposeHttpsRoute(docker:Docker,workloadId:string,projectId:string,configuration:ComposeConfiguration,hostname:string):Promise<void> {
  const {domain,index}=configuredComposeHttps(configuration,hostname),prefix=`servus-compose-${workloadId.replaceAll('-','')}`;
  const containers=await docker.listContainers({all:true,filters:{label:[`com.docker.compose.project=${prefix}`]}});
  if(containers.some(container=>container.Labels?.['panel.owner']!=='self-hosted-panel'||container.Labels?.['panel.workload']!==workloadId||container.Labels?.['panel.project']!==projectId))
    throw new ComposeTlsError('CERTIFICATE_DOMAIN','Compose container ownership could not be verified.');
  const base=`compose-${workloadId.replaceAll('-','')}-${index}`,route=`traefik.http.routers.${base}-https`;
  const target=containers.filter(container=>container.Labels?.['com.docker.compose.service']===domain.service&&container.State==='running');
  if(!target.length||target.some(container=>container.Labels?.[`${route}.rule`]!==`Host(\`${hostname}\`)`||container.Labels?.[`${route}.entrypoints`]!=='websecure'||
    container.Labels?.[`${route}.tls`]!=='true'||container.Labels?.[`${route}.tls.certresolver`]!=='servus'||container.Labels?.[`traefik.http.services.${base}.loadbalancer.server.port`]!==String(domain.port)))
    throw new ComposeTlsError('CERTIFICATE_DOMAIN','The running Compose HTTPS route differs from the deployed configuration. Deploy it before checking or retrying.');
}

export async function composeCertificateStatus(docker:Docker,workloadId:string,projectId:string,configuration:ComposeConfiguration,hostname:string,options:ComposeTlsOptions={}) {
  await assertComposeHttpsIngress(docker);
  await assertComposeHttpsRoute(docker,workloadId,projectId,configuration,hostname);
  const certificate=await (options.inspectCertificate??inspectManagedCertificate)(docker,hostname);
  let publicVerified=false;
  if(certificate.status==='active') {
    const verify=options.verifyEndpoints??(async(host,fingerprint)=>await verifyRedirectEndpoints(host,fingerprint)&&await verifyPublicHttpsRoute(host));
    try {publicVerified=await verify(hostname,certificate.fingerprint);} catch {publicVerified=false;}
  }
  const events=await inspectAcmeFailure(docker,hostname);
  return {hostname,checkedAt:new Date().toISOString(),...certificate,publicVerified,eventsAvailable:events.available,...(events.failure?{lastFailure:events.failure}:{})};
}
