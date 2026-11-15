import { describe, expect, it, vi } from 'vitest';
import { inspect } from 'node:util';
import { CloudflareDns01Provider } from '../../src/agent/acme/cloudflare.js';
import { Dns01ProviderError } from '../../src/agent/acme/dns01.js';

const zoneId = 'a'.repeat(32), recordId = 'b'.repeat(32), operationId = 'c'.repeat(32);
const token = 'fixture-only-token', value = Buffer.alloc(32, 0x75).toString('base64url');
const challenge = { operationId, identifier: '*.www.example.com', value };
const expected = { operationId, name: '_acme-challenge.www.example.com', value, recordId };
const providerRecord = { id: recordId, type: 'TXT', name: expected.name, content: value, comment: `servus-acme-${operationId}` };
const response = (result: unknown) => new Response(JSON.stringify({success:true,result}), {status:200, headers:{'content-type':'application/json'}});

function failure(error: unknown, code: Dns01ProviderError['code']) {
  expect(error).toBeInstanceOf(Dns01ProviderError);
  expect((error as Dns01ProviderError).code).toBe(code);
  expect(String(error)).not.toContain(token);
}

describe('Cloudflare DNS-01 adapter', () => {
  it('creates one TXT record for a wildcard and returns its exact ownership handle', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(providerRecord));
    const provider = new CloudflareDns01Provider(zoneId, 'example.com', token, fetcher);
    await expect(provider.present(challenge)).resolves.toEqual({status:'awaiting_dns',record:expected});
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(`https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records`);
    expect(init?.method).toBe('POST'); expect(init?.redirect).toBe('error');
    expect(init?.headers).toMatchObject({authorization:`Bearer ${token}`});
    expect(JSON.parse(init?.body as string)).toEqual({type:'TXT',name:expected.name,content:value,ttl:120,comment:`servus-acme-${operationId}`});
  });

  it('normalizes international names and requires the challenge to be in the configured zone', async () => {
    const fetcher=vi.fn<typeof fetch>().mockResolvedValue(response({...providerRecord,name:'_acme-challenge.xn--domen-7wa.example.com'}));
    const provider=new CloudflareDns01Provider(zoneId,'example.com',token,fetcher);
    await expect(provider.present({...challenge,identifier:'domeną.example.com'})).resolves.toMatchObject({status:'awaiting_dns',record:{name:'_acme-challenge.xn--domen-7wa.example.com'}});
    for (const identifier of ['example.com.attacker.test','*.attacker.test','foo..example.com','example.com.','*.*.example.com','https://example.com']) {
      await expect(provider.present({...challenge,identifier})).rejects.toMatchObject({code:'invalid_input'});
    }
    const longHost=[...Array(3).fill('a'.repeat(63)),'b'.repeat(38),'example','com'].join('.');
    await expect(provider.present({...challenge,identifier:longHost})).rejects.toMatchObject({code:'invalid_input'});
    await expect(provider.present({...challenge,value:'d'.repeat(43)})).rejects.toMatchObject({code:'invalid_input'});
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('removes only the verified record ID, value and operation marker', async () => {
    const fetcher=vi.fn<typeof fetch>().mockResolvedValueOnce(response(providerRecord)).mockResolvedValueOnce(response({id:recordId}));
    const provider=new CloudflareDns01Provider(zoneId,'example.com',token,fetcher);
    await expect(provider.remove(expected)).resolves.toEqual({status:'removed'});
    expect(fetcher.mock.calls.map(([url,init])=>[url,init?.method])).toEqual([
      [`https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records/${recordId}`,'GET'],
      [`https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records/${recordId}`,'DELETE'],
    ]);
  });

  it.each(['id','type','name','content','comment'])('does not delete a record whose %s changed',async field=>{
    const fetcher=vi.fn<typeof fetch>().mockResolvedValue(response({...providerRecord,[field]:'different'}));
    const provider=new CloudflareDns01Provider(zoneId,'example.com',token,fetcher);
    await expect(provider.remove(expected)).rejects.toMatchObject({code:'ownership_mismatch'});
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('fails closed for tampered handles and unsafe credentials without sending a request',async()=>{
    const fetcher=vi.fn<typeof fetch>();
    expect(()=>new CloudflareDns01Provider(zoneId,'example.com','bad\r\ntoken',fetcher)).toThrow(Dns01ProviderError);
    const provider=new CloudflareDns01Provider(zoneId,'example.com',token,fetcher);
    expect(JSON.stringify(provider)).not.toContain(token);
    expect(inspect(provider)).not.toContain(token);
    for(const record of [{...expected,name:'_acme-challenge.attacker.test'}, {...expected,recordId:'../bad'}, {...expected,value:'bad'}, {...expected,operationId:'bad'}]) {
      await expect(provider.remove(record)).rejects.toMatchObject({code:'invalid_input'});
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('does not retry uncertain mutations or expose external error text or credentials',async()=>{
    const fetcher=vi.fn<typeof fetch>().mockRejectedValue(new Error(`network failure ${token}`));
    const provider=new CloudflareDns01Provider(zoneId,'example.com',token,fetcher);
    try { await provider.present(challenge); throw new Error('expected failure'); } catch(error) { failure(error,'uncertain'); }
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockReset().mockResolvedValue(new Response(`provider error ${token}`,{status:403}));
    try { await provider.present(challenge); throw new Error('expected failure'); } catch(error) { failure(error,'rejected'); }
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('treats malformed or oversized success responses as uncertain',async()=>{
    const fetcher=vi.fn<typeof fetch>();
    const provider=new CloudflareDns01Provider(zoneId,'example.com',token,fetcher);
    for(const result of [response({...providerRecord,id:'bad'}),response({...providerRecord,content:'wrong'}),new Response('x'.repeat(128*1024+1),{status:200})]) {
      fetcher.mockResolvedValueOnce(result);
      await expect(provider.present(challenge)).rejects.toMatchObject({code:'uncertain'});
    }
  });

  it('does not report deletion complete when provider status or response is ambiguous',async()=>{
    const fetcher=vi.fn<typeof fetch>().mockResolvedValueOnce(response(providerRecord)).mockResolvedValueOnce(new Response('rate limited',{status:429}));
    const provider=new CloudflareDns01Provider(zoneId,'example.com',token,fetcher);
    await expect(provider.remove(expected)).rejects.toMatchObject({code:'uncertain'});
    expect(fetcher).toHaveBeenCalledTimes(2);
    fetcher.mockReset().mockResolvedValueOnce(new Response('not found',{status:404}));
    await expect(provider.remove(expected)).rejects.toMatchObject({code:'rejected'});
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
