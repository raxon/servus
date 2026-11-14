import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/server/app.js';
import { Store } from '../../src/server/store.js';
import { loadTrustedProxySecret, normalizeClientAddress } from '../../src/server/proxy-address.js';

const cleanup: (()=>Promise<void>)[]=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
async function fixture(secret?:string) {
  const dir=mkdtempSync(join(tmpdir(),'panel-proxy-')),store=new Store(dir);
  const app=await createApp({dataDir:dir,store,trustedProxySecret:secret});
  cleanup.push(async()=>{await app.close();store.close();rmSync(dir,{recursive:true,force:true});});
  return app;
}
const secret='a'.repeat(64),otherSecret='b'.repeat(64);
async function login(app:Awaited<ReturnType<typeof createApp>>,headers:Record<string,string>,remoteAddress='127.0.0.1') {
  return app.inject({method:'POST',url:'/api/v1/auth/login',headers,remoteAddress,payload:{email:'unknown@example.test',password:'synthetic-password'}});
}

describe('trusted proxy address',()=>{
  it('uses separate authenticated client addresses for rate limits',async()=>{
    const app=await fixture(secret), headers={'x-servus-proxy-secret':secret,'x-servus-client-ip':'192.0.2.10'};
    for(let i=0;i<10;i++)expect((await login(app,headers)).statusCode).toBe(401);
    expect((await login(app,headers)).statusCode).toBe(429);
    expect((await login(app,{...headers,'x-servus-client-ip':'192.0.2.11'})).statusCode).toBe(401);
  });
  it('ignores spoofed addresses and forwarded-for without a matching secret',async()=>{
    for(const configured of [undefined,secret]) {
      const app=await fixture(configured);
      for(let i=0;i<10;i++) {
        const headers={'x-servus-proxy-secret':otherSecret,'x-servus-client-ip':`192.0.2.${i+1}`,'x-forwarded-for':`198.51.100.${i+1}`};
        expect((await login(app,headers)).statusCode).toBe(401);
      }
      expect((await login(app,{'x-forwarded-for':'203.0.113.100','x-servus-client-ip':'203.0.113.100'})).statusCode).toBe(429);
      expect((await login(app,{},'127.0.0.2')).statusCode).toBe(401);
    }
  });
  it('rejects malformed client addresses only for authenticated proxies',async()=>{
    const app=await fixture(secret);
    for(const value of ['', '192.0.2.1, 192.0.2.2', '192.0.2.1:123', '[::1]', 'fe80::1%en0', ' 192.0.2.1', 'invalid']) {
      const result=await login(app,{'x-servus-proxy-secret':secret,'x-servus-client-ip':value});
      expect(result.statusCode).toBe(400);expect(result.body).not.toContain(secret);
    }
    expect((await login(app,{'x-servus-proxy-secret':secret})).statusCode).toBe(400);
    expect((await login(app,{'x-servus-proxy-secret':otherSecret,'x-servus-client-ip':'invalid'})).statusCode).toBe(401);
  });
  it('canonicalizes IPv6 and mapped IPv4 consistently for the same limit bucket',async()=>{
    expect(normalizeClientAddress('2001:0DB8:0:0:0:0:0:1')).toBe('2001:db8::1');
    expect(normalizeClientAddress('::ffff:192.0.2.1')).toBe('192.0.2.1');
    expect(normalizeClientAddress('::ffff:c000:201')).toBe('192.0.2.1');
    expect(normalizeClientAddress('fe80::1%en0')).toBeUndefined();
    const app=await fixture(secret),headers={'x-servus-proxy-secret':secret,'x-servus-client-ip':'::ffff:192.0.2.1'};
    for(let i=0;i<10;i++)expect((await login(app,headers)).statusCode).toBe(401);
    expect((await login(app,{...headers,'x-servus-client-ip':'192.0.2.1'})).statusCode).toBe(429);
  });
  it('loads a single secret source and rejects unsafe files',()=>{
    const dir=mkdtempSync(join(tmpdir(),'panel-proxy-secret-'));cleanup.push(async()=>rmSync(dir,{recursive:true,force:true}));
    const path=join(dir,'secret'),link=join(dir,'link');
    writeFileSync(path,secret+'\n',{mode:0o600});expect(loadTrustedProxySecret({PANEL_TRUSTED_PROXY_SECRET_FILE:path})).toBe(secret);
    expect(loadTrustedProxySecret({PANEL_TRUSTED_PROXY_SECRET:secret})).toBe(secret);
    expect(loadTrustedProxySecret({})).toBeUndefined();
    expect(loadTrustedProxySecret({PANEL_TRUSTED_PROXY_SECRET:''})).toBeUndefined();
    expect(loadTrustedProxySecret({PANEL_TRUSTED_PROXY_SECRET:'',PANEL_TRUSTED_PROXY_SECRET_FILE:path})).toBe(secret);
    expect(()=>loadTrustedProxySecret({PANEL_TRUSTED_PROXY_SECRET:secret,PANEL_TRUSTED_PROXY_SECRET_FILE:path})).toThrow();
    expect(()=>loadTrustedProxySecret({PANEL_TRUSTED_PROXY_SECRET:'short'})).toThrow();
    symlinkSync(path,link);expect(()=>loadTrustedProxySecret({PANEL_TRUSTED_PROXY_SECRET_FILE:link})).toThrow();
    chmodSync(path,0o644);expect(()=>loadTrustedProxySecret({PANEL_TRUSTED_PROXY_SECRET_FILE:path})).toThrow();
  });
});
