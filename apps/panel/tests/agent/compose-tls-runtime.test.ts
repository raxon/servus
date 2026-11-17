import {afterEach,describe,it,expect,vi} from 'vitest';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {ComposeRuntime} from '../../src/agent/compose.js';
import type {ComposeApplyRequest} from '../../src/shared/compose.js';
const tls=vi.hoisted(()=>({ingress:vi.fn(async()=>{}),certificate:vi.fn()}));
vi.mock('../../src/agent/compose-tls.js',async original=>({...await original<object>(),assertComposeHttpsIngress:tls.ingress,composeCertificateStatus:tls.certificate}));
const cleanup:(()=>void)[]=[];afterEach(()=>{for(const close of cleanup.splice(0).reverse())close();vi.clearAllMocks();});
function fixture(){
  const root=mkdtempSync(join(tmpdir(),'servus-compose-tls-')),runtime=new ComposeRuntime({dataDir:root,token:'fixture',socketPath:join(root,'agent.sock'),dockerSocket:'/unused',ingressPort:80,ingressImage:'unused'});
  cleanup.push(()=>{runtime.close();rmSync(root,{recursive:true,force:true});});
  vi.spyOn(runtime.docker,'listContainers').mockResolvedValue([]);vi.spyOn(runtime.docker,'getNetwork').mockImplementation((name:any)=>({inspect:async()=>{if(name!=='panel-ingress')throw{statusCode:404};return {Labels:{'panel.owner':'self-hosted-panel'},Attachable:true};}} as never));
  const definitions:any[]=[],run=vi.spyOn(runtime as any,'run').mockImplementation(async(_cmd:any,args:any)=>{definitions.push(JSON.parse(readFileSync(args[args.indexOf('--file')+1],'utf8')));return'completed';});
  const request:ComposeApplyRequest={operationId:randomUUID(),workloadId:randomUUID(),projectId:randomUUID(),type:'deploy',revision:1,configuration:{source:{type:'inline',yaml:'services: {web: {image: nginx:alpine}}'},domains:[{hostname:'compose.example.test',service:'web',port:80,https:true}]}};
  tls.certificate.mockResolvedValue({status:'not_found',publicVerified:false});return{runtime,request,run,definitions};
}
describe('Compose TLS durable operations',()=>{
  it('keeps HTTP until the deployed certificate and public route are verified',async()=>{
    const f=fixture(),redirect={...f.request,configuration:{...f.request.configuration,domains:f.request.configuration.domains.map(domain=>({...domain,redirectHttps:true}))}};
    await expect(f.runtime.apply(redirect)).rejects.toMatchObject({code:'HTTPS_REDIRECT_UNVERIFIED'});expect(f.run).not.toHaveBeenCalled();
    await f.runtime.apply({...f.request,operationId:randomUUID()});
    tls.certificate.mockResolvedValue({status:'active',publicVerified:false});
    await expect(f.runtime.apply({...redirect,operationId:randomUUID(),revision:2})).rejects.toMatchObject({code:'HTTPS_REDIRECT_UNVERIFIED'});expect(f.run).toHaveBeenCalledTimes(1);
    tls.certificate.mockResolvedValue({status:'active',publicVerified:true});await f.runtime.apply({...redirect,operationId:randomUUID(),revision:2});expect(f.run).toHaveBeenCalledTimes(2);
  });
  it('retries the pinned deployment and retains its cooldown through ordinary deployments',async()=>{
    const f=fixture();await f.runtime.apply(f.request);
    const source=vi.spyOn(f.runtime as any,'source').mockRejectedValue(new Error('Must not read pending source'));
    const retry={...f.request,operationId:randomUUID(),revision:99,configuration:{...f.request.configuration,source:{type:'inline' as const,yaml:'services: {web: {image: alpine:3.21}}'}},certificateRetry:{hostname:'compose.example.test'}};
    expect((await f.runtime.apply(retry)).revision).toBe(1);expect(source).not.toHaveBeenCalled();expect(f.definitions[1].services.web.image).toBe('nginx:alpine');
    await expect(f.runtime.apply({...retry,operationId:randomUUID()})).rejects.toMatchObject({code:'RETRY_COOLDOWN'});expect(f.run).toHaveBeenCalledTimes(2);
    source.mockRestore();await f.runtime.apply({...f.request,operationId:randomUUID(),revision:2});
    await expect(f.runtime.apply({...retry,operationId:randomUUID()})).rejects.toMatchObject({code:'RETRY_COOLDOWN'});expect(f.run).toHaveBeenCalledTimes(3);
  });
  it('rolls a failed TLS configuration back to its prior routes',async()=>{
    const f=fixture();await f.runtime.apply(f.request);
    const pending={...f.request,operationId:randomUUID(),revision:2,configuration:{...f.request.configuration,domains:[{hostname:'replacement.example.test',service:'web',port:80,https:true}]}};
    f.run.mockRejectedValueOnce(new Error('fixture update failed'));await expect(f.runtime.apply(pending)).rejects.toThrow('fixture update failed');
    expect(f.run).toHaveBeenCalledTimes(3);const restored=JSON.stringify(f.definitions.at(-1));expect(restored).toContain('compose.example.test');expect(restored).not.toContain('replacement.example.test');
    expect(f.runtime.journal.prepare('SELECT state FROM compose_operations WHERE id=?').get(pending.operationId)).toEqual({state:'failed'});
  });
  it('refuses an existing resource labeled for another project before invoking Compose',async()=>{
    const f=fixture();vi.mocked(f.runtime.docker.listContainers).mockResolvedValue([{Labels:{'panel.owner':'self-hosted-panel','panel.workload':f.request.workloadId,'panel.project':randomUUID()}}] as never);
    await expect(f.runtime.apply(f.request)).rejects.toThrow('require recovery');expect(f.run).not.toHaveBeenCalled();
    // An ownership conflict also fences cleanup instead of deleting foreign data.
    expect(f.runtime.journal.prepare('SELECT state FROM compose_operations').get()).toEqual({state:'running'});
  });
});
