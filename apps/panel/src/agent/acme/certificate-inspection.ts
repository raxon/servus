import { createPrivateKey, randomBytes, X509Certificate } from 'node:crypto';
import { canonicalDnsName } from './dns01.js';

const maxPemBytes = 128 * 1024;
export type CertificateInspection =
  | { status:'invalid_certificate'|'invalid_hostname'; trust:'not_checked'; usage:'not_checked' }
  | { status:'matching'|'expired'|'not_yet_valid'|'name_mismatch'; trust:'not_checked'; usage:'not_checked'; notBefore:string; notAfter:string; fingerprint256:string };

function certificate(pem: string): X509Certificate | undefined {
  if (typeof pem !== 'string' || Buffer.byteLength(pem) > maxPemBytes || !pem.includes('-----BEGIN CERTIFICATE-----')) return undefined;
  try { const result=new X509Certificate(pem); return result.ca ? undefined : result; } catch { return undefined; }
}

/** Inspects the leaf only. Chain trust and server usage must be checked independently. */
export function inspectCertificate(pem: string, identifier: string, now = Date.now()): CertificateInspection {
  const unchecked = {trust:'not_checked',usage:'not_checked'} as const, cert=certificate(pem);
  if (!cert || !Number.isFinite(now)) return {status:'invalid_certificate',...unchecked};
  let host: string, wildcard: boolean;
  try {
    if (typeof identifier !== 'string') throw new Error();
    wildcard=identifier.startsWith('*.');host=canonicalDnsName(wildcard?identifier.slice(2):identifier);
    if(wildcard && host.length + 2 > 253)throw new Error();
  } catch { return {status:'invalid_hostname',...unchecked}; }
  const before=Date.parse(cert.validFrom),after=Date.parse(cert.validTo);
  if (!Number.isFinite(before) || !Number.isFinite(after) || before >= after) return {status:'invalid_certificate',...unchecked};
  const info={...unchecked,notBefore:new Date(before).toISOString(),notAfter:new Date(after).toISOString(),fingerprint256:cert.fingerprint256};
  if(now<before)return {status:'not_yet_valid',...info};
  if(now>=after)return {status:'expired',...info};
  try {
    const probeLength=Math.min(32,252-host.length);
    const query=wildcard?`${randomBytes(16).toString('hex').slice(0,probeLength)}.${host}`:host;
    const match=cert.checkHost(query,{subject:'never',partialWildcards:false,multiLabelWildcards:false});
    if(!match || (wildcard && match.toLowerCase()!==`*.${host}`))return {status:'name_mismatch',...info};
    return {status:'matching',...info};
  } catch { return {status:'invalid_certificate',...unchecked}; }
}

/** No key material or crypto parser error is returned to the caller. */
export function certificateMatchesPrivateKey(pem: string, keyPem: string): boolean {
  const cert=certificate(pem);
  if (!cert || typeof keyPem !== 'string' || Buffer.byteLength(keyPem) > maxPemBytes) return false;
  try { return cert.checkPrivateKey(createPrivateKey(keyPem)); } catch { return false; }
}
