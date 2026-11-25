import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/server/app.js';
import { Store, hashToken } from '../../src/server/store.js';

const cleanups:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0))await cleanup();});
async function fixture() {
  const dir=mkdtempSync(join(tmpdir(),'panel-central-')),store=new Store(dir);
  const app=await createApp({dataDir:dir,store,allowedOrigins:['https://panel.example.test'],secureCookies:true});
  cleanups.push(async()=>{await app.close();store.close();rmSync(dir,{recursive:true,force:true});});
  const setup=await app.inject({method:'POST',url:'/api/v1/setup',payload:{email:'admin@example.test',password:'a-long-local-password'}});
  const headers={cookie:`panel_session=${setup.cookies[0]!.value}`,'x-csrf-token':setup.json().csrfToken};
  return {store,app,headers,user:setup.json().user};
}
describe('central sign-in removal',()=>{
  it('does not expose central settings, pairing, linking, invitations or OIDC callbacks',async()=>{
    const {app,headers}=await fixture();
    const routes=[
      ['GET','/api/v1/auth/central'],
      ['DELETE','/api/v1/auth/central'],
      ['GET','/api/v1/auth/central/pending'],
      ['POST','/api/v1/auth/central/pair'],
      ['POST','/api/v1/auth/central/redeem'],
      ['GET','/api/v1/auth/central/revocations'],
      ['POST','/api/v1/auth/central/retry-revocations'],
      ['POST','/api/v1/auth/central/invitations'],
      ['GET','/api/v1/auth/central/link/status'],
      ['POST','/api/v1/auth/central/link/start'],
      ['POST','/api/v1/auth/central/link/finish'],
      ['POST','/api/v1/auth/central/start'],
      ['GET',`/api/v1/auth/oidc/callback?state=${'a'.repeat(43)}&code=test`],
    ] as const;
    for(const [method,url] of routes) {
      for(const requestHeaders of [{},headers]) {
        const response=await app.inject({method,url,headers:requestHeaders});
        expect(response.statusCode,`${method} ${url}`).toBe(404);
        expect(response.headers.location).toBeUndefined();
        expect(response.cookies).toEqual([]);
      }
    }
  });
  it('preserves existing identities, configuration, project access and sessions',async()=>{
    const {store,app,headers,user}=await fixture();
    const issuer='https://auth.example.test';
    store.db.prepare('INSERT INTO central_config VALUES (1,?,?,?,?,?)').run(issuer,'client',store.vault.seal('secret'),'https://panel.example.test/api/v1/auth/oidc/callback',store.vault.seal('revoke-secret'));
    store.db.prepare('INSERT INTO external_identities VALUES (?,?,?)').run(issuer,'subject',user.id);
    const project=store.createProject('existing-project');
    const central=store.createSession(user.id,true);
    const sessionBefore=store.db.prepare('SELECT * FROM sessions WHERE token_hash=?').get(hashToken(central.token));
    const configBefore=store.db.prepare('SELECT * FROM central_config').get();
    for(const request of [
      {method:'DELETE',url:'/api/v1/auth/central'},
      {method:'POST',url:'/api/v1/auth/central/start'},
      {method:'GET',url:'/api/v1/auth/oidc/callback?state=old-state&code=old-code'},
    ] as const)expect((await app.inject({...request,headers})).statusCode).toBe(404);
    expect(store.db.prepare('SELECT * FROM central_config').get()).toEqual(configBefore);
    expect(store.db.prepare('SELECT * FROM external_identities').get()).toEqual({issuer,subject:'subject',user_id:user.id});
    expect(store.db.prepare('SELECT * FROM sessions WHERE token_hash=?').get(hashToken(central.token))).toEqual(sessionBefore);
    for(const cookie of [headers.cookie,`panel_session=${central.token}`]) {
      expect((await app.inject({url:'/api/v1/auth/session',headers:{cookie}})).json().user.id).toBe(user.id);
      expect((await app.inject({url:`/api/v1/projects/${project.id}`,headers:{cookie}})).statusCode).toBe(200);
    }
    const login=await app.inject({method:'POST',url:'/api/v1/auth/login',payload:{email:'admin@example.test',password:'a-long-local-password'}});
    expect(login.statusCode).toBe(200);
    expect(login.json().user.id).toBe(user.id);
    expect((await app.inject({url:'/api/v1/auth/password',headers})).json()).toEqual({available:true});
  });
  it('does not fabricate local credentials for an existing externally provisioned account',async()=>{
    const {app,store}=await fixture();
    store.db.prepare('INSERT INTO users VALUES (?,?,?,?,?)').run('external-user','external@example.test','external-credentials','member',new Date().toISOString());
    store.db.prepare('INSERT INTO external_identities VALUES (?,?,?)').run('https://auth.example.test','external-subject','external-user');
    const response=await app.inject({method:'POST',url:'/api/v1/auth/login',payload:{email:'external@example.test',password:'a-long-local-password'}});
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('INVALID_CREDENTIALS');
    expect(store.db.prepare('SELECT 1 FROM local_credentials WHERE user_id=?').get('external-user')).toBeUndefined();
    expect(store.db.prepare('SELECT user_id FROM external_identities WHERE subject=?').get('external-subject')).toEqual({user_id:'external-user'});
  });
  it('lets only administrators grant and revoke project membership',async()=>{
    const {store,app,headers}=await fixture();
    const user=store.createUser('member@example.test','unused'),project=store.createProject('project');
    const memberSession=store.createSession(user.id),memberHeaders={cookie:`panel_session=${memberSession.token}`,'x-csrf-token':memberSession.csrfToken};
    const url=`/api/v1/projects/${project.id}/members/${user.id}`;
    expect((await app.inject({method:'PUT',url,headers:memberHeaders,payload:{role:'editor'}})).statusCode).toBe(403);
    expect((await app.inject({method:'PUT',url,headers:{cookie:headers.cookie},payload:{role:'editor'}})).statusCode).toBe(403);
    expect((await app.inject({method:'PUT',url,headers,payload:{role:'editor'}})).statusCode).toBe(200);
    expect((await app.inject({url:`/api/v1/projects/${project.id}`,headers:memberHeaders})).statusCode).toBe(200);
    expect((await app.inject({method:'DELETE',url,headers})).statusCode).toBe(200);
    expect((await app.inject({url:`/api/v1/projects/${project.id}`,headers:memberHeaders})).statusCode).toBe(404);
  });
});
