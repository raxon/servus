import { Resolver } from 'node:dns/promises';
import { isIP } from 'node:net';
import { canonicalDnsName } from '../agent/acme/dns01.js';

type Lookup = (hostname: string) => Promise<string[]>;
export type DomainDnsResult = { hostname: string; checkedAt: string; ipv4: string[]; ipv6: string[]; status: 'resolved' | 'not_found' | 'unavailable' | 'partial' };

/** A single DNS observation cannot establish global propagation or proxy routing. */
export async function inspectDomainDns(hostname: string, lookups?: {ipv4: Lookup; ipv6: Lookup}): Promise<DomainDnsResult> {
  const host=canonicalDnsName(hostname);
  const resolver=lookups ? undefined : new Resolver({timeout:3000,tries:1});
  const queries=lookups ?? {ipv4:(name: string)=>resolver!.resolve4(name),ipv6:(name: string)=>resolver!.resolve6(name)};
  const results=await Promise.allSettled([queries.ipv4(host),queries.ipv6(host)]);
  const values=(index:number,family:number):string[]=>{
    const result=results[index];
    if(!result || result.status!=='fulfilled' || !Array.isArray(result.value) || result.value.length>100 || result.value.some(value=>typeof value!=='string' || isIP(value)!==family)) return [];
    return [...new Set(result.value)].sort();
  };
  const unavailable=results.some((result,index)=>result.status==='rejected' && !['ENODATA','ENOTFOUND','ENONAME'].includes((result.reason as {code?:string})?.code ?? '') || result.status==='fulfilled' && (!Array.isArray(result.value) || result.value.length>100 || result.value.some(value=>typeof value!=='string' || isIP(value)!==(index===0 ? 4 : 6))));
  const ipv4=values(0,4),ipv6=values(1,6),hasAddress=ipv4.length+ipv6.length>0;
  return {hostname:host,checkedAt:new Date().toISOString(),ipv4,ipv6,status:unavailable ? hasAddress ? 'partial' : 'unavailable' : hasAddress ? 'resolved' : 'not_found'};
}
