import {afterEach,describe,it,expect,vi} from 'vitest';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,mkdirSync,readFileSync,readdirSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ComposeRuntime} from '../../src/agent/compose.js';
import {parseComposeDefinition,compileComposeDefinition} from '../../src/agent/compose-configuration.js';
import {composeBuildPath,stageComposeBuildContext} from '../../src/agent/compose-build.js';
import type {ComposeApplyRequest} from '../../src/shared/compose.js';
const cleanup:(()=>void)[]=[];afterEach(()=>{for(const dispose of cleanup.splice(0).reverse())dispose();vi.restoreAllMocks();});
function folder(){const path=mkdtempSync(join(tmpdir(),'servus-compose-build-'));cleanup.push(()=>rmSync(path,{recursive:true,force:true}));return path;}
const inline='services:\n  web:\n    build:\n      dockerfile_inline: |\n        FROM nginx:alpine\n      args: {MODE: fixture-build-argument}\n';
function fixture(){
  const root=folder(),runtime=new ComposeRuntime({dataDir:root,token:'fixture',socketPath:join(root,'agent.sock'),dockerSocket:'/unused',ingressPort:18080,ingressImage:'unused'});cleanup.push(()=>runtime.close());
  vi.spyOn(runtime.docker,'listContainers').mockResolvedValue([]);vi.spyOn(runtime.docker,'getNetwork').mockReturnValue({inspect:async()=>{throw{statusCode:404};}} as never);
  const images=new Map<string,any>(),compose:any[]=[],builds:any[]=[];
  vi.spyOn(runtime.docker,'getImage').mockImplementation((id:any)=>({inspect:async()=>{if(!images.has(id))throw{statusCode:404};return images.get(id);}} as never));
  const run=vi.spyOn(runtime as any,'run').mockImplementation(async(command:any,args:any,cwd:any,operationId:any,env:any)=>{
    if(command==='docker'&&args.includes('build')){
      const labels:Record<string,string>={};args.forEach((entry:string,i:number)=>{if(entry==='--label'){const value=args[i+1],at=value.indexOf('=');labels[value.slice(0,at)]=value.slice(at+1);}});
      const tag=args[args.indexOf('--tag')+1],Id='sha256:'+createHash('sha256').update(tag).digest('hex'),image={Id,Config:{Labels:labels}};images.set(tag,image);images.set(Id,image);
      builds.push({args,cwd,operationId,env,files:readdirSync(args.at(-1)),dockerfile:readFileSync(args[args.indexOf('--file')+1],'utf8')});return 'Built fixture-build-argument';
    }
    if(command==='docker'&&args.includes('compose')){compose.push(JSON.parse(readFileSync(args[args.indexOf('--file')+1],'utf8')));return'completed';}
    throw Error('Unexpected fixture command');
  });
  const request:ComposeApplyRequest={operationId:randomUUID(),workloadId:randomUUID(),projectId:randomUUID(),revision:1,type:'deploy',configuration:{source:{type:'inline',yaml:inline},domains:[]}};
  return{root,runtime,request,images,compose,builds,run};
}
describe('Compose Dockerfile build boundary',()=>{
  it.each(['build: /etc','build: https://example.test/context.git','build: {context: ., additional_contexts: {host: /etc}}','build: {context: ., privileged: true}','build: {context: ., ssh: [default]}','build: {context: ., args: [HOST_SECRET]}','build: {dockerfile: Dockerfile, dockerfile_inline: "FROM scratch"}'])('rejects unbounded or privileged build inputs: %s',build=>expect(()=>parseComposeDefinition(`services: {web: {${build}}}`,'git')).toThrow());
  it('distinguishes file based Git builds from empty inline Dockerfile contexts',()=>{
    expect(()=>parseComposeDefinition('services: {web: {build: .}}')).toThrow('Inline Compose builds');
    expect(()=>parseComposeDefinition('services: {web: {build: {context: ../outside, dockerfile_inline: "FROM scratch"}}}')).toThrow('empty context');
    const definition=parseComposeDefinition('services: {web: {build: {context: ../app, dockerfile: Dockerfile}}}','git');expect(definition.services.web!.image).toBeUndefined();
    expect(()=>compileComposeDefinition(definition,{source:{type:'git',repository:'https://github.com/example/repo',branch:'main',path:'compose/compose.yml'},domains:[]},randomUUID(),randomUUID())).toThrow('has not been resolved');
  });
  it('rejects escaped paths, link kinds and linked files before sending a context',()=>{
    const root=folder(),outside=folder(),staging=join(folder(),'context');writeFileSync(join(outside,'secret'),'host-proof');mkdirSync(join(root,'context'));writeFileSync(join(root,'context','Dockerfile'),'FROM scratch');mkdirSync(join(root,'context','.git'));writeFileSync(join(root,'context','.git','config'),'must-not-copy');
    expect(()=>composeBuildPath(root,root,'../outside','directory')).toThrow('inside the pinned checkout');
    symlinkSync(join(outside,'secret'),join(root,'context','link'));expect(()=>composeBuildPath(root,join(root,'context'),'link','file')).toThrow('symlinks');expect(()=>stageComposeBuildContext(join(root,'context'),staging)).toThrow('symlinks');
    rmSync(join(root,'context','link'));rmSync(staging,{recursive:true,force:true});stageComposeBuildContext(join(root,'context'),staging);expect(readdirSync(staging)).toEqual(['Dockerfile']);
  });
  it('builds with private CLI config, records actual image IDs, and never rebuilds lifecycle operations',async()=>{
    const f=fixture(),result=await f.runtime.apply(f.request);expect(f.builds).toHaveLength(1);expect(f.builds[0].files).toEqual([]);expect(f.builds[0].env.DOCKER_CONFIG).toContain(f.root);expect(f.builds[0].args).not.toContain('--allow');
    expect(f.compose[0].services.web).not.toHaveProperty('build');expect(f.compose[0].services.web.image).toMatch(/^sha256:/);expect(result.logs).not.toContain('fixture-build-argument');
    await f.runtime.apply({...f.request,type:'restart',operationId:randomUUID()});expect(f.builds).toHaveLength(1);expect(f.compose[1].services.web.image).toBe(f.compose[0].services.web.image);
    const row=f.runtime.journal.prepare('SELECT snapshot FROM compose_operations WHERE id=?').get(f.request.operationId) as {snapshot:string};expect(JSON.parse(f.runtime.vault.open(row.snapshot)).images.web.tag).toBe(`servus-compose-build:${f.request.operationId}-web`);
  });
  it('reuses a prepared commit and a completed image checkpoint when recovering',async()=>{
    const f=fixture();await f.runtime.apply(f.request);const image=f.compose[0].services.web.image;
    f.runtime.journal.prepare("UPDATE compose_operations SET state='running',response=NULL,process_group=NULL WHERE id=?").run(f.request.operationId);
    const source=vi.spyOn(f.runtime as any,'source').mockRejectedValue(new Error('Moving branch must not be fetched'));
    await f.runtime.apply(f.request);expect(source).not.toHaveBeenCalled();expect(f.builds).toHaveLength(1);expect(f.compose.at(-1).services.web.image).toBe(image);
  });
  it('refetches only a recorded Git commit for an interrupted build, and fails without that commit',async()=>{
    const f=fixture(),checkout=folder(),yaml='services: {web: {build: .}}';writeFileSync(join(checkout,'compose.yaml'),yaml);writeFileSync(join(checkout,'Dockerfile'),'FROM scratch');
    const request={...f.request,configuration:{source:{type:'git' as const,repository:'https://github.com/example/repo.git',branch:'main',path:'compose.yaml'},domains:[]}},definition=parseComposeDefinition(yaml,'git'),commit='a'.repeat(40);
    f.runtime.journal.prepare("INSERT INTO compose_operations(id,workload_id,project_id,type,request_hash,state,snapshot,updated_at)VALUES(?,?,?,?,?,'running',?,?)").run(request.operationId,request.workloadId,request.projectId,'deploy',createHash('sha256').update(JSON.stringify(request)).digest('hex'),f.runtime.vault.seal(JSON.stringify({request,definition,commit,stage:'prepared'})),new Date().toISOString());
    const source=vi.spyOn(f.runtime as any,'source').mockResolvedValue({definition,commit,checkout});await f.runtime.apply(request);expect(source).toHaveBeenCalledWith(request,expect.any(String),commit);
    const missing={...request,operationId:randomUUID()};f.runtime.journal.prepare("INSERT INTO compose_operations(id,workload_id,project_id,type,request_hash,state,snapshot,updated_at)VALUES(?,?,?,?,?,'running',?,?)").run(missing.operationId,missing.workloadId,missing.projectId,'deploy',createHash('sha256').update(JSON.stringify(missing)).digest('hex'),f.runtime.vault.seal(JSON.stringify({request:missing,definition,stage:'prepared'})),new Date().toISOString());
    source.mockClear();await expect(f.runtime.apply(missing)).rejects.toThrow('pinned Compose commit is missing');expect(source).not.toHaveBeenCalled();
  });
  it('allows a Dockerfile outside COPY context only inside the same pinned checkout',async()=>{
    const f=fixture(),checkout=folder(),yaml='services: {web: {build: {context: app, dockerfile: ../Dockerfile}}}';mkdirSync(join(checkout,'app'));writeFileSync(join(checkout,'app','version'),'context-proof');writeFileSync(join(checkout,'Dockerfile'),'FROM scratch');writeFileSync(join(checkout,'compose.yaml'),yaml);writeFileSync(join(checkout,'outside-context-proof'),'must-not-copy');
    const request={...f.request,configuration:{source:{type:'git' as const,repository:'https://github.com/example/repo.git',branch:'main',path:'compose.yaml'},domains:[]}};
    vi.spyOn(f.runtime as any,'source').mockResolvedValue({definition:parseComposeDefinition(yaml,'git'),commit:'a'.repeat(40),checkout});
    await f.runtime.apply(request);expect(f.builds[0].dockerfile).toBe('FROM scratch');expect(f.builds[0].files).toEqual(['version']);
  });
  it('treats valid service names as own checkpoint keys rather than inherited object fields',async()=>{
    const f=fixture();await f.runtime.apply({...f.request,configuration:{source:{type:'inline',yaml:inline.replace('web:','constructor:')},domains:[]}});expect(f.builds).toHaveLength(1);expect(f.compose[0].services.constructor.image).toMatch(/^sha256:/);
  });
  it('restores the prior immutable built image after a later deployment fails',async()=>{
    const f=fixture();await f.runtime.apply(f.request);const original=f.compose[0].services.web.image,realRun=f.run.getMockImplementation()!;
    f.run.mockImplementation(async(...args:any[])=>{if(args[1].includes('compose')&&args[1].includes('up')&&!args[1].includes('rollback.json')&&!String(args[1][args[1].indexOf('--file')+1]).endsWith('rollback.json'))throw Error('new deployment failed');return realRun(...args);});
    await expect(f.runtime.apply({...f.request,operationId:randomUUID(),revision:2})).rejects.toThrow('new deployment failed');expect(f.builds).toHaveLength(2);expect(f.compose.at(-1).services.web.image).toBe(original);
  });
});
