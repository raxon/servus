import { createPublicKey, generateKeyPairSync } from 'node:crypto';
import { expect, it } from 'vitest';
import { AcmeInputError, accountKeyThumbprint, dns01Value } from '../../src/agent/acme/key-authorization.js';
import { ManualDns01Provider } from '../../src/agent/acme/manual.js';
import { observeDns01 } from '../../src/agent/acme/dns-observation.js';

// Public example from RFC 7638 section 3.1; this is not a credential.
const rfcKey=createPublicKey({format:'jwk',key:{kty:'RSA',e:'AQAB',n:
  '0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAt'+
  'VT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMstn6'+
  '4tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FD'+
  'W2QvzqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5hajrn1n9'+
  '1CbOpbISD08qNLyrdkt-bFTWhAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINH'+
  'aQ-G_xBniIqbw0Ls1jF44-csFCur-kEgU8awapJzKnqDKgw'}});

it('reproduces the published RFC 7638 RSA thumbprint',()=>{
  expect(accountKeyThumbprint(rfcKey)).toBe('NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs');
});
it('computes the RFC 8555 DNS digest from the challenge token and account thumbprint',()=>{
  expect(dns01Value('evaGxfADs6pSRb2LAv9IZf17Dt3juxGJ-PCt92wr-oA',rfcKey)).toBe('ZTRx1Ckl1-tM05o5zaizTTA0yUy5AGereMgSNWC6Ll8');
});
it('carries the generated value through manual publication and DNS observation',async()=>{
  const value=dns01Value('evaGxfADs6pSRb2LAv9IZf17Dt3juxGJ-PCt92wr-oA',rfcKey);
  const provider=new ManualDns01Provider();
  const result=await provider.present({operationId:'a'.repeat(32),identifier:'*.example.com',value});
  expect(result.status).toBe('manual_action_required');
  await expect(observeDns01(result.record,async()=>[[value]])).resolves.toEqual({...result.record,status:'observed'});
  await expect(provider.remove(result.record)).resolves.toEqual({status:'manual_action_required'});
});
it('supports approved EC public keys and rejects private, weak or unsupported keys',()=>{
  const ec=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),unsupported=generateKeyPairSync('ed25519'),weak=generateKeyPairSync('rsa',{modulusLength:1024});
  expect(accountKeyThumbprint(ec.publicKey)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  for(const key of [ec.privateKey,unsupported.publicKey,weak.publicKey])expect(()=>accountKeyThumbprint(key)).toThrow(AcmeInputError);
});
it('rejects malformed or short challenge tokens without exposing them',()=>{
  for(const token of ['too-short','abc\nsecret','='.repeat(40),'d'.repeat(43)]) {
    try { dns01Value(token,rfcKey);throw new Error('expected failure'); }
    catch(error) {expect(error).toBeInstanceOf(AcmeInputError);expect(String(error)).not.toContain(token);}
  }
});
