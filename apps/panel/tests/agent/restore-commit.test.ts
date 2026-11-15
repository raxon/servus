import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

const mocks=vi.hoisted(()=>({prepare:vi.fn(),apply:vi.fn(),rollback:vi.fn(),finalize:vi.fn(),finalizeRollback:vi.fn(),verify:vi.fn(),source:vi.fn()}));
vi.mock('../../src/agent/restore-switch-intent.js',()=>({prepareRestoreSwitchIntent:mocks.prepare}));
vi.mock('../../src/agent/restore-switch-apply.js',()=>({applyRestoreSwitch:mocks.apply}));
vi.mock('../../src/agent/restore-switch-rollback.js',()=>({rollbackRestoreSwitch:mocks.rollback}));
vi.mock('../../src/agent/restore-switch-finalize.js',()=>({finalizeRestoreSwitch:mocks.finalize}));
vi.mock('../../src/agent/restore-rollback-finalize.js',()=>({finalizeRestoreRollback:mocks.finalizeRollback}));
vi.mock('../../src/agent/restore-switch-verify.js',()=>({verifyRestoreDatabase:mocks.verify}));
vi.mock('../../src/agent/restore-source.js',()=>({loadRestoreSource:mocks.source}));
import { commitPreparedRestore, RestoreCommitUncertainError } from '../../src/agent/restore-commit.js';

afterEach(()=>vi.resetAllMocks());
function fixture(){
  const serviceId=randomUUID(),operationId='a'.repeat(32),record={id:operationId,service_id:serviceId,kind:'postgres',phase:'prepared'},intent={stage:'pending'};
  let retained=false;
  const journal={get:vi.fn(()=>record),switchIntent:vi.fn(()=>intent),retainedVolume:vi.fn(()=>retained?{reason:'rollback_candidate'}:undefined)};
  mocks.prepare.mockImplementation(async()=>{record.phase='switching';});
  mocks.apply.mockImplementation(async()=>{intent.stage='applied';});
  mocks.finalize.mockImplementation(async()=>{record.phase='completed';return record;});
  mocks.rollback.mockImplementation(async()=>{intent.stage='rolled_back';});
  mocks.finalizeRollback.mockImplementation(async()=>{record.phase='cancelled';retained=true;return record;});
  return {record,intent,journal,options:{docker:{} as never,journal:journal as never,vault:{} as never,dataDir:'/unused',serviceId,operationId}};
}

it('inspects, applies and finalizes the prepared restore',async()=>{
  const f=fixture();expect(await commitPreparedRestore(f.options)).toEqual({operationId:f.options.operationId,phase:'completed',rolledBack:false});
  expect(mocks.source).toHaveBeenCalledOnce();expect(mocks.prepare).toHaveBeenCalledOnce();expect(mocks.apply).toHaveBeenCalledOnce();expect(mocks.finalize).toHaveBeenCalledOnce();expect(mocks.rollback).not.toHaveBeenCalled();
  expect((await commitPreparedRestore(f.options)).phase).toBe('completed');expect(mocks.apply).toHaveBeenCalledOnce();
});

it('rolls back a failed switch and retains its candidate',async()=>{
  const f=fixture();mocks.apply.mockRejectedValueOnce(new Error('synthetic failure'));
  expect(await commitPreparedRestore(f.options)).toEqual({operationId:f.options.operationId,phase:'cancelled',rolledBack:true});
  expect(mocks.rollback).toHaveBeenCalledOnce();expect(mocks.finalizeRollback).toHaveBeenCalledOnce();expect(mocks.finalize).not.toHaveBeenCalled();
});

it('resumes a previously interrupted rollback',async()=>{
  const f=fixture();f.record.phase='switching';f.intent.stage='rolling_back';
  expect((await commitPreparedRestore(f.options)).phase).toBe('cancelled');expect(mocks.apply).not.toHaveBeenCalled();expect(mocks.rollback).toHaveBeenCalledOnce();
});

it('leaves a failed rollback unresolved and reports uncertainty',async()=>{
  const f=fixture();mocks.apply.mockRejectedValueOnce(new Error('switch failed'));mocks.rollback.mockRejectedValueOnce(new Error('rollback failed'));
  await expect(commitPreparedRestore(f.options)).rejects.toBeInstanceOf(RestoreCommitUncertainError);
  expect(f.record.phase).toBe('switching');expect(mocks.finalizeRollback).not.toHaveBeenCalled();
});

it('does not change a restore that is not prepared or belongs to another service',async()=>{
  const f=fixture();f.record.phase='importing';await expect(commitPreparedRestore(f.options)).rejects.toThrow('not ready');
  f.record.phase='prepared';f.record.service_id=randomUUID();await expect(commitPreparedRestore(f.options)).rejects.toThrow('not found');
  expect(mocks.prepare).not.toHaveBeenCalled();
});
