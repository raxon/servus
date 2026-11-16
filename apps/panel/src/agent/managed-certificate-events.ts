import type Docker from 'dockerode';
import { decodeDockerLogs } from './configuration.js';
import { outputBuffer } from './observability.js';
import { canonicalDnsName } from './acme/dns01.js';

export type AcmeFailure = {observedAt:string;operation:'issuance'|'renewal';category:'dns'|'rate_limit'|'contact'|'challenge'|'other'};

/** Extract a bounded, classified observation; raw proxy logs may contain secrets. */
export function lastAcmeFailure(text:string,hostname:string):AcmeFailure|undefined {
  const host=canonicalDnsName(hostname);
  if(host!==hostname || text.length>2_000_000)throw new Error('Invalid certificate event input.');
  let latest:AcmeFailure|undefined;
  for(const original of text.split('\n')) {
    const line=original.replace(/\x1b\[[0-9;]*m/g,'');
    if(line.length>100_000)continue;
    let message=line,provider='',domains:string[]=[],time='';
    try {
      const value:unknown=JSON.parse(line);
      if(value && typeof value==='object' && !Array.isArray(value)) {
        const entry=value as Record<string,unknown>;
        provider=typeof entry.providerName==='string'?entry.providerName:'';
        message=typeof entry.message==='string'?entry.message:'';
        domains=Array.isArray(entry.domains)?entry.domains.filter((item):item is string=>typeof item==='string'):[];
        time=typeof entry.time==='string'?entry.time:'';
      }
    }catch { /* Human-readable Traefik log format. */ }
    if(!provider && /(?:^|\s)providerName=servus\.acme(?:\s|$)/.test(line))provider='servus.acme';
    if(provider!=='servus.acme')continue;
    if(!time)time=line.match(/\b\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)\b/)?.[0]??'';
    const timestamp=Date.parse(time);
    if(!Number.isFinite(timestamp))continue;
    let operation:AcmeFailure['operation']|undefined;
    if(message.includes('Unable to obtain ACME certificate for domains')) {
      if(!domains.length) {const encoded=line.match(/(?:^|\s)domains=(\[[^\]\n]{0,4096}\])/i)?.[1];if(encoded)try{const parsed:unknown=JSON.parse(encoded);if(Array.isArray(parsed))domains=parsed.filter((item):item is string=>typeof item==='string');}catch{}}
      if(domains.includes(host))operation='issuance';
    } else if(message.includes(`Error renewing ACME certificate: {${host} []}`) || message.includes(`Error renewing ACME certificate: {Main:${host} SANs:[]}`))operation='renewal';
    if(!operation)continue;
    const combined=(line+' '+message).toLowerCase();
    const category:AcmeFailure['category']=combined.includes('invalidcontact')?'contact':combined.includes('ratelimited')||combined.includes('rate limit')?'rate_limit':combined.includes('acme:error:dns')||combined.includes('nxdomain')?'dns':combined.includes('unauthorized')||combined.includes('challenge')?'challenge':'other';
    if(!latest || timestamp>Date.parse(latest.observedAt))latest={observedAt:new Date(timestamp).toISOString(),operation,category};
  }
  return latest;
}

export async function inspectAcmeFailure(docker:Docker,hostname:string):Promise<{available:boolean;failure?:AcmeFailure}> {
  try {
    const service=docker.getService('panel-ingress'),inspection=await service.inspect();
    if(inspection.Spec.Labels?.['panel.owner']!=='self-hosted-panel'||inspection.Spec.Labels?.['panel.https']!=='servus-acme-v1')return {available:false};
    const raw=await outputBuffer(await service.logs({stdout:true,stderr:true,tail:500,timestamps:true}),2_000_000);
    const failure=lastAcmeFailure(decodeDockerLogs(raw),hostname);
    return failure?{available:true,failure}:{available:true};
  } catch {return {available:false};}
}
