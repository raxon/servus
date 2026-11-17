import type { DomainConfig } from '../shared/types.js';

/** The domain port is the container port; HTTP uses the ingress port instead. */
export function applicationUrl(domain:DomainConfig|null|undefined,ingressPort:number):string|null {
  if(!domain || !Number.isInteger(ingressPort) || ingressPort<1 || ingressPort>65535)return null;
  try {
    const url=new URL(`${domain.https?'https':'http'}://${domain.hostname}`);
    if(url.hostname!==domain.hostname || url.username || url.password || url.port || url.pathname!=='/' || url.search || url.hash)return null;
    if(!domain.https && ingressPort!==80)url.port=String(ingressPort);
    return url.origin;
  } catch {return null;}
}
