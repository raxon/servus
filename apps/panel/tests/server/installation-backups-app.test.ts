import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {createServer,type Server,type Socket} from 'node:net';
import {join} from 'node:path';
import {createApp} from '../../src/server/app.js';
import {Store} from '../../src/server/store.js';
import type {InstallationBackupApproval,InstallationBackupApprovalFields} from '../../src/server/installation-backup-approval.js';

// Only the privileged key reader/signer is replaced. Sessions, Store, routes and Unix transport are real.
const {signer,cancelSigner,deleteSigner,downloadSigner}=vi.hoisted(()=>({signer:vi.fn(),cancelSigner:vi.fn(),deleteSigner:vi.fn(),downloadSigner:vi.fn()}));
vi.mock('../../src/server/installation-backup-approval.js',async original=>({...await original<typeof import('../../src/server/installation-backup-approval.js')>(),signInstallationBackupApproval:signer,signInstallationBackupCancellation:cancelSigner,signInstallationBackupDeletion:deleteSigner,signInstallationBackupDownload:downloadSigner}));
const operationId='12345678-1234-4123-8123-123456789abc',input={operationId,name:'Installation backup'},origin='https://panel.example.test';
const cleanup:(()=>Promise<void>)[]=[];
beforeEach(()=>{signer.mockReset();signer.mockImplementation((fields:InstallationBackupApprovalFields)=>({...fields,version:1,proof:'a'.repeat(64)}));cancelSigner.mockReset();cancelSigner.mockImplementation((fields:InstallationBackupApprovalFields)=>({...fields,version:1,proof:'b'.repeat(64)}));deleteSigner.mockReset();deleteSigner.mockImplementation((fields:InstallationBackupApprovalFields)=>({...fields,version:1,proof:'c'.repeat(64)}));downloadSigner.mockReset();downloadSigner.mockImplementation((fields:InstallationBackupApprovalFields)=>({...fields,version:1,proof:'d'.repeat(64)}));});
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
type UpdaterRequest={version:number;action:string;approval?:InstallationBackupApproval;operationId?:string};

async function fixture({enabled=true,secret=true}={}){
  const directory=mkdtempSync('/tmp/siba-'),socketPath=join(directory,'u.sock'),store=new Store(directory),sockets=new Set<Socket>(),requests:UpdaterRequest[]=[];
  let responder:(socket:Socket,request:UpdaterRequest)=>void=()=>{},server:Server|undefined;
  const app=await createApp({dataDir:directory,store,allowedOrigins:[origin],...(enabled?{updaterSocketPath:socketPath,updaterApplyEnabled:true,...(secret?{installationBackupApprovalSecretPath:'/synthetic/not-read/role-api-key'}:{})}:{})});
  cleanup.push(async()=>{for(const socket of sockets)socket.destroy();await app.close();if(server)await new Promise<void>(resolve=>server!.close(()=>resolve()));store.close();rmSync(directory,{recursive:true,force:true});});
  const setup=await app.inject({method:'POST',url:'/api/v1/setup',headers:{origin},payload:{email:'admin@example.test',password:'fixture-admin-password'}});expect(setup.statusCode).toBe(200);
  const admin=setup.json().user as{id:string},adminToken=setup.cookies.find(cookie=>cookie.name==='panel_session')!.value,headers={origin,cookie:`panel_session=${adminToken}`,'x-csrf-token':setup.json().csrfToken as string},project=store.createProject('backup-access');
  const operation={...input,actorId:admin.id,state:'requested',createdAt:Date.now(),updatedAt:Date.now(),errorCode:null};
  responder=(socket,request)=>{const current=request.approval?{...operation,createdAt:request.approval.issuedAt,updatedAt:request.approval.issuedAt}:operation;socket.end(`${JSON.stringify({ok:true,operation:current})}\n`);};
  server=createServer(socket=>{sockets.add(socket);socket.on('error',()=>{});socket.on('close',()=>sockets.delete(socket));let data='';socket.on('data',chunk=>{data+=chunk.toString();if(!data.includes('\n'))return;const request=JSON.parse(data) as UpdaterRequest;requests.push(request);responder(socket,request);});});
  await new Promise<void>((resolve,reject)=>{server!.once('error',reject);server!.listen(socketPath,resolve);});
  let address=1;
  const post=(selected:Record<string,string>=headers,payload:unknown=input,url='/api/v1/installation-backups')=>app.inject({method:'POST',url,headers:selected,payload,remoteAddress:`192.0.2.${address++}`});
  const get=(selected:Record<string,string>=headers,url=`/api/v1/installation-backups/${operationId}`)=>app.inject({url,headers:selected,remoteAddress:`192.0.2.${address++}`});
  const member=(role:'member'|'editor'|'viewer')=>{const user=store.createUser(`${role}@example.test`,'unused-fixture-password-hash');if(role!=='member')store.addMember(project.id,user.id,role);const session=store.createSession(user.id);return{origin,cookie:`panel_session=${session.token}`,'x-csrf-token':session.csrfToken};};
  const token=async(scope:'read'|'deploy')=>{const result=await app.inject({method:'POST',url:'/api/v1/auth/api-tokens',headers,payload:{projectId:project.id,name:'Backup authorization regression',scope}});expect(result.statusCode).toBe(201);return result.json().token as string;};
  return{app,store,admin,adminToken,headers,operation,requests,post,get,member,token,respond:(value:typeof responder)=>{responder=value;}};
}

