import { afterAll, beforeAll, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { certificateMatchesPrivateKey, inspectCertificate } from '../../src/agent/acme/certificate-inspection.js';

let directory:string,cert:string,key:string,otherKey:string,exactCert:string;
beforeAll(()=>{
  directory=mkdtempSync(join(tmpdir(),'servus-cert-test-'));
  const generate=(prefix:string,san:string)=>{
    const keyPath=join(directory,`${prefix}.key`),certPath=join(directory,`${prefix}.pem`);
    execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=ignored.example.com','-addext',`subjectAltName=${san}`,'-addext','basicConstraints=critical,CA:FALSE','-keyout',keyPath,'-out',certPath],{stdio:'ignore'});
    return {cert:readFileSync(certPath,'utf8'),key:readFileSync(keyPath,'utf8')};
  };
  const wildcard=generate('wild','DNS:example.com,DNS:*.example.com'),exact=generate('exact','DNS:api.example.com');
  cert=wildcard.cert;key=wildcard.key;exactCert=exact.cert;otherKey=exact.key;
});
afterAll(()=>{if(directory)rmSync(directory,{recursive:true,force:true});});

it('reports dates and SAN coverage without claiming the self-signed certificate is trusted',()=>{
  expect(inspectCertificate(cert,'example.com')).toMatchObject({status:'matching',trust:'not_checked',notBefore:expect.any(String),notAfter:expect.any(String)});
  expect(inspectCertificate(cert,'*.example.com')).toMatchObject({status:'matching',trust:'not_checked'});
  expect(inspectCertificate(cert,'deep.api.example.com')).toMatchObject({status:'name_mismatch'});
  expect(inspectCertificate(cert,'attacker.test')).toMatchObject({status:'name_mismatch'});
  expect(inspectCertificate(exactCert,'*.example.com')).toMatchObject({status:'name_mismatch'});
  expect(inspectCertificate(exactCert,'ignored.example.com')).toMatchObject({status:'name_mismatch'});
});
it('reports expired and not-yet-valid certificates separately',()=>{
  const current=inspectCertificate(cert,'example.com');
  if(!('notBefore' in current))throw new Error('fixture certificate missing dates');
  expect(inspectCertificate(cert,'example.com',Date.parse(current.notBefore)-1).status).toBe('not_yet_valid');
  expect(inspectCertificate(cert,'example.com',Date.parse(current.notAfter)).status).toBe('expired');
});
it('rejects malformed certificates, identifiers and unrelated keys without disclosing material',()=>{
  expect(inspectCertificate('bad','example.com')).toEqual({status:'invalid_certificate',trust:'not_checked',usage:'not_checked'});
  expect(inspectCertificate(cert,'*.evil..example.com')).toEqual({status:'invalid_hostname',trust:'not_checked',usage:'not_checked'});
  expect(inspectCertificate(cert,'127.0.0.1')).toEqual({status:'invalid_hostname',trust:'not_checked',usage:'not_checked'});
  const tooLong=[...Array(3).fill('a'.repeat(63)),'b'.repeat(60)].join('.');
  expect(inspectCertificate(cert,`*.${tooLong}`)).toEqual({status:'invalid_hostname',trust:'not_checked',usage:'not_checked'});
  expect(certificateMatchesPrivateKey(cert,key)).toBe(true);
  expect(certificateMatchesPrivateKey(cert,otherKey)).toBe(false);
  expect(certificateMatchesPrivateKey(cert,'bad')).toBe(false);
});
