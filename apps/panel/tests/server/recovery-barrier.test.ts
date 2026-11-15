import { expect, it, vi } from 'vitest';
import { AgentMaintenanceGate } from '../../src/agent/maintenance.js';
import { MaintenanceGate } from '../../src/server/maintenance.js';
import { Worker } from '../../src/worker/runner.js';

it('blocks API, agent and worker work until the recovery barrier opens', async () => {
  let normal=false;
  const api=new MaintenanceGate(()=>normal),agent=new AgentMaintenanceGate(()=>normal);
  const claim=vi.fn(()=>undefined);
  const worker=new Worker({claimNextJob:claim} as never,60000,{allowWork:()=>normal});
  expect(api.admit()).toBeUndefined();expect(agent.admit()).toBeUndefined();
  expect(await worker.once()).toBe(false);expect(claim).not.toHaveBeenCalled();
  normal=true;
  const apiDone=api.admit(),agentDone=agent.admit();
  expect(apiDone).toBeTypeOf('function');expect(agentDone).toBeTypeOf('function');
  apiDone!();agentDone!();
  expect(await worker.once()).toBe(false);expect(claim).toHaveBeenCalledOnce();
});
