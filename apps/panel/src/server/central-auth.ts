import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import * as oidc from 'openid-client';
import { z } from 'zod';
import type { User } from '../shared/types.js';
import { AppError } from './errors.js';
import { hashToken, type Store } from './store.js';
import { verifyPassword } from './auth.js';

const prefix='/api/v1/auth/central';
const callbackPath='/api/v1/auth/oidc/callback';
const temporaryCookie='panel_oidc';
const random=()=>randomBytes(32).toString('base64url');
const expires=(ms:number)=>new Date(Date.now()+ms).toISOString();
const urlSchema=z.string().url().max(2048).refine(value=>{
  const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.search&&!u.hash&&!u.hostname.includes('*');
},'An HTTPS URL without credentials, query or fragment is required');
const pairingResponse=z.object({pairingId:z.string().min(1).max(256),approvalUrl:urlSchema,expiresAt:z.string().datetime()});
const credentialResponse=z.object({issuer:urlSchema,clientId:z.string().min(1).max(512),clientSecret:z.string().min(1).max(2048),revokeToken:z.string().min(1).max(2048)});
type CentralConfig={issuer:string;clientId:string;clientSecret:string;callbackUrl:string};
type AuthResult={user:User;csrfToken:string};
interface Options {store:Store;allowedOrigins:Set<string>;secureCookies:boolean;session:(request:FastifyRequest,mutation?:boolean)=>AuthResult;setSession:(reply:FastifyReply,user:User,central?:boolean)=>unknown}

