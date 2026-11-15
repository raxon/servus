import { createServer } from 'node:http';
import { once } from 'node:events';
import { expect, it } from 'vitest';
import { CloudflareDns01Provider } from '../../src/agent/acme/cloudflare.js';

it('creates and removes only its own TXT record through a local HTTP fixture',async()=>{
  const zone='a'.repeat(32), id='b'.repeat(32), other='e'.repeat(32), operationId='c'.repeat(32);
  const value=Buffer.alloc(32,4).toString('base64url'), token='fixture-only-token';
  const records=new Map<string,Record<string,unknown>>([[other,{id:other,type:'TXT',name:'_acme-challenge.example.com',content:'someone-else',comment:'external'}]]);
  const requests:string[]=[];
  const server=createServer(async(req,res)=>{
    requests.push(`${req.method} ${req.url}`);
    if(req.headers.authorization!==`Bearer ${token}`){res.writeHead(403).end();return;}
    const path=`/client/v4/zones/${zone}/dns_records`;
    let result:unknown;
    if(req.method==='POST'&&req.url===path){
      const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
      const body=JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string,unknown>;
      result={...body,id};records.set(id,result as Record<string,unknown>);
    }else if(req.method==='GET'&&req.url===`${path}/${id}`){result=records.get(id);}
    else if(req.method==='DELETE'&&req.url===`${path}/${id}`){records.delete(id);result={id};}
    else {res.writeHead(404).end();return;}
    res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({success:true,result}));
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  try {
    const address=server.address();if(!address||typeof address==='string')throw new Error('Fixture has no TCP address');
    const transport:typeof fetch=(url,init)=>fetch(String(url).replace('https://api.cloudflare.com',`http://127.0.0.1:${address.port}`),init);
    const provider=new CloudflareDns01Provider(zone,'example.com',token,transport);
    const created=await provider.present({operationId,identifier:'*.example.com',value});
    expect(created.status).toBe('awaiting_dns');expect(records.size).toBe(2);
    await expect(provider.remove(created.record)).resolves.toEqual({status:'removed'});
    expect([...records.keys()]).toEqual([other]);
    expect(requests.map(line=>line.split(' ')[0])).toEqual(['POST','GET','DELETE']);
  } finally {server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});
