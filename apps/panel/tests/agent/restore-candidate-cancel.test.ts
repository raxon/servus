import { afterEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { RestoreJournal } from '../../src/agent/restore-journal.js';
import { uploadRestoreArchive } from '../../src/agent/restore-upload.js';
import { cancelPreparedRestore } from '../../src/agent/restore-candidate-cancel.js';

const cleanup:(()=>void)[]=[];
afterEach(()=>{for(const remove of cleanup.splice(0).reverse())remove();});
async function fixture(){
  const dataDir=mkdtempSync(join(tmpdir(),'restore-candidate-cancel-'));cleanup.push(()=>rmSync(dataDir,{recursive:true,force:true}));
  const db=new Database(join(dataDir,'agent.sqlite'));db.exec('CREATE TABLE operations(id TEXT PRIMARY KEY,service_id TEXT,state TEXT)');cleanup.push(()=>db.close());
  const journal=new RestoreJournal(db,()=>false),operationId=randomBytes(16).toString('hex'),serviceId=randomUUID(),name=`panel-restore-${operationId}`,id='a'.repeat(64);
  await uploadRestoreArchive({journal,operationId,serviceId,dataDir,kind:'postgres',key:randomBytes(32),input:()=>Readable.from(['archive'])});
  journal.advance(operationId,'reserved','importing');journal.advance(operationId,'importing','prepared');
  const labels={'panel.restore.operation':operationId,'panel.restore.purpose':'candidate','panel.restore.service':serviceId};
  const info={Id:id,Config:{Labels:{...labels,'panel.owner':'self-hosted-panel'}},HostConfig:{NetworkMode:'none'},State:{Running:true},Mounts:[{Type:'volume',Name:name,Destination:'/var/lib/postgresql/data',RW:true}]};
  let containerPresent=true,volumePresent=true,other=false;
  const container={inspect:vi.fn(async()=>{if(!containerPresent)throw {statusCode:404};return info;}),stop:vi.fn(async()=>{info.State.Running=false;}),remove:vi.fn(async()=>{containerPresent=false;})};
  const volume={inspect:vi.fn(async()=>{if(!volumePresent)throw {statusCode:404};return {Name:name,Labels:labels};}),remove:vi.fn(async()=>{volumePresent=false;})};
  const docker={getContainer:vi.fn(()=>container),getVolume:vi.fn(()=>volume),listContainers:vi.fn(async()=>[...(containerPresent?[{Id:id}]:[]),...(other?[{Id:'b'.repeat(64)}]:[])])};
  return {dataDir,journal,operationId,serviceId,docker:docker as never,info,container,volume,setOther:(value:boolean)=>{other=value;},path:join(dataDir,'restore-archives',`${operationId}.enc`)};
}

it('stops the owned candidate, removes only its volume and clears the fence after deleting the archive',async()=>{
  const f=await fixture();expect((await cancelPreparedRestore(f)).phase).toBe('cancelled');
  expect(f.container.stop).toHaveBeenCalledOnce();expect(f.container.remove).toHaveBeenCalledOnce();expect(f.volume.remove).toHaveBeenCalledOnce();
  expect(existsSync(f.path)).toBe(false);expect(f.journal.hasUnresolved(f.serviceId)).toBe(false);
  expect((await cancelPreparedRestore(f)).phase).toBe('cancelled');
});

it('retains the fence if the volume is attached elsewhere and can retry after recovery',async()=>{
  const f=await fixture();f.setOther(true);
  await expect(cancelPreparedRestore(f)).rejects.toThrow('another container');
  expect(f.container.stop).not.toHaveBeenCalled();expect(f.volume.remove).not.toHaveBeenCalled();
  expect(f.journal.get(f.operationId)?.phase).toBe('discarding_candidate');
  f.setOther(false);expect((await cancelPreparedRestore(f)).phase).toBe('cancelled');
});

it('never removes a candidate whose labels or mounts changed',async()=>{
  const f=await fixture();f.info.Config.Labels['panel.restore.service']=randomUUID();
  await expect(cancelPreparedRestore(f)).rejects.toThrow('ownership');expect(f.container.remove).not.toHaveBeenCalled();expect(f.volume.remove).not.toHaveBeenCalled();
  expect(f.journal.hasUnresolved(f.serviceId)).toBe(true);
});

it('resumes after the candidate was removed and keeps the fence on Docker failure',async()=>{
  const f=await fixture();f.volume.remove.mockRejectedValueOnce(new Error('synthetic daemon failure'));
  await expect(cancelPreparedRestore(f)).rejects.toThrow('daemon failure');expect(f.journal.get(f.operationId)?.phase).toBe('discarding_candidate');
  expect((await cancelPreparedRestore(f)).phase).toBe('cancelled');
});