async function postJson(url:string,body:unknown) {
  const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(8000)});
  if(response.status===202)throw new AppError('PAIRING_PENDING','Pairing has not been approved yet',409);
  if(!response.ok)throw new AppError('CENTRAL_UNAVAILABLE','Central identity service rejected the request',502);
  if(Number(response.headers.get('content-length')??0)>65536)throw new AppError('CENTRAL_RESPONSE','Invalid central service response',502);
  return response.json();
}
function requireAdmin(options:Options,req:FastifyRequest) {
  const auth=options.session(req,true);
  if(auth.user.role!=='admin')throw new AppError('FORBIDDEN','Administrator access required',403);
  return auth.user;
}
function config(store:Store):CentralConfig {
  const row=store.db.prepare('SELECT issuer,client_id AS clientId,client_secret AS clientSecret,callback_url AS callbackUrl FROM central_config WHERE id=1').get() as CentralConfig|undefined;
  if(!row)throw new AppError('CENTRAL_NOT_CONFIGURED','Central sign in is not configured',409);
  return {...row,clientSecret:store.vault.open(row.clientSecret)};
}
async function discover(c:CentralConfig) {
  const origin=new URL(c.issuer).origin;
  const safeFetch:oidc.CustomFetch=async (input,init)=>{
    const u=new URL(input);
    if(u.protocol!=='https:'||u.origin!==origin||u.username||u.password)throw new Error('Untrusted OIDC endpoint');
    return fetch(input,{...(init as unknown as RequestInit),redirect:'error',signal:AbortSignal.timeout(8000)});
  };
  let result:oidc.Configuration;
  try { result=await oidc.discovery(new URL(c.issuer),c.clientId,c.clientSecret,oidc.ClientSecretBasic(c.clientSecret),{execute:[oidc.enableNonRepudiationChecks],[oidc.customFetch]:safeFetch}); }
  catch { throw new AppError('CENTRAL_UNAVAILABLE','Central identity service is unavailable',502); }
  const meta=result.serverMetadata();
  for(const endpoint of [meta.authorization_endpoint,meta.token_endpoint,meta.jwks_uri,meta.userinfo_endpoint]) {
    if(!endpoint||new URL(endpoint).origin!==origin||new URL(endpoint).protocol!=='https:')throw new AppError('CENTRAL_RESPONSE','Invalid central service metadata',502);
  }
  return result;
}
export function registerCentralAuth(app:FastifyInstance,options:Options) {
  const {store}=options;
  function expireUnconfirmed() {
    const rows=store.db.prepare('SELECT id,service_url AS serviceUrl,redeemed_credentials AS credentials FROM central_pairings WHERE expires_at<=? AND redeemed_credentials IS NOT NULL').all(new Date().toISOString()) as {id:string;serviceUrl:string;credentials:string}[];
    store.db.transaction(()=>{
      for(const row of rows) {
        const credentials=credentialResponse.parse(JSON.parse(store.vault.open(row.credentials)));
        store.db.prepare('INSERT OR REPLACE INTO central_pending_revocations VALUES (?,?,?)').run(credentials.clientId,row.serviceUrl,store.vault.seal(credentials.revokeToken));
        const current=store.db.prepare('SELECT client_id AS clientId FROM central_config WHERE id=1').get() as {clientId:string}|undefined;
        if(current?.clientId===credentials.clientId) {
          store.db.prepare('DELETE FROM sessions WHERE token_hash IN (SELECT token_hash FROM central_sessions)').run();
          store.db.prepare('DELETE FROM central_config').run();
          store.db.prepare('DELETE FROM central_invitations WHERE used_at IS NULL').run();
        }
        store.db.prepare('DELETE FROM central_pairings WHERE id=?').run(row.id);
      }
    })();
  }
  app.get(prefix,async()=>{expireUnconfirmed();return {connected:!!store.db.prepare('SELECT 1 FROM central_config WHERE id=1').get()};});
  app.get(`${prefix}/pending`,async req=>{
    const auth=options.session(req);
    if(auth.user.role!=='admin')throw new AppError('FORBIDDEN','Administrator access required',403);
    expireUnconfirmed();
    return (store.db.prepare('SELECT id AS pairingId,expires_at AS expiresAt FROM central_pairings WHERE actor_id=? AND redeemed_credentials IS NOT NULL AND expires_at>? ORDER BY expires_at DESC LIMIT 1').get(auth.user.id,new Date().toISOString())??null);
  });
  app.post(`${prefix}/pair`,{config:{rateLimit:{max:5,timeWindow:'1 minute'}}},async req=>{
    const actor=requireAdmin(options,req);
    const input=z.object({serviceUrl:urlSchema,callbackUrl:urlSchema}).strict().parse(req.body);
    const service=new URL(input.serviceUrl),callback=new URL(input.callbackUrl);
    if(service.pathname!=='/'||callback.pathname!==callbackPath||!options.allowedOrigins.has(callback.origin))throw new AppError('INVALID_ADDRESS','The service origin and configured panel callback are required',400);
    const secret=random(),challenge=createHash('sha256').update(secret).digest('base64url');
    const result=pairingResponse.parse(await postJson(new URL('/api/instances/pairings',service).href,{callbackUrl:callback.href,challenge}));
    if(new URL(result.approvalUrl).origin!==service.origin||Date.parse(result.expiresAt)<=Date.now()||Date.parse(result.expiresAt)>Date.now()+86_400_000)throw new AppError('CENTRAL_RESPONSE','Invalid central service response',502);
    store.db.prepare('INSERT INTO central_pairings VALUES (?,?,?,?,?,?,NULL)').run(result.pairingId,service.origin,callback.href,store.vault.seal(secret),actor.id,result.expiresAt);
    store.recordAudit(actor.id,'central.pair.start',result.pairingId);
    return result;
  });
  app.post(`${prefix}/redeem`,{config:{rateLimit:{max:20,timeWindow:'1 minute'}}},async req=>{
    const actor=requireAdmin(options,req),input=z.object({pairingId:z.string().min(1).max(256)}).strict().parse(req.body);
    const row=store.db.prepare('SELECT service_url AS serviceUrl,callback_url AS callbackUrl,secret,actor_id AS actorId,expires_at AS expiresAt,redeemed_credentials AS redeemedCredentials FROM central_pairings WHERE id=?').get(input.pairingId) as {serviceUrl:string;callbackUrl:string;secret:string;actorId:string;expiresAt:string;redeemedCredentials:string|null}|undefined;
    if(!row||row.actorId!==actor.id||row.expiresAt<=new Date().toISOString())throw new AppError('PAIRING_EXPIRED','Pairing is missing or expired',400);
    const result=credentialResponse.parse(row.redeemedCredentials ? JSON.parse(store.vault.open(row.redeemedCredentials)) : await postJson(new URL(`/api/instances/pairings/${encodeURIComponent(input.pairingId)}/redeem`,row.serviceUrl).href,{secret:store.vault.open(row.secret)}));
    if(new URL(result.issuer).origin!==row.serviceUrl)throw new AppError('CENTRAL_RESPONSE','Unexpected identity issuer',502);
    if(!row.redeemedCredentials)store.db.prepare('UPDATE central_pairings SET redeemed_credentials=? WHERE id=?').run(store.vault.seal(JSON.stringify(result)),input.pairingId);
    await discover({...result,callbackUrl:row.callbackUrl});
    store.db.transaction(()=>{
      store.db.prepare('DELETE FROM sessions WHERE token_hash IN (SELECT token_hash FROM central_sessions)').run();
      store.db.prepare('DELETE FROM central_invitations WHERE used_at IS NULL').run();
      const previous=store.db.prepare('SELECT issuer,client_id AS clientId,revoke_token AS revokeToken FROM central_config WHERE id=1').get() as {issuer:string;clientId:string;revokeToken:string}|undefined;
      if(previous&&previous.clientId!==result.clientId)store.db.prepare('INSERT OR REPLACE INTO central_pending_revocations VALUES (?,?,?)').run(previous.clientId,new URL(previous.issuer).origin,previous.revokeToken);
      store.db.prepare('INSERT INTO central_config VALUES (1,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET issuer=excluded.issuer,client_id=excluded.client_id,client_secret=excluded.client_secret,callback_url=excluded.callback_url,revoke_token=excluded.revoke_token').run(result.issuer,result.clientId,store.vault.seal(result.clientSecret),row.callbackUrl,store.vault.seal(result.revokeToken));
      store.recordAudit(actor.id,'central.pair.complete',input.pairingId);
    })();
    try {
      z.object({success:z.literal(true)}).parse(await postJson(new URL(`/api/instances/pairings/${encodeURIComponent(input.pairingId)}/confirm`,row.serviceUrl).href,{secret:store.vault.open(row.secret)}));
      store.db.prepare('DELETE FROM central_pairings WHERE id=?').run(input.pairingId);
    } catch { throw new AppError('PAIRING_CONFIRM_PENDING','Pairing was saved but confirmation failed; retry before it expires',503); }
    return {connected:true};
  });
  async function retryRevocations() {
    const rows=store.db.prepare('SELECT client_id AS clientId,service_origin AS serviceOrigin,revoke_token AS revokeToken FROM central_pending_revocations').all() as {clientId:string;serviceOrigin:string;revokeToken:string}[];
    for(const row of rows) {
      try {
        const result=z.object({success:z.literal(true)}).parse(await postJson(new URL('/api/instances/revoke',row.serviceOrigin).href,{clientId:row.clientId,revokeToken:store.vault.open(row.revokeToken)}));
        if(result.success)store.db.prepare('DELETE FROM central_pending_revocations WHERE client_id=?').run(row.clientId);
      } catch { /* Retain encrypted revocation credentials for an explicit retry. */ }
    }
    return (store.db.prepare('SELECT count(*) AS count FROM central_pending_revocations').get() as {count:number}).count;
  }
  app.get(`${prefix}/revocations`,async req=>{
    const auth=options.session(req);
    if(auth.user.role!=='admin')throw new AppError('FORBIDDEN','Administrator access required',403);
    return {pendingRevocations:(store.db.prepare('SELECT count(*) AS count FROM central_pending_revocations').get() as {count:number}).count};
  });
  app.post(`${prefix}/retry-revocations`,async req=>{
    requireAdmin(options,req);return {pendingRevocations:await retryRevocations()};
  });
  app.delete(prefix,async req=>{
    const actor=requireAdmin(options,req);
    store.db.transaction(()=>{
      const current=store.db.prepare('SELECT issuer,client_id AS clientId,revoke_token AS revokeToken FROM central_config WHERE id=1').get() as {issuer:string;clientId:string;revokeToken:string}|undefined;
      if(current)store.db.prepare('INSERT OR REPLACE INTO central_pending_revocations VALUES (?,?,?)').run(current.clientId,new URL(current.issuer).origin,current.revokeToken);
      store.db.prepare('DELETE FROM sessions WHERE token_hash IN (SELECT token_hash FROM central_sessions)').run();store.db.prepare('DELETE FROM central_config').run();store.db.prepare('DELETE FROM central_pairings').run();store.db.prepare('DELETE FROM central_transactions').run();store.db.prepare('DELETE FROM central_link_proofs').run();store.db.prepare('DELETE FROM central_invitations WHERE used_at IS NULL').run();store.recordAudit(actor.id,'central.disconnect','central');
    })();
    return {success:true,pendingRevocations:await retryRevocations()};
  });
  app.post(`${prefix}/invitations`,{config:{rateLimit:{max:20,timeWindow:'1 minute'}}},async req=>{
    const actor=requireAdmin(options,req);config(store);
    const {email}=z.object({email:z.string().email().max(254).transform(v=>v.toLowerCase())}).strict().parse(req.body);
    const token=random(),until=expires(7*86_400_000);
    store.db.prepare('INSERT INTO central_invitations VALUES (?,?,?,?,NULL)').run(hashToken(token),email,actor.id,until);
    store.recordAudit(actor.id,'central.invitation.create',hashToken(token));
    return {token,expiresAt:until};
  });
  app.get(`${prefix}/link/status`,async req=>{
    const {user}=options.session(req);
    const issuer=(store.db.prepare('SELECT issuer FROM central_config WHERE id=1').get() as {issuer:string}|undefined)?.issuer;
    const linked=!!issuer&&!!store.db.prepare('SELECT 1 FROM external_identities WHERE issuer=? AND user_id=?').get(issuer,user.id);
    const hasPassword=!!store.db.prepare('SELECT 1 FROM local_credentials WHERE user_id=?').get(user.id);
    return {linked,canLink:!!issuer&&hasPassword&&!linked};
  });
  app.post(`${prefix}/link/start`,{config:{rateLimit:{max:5,timeWindow:'1 minute'}}},async(req,reply)=>{
    expireUnconfirmed();
    const {user}=options.session(req,true);
    const {password}=z.object({password:z.string().min(1).max(128)}).strict().parse(req.body);
    const credential=store.db.prepare('SELECT password_hash AS passwordHash FROM local_credentials WHERE user_id=?').get(user.id) as {passwordHash:string}|undefined;
    if(!credential)throw new AppError('LINK_UNAVAILABLE','This account does not have a local password',409);
    if(!await verifyPassword(password,credential.passwordHash))throw new AppError('INVALID_CREDENTIALS','Email or password is incorrect',401);
    const sessionToken=req.cookies.panel_session!;
    const c=config(store);
    if(store.db.prepare('SELECT 1 FROM external_identities WHERE issuer=? AND user_id=?').get(c.issuer,user.id))throw new AppError('IDENTITY_CONFLICT','This account is already linked',409);
    const oidcConfig=await discover(c);
    if(options.session(req,true).user.id!==user.id)throw new AppError('UNAUTHORIZED','Sign in to continue',401);
    const state=random(),cookie=random(),nonce=random(),verifier=oidc.randomPKCECodeVerifier(),until=expires(300_000);
    store.db.prepare('DELETE FROM central_transactions WHERE expires_at<=?').run(new Date().toISOString());
    store.db.prepare('INSERT INTO central_transactions(state_hash,cookie_hash,verifier,nonce,invitation_hash,expires_at,link_user_id,link_session_hash) VALUES (?,?,?,?,NULL,?,?,?)').run(hashToken(state),hashToken(cookie),store.vault.seal(verifier),nonce,until,user.id,hashToken(sessionToken));
    reply.setCookie(temporaryCookie,cookie,{path:callbackPath,httpOnly:true,secure:true,sameSite:'lax',maxAge:300});
    return {authorizationUrl:oidc.buildAuthorizationUrl(oidcConfig,{redirect_uri:c.callbackUrl,scope:'openid email',state,nonce,code_challenge:await oidc.calculatePKCECodeChallenge(verifier),code_challenge_method:'S256'}).href};
  });
  app.post(`${prefix}/link/finish`,{config:{rateLimit:{max:10,timeWindow:'1 minute'}}},async req=>{
    const {user}=options.session(req,true),sessionToken=req.cookies.panel_session!;
    const {proof}=z.object({proof:z.string().regex(/^[A-Za-z0-9_-]{43}$/)}).strict().parse(req.body);
    const key=hashToken(proof),sessionHash=hashToken(sessionToken);
    const result=store.db.transaction(()=>{
      const row=store.db.prepare('SELECT user_id AS userId,session_hash AS sessionHash,issuer,subject,expires_at AS expiresAt FROM central_link_proofs WHERE token_hash=?').get(key) as {userId:string;sessionHash:string;issuer:string;subject:string;expiresAt:string}|undefined;
      if(!row||row.userId!==user.id||row.sessionHash!==sessionHash||row.expiresAt<=new Date().toISOString())return 'invalid';
      store.db.prepare('DELETE FROM central_link_proofs WHERE token_hash=?').run(key);
      const current=store.db.prepare('SELECT issuer FROM central_config WHERE id=1').get() as {issuer:string}|undefined;
      if(!current||current.issuer!==row.issuer)return 'invalid';
      const existing=store.db.prepare('SELECT user_id AS userId FROM external_identities WHERE issuer=? AND subject=?').get(row.issuer,row.subject) as {userId:string}|undefined;
      if(existing&&existing.userId!==user.id)return 'conflict';
      const owned=store.db.prepare('SELECT subject FROM external_identities WHERE issuer=? AND user_id=?').get(row.issuer,user.id) as {subject:string}|undefined;
      if(owned&&owned.subject!==row.subject)return 'conflict';
      if(!existing)store.db.prepare('INSERT INTO external_identities VALUES (?,?,?)').run(row.issuer,row.subject,user.id);
      store.recordAudit(user.id,'central.identity.link',user.id);
      return 'ok';
    }).immediate();
    if(result==='invalid')throw new AppError('LINK_EXPIRED','Linking has expired or the session changed',403);
    if(result==='conflict')throw new AppError('IDENTITY_CONFLICT','The identity is already linked to another account',409);
    return {success:true};
  });
  app.post(`${prefix}/start`,{config:{rateLimit:{max:15,timeWindow:'1 minute'}}},async(req,reply)=>{
    expireUnconfirmed();
    const {invitation}=z.object({invitation:z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional()}).strict().parse(req.body??{});
    const c=config(store),oidcConfig=await discover(c),state=random(),cookie=random(),nonce=random(),verifier=oidc.randomPKCECodeVerifier();
    const until=expires(300_000);
    store.db.prepare('DELETE FROM central_transactions WHERE expires_at<=?').run(new Date().toISOString());
    store.db.prepare('INSERT INTO central_transactions(state_hash,cookie_hash,verifier,nonce,invitation_hash,expires_at) VALUES (?,?,?,?,?,?)').run(hashToken(state),hashToken(cookie),store.vault.seal(verifier),nonce,invitation?hashToken(invitation):null,until);
    reply.setCookie(temporaryCookie,cookie,{path:callbackPath,httpOnly:true,secure:true,sameSite:'lax',maxAge:300});
    const destination=oidc.buildAuthorizationUrl(oidcConfig,{redirect_uri:c.callbackUrl,scope:'openid email',state,nonce,code_challenge:await oidc.calculatePKCECodeChallenge(verifier),code_challenge_method:'S256'});
    return {authorizationUrl:destination.href};
  });
  app.get<{Querystring:{state?:string}}>(callbackPath,{config:{rateLimit:{max:20,timeWindow:'1 minute'}}},async(req,reply)=>{
    const state=z.string().regex(/^[A-Za-z0-9_-]{43}$/).parse(req.query.state),cookie=req.cookies[temporaryCookie]??'';
    reply.clearCookie(temporaryCookie,{path:callbackPath,secure:true,sameSite:'lax'});
    const key=hashToken(state);
    const tx=store.db.transaction(()=>{
      const row=store.db.prepare('SELECT cookie_hash AS cookieHash,verifier,nonce,invitation_hash AS invitationHash,expires_at AS expiresAt,link_user_id AS linkUserId,link_session_hash AS linkSessionHash FROM central_transactions WHERE state_hash=?').get(key) as {cookieHash:string;verifier:string;nonce:string;invitationHash:string|null;expiresAt:string;linkUserId:string|null;linkSessionHash:string|null}|undefined;
      store.db.prepare('DELETE FROM central_transactions WHERE state_hash=?').run(key);return row;
    })();
    if(!tx||tx.expiresAt<=new Date().toISOString()||tx.cookieHash!==hashToken(cookie))throw new AppError('OIDC_STATE','Sign in expired or is invalid',401);
    const c=config(store),oidcConfig=await discover(c),callback=new URL(c.callbackUrl);callback.search=req.url.includes('?')?req.url.slice(req.url.indexOf('?')):'';
    let tokens:Awaited<ReturnType<typeof oidc.authorizationCodeGrant>>;
    try { tokens=await oidc.authorizationCodeGrant(oidcConfig,callback,{pkceCodeVerifier:store.vault.open(tx.verifier),expectedState:state,expectedNonce:tx.nonce,idTokenExpected:true}); }
    catch { throw new AppError('OIDC_INVALID','Central sign in could not be verified',401); }
    const claims=tokens.claims();
    if(!claims||typeof claims.sub!=='string')throw new AppError('OIDC_IDENTITY','A valid identity is required',403);
    let profile:Awaited<ReturnType<typeof oidc.fetchUserInfo>>;
    try { profile=await oidc.fetchUserInfo(oidcConfig,tokens.access_token,claims.sub); }
    catch { throw new AppError('OIDC_IDENTITY','Identity information could not be verified',403); }
    if(typeof profile.email!=='string'||profile.email_verified!==true)throw new AppError('OIDC_IDENTITY','A verified email is required',403);
    const subject=claims.sub,email=profile.email.toLowerCase();
    if(tx.linkUserId&&tx.linkSessionHash) {
      const savedSession=store.db.prepare('SELECT user_id AS userId,expires_at AS expiresAt,absolute_expires_at AS absoluteExpiresAt FROM sessions WHERE token_hash=?').get(tx.linkSessionHash) as {userId:string;expiresAt:string;absoluteExpiresAt:string}|undefined;
      const currentTime=new Date().toISOString();
      if(!savedSession||savedSession.userId!==tx.linkUserId||savedSession.expiresAt<=currentTime||savedSession.absoluteExpiresAt<=currentTime)throw new AppError('LINK_EXPIRED','Linking has expired or the session changed',403);
      const proof=random(),scriptNonce=random();
      store.db.prepare('DELETE FROM central_link_proofs WHERE expires_at<=?').run(currentTime);
      store.db.prepare('INSERT INTO central_link_proofs VALUES (?,?,?,?,?,?)').run(hashToken(proof),tx.linkUserId,tx.linkSessionHash,c.issuer,subject,expires(60_000));
      const script=`(async()=>{try{const s=await fetch('/api/v1/auth/session');if(!s.ok)throw 0;const a=await s.json();const r=await fetch('/api/v1/auth/central/link/finish',{method:'POST',headers:{'content-type':'application/json','x-csrf-token':a.csrfToken},body:JSON.stringify({proof:'${proof}'})});if(!r.ok)throw 0;location.replace('/');}catch{document.getElementById('result').textContent='Could not link the account. Return to your panel and try again.';}})()`;
      return reply.type('text/html; charset=utf-8').header('Content-Security-Policy',`default-src 'none'; connect-src 'self'; script-src 'nonce-${scriptNonce}'; base-uri 'none'; frame-ancestors 'none'`).send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Link account</title></head><body><p id="result">Linking your account...</p><script nonce="${scriptNonce}">${script}</script></body></html>`);
    }
    const user=store.db.transaction(()=>{
      const existing=store.db.prepare('SELECT u.id,u.email,u.role,u.created_at AS createdAt FROM external_identities i JOIN users u ON u.id=i.user_id WHERE i.issuer=? AND i.subject=?').get(c.issuer,subject) as User|undefined;
      if(existing)return existing;
      if(!tx.invitationHash)throw new AppError('INVITATION_REQUIRED','An invitation is required',403);
      const invite=store.db.prepare('SELECT email,expires_at AS expiresAt,used_at AS usedAt FROM central_invitations WHERE token_hash=?').get(tx.invitationHash) as {email:string;expiresAt:string;usedAt:string|null}|undefined;
      if(!invite||invite.usedAt||invite.expiresAt<=new Date().toISOString()||invite.email!==email)throw new AppError('INVITATION_INVALID','Invitation is invalid or expired',403);
      if(store.db.prepare('SELECT 1 FROM users WHERE email=?').get(email))throw new AppError('ACCOUNT_EXISTS','An account with this email already exists',409);
      const created:User={id:randomUUID(),email,role:'member',createdAt:new Date().toISOString()};
      store.db.prepare('INSERT INTO users VALUES (?,?,?,?,?)').run(created.id,created.email,'external-credentials',created.role,created.createdAt);
      store.db.prepare('INSERT INTO external_identities VALUES (?,?,?)').run(c.issuer,subject,created.id);
      store.db.prepare('UPDATE central_invitations SET used_at=? WHERE token_hash=?').run(new Date().toISOString(),tx.invitationHash);
      store.recordAudit(created.id,'central.identity.link',created.id);return created;
    }).immediate();
    options.setSession(reply,user,true);store.recordAudit(user.id,'central.login',user.id);
    return reply.type('text/html; charset=utf-8').header('Content-Security-Policy',"default-src 'none'; base-uri 'none'; frame-ancestors 'none'").send('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=/"><title>Sign in</title></head><body><a href="/">Continue to Servus</a></body></html>');
  });
}
