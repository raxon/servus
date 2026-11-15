// Exercise the release image against a disposable authenticated HTTPS Git server and a real Docker build.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:https';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { buildSource, buildLogPath } from '/app/dist/agent/build.js';
import { SecretVault } from '/app/dist/shared/secrets.js';

const require=createRequire('/app/package.json');
const Database=require('better-sqlite3');
const root=process.env.SERVUS_FIXTURE_DIR;
if (!root || !/^\/tmp\/servus-private-git-[a-f0-9]{32}$/.test(root)) throw new Error('A disposable fixture directory is required');
const source=join(root,'source'),repos=join(root,'repos'),bare=join(repos,'private.git'),data=join(root,'data');
for (const path of [source,repos,data]) mkdirSync(path,{mode:0o700});
const git=(args,cwd=source)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
git(['init','-b','main']);
writeFileSync(join(source,'Dockerfile'),'FROM scratch\nCOPY proof /proof\n');
writeFileSync(join(source,'proof'),'servus-private-git-fixture\n');
git(['add','.']);git(['-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-m','fixture']);
const commit=git(['rev-parse','HEAD']);git(['clone','--bare',source,bare],root);
const username='fixture',token=randomUUID(),authorization='Basic '+Buffer.from(`${username}:${token}`).toString('base64');
let authenticated=0;
const server=createServer({key:readFileSync(join(root,'key.pem')),cert:readFileSync(join(root,'cert.pem'))},(req,res)=>{
  if(req.headers.authorization!==authorization){res.writeHead(401,{'WWW-Authenticate':'Basic realm="fixture"'}).end();return;}
  authenticated++;
  const url=new URL(req.url,'https://fixture');
  const cgi=spawn('git',['http-backend'],{env:{PATH:'/usr/bin:/bin',GIT_PROJECT_ROOT:repos,GIT_HTTP_EXPORT_ALL:'1',PATH_INFO:url.pathname,QUERY_STRING:url.search.slice(1),REQUEST_METHOD:req.method,CONTENT_TYPE:req.headers['content-type']??'',CONTENT_LENGTH:req.headers['content-length']??'',REMOTE_USER:username},stdio:['pipe','pipe','pipe']});
  req.pipe(cgi.stdin);let pending=Buffer.alloc(0),started=false;
  cgi.stdout.on('data',chunk=>{
    if(started){res.write(chunk);return;}
    pending=Buffer.concat([pending,chunk]);let at=pending.indexOf('\r\n\r\n'),skip=4;
    if(at<0){at=pending.indexOf('\n\n');skip=2;}if(at<0)return;
    let status=200;const headers={};
    for(const line of pending.subarray(0,at).toString().split(/\r?\n/)){
      const n=line.indexOf(':');if(n<0)continue;
      const name=line.slice(0,n).trim(),value=line.slice(n+1).trim();
      if(name.toLowerCase()==='status')status=Number(value.slice(0,3));else headers[name]=value;
    }
    res.writeHead(status,headers);res.write(pending.subarray(at+skip));started=true;
  });
  cgi.on('close',()=>{if(!started)res.writeHead(500);res.end();});
  cgi.on('error',()=>{if(!res.headersSent)res.writeHead(500);res.end();});
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const repository=`https://127.0.0.1:${server.address().port}/private.git`;
process.env.PANEL_GIT_HTTP_HOSTS='127.0.0.1';process.env.PANEL_GIT_TEST_CA=join(root,'cert.pem');
const vault=new SecretVault(data),id=randomUUID(),operationId=randomUUID();
const secretRef=vault.put(JSON.stringify({kind:'git-credential-v1',serviceId:id,repository,username,token}));
const db=new Database(join(data,'panel.sqlite'));
db.exec('CREATE TABLE service_secret_refs(reference TEXT PRIMARY KEY,service_id TEXT NOT NULL,purpose TEXT NOT NULL); PRAGMA user_version=5');
db.prepare('INSERT INTO service_secret_refs VALUES (?,?,?)').run(secretRef,id,'git');db.close();
const service={id,projectId:randomUUID(),name:'fixture',image:'unused',hostname:'fixture.localhost',port:80,replicas:1,revision:1,deployedRevision:null,state:'pending',createdAt:'now',updatedAt:'now',lastError:null,source:{type:'git',repository,branch:'main',context:'.',dockerfile:'Dockerfile',credential:{username,secretRef}}};
try {
  const result=await buildSource(service,operationId,data,'/var/run/docker.sock',vault);
  assert.equal(result.sourceCommit,commit);assert.equal(result.image,`panel-build:${operationId}`);assert.ok(authenticated>0);
  const inspect=JSON.parse(execFileSync('docker',['image','inspect',result.image],{encoding:'utf8'}))[0];
  assert.equal(inspect.Config.Labels['panel.source.commit'],commit);
  const log=readFileSync(buildLogPath(data,id,operationId),'utf8');
  assert.ok(!log.includes(token)&&!log.includes(authorization));
  console.log('PASS authenticated HTTPS Git clone and real Docker image build');
} finally {
  await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  const image=`panel-build:${operationId}`;
  let inspected;
  try {inspected=JSON.parse(execFileSync('docker',['image','inspect',image],{encoding:'utf8',stdio:['ignore','pipe','ignore']}))[0];}
  catch(error) {if(error.status!==1)throw error;}
  if(inspected){
    assert.equal(inspected.Config.Labels['panel.service'],id);
    execFileSync('docker',['image','rm',image],{stdio:'ignore'});
  }
}
