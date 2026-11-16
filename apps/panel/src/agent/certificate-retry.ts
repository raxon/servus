import type Docker from 'dockerode';
import { canonicalDnsName } from './acme/dns01.js';

export class CertificateRetryError extends Error {
  constructor(readonly code:'RETRY_UNAVAILABLE'|'RETRY_COOLDOWN',message:string){super(message);this.name='CertificateRetryError';}
}

/** Change only the chosen router's equivalent TLS domain declaration. */
export function planCertificateRetry(spec:Docker.ServiceSpec,serviceId:string,hostname:string,now=Date.now()):Docker.ServiceSpec {
  const host=canonicalDnsName(hostname);
  if(host!==hostname || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(serviceId) || !Number.isSafeInteger(now))throw new CertificateRetryError('RETRY_UNAVAILABLE','Invalid certificate retry request.');
  const labels=spec.Labels??{};
  if(spec.Name!==`panel-app-${serviceId}` || labels['panel.owner']!=='self-hosted-panel' || labels['panel.service']!==serviceId)throw new CertificateRetryError('RETRY_UNAVAILABLE','The running service cannot be verified.');
  const matches:number[]=[];
  for(let index=0;index<20;index++) {
    const route=`${serviceId.replaceAll('-','')}-${index}-https`,prefix=`traefik.http.routers.${route}`;
    if(labels[`${prefix}.rule`]===`Host(\`${host}\`)` && labels[`${prefix}.entrypoints`]==='websecure' && labels[`${prefix}.tls`]==='true' && labels[`${prefix}.tls.certresolver`]==='servus')matches.push(index);
  }
  if(matches.length!==1)throw new CertificateRetryError('RETRY_UNAVAILABLE','Deploy this domain with automatic HTTPS before retrying issuance.');
  const index=matches[0]!,route=`${serviceId.replaceAll('-','')}-${index}-https`;
  const marker=`panel.acme-retry-${index}`,prior=labels[marker];
  if(prior!==undefined) {
    const previous=Date.parse(prior);
    if(!Number.isFinite(previous) || previous>now+30_000)throw new CertificateRetryError('RETRY_UNAVAILABLE','The previous retry time cannot be verified.');
    if(now-previous<15*60_000)throw new CertificateRetryError('RETRY_COOLDOWN','Wait 15 minutes between certificate retries to avoid certificate authority rate limits.');
  }
  const key=`traefik.http.routers.${route}.tls.domains[0].main`,existing=labels[key];
  if(Object.keys(labels).some(label=>label.startsWith(`traefik.http.routers.${route}.tls.domains`) && label!==key))throw new CertificateRetryError('RETRY_UNAVAILABLE','The TLS domain configuration differs from the managed route.');
  if(existing!==undefined && existing!==host)throw new CertificateRetryError('RETRY_UNAVAILABLE','The TLS domain configuration differs from the managed route.');
  const target=structuredClone(spec);target.Labels={...labels,[marker]:new Date(now).toISOString()};
  if(existing===undefined)target.Labels[key]=host;else delete target.Labels[key];
  return target;
}
