import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/server/app.js';
import { hashPassword, verifyPassword } from '../../src/server/auth.js';
import { Store } from '../../src/server/store.js';

const cleanups: (()=>Promise<void>)[]=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0))await cleanup();});
async function fixture() {
  const dir=mkdtempSync(join(tmpdir(),'panel-password-')),store=new Store(dir),app=await createApp({dataDir:dir,store});
  cleanups.push(async()=>{await app.close();store.close();rmSync(dir,{recursive:true,force:true});});
  const setup=await app.inject({method:'POST',url:'/api/v1/setup',payload:{email:'admin@example.test',password:'old-password'}});
  const token=setup.cookies.find(cookie=>cookie.name==='panel_session')!.value;
  const headers={cookie:`panel_session=${token}`,'x-csrf-token':setup.json().csrfToken};
  return {store,app,headers,token,user:setup.json().user};
}
const payload={currentPassword:'old-password',newPassword:'new-password'};

describe('local password changes',()=>{
  it('changes credentials atomically, retains this session and revokes other local and central sessions',async()=>{
    const {store,app,headers,user}=await fixture();
    const local=store.createSession(user.id),central=store.createSession(user.id,true);
    expect((await app.inject({url:'/api/v1/auth/password',headers})).json()).toEqual({available:true});
    expect((await app.inject({method:'POST',url:'/api/v1/auth/password',headers,payload})).statusCode).toBe(200);
    expect((await app.inject({url:'/api/v1/auth/session',headers})).statusCode).toBe(200);
    for(const token of [local.token,central.token]) expect((await app.inject({url:'/api/v1/auth/session',headers:{cookie:`panel_session=${token}`}})).statusCode).toBe(401);
    expect((await app.inject({method:'POST',url:'/api/v1/auth/login',payload:{email:user.email,password:'old-password'}})).statusCode).toBe(401);
    expect((await app.inject({method:'POST',url:'/api/v1/auth/login',payload:{email:user.email,password:'new-password'}})).statusCode).toBe(200);
    const row=store.findUser(user.email)!;
    expect(row.passwordHash).not.toContain('new-password');
    expect(await verifyPassword('new-password',row.passwordHash)).toBe(true);
  });
  it('requires local authentication, CSRF, same origin, correct current password and 8 characters',async()=>{
    const {store,app,headers,user}=await fixture();
    const request={method:'POST' as const,url:'/api/v1/auth/password',payload};
    expect((await app.inject(request)).statusCode).toBe(401);
    expect((await app.inject({...request,headers:{cookie:headers.cookie}})).statusCode).toBe(403);
    expect((await app.inject({...request,headers:{...headers,origin:'https://attacker.test'}})).statusCode).toBe(403);
    expect((await app.inject({...request,headers,payload:{...payload,newPassword:'1234567'}})).statusCode).toBe(400);
    expect((await app.inject({...request,headers,payload:{...payload,currentPassword:'wrong-password'}})).statusCode).toBe(401);
    const central=store.createSession(user.id,true),centralHeaders={cookie:`panel_session=${central.token}`,'x-csrf-token':central.csrfToken};
    expect((await app.inject({url:'/api/v1/auth/password',headers:centralHeaders})).json()).toEqual({available:false});
    expect((await app.inject({...request,headers:centralHeaders})).statusCode).toBe(403);
    expect(await verifyPassword('old-password',store.findUser(user.email)!.passwordHash)).toBe(true);
  });
  it('rate limits password verification',async()=>{
    const {app,headers}=await fixture();
    for(let index=0;index<5;index++)expect((await app.inject({method:'POST',url:'/api/v1/auth/password',headers,payload:{...payload,currentPassword:'incorrect'}})).statusCode).toBe(401);
    expect((await app.inject({method:'POST',url:'/api/v1/auth/password',headers,payload})).statusCode).toBe(429);
  });
  it('allows one concurrent password change and prevents stale verified logins',async()=>{
    const {store,app,headers,user}=await fixture();
    const oldHash=store.findUser(user.email)!.passwordHash;
    const results=await Promise.all(['first-new','second-new'].map(newPassword=>app.inject({method:'POST',url:'/api/v1/auth/password',headers,payload:{currentPassword:'old-password',newPassword}})));
    expect(results.map(result=>result.statusCode).sort()).toEqual([200,409]);
    expect(store.createLocalSession(user.id,oldHash)).toBeNull();
    expect(await verifyPassword('old-password',store.findUser(user.email)!.passwordHash)).toBe(false);
  });
  it('does not modify a user without local credentials',async()=>{
    const {store,app,user}=await fixture();
    store.db.prepare('DELETE FROM local_credentials WHERE user_id=?').run(user.id);
    const central=store.createSession(user.id,true),headers={cookie:`panel_session=${central.token}`,'x-csrf-token':central.csrfToken};
    expect((await app.inject({url:'/api/v1/auth/password',headers})).json()).toEqual({available:false});
    expect((await app.inject({method:'POST',url:'/api/v1/auth/password',headers,payload})).statusCode).toBe(403);
  });
});
