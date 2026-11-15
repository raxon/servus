import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
vi.mock('../../src/agent/database-export.js',async(importOriginal)=>({...await importOriginal<typeof import('../../src/agent/database-export.js')>(),exportDatabase:vi.fn()}));
import { DatabaseExportUncertainError, exportDatabase } from '../../src/agent/database-export.js';
import { createAgent } from '../../src/agent/app.js';
import { AgentMaintenanceGate } from '../../src/agent/maintenance.js';

const cleanup:(()=>Promise<void>|void)[]=[];
afterEach(async()=>{for(const fn of cleanup.splice(0).reverse())await fn();vi.resetAllMocks();});
async function fixture(maintenance?:AgentMaintenanceGate){
  const dataDir=mkdtempSync(join(tmpdir(),'agent-export-'));cleanup.push(()=>rmSync(dataDir,{recursive:true,force:true}));
  const config={dataDir,token:'test-token',socketPath:join(dataDir,'sock'),dockerSocket:'/unused',ingressPort:18080,ingressImage:'unused'};
  const container={id:'a'.repeat(64),inspect:vi.fn(async()=>({Config:{Env:['POSTGRES_DB=fixture','POSTGRES_USER=fixture']}}))};
  const runtime={status:async()=>({online:true}),inspectService:async()=>({state:'unknown' as const}),apply:async()=>({state:'running' as const,deployedRevision:1,messages:[]}),consoleContainer:vi.fn(async()=>container)};
  const app=await createAgent(config,runtime as never,maintenance);cleanup.push(()=>app.close());
  return {app,container,runtime,id:randomUUID()};
}
const body={kind:'postgres',database:'fixture',user:'fixture'};
const headers={authorization:'Bearer test-token'};

it('checks agent authentication and the running database identity',async()=>{
  const {app,id,container}=await fixture();
  expect((await app.inject({method:'POST',url:`/services/${id}/database-export`,payload:body})).statusCode).toBe(401);
  container.inspect.mockResolvedValue({Config:{Env:['POSTGRES_DB=other','POSTGRES_USER=fixture']}});
  expect((await app.inject({method:'POST',url:`/services/${id}/database-export`,headers,payload:body})).statusCode).toBe(422);
  expect(exportDatabase).not.toHaveBeenCalled();
});

it('blocks maintenance when an interrupted export may still run in the container',async()=>{
  const maintenance=new AgentMaintenanceGate();
  const {app,id}=await fixture(maintenance);
  vi.mocked(exportDatabase).mockRejectedValue(new DatabaseExportUncertainError('Export state unknown'));
  expect((await app.inject({method:'POST',url:`/services/${id}/database-export`,headers,payload:body})).statusCode).toBe(422);
  expect(await maintenance.drain(1000)).toEqual({status:'uncertain'});
});

it('streams the completed export and releases its resources',async()=>{
  const {app,id}=await fixture(),close=vi.fn();
  vi.mocked(exportDatabase).mockResolvedValue({size:4,extension:'dump',stream:()=>Readable.from([Buffer.from('data')]) as never,close});
  const response=await app.inject({method:'POST',url:`/services/${id}/database-export`,headers,payload:body});
  expect(response.statusCode).toBe(200);expect(response.rawPayload.toString()).toBe('data');
  expect(response.headers['x-export-extension']).toBe('dump');expect(close).toHaveBeenCalledOnce();
});

it('does not let a rejected concurrent request release the active export lock',async()=>{
  const {app,id}=await fixture();let finish!:(value:Awaited<ReturnType<typeof exportDatabase>>)=>void;
  vi.mocked(exportDatabase).mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
  const request=app.inject({method:'POST',url:`/services/${id}/database-export`,headers,payload:body});
  await vi.waitFor(()=>expect(exportDatabase).toHaveBeenCalledOnce());
  for(let i=0;i<2;i++)expect((await app.inject({method:'POST',url:`/services/${id}/database-export`,headers,payload:body})).statusCode).toBe(409);
  finish({size:1,extension:'dump',stream:()=>Readable.from(['x']) as never,close:()=>{}});
  expect((await request).statusCode).toBe(200);
});
