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
describe('central identity security',()=>{
  it('requires local admin and CSRF to create invitations or modify settings',async()=>{
    const {app,headers}=await fixture();
    expect((await app.inject({url:'/api/v1/auth/central'})).json()).toEqual({connected:false});
    expect((await app.inject({method:'POST',url:'/api/v1/auth/central/invitations',payload:{email:'test@example.test'}})).statusCode).toBe(401);
    expect((await app.inject({method:'DELETE',url:'/api/v1/auth/central',headers:{cookie:headers.cookie}})).statusCode).toBe(403);
    expect((await app.inject({method:'POST',url:'/api/v1/auth/central/pair',headers,payload:{serviceUrl:'http://bad.example',callbackUrl:'https://panel.example.test/api/v1/auth/oidc/callback'}})).statusCode).toBe(400);
  });
  it('stores only a hash of an invitation and revokes central sessions on disconnect',async()=>{
    const {store,app,headers,user}=await fixture();
    store.db.prepare('INSERT INTO central_config VALUES (1,?,?,?,?,?)').run('https://auth.example.test','client',store.vault.seal('secret'),'https://panel.example.test/api/v1/auth/oidc/callback',store.vault.seal('revoke-secret'));
    const result=await app.inject({method:'POST',url:'/api/v1/auth/central/invitations',headers,payload:{email:'Invite@Example.test'}});
    expect(result.statusCode).toBe(200);
    const token=result.json().token;
    expect(store.db.prepare('SELECT token_hash,email FROM central_invitations').get()).toEqual({token_hash:hashToken(token),email:'invite@example.test'});
    const central=store.createSession(user.id,true),local=store.createSession(user.id);
    const row=store.db.prepare('SELECT expires_at AS expires,absolute_expires_at AS absolute FROM sessions WHERE token_hash=?').get(hashToken(central.token)) as {expires:string;absolute:string};
    expect(row.expires).toBe(row.absolute);expect(Date.parse(row.absolute)-Date.now()).toBeLessThanOrEqual(900_000);
    const disconnected=await app.inject({method:'DELETE',url:'/api/v1/auth/central',headers});expect(disconnected.statusCode).toBe(200);expect(disconnected.json().pendingRevocations).toBe(1);
    expect(store.getSession(central.token)).toBeNull();expect(store.getSession(local.token)).not.toBeNull();
    expect(store.db.prepare('SELECT 1 FROM central_invitations WHERE token_hash=?').get(hashToken(token))).toBeUndefined();
  });
  it('rejects unsolicited callbacks before contacting an identity service',async()=>{
    const {app}=await fixture();
    const response=await app.inject({url:`/api/v1/auth/oidc/callback?state=${'a'.repeat(43)}&code=test`});
    expect(response.statusCode).toBe(401);expect(response.json().error.code).toBe('OIDC_STATE');
  });
  it('exposes pending confirmation only to its administrator and invalidates expired trust',async()=>{
    const {app,store,headers,user}=await fixture();
    const credentials={issuer:'https://auth.example.test/api/auth',clientId:'client',clientSecret:'temporary-secret',revokeToken:'temporary-revoke'};
    store.db.prepare('INSERT INTO central_config VALUES (1,?,?,?,?,?)').run(credentials.issuer,credentials.clientId,store.vault.seal(credentials.clientSecret),'https://panel.example.test/api/v1/auth/oidc/callback',store.vault.seal(credentials.revokeToken));
    const until=new Date(Date.now()+60_000).toISOString();
    store.db.prepare('INSERT INTO central_pairings VALUES (?,?,?,?,?,?,?)').run('pending-id','https://auth.example.test','https://panel.example.test/api/v1/auth/oidc/callback',store.vault.seal('pair-secret'),user.id,until,store.vault.seal(JSON.stringify(credentials)));
    expect((await app.inject({url:'/api/v1/auth/central/pending'})).statusCode).toBe(401);
    expect((await app.inject({url:'/api/v1/auth/central/pending',headers})).json()).toEqual({pairingId:'pending-id',expiresAt:until});
    const session=store.createSession(user.id,true);
    store.db.prepare('UPDATE central_pairings SET expires_at=? WHERE id=?').run(new Date(Date.now()-1000).toISOString(),'pending-id');
    expect((await app.inject({url:'/api/v1/auth/central/pending',headers})).json()).toBeNull();
    expect((await app.inject({url:'/api/v1/auth/central'})).json()).toEqual({connected:false});
    expect(store.getSession(session.token)).toBeNull();
    const pending=store.db.prepare('SELECT revoke_token AS token FROM central_pending_revocations WHERE client_id=?').get('client') as {token:string};
    expect(pending.token).not.toContain(credentials.revokeToken);expect(store.vault.open(pending.token)).toBe(credentials.revokeToken);
  });
  it('does not authenticate a user without local credentials through password login',async()=>{
    const {app,store}=await fixture();
    store.db.prepare('INSERT INTO users VALUES (?,?,?,?,?)').run('external-user','external@example.test','external-credentials','member',new Date().toISOString());
    const response=await app.inject({method:'POST',url:'/api/v1/auth/login',payload:{email:'external@example.test',password:'a-long-local-password'}});
    expect(response.statusCode).toBe(401);expect(response.json().error.code).toBe('INVALID_CREDENTIALS');
  });
  it('requires the current session, CSRF and the local password to initiate linking',async()=>{
    const {app,store,headers}=await fixture();
    store.db.prepare('INSERT INTO central_config VALUES (1,?,?,?,?,?)').run('https://auth.example.test/api/auth','client',store.vault.seal('secret'),'https://panel.example.test/api/v1/auth/oidc/callback',store.vault.seal('revoke'));
    expect((await app.inject({url:'/api/v1/auth/central/link/status',headers})).json()).toEqual({linked:false,canLink:true});
    const url='/api/v1/auth/central/link/start';
    expect((await app.inject({method:'POST',url,payload:{password:'a-long-local-password'}})).statusCode).toBe(401);
    expect((await app.inject({method:'POST',url,headers:{cookie:headers.cookie},payload:{password:'a-long-local-password'}})).statusCode).toBe(403);
    const invalid=await app.inject({method:'POST',url,headers,payload:{password:'incorrect-password'}});
    expect(invalid.statusCode).toBe(401);expect(invalid.json().error.code).toBe('INVALID_CREDENTIALS');
    expect((store.db.prepare('SELECT count(*) AS count FROM central_transactions').get() as {count:number}).count).toBe(0);
  });
  it('binds a one-time linking proof to the initiating session and preserves local login',async()=>{
    const {app,store,headers,user}=await fixture();
    const issuer='https://auth.example.test/api/auth',subject='external-subject',proof='q'.repeat(43);
    store.db.prepare('INSERT INTO central_config VALUES (1,?,?,?,?,?)').run(issuer,'client',store.vault.seal('secret'),'https://panel.example.test/api/v1/auth/oidc/callback',store.vault.seal('revoke'));
    const token=headers.cookie.split('=')[1]!;
    store.db.prepare('INSERT INTO central_link_proofs VALUES (?,?,?,?,?,?)').run(hashToken(proof),user.id,hashToken(token),issuer,subject,new Date(Date.now()+60_000).toISOString());
    const otherSession=store.createSession(user.id),otherHeaders={cookie:`panel_session=${otherSession.token}`,'x-csrf-token':otherSession.csrfToken};
    const url='/api/v1/auth/central/link/finish';
    expect((await app.inject({method:'POST',url,headers:otherHeaders,payload:{proof}})).statusCode).toBe(403);
    expect((await app.inject({method:'POST',url,headers:{cookie:headers.cookie},payload:{proof}})).statusCode).toBe(403);
    expect((await app.inject({method:'POST',url,headers,payload:{proof}})).statusCode).toBe(200);
    expect((await app.inject({method:'POST',url,headers,payload:{proof}})).statusCode).toBe(403);
    expect((await app.inject({url:'/api/v1/auth/central/link/status',headers})).json()).toEqual({linked:true,canLink:false});
    const login=await app.inject({method:'POST',url:'/api/v1/auth/login',payload:{email:'admin@example.test',password:'a-long-local-password'}});
    expect(login.statusCode).toBe(200);
  });
  it('rejects an identity linked to another user and consumes the proof',async()=>{
    const {app,store,headers,user}=await fixture();
    const issuer='https://auth.example.test/api/auth',subject='already-linked',proof='r'.repeat(43),other=store.createUser('other@example.test','unused');
    store.db.prepare('INSERT INTO central_config VALUES (1,?,?,?,?,?)').run(issuer,'client',store.vault.seal('secret'),'https://panel.example.test/api/v1/auth/oidc/callback',store.vault.seal('revoke'));
    store.db.prepare('INSERT INTO external_identities VALUES (?,?,?)').run(issuer,subject,other.id);
    store.db.prepare('INSERT INTO central_link_proofs VALUES (?,?,?,?,?,?)').run(hashToken(proof),user.id,hashToken(headers.cookie.split('=')[1]!),issuer,subject,new Date(Date.now()+60_000).toISOString());
    const response=await app.inject({method:'POST',url:'/api/v1/auth/central/link/finish',headers,payload:{proof}});
    expect(response.statusCode).toBe(409);expect(response.json().error.code).toBe('IDENTITY_CONFLICT');
    expect(store.db.prepare('SELECT user_id FROM external_identities WHERE issuer=? AND subject=?').get(issuer,subject)).toEqual({user_id:other.id});
    expect((await app.inject({method:'POST',url:'/api/v1/auth/central/link/finish',headers,payload:{proof}})).statusCode).toBe(403);
  });
  it('rejects expired proofs and proofs from a logged-out session',async()=>{
    const {app,store,headers,user}=await fixture();
    const issuer='https://auth.example.test/api/auth',token=headers.cookie.split('=')[1]!,url='/api/v1/auth/central/link/finish';
    store.db.prepare('INSERT INTO central_config VALUES (1,?,?,?,?,?)').run(issuer,'client',store.vault.seal('secret'),'https://panel.example.test/api/v1/auth/oidc/callback',store.vault.seal('revoke'));
    const expired='s'.repeat(43),loggedOut='t'.repeat(43);
    store.db.prepare('INSERT INTO central_link_proofs VALUES (?,?,?,?,?,?)').run(hashToken(expired),user.id,hashToken(token),issuer,'subject',new Date(Date.now()-1000).toISOString());
    store.db.prepare('INSERT INTO central_link_proofs VALUES (?,?,?,?,?,?)').run(hashToken(loggedOut),user.id,hashToken(token),issuer,'subject',new Date(Date.now()+60_000).toISOString());
    expect((await app.inject({method:'POST',url,headers,payload:{proof:expired}})).statusCode).toBe(403);
    await app.inject({method:'POST',url:'/api/v1/auth/logout',headers});
    expect((await app.inject({method:'POST',url,headers,payload:{proof:loggedOut}})).statusCode).toBe(401);
    expect(store.db.prepare('SELECT 1 FROM external_identities WHERE issuer=?').get(issuer)).toBeUndefined();
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
