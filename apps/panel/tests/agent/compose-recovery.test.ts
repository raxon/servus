import {afterEach,describe,expect,it,vi} from 'vitest';
import {createHash,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ComposeRuntime} from '../../src/agent/compose.js';
import {parseComposeDefinition} from '../../src/agent/compose-configuration.js';
import type {ComposeApplyRequest} from '../../src/shared/compose.js';

const cleanup:(()=>Promise<void>|void)[]=[];afterEach(async()=>{for(const dispose of cleanup.splice(0).reverse())await dispose();});
function fixture(){const root=mkdtempSync(join(tmpdir(),'servus-compose-recovery-')),runtime=new ComposeRuntime({dataDir:root,token:'fixture',socketPath:join(root,'agent.sock'),dockerSocket:'/unused',ingressPort:18080,ingressImage:'unused'});cleanup.push(()=>{runtime.close();rmSync(root,{recursive:true,force:true});});
  const request:ComposeApplyRequest={operationId:randomUUID(),workloadId:randomUUID(),projectId:randomUUID(),revision:1,type:'deploy',configuration:{source:{type:'git',repository:'https://github.com/example/app.git',branch:'main',path:'compose.yaml'},domains:[]}};
  const definition=parseComposeDefinition('services: {web: {image: "nginx:1.28-alpine", environment: {TOKEN: q}}}');
  runtime.journal.prepare("INSERT INTO compose_operations(id,workload_id,project_id,type,request_hash,state,snapshot,updated_at)VALUES(?,?,?,?,?,'running',?,?)").run(request.operationId,request.workloadId,request.projectId,request.type,createHash('sha256').update(JSON.stringify(request)).digest('hex'),runtime.vault.seal(JSON.stringify({request,definition,commit:'a'.repeat(40)})),new Date().toISOString());
  vi.spyOn(runtime.docker,'listContainers').mockResolvedValue([]);vi.spyOn(runtime.docker,'getNetwork').mockReturnValue({inspect:async()=>{throw{statusCode:404};}} as never);
  return{runtime,request};}
describe('Compose operation recovery',()=>{
  it('reuses the sealed prepared Git definition and cached result instead of fetching a changed branch',async()=>{
    const f=fixture(),source=vi.spyOn(f.runtime as any,'source').mockRejectedValue(new Error('Git must not be fetched again'));let seen:any;
    const run=vi.spyOn(f.runtime as any,'run').mockImplementation(async(_command:any,args:any)=>{seen=JSON.parse(readFileSync(args[args.indexOf('--file')+1],'utf8'));return'completed';});
    const result=await f.runtime.apply(f.request);expect(result.state).toBe('running');expect(seen.services.web.image).toBe('nginx:1.28-alpine');expect(source).not.toHaveBeenCalled();
    expect(await f.runtime.apply(f.request)).toEqual(result);expect(run).toHaveBeenCalledTimes(1);
    await expect(f.runtime.apply({...f.request,revision:2})).rejects.toThrow('reused for different input');
    expect(JSON.stringify(f.runtime.journal.prepare('SELECT snapshot FROM compose_operations').all())).not.toContain('nginx:1.28-alpine');
  });
  it('refuses overlapping recovery while the journaled CLI process group is alive',async()=>{
    const f=fixture(),child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});await new Promise<void>((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});let stopped=false;
    const stop=async()=>{if(stopped)return;stopped=true;const closed=new Promise<void>(resolve=>child.once('close',()=>resolve()));process.kill(-child.pid!,'SIGKILL');await closed;};cleanup.push(stop);
    f.runtime.journal.prepare('UPDATE compose_operations SET process_group=? WHERE id=?').run(child.pid!,f.request.operationId);
    const run=vi.spyOn(f.runtime as any,'run').mockResolvedValue('completed');
    await expect(f.runtime.apply(f.request)).rejects.toThrow('still running');expect(run).not.toHaveBeenCalled();
    await stop();expect((await f.runtime.apply(f.request)).state).toBe('running');expect(run).toHaveBeenCalledTimes(1);
  });
  it('redacts short explicit environment values from persisted failures',async()=>{
    const f=fixture();vi.spyOn(f.runtime as any,'run').mockRejectedValueOnce(new Error('secret q failed')).mockResolvedValue('initial failed deployment removed; volumes retained');
    await expect(f.runtime.apply(f.request)).rejects.toThrow('secret [REDACTED] failed');
    expect(f.runtime.journal.prepare('SELECT error,state FROM compose_operations').get()).toEqual({error:'secret [REDACTED] failed',state:'failed'});
  });
  it('resumes a failed rollback before allowing a new deployment',async()=>{
    const f=fixture(),run=vi.spyOn(f.runtime as any,'run').mockRejectedValue(new Error('secret q failed'));
    await expect(f.runtime.apply(f.request)).rejects.toThrow('require recovery');
    expect(f.runtime.journal.prepare('SELECT state FROM compose_operations').get()).toEqual({state:'running'});
    const saved=f.runtime.journal.prepare('SELECT snapshot FROM compose_operations').get() as {snapshot:string};
    expect(JSON.parse(f.runtime.vault.open(saved.snapshot))).toMatchObject({stage:'rolling_back',failure:'secret [REDACTED] failed'});
    await expect(f.runtime.apply({...f.request,operationId:randomUUID()})).rejects.toThrow('requires recovery');
    run.mockResolvedValue('removed failed initial deployment');
    await expect(f.runtime.apply(f.request)).rejects.toThrow('secret [REDACTED] failed');
    expect(f.runtime.journal.prepare('SELECT state FROM compose_operations').get()).toEqual({state:'failed'});
    expect(run).toHaveBeenCalledTimes(3);
  });
});