describe('installation backup routes through createApp',()=>{
  it('cancels only with fresh administrator approval and the original name, preserving the creator identity',async()=>{
    const f=await fixture(),creator='32345678-1234-4123-8123-123456789abc';f.respond((socket,request)=>socket.end(`${JSON.stringify({ok:true,operation:{...f.operation,actorId:creator,state:'cancelled'}})}\n`));
    const result=await f.post(f.headers,{name:input.name},`/api/v1/installation-backups/${operationId}/cancel`);expect(result.statusCode).toBe(202);expect(result.json().operation.actorId).toBe(creator);expect(result.json().operation.state).toBe('cancelled');expect(signer).not.toHaveBeenCalled();expect(cancelSigner).toHaveBeenCalledWith({...input,actorId:f.admin.id,issuedAt:expect.any(Number)},'/synthetic/not-read/role-api-key');expect(f.requests[0]).toMatchObject({version:1,action:'installation_backup_cancel',approval:{...input,actorId:f.admin.id,proof:'b'.repeat(64)}});
  });
  it('guards cancellation authorization, CSRF and payloads before signing or dispatch',async()=>{
    const f=await fixture(),url=`/api/v1/installation-backups/${operationId}/cancel`;
    for(const headers of[{},f.member('editor'),{...f.headers,'x-csrf-token':''},{...f.headers,origin:'https://foreign.example.test'},{authorization:`Bearer ${await f.token('deploy')}`}])expect((await f.post(headers,{name:input.name},url)).statusCode).toBeGreaterThanOrEqual(400);
    for(const extra of[{actorId:f.admin.id},{proof:'a'.repeat(64)},{path:'/root/private'},{operationId}])expect((await f.post(f.headers,{name:input.name,...extra},url)).statusCode).toBe(400);
    expect(cancelSigner).not.toHaveBeenCalled();expect(f.requests).toEqual([]);
  });
  it('rechecks a cancelled-operation response against the current administrator session',async()=>{
    const f=await fixture();f.respond(socket=>{f.store.deleteSession(f.adminToken);socket.end(`${JSON.stringify({ok:true,operation:{...f.operation,state:'cancelled'}})}\n`);});expect((await f.post(f.headers,{name:input.name},`/api/v1/installation-backups/${operationId}/cancel`)).statusCode).toBe(401);
  });
  it('reports configured host support using a read-only probe without touching the signer',async()=>{
    const f=await fixture();f.respond((socket,request)=>{expect(request.action).toBe('installation_backup_status');expect(request.operationId).toMatch(/^[a-f0-9-]{36}$/);socket.end(`${JSON.stringify({ok:false,error:'not_found'})}\n`);});
    const result=await f.get(f.headers,'/api/v1/installation-backups');expect(result.statusCode).toBe(200);expect(result.json()).toEqual({available:true});expect(signer).not.toHaveBeenCalled();expect(f.requests).toHaveLength(1);
    expect((await f.get(f.member('editor'),'/api/v1/installation-backups')).statusCode).toBe(403);
    expect((await f.get({authorization:`Bearer ${await f.token('deploy')}`},'/api/v1/installation-backups')).statusCode).toBe(401);
    expect((await f.get(f.headers,'/api/v1/installation-backups?path=/root')).statusCode).toBe(400);expect(f.requests).toHaveLength(1);
  });
  it.each([['invalid_request','host_unsupported'],['unavailable','host_unavailable']] as const)('distinguishes unavailable capability without advertising a working host: %s',async(error,reason)=>{
    const f=await fixture();f.respond(socket=>socket.end(`${JSON.stringify({ok:false,error})}\n`));expect((await f.get(f.headers,'/api/v1/installation-backups')).json()).toEqual({available:false,reason});expect(signer).not.toHaveBeenCalled();
  });
  it('reports disabled-by-default capability without transport or approval-key access',async()=>{
    const f=await fixture({enabled:false});expect((await f.get(f.headers,'/api/v1/installation-backups')).json()).toEqual({available:false,reason:'not_configured'});expect(f.requests).toEqual([]);expect(signer).not.toHaveBeenCalled();
  });
  it('rechecks the administrator after awaiting capability detection',async()=>{
    const f=await fixture();f.respond(socket=>{f.store.deleteSession(f.adminToken);socket.end(`${JSON.stringify({ok:false,error:'not_found'})}\n`);});expect((await f.get(f.headers,'/api/v1/installation-backups')).statusCode).toBe(401);
  });
  it.each(['anonymous','member','editor','viewer'] as const)('requires instance administrator access for %s',async role=>{
    const f=await fixture(),headers=role==='anonymous'?{}:f.member(role),expected=role==='anonymous'?401:403;
    expect((await f.post(headers)).statusCode).toBe(expected);expect((await f.get(headers)).statusCode).toBe(expected);
    expect(signer).not.toHaveBeenCalled();expect(f.requests).toEqual([]);
  });
  it('enforces real session CSRF and origin checks before approval or transport',async()=>{
    const f=await fixture();
    for(const headers of[{...f.headers,'x-csrf-token':''},{...f.headers,'x-csrf-token':'foreign-token'},{...f.headers,origin:'https://foreign.example.test'}])expect((await f.post(headers)).statusCode).toBe(403);
    expect(signer).not.toHaveBeenCalled();expect(f.requests).toEqual([]);
  });
  it('rejects valid read/deploy bearer tokens and mixed bearer/session credentials',async()=>{
    const f=await fixture();
    for(const scope of['read','deploy'] as const){const token=await f.token(scope),headers={origin,authorization:`Bearer ${token}`};
      expect((await f.post(headers)).statusCode).toBe(401);expect((await f.get(headers)).statusCode).toBe(401);
      expect((await f.post({...f.headers,...headers})).statusCode).toBe(401);expect((await f.get({...f.headers,...headers})).statusCode).toBe(401);
    }
    expect(signer).not.toHaveBeenCalled();expect(f.requests).toEqual([]);
  });
  it('rejects caller paths, actor identities, proofs and query extras before the privileged signer',async()=>{
    const f=await fixture();
    for(const payload of[{...input,path:'/root/private'},{...input,snapshotPath:'/var/lib/private'},{...input,actorId:f.admin.id},{...input,proof:'b'.repeat(64)},{...input,issuedAt:Date.now()},{...input,operationId:'../escape'}])expect((await f.post(f.headers,payload)).statusCode).toBe(400);
    expect((await f.post(f.headers,input,'/api/v1/installation-backups?path=/root/private')).statusCode).toBe(400);
    expect((await f.get(f.headers,`/api/v1/installation-backups/${operationId}?proof=caller-proof`)).statusCode).toBe(400);
    expect((await f.get(f.headers,'/api/v1/installation-backups/not-a-uuid')).statusCode).toBe(400);
    expect(signer).not.toHaveBeenCalled();expect(f.requests).toEqual([]);
  });
  it.each([{enabled:false},{enabled:true,secret:false}])('keeps an authenticated administrator disabled without full host opt-in: %j',async options=>{
    const f=await fixture(options);expect((await f.post()).statusCode).toBe(503);expect((await f.get()).statusCode).toBe(503);expect(signer).not.toHaveBeenCalled();expect(f.requests).toEqual([]);
  });
  it('uses the authenticated actor and exact Unix updater protocol through the full application',async()=>{
    const f=await fixture(),submitted=await f.post();expect(submitted.statusCode).toBe(202);expect(submitted.json().operation).toMatchObject({...input,actorId:f.admin.id,state:'requested'});
    expect(signer).toHaveBeenCalledOnce();expect(signer).toHaveBeenCalledWith({...input,actorId:f.admin.id,issuedAt:expect.any(Number)},'/synthetic/not-read/role-api-key');
    expect(f.requests[0]).toEqual({version:1,action:'installation_backup_submit',approval:{...input,actorId:f.admin.id,issuedAt:expect.any(Number),version:1,proof:'a'.repeat(64)}});
    const status=await f.get();expect(status.statusCode).toBe(200);expect(status.json()).toEqual({ok:true,operation:f.operation});expect(f.requests[1]).toEqual({version:1,action:'installation_backup_status',operationId});
    for(const response of[submitted,status]){expect(response.body).not.toContain('proof');expect(response.body).not.toContain('/synthetic');}
  });
  it.each(['submit','status'] as const)('rechecks a revoked real administrator session after awaited %s transport',async operation=>{
    const f=await fixture();f.respond(socket=>{f.store.deleteSession(f.adminToken);socket.end(`${JSON.stringify({ok:true,operation:f.operation})}\n`);});
    const response=operation==='submit'?await f.post():await f.get();expect(response.statusCode).toBe(401);expect(response.body).not.toContain(input.name);expect(f.requests).toHaveLength(1);
  });
  it.each(['submit','status'] as const)('rechecks a downgraded administrator after awaited %s transport',async operation=>{
    const f=await fixture();f.respond(socket=>{f.store.db.prepare("UPDATE users SET role='member' WHERE id=?").run(f.admin.id);socket.end(`${JSON.stringify({ok:true,operation:f.operation})}\n`);});
    const response=operation==='submit'?await f.post():await f.get();expect(response.statusCode).toBe(403);expect(response.body).not.toContain(input.name);expect(f.requests).toHaveLength(1);
  });
  it('deletes and verifies completed installation backups with distinct delete signing and live admin rechecks',async()=>{
    const f=await fixture();
    const digest=`sha256:${'d'.repeat(64)}`;
    f.respond((socket,request)=>{
      if(request.action==='installation_backup_delete'){
        socket.end(`${JSON.stringify({ok:true,operation:{operationId,name:input.name,deleted:true,remainingSnapshots:1}})}\n`);
        return;
      }
      if(request.action==='installation_backup_verify'){
        socket.end(`${JSON.stringify({ok:true,operation:{operationId,name:input.name,verified:true,manifestDigest:digest}})}\n`);
        return;
      }
      socket.end(`${JSON.stringify({ok:false,error:'invalid_request'})}\n`);
    });
    // Unauthorized / non-admin / bearer rejected before signing
    for(const headers of[{},f.member('editor'),{...f.headers,'x-csrf-token':''},{...f.headers,origin:'https://foreign.example.test'},{authorization:`Bearer ${await f.token('deploy')}`}]){
      expect((await f.post(headers,{name:input.name},`/api/v1/installation-backups/${operationId}/delete`)).statusCode).toBeGreaterThanOrEqual(400);
      expect((await f.post(headers,{},`/api/v1/installation-backups/${operationId}/verify`)).statusCode).toBeGreaterThanOrEqual(400);
    }
    expect(deleteSigner).not.toHaveBeenCalled();
    expect(f.requests).toEqual([]);

    const del=await f.post(f.headers,{name:input.name},`/api/v1/installation-backups/${operationId}/delete`);
    expect(del.statusCode).toBe(200);
    expect(del.json()).toEqual({ok:true,result:{operationId,name:input.name,deleted:true,remainingSnapshots:1}});
    expect(deleteSigner).toHaveBeenCalledWith({...input,actorId:f.admin.id,issuedAt:expect.any(Number)},'/synthetic/not-read/role-api-key');
    expect(signer).not.toHaveBeenCalled();
    expect(cancelSigner).not.toHaveBeenCalled();
    expect(del.body).not.toContain('proof');
    expect(del.body).not.toContain('/synthetic');

    const verify=await f.post(f.headers,{},`/api/v1/installation-backups/${operationId}/verify`);
    expect(verify.statusCode).toBe(200);
    expect(verify.json()).toEqual({ok:true,verification:{operationId,name:input.name,verified:true,manifestDigest:digest}});

    // Revoked session after await must fail closed
    f.respond(socket=>{f.store.deleteSession(f.adminToken);socket.end(`${JSON.stringify({ok:true,operation:{operationId,name:input.name,verified:true,manifestDigest:digest}})}\n`);});
    expect((await f.post(f.headers,{},`/api/v1/installation-backups/${operationId}/verify`)).statusCode).toBe(401);
  });

  it('downloads verified installation backup archives with distinct signing, checksum verification and post-await admin recheck',async()=>{
    const f=await fixture();
    const archiveBytes=Buffer.from('synthetic-gzip-tar-archive-payload');
    const archiveHex=createHash('sha256').update(archiveBytes).digest('hex');
    const manifestDigest=`sha256:${'e'.repeat(64)}`;
    const downloadUrl=`/api/v1/installation-backups/${operationId}/download`;

    // Reject anonymous, non-admin, bad CSRF/origin, and bearer tokens before signing
    for(const headers of[{},f.member('editor'),{...f.headers,'x-csrf-token':''},{...f.headers,origin:'https://foreign.example.test'},{authorization:`Bearer ${await f.token('deploy')}`}]){
      expect((await f.post(headers,{name:input.name},downloadUrl)).statusCode).toBeGreaterThanOrEqual(400);
    }
    expect(downloadSigner).not.toHaveBeenCalled();
    expect(f.requests).toEqual([]);

    // Valid verified download
    f.respond((socket,request)=>{
      expect(request.action).toBe('installation_backup_download');
      const header=JSON.stringify({ok:true,operation:{operationId,name:input.name,manifestDigest,archiveSha256:`sha256:${archiveHex}`,sizeBytes:archiveBytes.length}});
      socket.write(`${header}\n`);
      socket.end(archiveBytes);
    });
    const res=await f.post(f.headers,{name:input.name},downloadUrl);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/gzip');
    expect(res.headers['content-disposition']).toBe(`attachment; filename="servus-installation-backup-${operationId}.tar.gz"`);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-backup-sha256']).toBe(archiveHex);
    expect(res.headers['x-backup-manifest-digest']).toBe(manifestDigest);
    expect(res.rawPayload.equals(archiveBytes)).toBe(true);
    expect(downloadSigner).toHaveBeenCalledWith({...input,actorId:f.admin.id,issuedAt:expect.any(Number)},'/synthetic/not-read/role-api-key');
    expect(signer).not.toHaveBeenCalled();
    expect(deleteSigner).not.toHaveBeenCalled();

    // Corrupted archive checksum must fail closed
    f.respond(socket=>{
      const header=JSON.stringify({ok:true,operation:{operationId,name:input.name,manifestDigest,archiveSha256:`sha256:${'0'.repeat(64)}`,sizeBytes:archiveBytes.length}});
      socket.write(`${header}\n`);
      socket.end(archiveBytes);
    });
    expect((await f.post(f.headers,{name:input.name},downloadUrl)).statusCode).toBe(503);

    // Revoked admin session mid-flight must fail closed without returning archive bytes
    f.respond(socket=>{
      f.store.deleteSession(f.adminToken);
      const header=JSON.stringify({ok:true,operation:{operationId,name:input.name,manifestDigest,archiveSha256:`sha256:${archiveHex}`,sizeBytes:archiveBytes.length}});
      socket.write(`${header}\n`);
      socket.end(archiveBytes);
    });
    const revoked=await f.post(f.headers,{name:input.name},downloadUrl);
    expect(revoked.statusCode).toBe(401);
    expect(revoked.rawPayload.includes(archiveBytes)).toBe(false);
  });
});
