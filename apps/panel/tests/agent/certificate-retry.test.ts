import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Docker from 'dockerode';
import { createAgent } from '../../src/agent/app.js';
import { DockerRuntime } from '../../src/agent/runtime.js';
import { httpsRouteLabels } from '../../src/agent/https-routing.js';
import { inspectManagedCertificate } from '../../src/agent/managed-certificate.js';

vi.mock('../../src/agent/managed-certificate.js',async importOriginal=>({...await importOriginal<object>(),inspectManagedCertificate:vi.fn()}));
const cleanups:(()=>unknown|Promise<unknown>)[]=[];
afterEach(async()=>{for(const fn of cleanups.splice(0).reverse())await fn();vi.resetAllMocks();});
const id='64150ff3-fc4c-4c33-b79a-4821482be3c1',host='app.example.com',headers={authorization:'Bearer agent-test-token'};
async function fixture() {
  const dir=mkdtempSync(join(tmpdir(),'agent-cert-retry-'));cleanups.push(()=>rmSync(dir,{recursive:true,force:true}));
  const runtime=new DockerRuntime('/unused',80,'unused',dir);
  vi.spyOn(runtime,'status').mockResolvedValue({online:true,httpsConfigured:true});
  let version=1,spec:Docker.ServiceSpec={Name:`panel-app-${id}`,Labels:{'panel.owner':'self-hosted-panel','panel.service':id,...httpsRouteLabels(id,0,host,80)},TaskTemplate:{ContainerSpec:{Image:'test'}}};
  const update=vi.fn(async(value:Docker.ServiceSpec & {version:number})=>{expect(value.version).toBe(version);const {version:_,...next}=value;spec=next;version++;});
  (runtime.docker as any).getService=()=>({inspect:async()=>({Spec:structuredClone(spec),Version:{Index:version}}),update});
  const app=await createAgent({dataDir:dir,token:'agent-test-token',socketPath:join(dir,'agent.sock'),dockerSocket:'/unused',ingressPort:80,ingressImage:'unused'},runtime);cleanups.push(()=>app.close());
  const send=(hostname=host)=>app.inject({method:'POST',url:'/certificates/retry',headers,payload:{serviceId:id,hostname}});
  return {app,send,update};
}
it('retries a missing certificate once and enforces the durable cooldown',async()=>{
  vi.mocked(inspectManagedCertificate).mockResolvedValue({status:'not_found'});
  const {send,update}=await fixture();
  const result=await send();expect(result.statusCode).toBe(200);expect(result.json().accepted).toBe(true);expect(update).toHaveBeenCalledTimes(1);
  const repeat=await send();expect(repeat.statusCode).toBe(409);expect(repeat.json().error.code).toBe('RETRY_COOLDOWN');expect(update).toHaveBeenCalledTimes(1);
});
it('does not touch another route or a certificate already stored',async()=>{
  vi.mocked(inspectManagedCertificate).mockResolvedValue({status:'active',notBefore:'2026-01-01T00:00:00.000Z',expiresAt:'2027-01-01T00:00:00.000Z',fingerprint:Array(32).fill('AA').join(':')});
  const {send,update}=await fixture();
  expect((await send('other.example.com')).statusCode).toBe(409);
  expect((await send()).statusCode).toBe(409);
  expect(update).not.toHaveBeenCalled();
});
it('serializes concurrent retries for the same service',async()=>{
  let entered!:()=>void,finish!:(value:{status:'not_found'})=>void;
  const started=new Promise<void>(resolve=>{entered=resolve;}),pending=new Promise<{status:'not_found'}>(resolve=>{finish=resolve;});
  vi.mocked(inspectManagedCertificate).mockImplementation(async()=>{entered();return pending;});
  const {send,update}=await fixture();
  const first=send();await started;
  const second=await send();expect(second.statusCode).toBe(409);expect(second.json().error.code).toBe('RETRY_BUSY');
  finish({status:'not_found'});expect((await first).statusCode).toBe(200);expect(update).toHaveBeenCalledTimes(1);
});
