import { expect, it } from 'vitest';
import { lastAcmeFailure } from '../../src/agent/managed-certificate-events.js';

it('returns only classified failures for the exact domain and resolver',()=>{
  const lines=[
    '2026-01-01T00:00:00Z ERR Unable to obtain ACME certificate for domains error="invalidContact secret-token" domains=["app.example.com"] providerName=servus.acme',
    '2026-01-02T00:00:00Z ERR Unable to obtain ACME certificate for domains error="unauthorized" domains=["other.example.com"] providerName=servus.acme',
    '2026-01-03T00:00:00Z ERR Unable to obtain ACME certificate for domains error="unauthorized" domains=["app.example.com"] providerName=unrelated.acme',
    '2026-01-04T00:00:00Z ERR Error renewing ACME certificate: {app.example.com []} error="acme:error:dns secret-token" providerName=servus.acme',
  ].join('\n');
  const result=lastAcmeFailure(lines,'app.example.com');
  expect(result).toEqual({observedAt:'2026-01-04T00:00:00.000Z',operation:'renewal',category:'dns'});
  expect(JSON.stringify(result)).not.toContain('secret-token');
  expect(lastAcmeFailure(lines,'notapp.example.com')).toBeUndefined();
});
it('supports structured JSON and ignores incomplete or ambiguous events',()=>{
  const line=JSON.stringify({time:'2026-01-01T00:00:00Z',providerName:'servus.acme',message:'Unable to obtain ACME certificate for domains',domains:['app.example.com'],error:'rateLimited secret'});
  expect(lastAcmeFailure(line,'app.example.com')).toEqual({observedAt:'2026-01-01T00:00:00.000Z',operation:'issuance',category:'rate_limit'});
  expect(lastAcmeFailure(line.replace('app.example.com','other.example.com'),'app.example.com')).toBeUndefined();
  expect(lastAcmeFailure('2026-01-01T00:00:00Z ERR Unable to obtain ACME certificate for domains providerName=servus.acme','app.example.com')).toBeUndefined();
});
