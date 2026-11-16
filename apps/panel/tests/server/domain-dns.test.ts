import { describe, expect, it } from 'vitest';
import { inspectDomainDns } from '../../src/server/domain-dns.js';

const noData = async (): Promise<string[]> => {throw Object.assign(new Error('none'),{code:'ENODATA'});};
const timeout = async (): Promise<string[]> => {throw Object.assign(new Error('timeout'),{code:'ETIMEOUT'});};

describe('domain DNS observation',()=>{
  it('reports actual A and AAAA answers and deduplicates them',async()=>{
    const result=await inspectDomainDns('App.Example.com',{ipv4:async()=>['8.8.8.8','8.8.8.8'],ipv6:async()=>['2606:4700:4700::1111']});
    expect(result).toMatchObject({hostname:'app.example.com',status:'resolved',ipv4:['8.8.8.8'],ipv6:['2606:4700:4700::1111']});
  });
  it('distinguishes absent records, partial answers and unavailable resolvers',async()=>{
    expect((await inspectDomainDns('app.example.com',{ipv4:noData,ipv6:noData})).status).toBe('not_found');
    expect((await inspectDomainDns('app.example.com',{ipv4:async()=>['8.8.8.8'],ipv6:timeout})).status).toBe('partial');
    expect((await inspectDomainDns('app.example.com',{ipv4:timeout,ipv6:noData})).status).toBe('unavailable');
    expect((await inspectDomainDns('app.example.com',{ipv4:async()=>['::1'],ipv6:noData})).status).toBe('unavailable');
  });
  it('rejects local, IP and malformed names before querying DNS',async()=>{
    let called=false;const query=async()=>{called=true;return [];};
    for(const host of ['localhost','127.0.0.1','app.example.com/path','*.example.com']) await expect(inspectDomainDns(host,{ipv4:query,ipv6:query})).rejects.toThrow();
    expect(called).toBe(false);
  });
});
