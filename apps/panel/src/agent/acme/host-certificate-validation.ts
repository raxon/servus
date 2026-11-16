import { createPrivateKey, X509Certificate } from 'node:crypto';
import { hostCertificateSchema, type HostCertificate } from '../../shared/host-domain.js';

export function validateHostCertificate(value:HostCertificate):X509Certificate {
  hostCertificateSchema.parse(value);
  const certificate=new X509Certificate(value.certificate);
  const names=certificate.subjectAltName?.split(', ').sort();
  if(JSON.stringify(names)!==JSON.stringify([`DNS:${value.hostname}`,`DNS:*.${value.hostname}`].sort()) || !certificate.checkPrivateKey(createPrivateKey(value.privateKey)) || Date.parse(certificate.validFrom)>Date.now() || Date.parse(certificate.validTo)<=Date.now() || new Date(certificate.validTo).toISOString()!==value.expiresAt)throw new Error('The host certificate does not match this installation or is not valid.');
  return certificate;
}
