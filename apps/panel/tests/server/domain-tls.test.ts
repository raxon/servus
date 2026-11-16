import { expect, it, vi } from 'vitest';
import { inspectDomainTls, verifyRedirectEndpoints, verifyPublicHttpsRoute } from '../../src/server/domain-tls.js';
import type { DomainDnsResult } from '../../src/server/domain-dns.js';

const observation=(ipv4:string[],ipv6:string[]=[],status:DomainDnsResult['status']='resolved'):DomainDnsResult=>({hostname:'app.example.com',checkedAt:'2026-01-01T00:00:00Z',ipv4,ipv6,status});
it('pins TLS to a validated public address and reports the peer result',async()=>{
  const probe=vi.fn().mockResolvedValue({expiresAt:'2027-01-01T00:00:00.000Z',fingerprint:'AA'});
  const result=await inspectDomainTls('app.example.com',{dns:async()=>observation(['8.8.8.8']),probe});
  expect(probe).toHaveBeenCalledWith('8.8.8.8','app.example.com');expect(result).toMatchObject({status:'valid',expiresAt:'2027-01-01T00:00:00.000Z'});
});

it('only permits a redirect when every observed public endpoint serves the managed certificate',async()=>{
  const probe=vi.fn().mockResolvedValue({expiresAt:'2027-01-01T00:00:00.000Z',fingerprint:'AA'});
  const dns=async()=>observation(['8.8.8.8','1.1.1.1']);
  expect(await verifyRedirectEndpoints('app.example.com','AA',{dns,probe})).toBe(true);
  expect(probe).toHaveBeenCalledTimes(2);
  probe.mockResolvedValueOnce({expiresAt:'2027-01-01T00:00:00.000Z',fingerprint:'BB'});
  expect(await verifyRedirectEndpoints('app.example.com','AA',{dns,probe})).toBe(false);
  probe.mockRejectedValueOnce(new Error('unreachable'));
  expect(await verifyRedirectEndpoints('app.example.com','AA',{dns,probe})).toBe(false);
  probe.mockClear();
  expect(await verifyRedirectEndpoints('app.example.com','AA',{dns:async()=>observation(['127.0.0.1']),probe})).toBe(false);
  expect(await verifyRedirectEndpoints('app.example.com','AA',{dns:async()=>observation(['8.8.8.8'],[],'partial'),probe})).toBe(false);
  expect(probe).not.toHaveBeenCalled();
});

it('requires a successful HTTPS application response on every public address',async()=>{
  const dns=async()=>observation(['8.8.8.8','1.1.1.1']);
  const probe=vi.fn().mockResolvedValue(200);
  expect(await verifyPublicHttpsRoute('app.example.com',{dns,probe})).toBe(true);
  probe.mockResolvedValueOnce(503);
  expect(await verifyPublicHttpsRoute('app.example.com',{dns,probe})).toBe(false);
  probe.mockRejectedValueOnce(new Error('unreachable'));
  expect(await verifyPublicHttpsRoute('app.example.com',{dns,probe})).toBe(false);
  probe.mockClear();
  expect(await verifyPublicHttpsRoute('app.example.com',{dns:async()=>observation(['127.0.0.1']),probe})).toBe(false);
  expect(probe).not.toHaveBeenCalled();
});
it('rejects any mixed private or reserved DNS answer before connecting',async()=>{
  const probe=vi.fn();
  for(const ip of ['127.0.0.1','169.254.169.254','192.168.1.1','::1','::ffff:127.0.0.1']) {
    const record=ip.includes(':')?observation(['8.8.8.8'],[ip]):observation(['8.8.8.8',ip]);
    expect((await inspectDomainTls('app.example.com',{dns:async()=>record,probe})).status).toBe('unsafe_address');
  }
  expect(probe).not.toHaveBeenCalled();
});
it('distinguishes untrusted certificates, connection failures and incomplete DNS',async()=>{
  const dns=async()=>observation(['8.8.8.8']);
  expect((await inspectDomainTls('app.example.com',{dns,probe:async()=>{throw Object.assign(new Error(),{code:'CERT_HAS_EXPIRED'});}})).status).toBe('untrusted');
  expect((await inspectDomainTls('app.example.com',{dns,probe:async()=>{throw Object.assign(new Error(),{code:'ECONNREFUSED'});}})).status).toBe('unavailable');
  expect((await inspectDomainTls('app.example.com',{dns:async()=>observation(['8.8.8.8'],[],'partial')})).status).toBe('dns_unavailable');
});
