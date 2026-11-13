import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../../src/server/store.js';
import { Worker } from '../../src/worker/runner.js';
import { AgentRequestError } from '../../src/agent/client.js';
import type { Service } from '../../src/shared/types.js';

const cleanup: (()=>void)[]=[];
afterEach(()=>{for(const fn of cleanup.splice(0).reverse())fn();});
function fixture() {
  const dir=mkdtempSync(join(tmpdir(),'panel-worker-')),store=new Store(dir);
  cleanup.push(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const actor=store.createUser('admin@example.test','unused-test-hash','admin'),project=store.createProject('worker');
  const {service,action}=store.createService(project.id,{name:'web',image:'nginx:alpine',port:80,hostname:'worker.localhost'},actor.id);
  return {store,actor,project,service,action};
}
const success={state:'running' as const,deployedRevision:1,messages:['Confirmed healthy deployment.']};

describe('worker uncertain operation reconciliation',()=>{
  it('keeps its lease and retries transport timeouts with the same immutable request',async()=>{
    const {store,service,action}=fixture();
    const calls:{id:string;snapshot:Service}[]=[];
    const worker=new Worker(store,1000,{
      apply:async(id,snapshot)=>{
        calls.push({id,snapshot:{...snapshot}});
        if(calls.length===1)throw new AgentRequestError('Timed out','uncertain');
        return success;
      },
      wait:async()=>{
        expect(store.getAction(action.id)!.status).toBe('running');
        expect(store.getAction(action.id)!.phase).toBe('reconciling');
        store.updateService(service.id,{expectedRevision:1,image:'nginx:stable-alpine'});
        await delay(1100);
        expect(store.claimNextJob('another-worker',1000)).toBeNull();
      },
    });
    expect(await worker.once()).toBe(true);
    expect(calls).toHaveLength(2);expect(calls[0]).toEqual(calls[1]);expect(calls[0]!.id).toBe(action.id);
    expect(store.getAction(action.id)!.status).toBe('succeeded');
    expect(store.getService(service.id)!.revision).toBe(2);expect(store.getService(service.id)!.deployedRevision).toBe(1);
  });
  it('marks a definitive agent failure terminal and releases the service job',async()=>{
    const {store,actor,service,action}=fixture();
    const worker=new Worker(store,60000,{
      apply:async()=>{throw new AgentRequestError('Image pull was rejected','definitive',422,'RUNTIME_FAILED');},
      readState:async()=>({state:'unknown'}),
    });
    await worker.once();
    expect(store.getAction(action.id)!.status).toBe('failed');
    expect(store.createAction(service.id,'deploy',actor.id,'retry-after-terminal').id).not.toBe(action.id);
  });
  it('does not append logs or finalize a result after another worker owns the lease',async()=>{
    const {store,action}=fixture();
    const worker=new Worker(store,60000,{
      apply:async()=>{
        store.db.prepare("UPDATE jobs SET worker_id='new-owner',lease_until=? WHERE action_id=?").run(new Date(Date.now()+60000).toISOString(),action.id);
        return {...success,messages:['Stale worker must not publish this message']};
      },
    });
    await worker.once();
    expect(store.getAction(action.id)!.status).toBe('running');
    expect(store.getEvents(action.id).some(event=>event.message.includes('must not publish'))).toBe(false);
    expect(store.appendOwnedEvent(action.id,worker.id,'error','stale event')).toBe(false);
    expect(store.setActionPhase(action.id,worker.id,'failed')).toBe(false);
  });
  it('leaves an uncertain operation running on shutdown so another worker can recover it',async()=>{
    const {store,action}=fixture();let calls=0;
    const worker=new Worker(store,60000,{
      apply:async()=>{calls++;throw new AgentRequestError('Connection reset','uncertain');},
      wait:async()=>{worker.stopping=true;},
    });
    await worker.once();
    expect(calls).toBe(1);expect(store.getAction(action.id)!.status).toBe('running');
    expect(store.claimNextJob('recovering-worker',60000)).toBeNull();
    store.db.prepare('UPDATE jobs SET lease_until=? WHERE action_id=?').run('2000-01-01T00:00:00.000Z',action.id);
    const recovered=store.claimNextJob('recovering-worker',60000)!;
    expect(recovered.actionId).toBe(action.id);expect(recovered.recovered).toBe(true);
  });
  it('treats an unclassified connection error conservatively instead of releasing the job',async()=>{
    const {store,action}=fixture();
    const worker=new Worker(store,60000,{
      apply:async()=>{worker.stopping=true;throw new Error('Unexpected connection failure');},
    });
    await worker.once();
    expect(store.getAction(action.id)!.status).toBe('running');
    expect(store.getAction(action.id)!.phase).toBe('reconciling');
  });
  it('guards the late observation following a definite failure against a newer action',async()=>{
    const {store,actor,service,action}=fixture();
    const worker=new Worker(store,60000,{
      apply:async()=>{throw new AgentRequestError('Unhealthy image','definitive',422);},
      readState:async()=>{
        const next=store.createAction(service.id,'deploy',actor.id,'new-deploy');
        store.claimNextJob('next-worker',60000);
        store.completeAction(next.id,'next-worker',{state:'running',deployedRevision:1});
        return {state:'failed'};
      },
    });
    await worker.once();
    expect(store.getAction(action.id)!.status).toBe('failed');
    expect(store.getService(service.id)!.state).toBe('running');expect(store.getService(service.id)!.lastError).toBeNull();
  });
});
