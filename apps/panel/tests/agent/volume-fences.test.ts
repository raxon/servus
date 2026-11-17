import { afterEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgent } from '../../src/agent/app.js';
import { AgentMaintenanceGate } from '../../src/agent/maintenance.js';
import { SecretVault } from '../../src/shared/secrets.js';
const cleanup:(()=>void|Promise<void>)[]=[];
afterEach(async()=>{for(const fn of cleanup.splice(0).reverse())await fn();});
async function fixture(){
  const dataDir=mkdtempSync(join(tmpdir(),'volume-fences-'));cleanup.push(()=>rmSync(dataDir,{recursive:true,force:true}));
  const gate=new AgentMaintenanceGate(),apply=vi.fn(async()=>({state:'running' as const,deployedRevision:1,messages:[]})),consoleContainer=vi.fn();
  const app=await createAgent({dataDir,token:'volume-test',socketPath:join(dataDir,'agent.sock'),dockerSocket:'/never-connect',ingressPort:18080,ingressImage:'unused'},{status:async()=>({online:true}),inspectService:async()=>({state:'unknown'}),apply,consoleContainer},gate);
  await app.ready();cleanup.push(()=>app.close());return{app,gate,apply,consoleContainer,dataDir};
}
it('refuses lifecycle changes and new terminal sessions while a volume switch needs recovery',async()=>{
  const f=await fixture(),serviceId=randomUUID(),operationId=randomUUID(),db=new Database(join(f.dataDir,'agent.sqlite')),stamp=new Date().toISOString();
  db.prepare('INSERT INTO volume_restore_operations VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(operationId,serviceId,randomUUID(),'/data','data','needs_review',new SecretVault(f.dataDir).seal('{}'),`panel-volume-restore-${operationId}`,`panel-data-${serviceId}-data`,null,stamp,stamp);db.close();
  const service={id:serviceId,projectId:randomUUID(),name:'web',image:'alpine',hostname:'web.localhost',port:80,replicas:1,revision:1,deployedRevision:1,state:'running',createdAt:stamp,updatedAt:stamp,lastError:null};
  const headers={authorization:'Bearer volume-test'};
  const response=await f.app.inject({method:'POST',url:'/services/apply',headers,payload:{operationId:randomUUID(),type:'restart',service}});
  expect(response.statusCode).toBe(409);expect(response.json().error.code).toBe('SERVICE_BUSY');expect(f.apply).not.toHaveBeenCalled();
  const terminal=await f.app.inject({method:'GET',url:`/services/${serviceId}/console`,headers});expect(terminal.statusCode).toBe(409);expect(f.consoleContainer).not.toHaveBeenCalled();
  expect(await f.gate.drain(100)).toEqual({status:'uncertain'});
});
it('does not allow an export or retry to bypass an interrupted volume capture',async()=>{
  const f=await fixture(),serviceId=randomUUID(),id=randomUUID(),db=new Database(join(f.dataDir,'agent.sqlite')),stamp=new Date().toISOString();
  db.prepare('INSERT INTO volume_backup_operations VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,serviceId,'/data','data',`panel-data-${serviceId}-data`,'capturing',new SecretVault(f.dataDir).seal('{}'),null,null,null,null,stamp,stamp);db.close();
  const headers={authorization:'Bearer volume-test'};
  const response=await f.app.inject({method:'POST',url:`/services/${serviceId}/database-export`,headers,payload:{kind:'postgres',database:'app',user:'app'}});
  expect(response.statusCode).toBe(409);expect(f.consoleContainer).not.toHaveBeenCalled();expect(await f.gate.drain(100)).toEqual({status:'uncertain'});
});
