import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/server/app.js';
import { Store } from '../../src/server/store.js';
import { hashPassword } from '../../src/server/auth.js';

const id='12345678-1234-4123-8123-123456789abc';
const release={operationId:id,commit:'a'.repeat(40),digest:`sha256:${'b'.repeat(64)}`,tag:'v1.2.3'};
const cleanups:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0).reverse())await cleanup();});
async function fixture(withSocket=false) {
  const dir=mkdtempSync(join(tmpdir(),'servus-update-api-')),store=new Store(dir),socketPath=join(dir,'updater.sock');
  const app=await createApp({dataDir:dir,store,updaterSocketPath:withSocket?socketPath:undefined});
  cleanups.push(async()=>{await app.close();store.close();rmSync(dir,{recursive:true,force:true});});
  const setup=await app.inject({method:'POST',url:'/api/v1/setup',payload:{email:'admin@example.test',password:'12345678'}});
  const token=setup.cookies.find(c=>c.name==='panel_session')!.value;
  const headers={cookie:`panel_session=${token}`,'x-csrf-token':setup.json().csrfToken as string};
  const user=store.createUser('member@example.test',await hashPassword('12345678'));
  const session=store.createSession(user.id);
  const member={cookie:`panel_session=${session.token}`,'x-csrf-token':session.csrfToken};
  return {app,headers,member,socketPath};
}
async function serve(path:string, response:unknown, requests:string[]):Promise<void> {
  const server:Server=createServer(socket=>{
    let input='';socket.on('data',chunk=>{input+=chunk.toString();if(input.includes('\n')){requests.push(input);socket.end(JSON.stringify(response)+'\n');}});
  });
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(path,resolve);});
  cleanups.push(async()=>{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));});
}

describe('update management API',()=>{
  it('requires an administrator and exposes only the configured status capability',async()=>{
    const {app,headers,member}=await fixture();
    expect((await app.inject({url:'/api/v1/updates'})).statusCode).toBe(401);
    expect((await app.inject({url:'/api/v1/updates',headers:member})).statusCode).toBe(403);
    expect((await app.inject({url:'/api/v1/updates',headers})).json()).toEqual({applyAvailable:false,verificationStatusConfigured:false});
    expect((await app.inject({url:`/api/v1/updates/${id}`,headers})).statusCode).toBe(503);
  });
  it('reads the exact operation from a configured helper and handles missing/offline results',async()=>{
    const {app,headers,socketPath}=await fixture(true),requests:string[]=[];
    const unavailable=await app.inject({url:`/api/v1/updates/${id}`,headers});
    expect(unavailable.statusCode).toBe(503);
    expect((await app.inject({url:'/api/v1/updates/not-a-uuid',headers})).statusCode).toBe(400);
    await serve(socketPath,{ok:true,operation:{...release,status:'verified',createdAt:'2026-11-14 12:00:00'}},requests);
    const response=await app.inject({url:`/api/v1/updates/${id}`,headers});
    expect(response.statusCode).toBe(200);
    expect(response.json().operation).toEqual({...release,status:'verified',createdAt:'2026-11-14 12:00:00'});
    expect(JSON.parse(requests[0]!)).toEqual({version:1,action:'status',operationId:id});
  });
  it('hides operation details from non-administrators and maps missing operations safely',async()=>{
    const {app,headers,member,socketPath}=await fixture(true),requests:string[]=[];
    await serve(socketPath,{ok:false,error:'not_found'},requests);
    expect((await app.inject({url:`/api/v1/updates/${id}`,headers:member})).statusCode).toBe(403);
    expect(requests).toEqual([]);
    const response=await app.inject({url:`/api/v1/updates/${id}`,headers});
    expect(response.statusCode).toBe(404);expect(response.json().error.code).toBe('NOT_FOUND');
    expect(requests).toHaveLength(1);
  });
  it('rejects unprivileged, foreign-origin, missing-CSRF and invalid mutation attempts without contacting the helper',async()=>{
    const {app,headers,member,socketPath}=await fixture(true),requests:string[]=[];
    await serve(socketPath,{ok:false,error:'unavailable'},requests);
    const request={method:'POST' as const,url:'/api/v1/updates',payload:release};
    expect((await app.inject(request)).statusCode).toBe(401);
    expect((await app.inject({...request,headers:member})).statusCode).toBe(403);
    expect((await app.inject({...request,headers:{cookie:headers.cookie}})).statusCode).toBe(403);
    expect((await app.inject({...request,headers:{...headers,origin:'https://attacker.example'}})).statusCode).toBe(403);
    expect((await app.inject({...request,headers,payload:{...release,digest:'invalid'}})).statusCode).toBe(400);
    const refused=await app.inject({...request,headers});
    expect(refused.statusCode).toBe(503);expect(refused.json().error.code).toBe('UPDATE_UNAVAILABLE');
    expect((await app.inject({method:'POST',url:`/api/v1/updates/${id}/retry`,headers,payload:{}})).statusCode).toBe(503);
    expect(requests).toEqual([]);
  });
  it('limits repeated submit requests without contacting a helper',async()=>{
    const {app,headers,socketPath}=await fixture(true),requests:string[]=[];
    await serve(socketPath,{ok:false,error:'unavailable'},requests);
    for(let i=0;i<5;i++)expect((await app.inject({method:'POST',url:'/api/v1/updates',headers,payload:release})).statusCode).toBe(503);
    expect((await app.inject({method:'POST',url:'/api/v1/updates',headers,payload:release})).statusCode).toBe(429);
    expect(requests).toEqual([]);
  });
});
