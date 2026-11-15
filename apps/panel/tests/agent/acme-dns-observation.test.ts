import { expect, it, vi } from 'vitest';
import { createSocket } from 'node:dgram';
import { Resolver } from 'node:dns/promises';
import { once } from 'node:events';
import { observeDns01 } from '../../src/agent/acme/dns-observation.js';

const value=Buffer.alloc(32,5).toString('base64url');
const record={operationId:'a'.repeat(32),name:'_acme-challenge.example.com',value};
it('observes the exact value, including a DNS TXT split into character strings',async()=>{
  const lookup=vi.fn().mockResolvedValue([['unrelated'],[value.slice(0,20),value.slice(20)]]);
  await expect(observeDns01(record,lookup)).resolves.toEqual({...record,status:'observed'});
  expect(lookup).toHaveBeenCalledExactlyOnceWith(record.name);
});
it('treats absent or different values as pending, not validation success',async()=>{
  await expect(observeDns01(record,async()=>[['different']])).resolves.toEqual({...record,status:'pending'});
  await expect(observeDns01(record,async()=>{throw Object.assign(new Error('no record'),{code:'ENOTFOUND'});})).resolves.toEqual({...record,status:'pending'});
  await expect(observeDns01(record,async()=>{throw Object.assign(new Error('no data'),{code:'ENODATA'});})).resolves.toEqual({...record,status:'pending'});
});
it('reports resolver failure or malformed answers as unavailable',async()=>{
  await expect(observeDns01(record,async()=>{throw new Error('secret in resolver error');})).resolves.toEqual({...record,status:'unavailable'});
  await expect(observeDns01(record,async()=>[['a'.repeat(256)]])).resolves.toEqual({...record,status:'unavailable'});
  const lookup=vi.fn();
  await expect(observeDns01({...record,name:'_acme-challenge.example.com.'},lookup)).rejects.toMatchObject({code:'invalid_input'});
  expect(lookup).not.toHaveBeenCalled();
});

it('reads a split TXT record through a real isolated DNS resolver',async()=>{
  const server=createSocket('udp4');
  server.on('message',(query,remote)=>{
    const header=Buffer.from(query.subarray(0,12));header.writeUInt16BE(0x8180,2);header.writeUInt16BE(2,6);header.writeUInt16BE(0,8);header.writeUInt16BE(0,10);
    const answer=(parts:string[])=>{
      const data=Buffer.concat(parts.map(part=>Buffer.concat([Buffer.from([Buffer.byteLength(part)]),Buffer.from(part)])));
      const meta=Buffer.alloc(12);meta.writeUInt16BE(0xc00c,0);meta.writeUInt16BE(16,2);meta.writeUInt16BE(1,4);meta.writeUInt32BE(60,6);meta.writeUInt16BE(data.length,10);
      return Buffer.concat([meta,data]);
    };
    const packet=Buffer.concat([header,query.subarray(12),answer(['unrelated']),answer([value.slice(0,20),value.slice(20)])]);
    server.send(packet,remote.port,remote.address);
  });
  server.bind(0,'127.0.0.1');await once(server,'listening');
  try {
    const resolver=new Resolver({timeout:2000,tries:1});resolver.setServers([`127.0.0.1:${server.address().port}`]);
    await expect(observeDns01(record,name=>resolver.resolveTxt(name))).resolves.toEqual({...record,status:'observed'});
  } finally {server.close();}
});
