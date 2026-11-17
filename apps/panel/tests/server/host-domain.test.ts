import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHmac, randomBytes, randomUUID, X509Certificate } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/server/store.js';
import { createApp } from '../../src/server/app.js';
import { HostDomainManager, generatedApplicationHostname } from '../../src/server/host-domain.js';
import { hashPassword } from '../../src/server/auth.js';
import { hostDomainPattern, hostConnectionSchema, isHostApplication, type HostCertificate, type HostConnection } from '../../src/shared/host-domain.js';

const host='abc123.host.servus.run',password='host-domain-test-password';
const cleanup:(()=>Promise<void>|void)[]=[];
afterEach(async()=>{for(const fn of cleanup.splice(0).reverse())await fn();});
let certificate:HostCertificate;
beforeAll(()=>{
  const dir=mkdtempSync(join(tmpdir(),'host-cert-fixture-'));
  try {
    execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(dir,'key'),'-out',join(dir,'cert'),'-days','60','-subj',`/CN=${host}`,'-addext',`subjectAltName=DNS:${host},DNS:*.${host}`],{stdio:'ignore'});
    const pem=readFileSync(join(dir,'cert'),'utf8');
    certificate={hostname:host,certificate:pem,privateKey:readFileSync(join(dir,'key'),'utf8'),expiresAt:new Date(new X509Certificate(pem).validTo).toISOString(),staging:false};
  } finally {rmSync(dir,{recursive:true,force:true});}
});
async function fixture(registered=false) {
  const dir=mkdtempSync(join(tmpdir(),'panel-host-')),store=new Store(dir);
  cleanup.push(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const admin=store.setup('host-admin@example.test',await hashPassword(password)),session=store.createSession(admin.id);
  const connection:HostConnection={kind:'servus-host-v1',machineId:randomUUID(),token:randomBytes(32).toString('base64url'),apiOrigin:'https://api.servus.run',enabled:true,ready:true,hostname:host,certificateExpiresAt:certificate.expiresAt};
  if(registered)store.vault.setHostConnection(connection);
  return {dir,store,admin,connection,headers:{cookie:`panel_session=${session.token}`,'x-csrf-token':session.csrfToken}};
}

it('accepts six-character host names and persisted legacy names while rejecting other label lengths',async()=>{
  const {connection}=await fixture();
  for(const label of ['abc123','1234567890abcdef']) {
    const hostname=`${label}.host.servus.run`;
    expect(hostDomainPattern.test(hostname)).toBe(true);
    expect(hostConnectionSchema.parse({...connection,hostname}).hostname).toBe(hostname);
    expect(isHostApplication(`project-web.${hostname}`,hostname)).toBe(true);
  }
  for(const label of ['abc12','abc1234','abc123456789012','abc12345678901234'])expect(hostDomainPattern.test(`${label}.host.servus.run`)).toBe(false);
});

describe('host domain synchronization',()=>{
  it('persists credentials before sending and retries a lost registration response with the same identity',async()=>{
    const {store,dir}=await fixture(),requests:{machineId:string;authorization:string|null}[]=[];
    let failed=false;
    const transport=vi.fn(async(input:any,init:any)=>{
      if(String(input).endsWith('/register')) {
        requests.push({machineId:JSON.parse(init.body).machineId,authorization:init.headers.authorization});
        expect(store.vault.hostConnection()?.machineId).toBe(requests.at(-1)!.machineId);
        if(!failed){failed=true;throw new Error('response lost');}
        return Response.json({hostname:host,ip:'8.8.8.8',dnsStatus:'ready'});
      }
      return Response.json({status:'pending',retryAfter:60},{status:202});
    }) as unknown as typeof fetch;
    const manager=new HostDomainManager(store,{apiOrigin:'https://api.servus.run',fetch:transport},async()=>({ok:true}),()=>{});
    manager.start(true);await manager.settled();expect(manager.status().lastError).toContain('reached securely');
    manager.start(true);await manager.settled();expect(requests).toHaveLength(2);expect(requests[0]).toEqual(requests[1]);
    expect(manager.status()).toMatchObject({hostname:host,ready:false,dnsStatus:'ready'});
    const saved=store.vault.hostConnection()!;expect(store.vault.redact(`token=${saved.token}`)).toBe('token=[REDACTED]');
    expect(readFileSync(join(dir,'secrets','bd1e8899-6ba3-4e5e-bd51-b63bbb5010b9'),'utf8')).not.toContain(saved.token);
  });
  it('marks the panel ready only after certificate installation and an authenticated public proof',async()=>{
    const {store}=await fixture(),origins:string[]=[];let manager:HostDomainManager;
    const transport=(async(input:any)=>{
      const url=String(input);
      if(url.endsWith('/register'))return Response.json({hostname:host,ip:'8.8.8.8',dnsStatus:'ready'});
      if(url.endsWith('/certificate'))return Response.json({status:'ready',...certificate});
      const challenge=url.split('/').at(-1)!;
      return Response.json({proof:manager.proof(challenge)});
    }) as typeof fetch;
    const runtime=vi.fn(async()=>({ok:true}));
    manager=new HostDomainManager(store,{apiOrigin:'https://api.servus.run',fetch:transport},runtime,origin=>origins.push(origin));
    manager.start(true);manager.start(true);await manager.settled();
    expect(manager.status()).toMatchObject({ready:true,hostname:host,certificateExpiresAt:certificate.expiresAt});
    expect(runtime).toHaveBeenCalledTimes(1);expect(runtime).toHaveBeenCalledWith('/host-domain/configure',certificate,{timeoutMs:400_000});
    expect(origins).toEqual([`https://${host}`]);
    const challenge='a'.repeat(64),saved=store.vault.hostConnection()!;
    expect(manager.proof(challenge)).toBe(createHmac('sha256',saved.token).update(`servus-host-proof:${challenge}`).digest('hex'));
  });
  it('retains a pending state when public HTTPS reaches a different panel',async()=>{
    const {store}=await fixture();
    const transport=(async(input:any)=>String(input).endsWith('/register')?Response.json({hostname:host,ip:'8.8.8.8',dnsStatus:'ready'}):String(input).endsWith('/certificate')?Response.json({status:'ready',...certificate}):Response.json({proof:'wrong-panel'})) as typeof fetch;
    const manager=new HostDomainManager(store,{apiOrigin:'https://api.servus.run',fetch:transport},async()=>({ok:true}),()=>{});
    manager.start(true);await manager.settled();expect(manager.status().ready).toBe(false);expect(manager.status().lastError).toContain('verified');
  });
  it('refuses API changes before transmitting persisted credentials',async()=>{
    const {store}=await fixture(true),transport=vi.fn();
    const manager=new HostDomainManager(store,{apiOrigin:'https://other.example.test',fetch:transport as typeof fetch},async()=>({ok:true}),()=>{});
    expect(()=>manager.start(true)).toThrow('original host domain API');expect(transport).not.toHaveBeenCalled();
  });
});

describe('panel host-domain API and generated application domains',()=>{
  it('keeps credentials private, requires administrator and CSRF, and secures host cookies',async()=>{
    const {store,dir,connection,headers}=await fixture(true),app=await createApp({dataDir:dir,store});cleanup.push(()=>app.close());
    const status=await app.inject({url:'/api/v1/host-domain',headers});expect(status.statusCode).toBe(200);expect(status.body).not.toContain(connection.token);expect(status.body).not.toContain(connection.machineId);
    expect((await app.inject({method:'POST',url:'/api/v1/host-domain/sync',headers:{cookie:headers.cookie},payload:{}})).statusCode).toBe(403);
    const member=store.createUser('host-member@example.test','unused-hash'),session=store.createSession(member.id);
    expect((await app.inject({method:'POST',url:'/api/v1/host-domain/sync',headers:{cookie:`panel_session=${session.token}`,'x-csrf-token':session.csrfToken},payload:{}})).statusCode).toBe(403);
    const login=await app.inject({method:'POST',url:'/api/v1/auth/login',headers:{host,origin:`https://${host}`},payload:{email:'host-admin@example.test',password}});
    expect(login.statusCode).toBe(200);expect(login.headers['set-cookie']).toContain('Secure');expect(login.headers['set-cookie']).not.toContain('Domain=');
    const explicitPort=await app.inject({method:'POST',url:'/api/v1/auth/login',headers:{host:`${host.toUpperCase()}:443`,origin:`https://${host}`},payload:{email:'host-admin@example.test',password}});expect(explicitPort.headers['set-cookie']).toContain('Secure');
    expect((await app.inject({method:'POST',url:'/api/v1/auth/login',headers:{host,origin:`https://evil.${host}`},payload:{email:'host-admin@example.test',password}})).statusCode).toBe(403);
  });
  it('generates HTTPS domains on the server, preserves idempotency and explicit private or custom routing',async()=>{
    const {store,dir,headers}=await fixture(true),app=await createApp({dataDir:dir,store});cleanup.push(()=>app.close());
    const project=store.createProject('project');
    const create=(input:unknown,key:string)=>app.inject({method:'POST',url:`/api/v1/projects/${project.id}/services`,headers:{...headers,'idempotency-key':key},payload:input});
    const input={name:'api',image:'nginx:alpine',port:3000};
    const first=await create(input,'auto');expect(first.statusCode).toBe(202);expect(first.json().service.domains).toEqual([{hostname:`project-api.${host}`,port:3000,primary:true,https:true}]);
    expect((await create(input,'auto')).json().action.id).toBe(first.json().action.id);
    const privateService=await create({...input,name:'private',domains:[]},'private');expect(privateService.json().service.domains).toEqual([]);
    expect((await create({...input,name:'custom',hostname:'custom.example.test'},'custom')).json().service.hostname).toBe('custom.example.test');
    expect((await create({...input,name:'panel',hostname:host},'reserved')).statusCode).toBe(403);
    expect((await create({...input,name:'foreign',hostname:'web.abcdef1234567890.host.servus.run'},'foreign')).statusCode).toBe(403);
    const update=await app.inject({method:'PATCH',url:`/api/v1/services/${first.json().service.id}`,headers,payload:{expectedRevision:1,domains:[{hostname:host,port:3000}]}});expect(update.statusCode).toBe(403);
    const long=generatedApplicationHostname('a'.repeat(63),'b'.repeat(63),host);expect(long.split('.')[0]!.length).toBeLessThanOrEqual(63);expect(long).not.toBe(generatedApplicationHostname('a'.repeat(63),'c'.repeat(63),host));
  });
});
