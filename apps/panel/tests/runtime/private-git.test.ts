import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:https';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { buildSource, buildLogPath } from '../../src/agent/build.js';
import { compileConfiguration } from '../../src/agent/configuration.js';
import { SecretVault } from '../../src/shared/secrets.js';
import type { Service } from '../../src/shared/types.js';
import Database from 'better-sqlite3';

const cleanup:(()=>unknown|Promise<unknown>)[]=[];
afterEach(async()=>{for(const fn of cleanup.splice(0).reverse())await fn();vi.unstubAllEnvs();});
it('clones and retries a private HTTPS repository without persisting credentials',async()=>{
  const root=mkdtempSync(join(tmpdir(),'servus-private-git-'));cleanup.push(()=>rmSync(root,{recursive:true,force:true}));
  const source=join(root,'source'),repos=join(root,'repos'),bare=join(repos,'control.git'),bin=join(root,'bin'),data=join(root,'data');
  for(const p of [source,repos,bin,data])mkdirSync(p,{recursive:true});
  const git=(args:string[],cwd=source)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  git(['init','-b','main']);writeFileSync(join(source,'Dockerfile'),'FROM scratch\n');git(['add','.']);git(['-c','user.name=Test','-c','user.email=test@example.test','commit','-m','first']);
  const first=git(['rev-parse','HEAD']);git(['clone','--bare',source,bare],root);
  const cert=join(root,'cert.pem'),key=join(root,'key.pem');
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1'],{stdio:'ignore'});
  const token='fixture-secret-9f73',replacement='fixture-rotated-token', username='build-user', auth='Basic '+Buffer.from(username+':'+token).toString('base64');
  const validAuth=new Set([auth,'Basic '+Buffer.from(username+':'+replacement).toString('base64')]);
  let redirectedRequests=0;
  const server=createServer({key:readFileSync(key),cert:readFileSync(cert)},(req,res)=>{
    if(req.url?.startsWith('/capture')){redirectedRequests++;res.writeHead(200).end();return;}
    if(!validAuth.has(req.headers.authorization??'')){res.writeHead(401,{'WWW-Authenticate':'Basic realm="fixture"'}).end();return;}
    const url=new URL(req.url!,'https://fixture');
    if(url.pathname.startsWith('/redirect.git/')){res.writeHead(302,{Location:`https://127.0.0.1:${(server.address() as {port:number}).port}/capture`}).end();return;}
    const cgi=spawn('git',['http-backend'],{env:{PATH:'/usr/bin:/bin',GIT_PROJECT_ROOT:repos,GIT_HTTP_EXPORT_ALL:'1',PATH_INFO:url.pathname,QUERY_STRING:url.search.slice(1),REQUEST_METHOD:req.method!,CONTENT_TYPE:req.headers['content-type']??'',CONTENT_LENGTH:req.headers['content-length']??'',REMOTE_USER:username},stdio:['pipe','pipe','pipe']});
    req.pipe(cgi.stdin);let pending=Buffer.alloc(0), started=false;
    cgi.stdout.on('data',(chunk:Buffer)=>{if(started){res.write(chunk);return;}pending=Buffer.concat([pending,chunk]);let at=pending.indexOf('\r\n\r\n'),skip=4;if(at<0){at=pending.indexOf('\n\n');skip=2;}if(at<0)return;let status=200;const headers:Record<string,string>={};for(const line of pending.subarray(0,at).toString().split(/\r?\n/)){const n=line.indexOf(':');if(n<0)continue;const name=line.slice(0,n).trim(),value=line.slice(n+1).trim();if(name.toLowerCase()==='status')status=Number(value.slice(0,3));else headers[name]=value;}res.writeHead(status,headers);res.write(pending.subarray(at+skip));started=true;});
    cgi.on('close',()=>{if(!started)res.writeHead(500);res.end();});cgi.on('error',()=>{if(!res.headersSent)res.writeHead(500);res.end();});
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));cleanup.push(()=>new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve())));
  const port=(server.address() as {port:number}).port,repository=`https://127.0.0.1:${port}/control.git`;
  const configFile=join(root,'git-config');
  writeFileSync(join(bin,'docker'),`#!${process.execPath}\nconst fs=require('node:fs');fs.copyFileSync('.git/config',${JSON.stringify(configFile)});const s=${JSON.stringify(auth)};process.stdout.write(s.slice(0,11));setTimeout(()=>process.stdout.write(s.slice(11)+'\\n'),10);`,{mode:0o755});
  vi.stubEnv('PATH',bin+delimiter+(process.env.PATH||''));vi.stubEnv('PANEL_GIT_HTTP_HOSTS','127.0.0.1');vi.stubEnv('PANEL_GIT_TEST_CA',cert);
  const vault=new SecretVault(data),id=randomUUID(),operationId=randomUUID();
  const secretRef=vault.put(JSON.stringify({kind:'git-credential-v1',serviceId:id,repository,username,token}));
  const metadata=new Database(join(data,'panel.sqlite'));metadata.exec('CREATE TABLE service_secret_refs(reference TEXT PRIMARY KEY,service_id TEXT NOT NULL,purpose TEXT NOT NULL); PRAGMA user_version=5');metadata.prepare('INSERT INTO service_secret_refs VALUES (?,?,?)').run(secretRef,id,'git');cleanup.push(()=>metadata.close());
  const service:Service={id,projectId:randomUUID(),name:'private',image:'unused',hostname:'private.localhost',port:80,replicas:1,revision:1,deployedRevision:null,state:'pending',createdAt:'now',updatedAt:'now',lastError:null,source:{type:'git',repository,branch:'main',context:'.',dockerfile:'Dockerfile',credential:{username,secretRef}}};
  const exposed={...service,environment:[{name:'GIT_TOKEN',secret:true,secretRef}]};
  await expect(compileConfiguration({} as never,exposed,vault,data)).rejects.toThrow('not valid for this purpose');
  await expect(buildSource(exposed,randomUUID(),data,'/unused',vault)).rejects.toThrow('not valid for this purpose');
  expect(()=>vault.getServiceSecret(secretRef,id,'database')).toThrow('not valid for this purpose');
  expect(()=>vault.getDatabaseRootSecret(secretRef)).toThrow('Database root secret is invalid');
  const checked=await buildSource(service,randomUUID(),data,'/unused',vault,{checkOnly:true});
  expect(checked.sourceCommit).toBe(first);
  validAuth.delete(auth);
  await expect(buildSource(service,randomUUID(),data,'/unused',vault,{checkOnly:true})).rejects.toMatchObject({code:'SOURCE_REPOSITORY_OR_BRANCH'});
  validAuth.add(auth);
  const result=await buildSource(service,operationId,data,'/unused',vault);expect(result.sourceCommit).toBe(first);
  const rotatedRef=vault.put(JSON.stringify({kind:'git-credential-v1',serviceId:id,repository,username,token:replacement}));
  metadata.prepare('INSERT INTO service_secret_refs VALUES (?,?,?)').run(rotatedRef,id,'git');
  const rotated:Service={...service,source:{type:'git',repository,branch:'main',context:'.',dockerfile:'Dockerfile',credential:{username,secretRef:rotatedRef}}};
  expect((await buildSource(rotated,randomUUID(),data,'/unused',vault)).sourceCommit).toBe(first);
  const retry=await buildSource(service,operationId,data,'/unused',vault);expect(retry.sourceCommit).toBe(first);
  for(const text of [readFileSync(configFile,'utf8'),readFileSync(buildLogPath(data,id,operationId),'utf8'),readFileSync(join(data,'source-revisions',operationId),'utf8')]) {expect(text).not.toContain(token);expect(text).not.toContain(auth);expect(text).not.toContain(auth.slice(6));}
  const wrong={...service,id:randomUUID()};await expect(buildSource(wrong,randomUUID(),data,'/unused',vault)).rejects.toThrow('Invalid private Git credential');
  validAuth.delete(auth);await expect(buildSource(service,operationId,data,'/unused',vault)).rejects.toThrow('git failed');validAuth.add(auth);
  const redirected=`https://127.0.0.1:${port}/redirect.git`,redirectRef=vault.put(JSON.stringify({kind:'git-credential-v1',serviceId:id,repository:redirected,username,token}));
  metadata.prepare('INSERT INTO service_secret_refs VALUES (?,?,?)').run(redirectRef,id,'git');
  const redirectService:Service={...service,source:{type:'git',repository:redirected,branch:'main',context:'.',dockerfile:'Dockerfile',credential:{username,secretRef:redirectRef}}};
  const failedOperation=randomUUID();await expect(buildSource(redirectService,failedOperation,data,'/unused',vault)).rejects.toThrow('git failed');
  expect(redirectedRequests).toBe(0);expect(readFileSync(buildLogPath(data,id,failedOperation),'utf8')).not.toContain(token);
},30000);
