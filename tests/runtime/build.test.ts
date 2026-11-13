import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { join, resolve, sep, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { buildSource, buildLogPath } from '../../src/agent/build.js';
import { SecretVault } from '../../src/shared/secrets.js';
import type { Service } from '../../src/shared/types.js';

const cleanup:(()=>unknown|Promise<unknown>)[]=[];
afterEach(async()=>{for(const fn of cleanup.splice(0).reverse())await fn();vi.unstubAllEnvs();});
it('pins Git source across retries, passes commit metadata and never persists streamed secret output',async()=>{
  const root=mkdtempSync(join(tmpdir(),'panel-git-build-'));cleanup.push(()=>rmSync(root,{recursive:true,force:true}));
  const source=join(root,'source'),httpRoot=join(root,'http'),bare=join(httpRoot,'control.git'),bin=join(root,'bin'),dataDir=join(root,'data'),calls=join(root,'calls');
  for(const directory of[source,httpRoot,bin,dataDir])mkdirSync(directory,{recursive:true});
  const git=(args:string[],cwd=source)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  git(['init','-b','main']);writeFileSync(join(source,'Dockerfile'),'FROM scratch\nARG SOURCE_COMMIT\n');git(['add','.']);git(['-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-m','first']);
  const first=git(['rev-parse','HEAD']);git(['clone','--bare',source,bare],root);git(['--git-dir',bare,'update-server-info'],root);
  const server=createServer((req,res)=>{
    const path=resolve(httpRoot,'.'+new URL(req.url||'/', 'http://fixture').pathname);
    if(!path.startsWith(httpRoot+sep)){res.writeHead(404).end();return;}
    try{const content=readFileSync(path);res.writeHead(200,{'content-type':'text/plain','content-length':content.length});res.end(content);}catch{res.writeHead(404).end();}
  });
  await new Promise<void>(resolvePromise=>server.listen(0,'127.0.0.1',resolvePromise));cleanup.push(()=>new Promise<void>((resolvePromise,reject)=>server.close(error=>error?reject(error):resolvePromise())));
  const port=(server.address() as {port:number}).port;
  const script=`#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n');const ref=args.find(value=>value.startsWith('id='));if(ref){const value=fs.readFileSync(ref.split('src=')[1]);process.stdout.write(value.subarray(0,5));setTimeout(()=>process.stdout.write(Buffer.concat([value.subarray(5),Buffer.from('\\n')])),10);}else console.log('build complete');`;
  writeFileSync(join(bin,'docker'),script,{mode:0o755});
  vi.stubEnv('PATH',bin+delimiter+(process.env.PATH||''));
  vi.stubEnv('PANEL_GIT_HTTP_HOSTS','127.0.0.1');
  const vault=new SecretVault(dataDir),secret='sensitive-build-token',reference=vault.put(secret),operationId=randomUUID();
  const service:Service={id:randomUUID(),projectId:randomUUID(),name:'git',image:'unused',hostname:'git.localhost',port:80,replicas:1,revision:1,deployedRevision:null,state:'pending',createdAt:'now',updatedAt:'now',lastError:null,
    source:{type:'git',repository:`http://127.0.0.1:${port}/control.git`,branch:'main',context:'.',dockerfile:'Dockerfile'},environment:[{name:'BUILD_SECRET',secret:true,secretRef:reference}]};
  const built=await buildSource(service,operationId,dataDir,'/unused',vault);expect(built.sourceCommit).toBe(first);
  const logs=readFileSync(buildLogPath(dataDir,service.id,operationId),'utf8');expect(logs).toContain('[REDACTED]');expect(logs).not.toContain(secret);
  writeFileSync(join(source,'new-file'),'second');git(['add','.']);git(['-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-m','second']);git(['--git-dir',bare,'fetch',source,'main:main'],root);git(['--git-dir',bare,'update-server-info'],root);
  expect(git(['rev-parse','HEAD'])).not.toBe(first);
  git(['--git-dir',bare,'update-ref','-d','refs/heads/main'],root);git(['--git-dir',bare,'update-server-info'],root);
  const retried=await buildSource(service,operationId,dataDir,'/unused',vault);expect(retried.sourceCommit).toBe(first);
  const args=readFileSync(calls,'utf8').trim().split('\n').map(line=>JSON.parse(line) as string[]);expect(args).toHaveLength(2);
  for(const call of args){expect(call).toContain(`SOURCE_COMMIT=${first}`);expect(call).toContain(`panel.source.commit=${first}`);expect(JSON.stringify(call)).not.toContain(secret);}
  expect(statSync(join(dataDir,'source-revisions',operationId)).mode&0o777).toBe(0o600);
});
