import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createAgent } from '../../src/agent/app.js';

const cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
it('requires agent authentication and bounded port candidates before inspecting the local runtime',async()=>{
  const dataDir=mkdtempSync(join(tmpdir(),'agent-port-suggestion-'));
  const runtime={status:vi.fn(),inspectService:vi.fn(),apply:vi.fn(),databasePortSuggestion:vi.fn(async()=>({port:15433}))};
  const app=await createAgent({dataDir,token:'test-token',socketPath:join(dataDir,'sock'),dockerSocket:'/unused',ingressPort:18080,ingressImage:'unused'},runtime as never);
  cleanup.push(async()=>{await app.close();rmSync(dataDir,{recursive:true,force:true});});
  const url=`/services/${randomUUID()}/database-port-suggestion`,headers={authorization:'Bearer test-token'};
  expect((await app.inject({method:'POST',url,payload:{candidates:[15432]}})).statusCode).toBe(401);
  for(const payload of [{candidates:[]},{candidates:Array(65).fill(15432)},{candidates:[22]},{candidates:[15432],host:'remote.test'}])expect((await app.inject({method:'POST',url,headers,payload})).statusCode).toBe(400);
  expect(runtime.databasePortSuggestion).not.toHaveBeenCalled();
  const response=await app.inject({method:'POST',url,headers,payload:{candidates:[15432,15433]}});
  expect(response.statusCode).toBe(200);expect(response.json()).toEqual({port:15433});
  expect(runtime.databasePortSuggestion).toHaveBeenCalledExactlyOnceWith([15432,15433]);
});
