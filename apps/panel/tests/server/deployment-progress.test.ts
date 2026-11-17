import { expect,it } from 'vitest';
import { deploymentProgress } from '../../src/web/deployment-progress.js';
import type { Action } from '../../src/shared/types.js';
const base:Action={id:'1',projectId:'2',serviceId:'3',type:'deploy',status:'running',phase:'applying',error:null,createdAt:'2026-01-01T00:00:00Z',updatedAt:'2026-01-01T00:00:00Z',finishedAt:null};
const log=(text:string)=>({available:true,truncated:false,text});
it('shows only phases justified by operation status and build markers',()=>{
  expect(deploymentProgress({...base,status:'queued'})).toBe('Queued');
  expect(deploymentProgress(base,log('2026-01-01T00:00:00.000Z [servus] Fetching source branch main\n'))).toBe('Fetching source');
  expect(deploymentProgress(base,log('2026-01-01T00:00:00.000Z [servus] Fetching source branch main\n2026-01-01T00:00:02.000Z [servus] Building immutable source abc\n'))).toBe('Building image');
  expect(deploymentProgress(base,log('2026-01-01T00:00:00.000Z [servus] Build completed\n'))).toBe('Applying and checking service');
  expect(deploymentProgress(base,log('2026-01-01T00:00:00.000Z [output] [servus] Build completed\n'))).toBe('Applying deployment');
  expect(deploymentProgress({...base,phase:'reconciling'},log('2026-01-01T00:00:00.000Z [servus] Build completed\n'))).toBe('Recovering operation');
  expect(deploymentProgress({...base,status:'failed'})).toBe('Failed');
});
