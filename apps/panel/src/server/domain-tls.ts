import { connect, type PeerCertificate } from 'node:tls';
import { request } from 'node:https';
import { isPrivateAddress } from '../shared/network-address.js';
import { inspectDomainDns } from './domain-dns.js';

type DnsResult = Awaited<ReturnType<typeof inspectDomainDns>>;
export type DomainTlsResult = { hostname:string; checkedAt:string; status:'valid'|'unavailable'|'untrusted'|'unsafe_address'|'dns_unavailable'; expiresAt?:string; fingerprint?:string };
type Probe = (address:string, hostname:string) => Promise<{expiresAt:string;fingerprint:string}>;

function probeTls(address:string, hostname:string):Promise<{expiresAt:string;fingerprint:string}> {
  return new Promise((resolve,reject)=>{
    const socket=connect({host:address,port:443,servername:hostname,rejectUnauthorized:true});
    let finished=false;
    const finish=(error?:Error,certificate?:PeerCertificate)=>{
      if(finished)return;finished=true;socket.destroy();
      if(error)return reject(error);
      const expiry=Date.parse(certificate?.valid_to ?? '');
      if(!Number.isFinite(expiry) || !certificate?.fingerprint256)return reject(new Error('Invalid peer certificate'));
      resolve({expiresAt:new Date(expiry).toISOString(),fingerprint:certificate.fingerprint256});
    };
    socket.setTimeout(5000,()=>finish(new Error('TLS connection timed out')));
    socket.once('error',error=>finish(error));
    socket.once('secureConnect',()=>finish(undefined,socket.getPeerCertificate()));
  });
}

/** Require every observed public address to present the currently managed certificate. */
export async function verifyRedirectEndpoints(hostname:string,fingerprint:string,options:{dns?:(host:string)=>Promise<DnsResult>;probe?:Probe}={}):Promise<boolean> {
  const dns=await (options.dns??inspectDomainDns)(hostname);
  const addresses=[...dns.ipv4,...dns.ipv6];
  if(dns.hostname!==hostname || dns.status!=='resolved' || !addresses.length || addresses.length>16 || addresses.some(isPrivateAddress))return false;
  const results=await Promise.allSettled(addresses.map(address=>(options.probe??probeTls)(address,hostname)));
  return results.every(result=>result.status==='fulfilled' && result.value.fingerprint===fingerprint);
}

function probeHttpsResponse(address:string,hostname:string):Promise<number> {
  return new Promise((resolve,reject)=>{
    const req=request({host:address,port:443,servername:hostname,method:'GET',path:'/',headers:{host:hostname},rejectUnauthorized:true},res=>{
      const status=res.statusCode??0;res.destroy();resolve(status);
    });
    req.setTimeout(5000,()=>req.destroy(new Error('HTTPS route timed out')));
    req.once('error',reject);req.end();
  });
}

/** Probe the HTTPS application route itself instead of accepting its HTTP redirect as readiness. */
export async function verifyPublicHttpsRoute(hostname:string,options:{dns?:(host:string)=>Promise<DnsResult>;probe?:(address:string,hostname:string)=>Promise<number>}={}):Promise<boolean> {
  const dns=await (options.dns??inspectDomainDns)(hostname);
  const addresses=[...dns.ipv4,...dns.ipv6];
  if(dns.hostname!==hostname || dns.status!=='resolved' || !addresses.length || addresses.length>16 || addresses.some(isPrivateAddress))return false;
  const results=await Promise.allSettled(addresses.map(address=>(options.probe??probeHttpsResponse)(address,hostname)));
  return results.every(result=>result.status==='fulfilled' && result.value>=200 && result.value<400);
}

/** Checks the certificate served by one observed public endpoint, which may be a proxy. */
export async function inspectDomainTls(hostname:string, options:{dns?:(host:string)=>Promise<DnsResult>;probe?:Probe}={}):Promise<DomainTlsResult> {
  const dns=await (options.dns??inspectDomainDns)(hostname);
  const result=(status:DomainTlsResult['status']):DomainTlsResult=>({hostname:dns.hostname,checkedAt:new Date().toISOString(),status});
  const addresses=[...dns.ipv4,...dns.ipv6];
  if(dns.status==='unavailable'||dns.status==='partial'||!addresses.length)return result('dns_unavailable');
  if(addresses.some(isPrivateAddress))return result('unsafe_address');
  try {return {...result('valid'),...await (options.probe??probeTls)(addresses[0]!,dns.hostname)};}
  catch(error) {
    const code=(error as {code?:string})?.code??'';
    const untrusted=/^(CERT_|ERR_TLS_CERT_|DEPTH_|SELF_SIGNED_CERT|UNABLE_TO_|UNABLE_TO_VERIFY_LEAF_SIGNATURE)/.test(code);
    return result(untrusted?'untrusted':'unavailable');
  }
}
