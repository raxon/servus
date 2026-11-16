import { afterEach, expect, it } from 'vitest';
import { X509Certificate } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { selectManagedCertificate } from '../../src/agent/managed-certificate.js';

const dirs:string[]=[];
afterEach(()=>{for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
it('returns only metadata for a matching SAN, never ACME account or private key data',()=>{
  const dir=mkdtempSync(join(tmpdir(),'servus-cert-'));dirs.push(dir);
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(dir,'key'),'-out',join(dir,'cert'),'-subj','/CN=example.test','-addext','subjectAltName=DNS:app.example.test','-days','1'],{stdio:'ignore'});
  const cert=readFileSync(join(dir,'cert'));
  const raw=JSON.stringify({servus:{Account:{PrivateKey:'account-private-value'},Certificates:[{certificate:cert.toString('base64'),key:'application-private-value'}]}});
  const result=selectManagedCertificate(raw,'app.example.test',X509Certificate);
  expect(result.status).toBe('active');
  expect(JSON.stringify(result)).not.toContain('private');
  expect(JSON.stringify(result)).not.toContain(cert.toString('base64'));
  expect(selectManagedCertificate(raw,'other.example.test',X509Certificate)).toEqual({status:'not_found'});
  expect(selectManagedCertificate(raw,'example.test',X509Certificate)).toEqual({status:'not_found'});
  expect(()=>selectManagedCertificate('{broken','app.example.test',X509Certificate)).toThrow();
});
