import { expect,it } from 'vitest';
import { deploymentFailure, deploymentProgress } from '../../src/web/deployment-progress.js';
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

it('shows a known build error and retains the original error when the stage is uncertain', () => {
  const failure: Action = {...base, status:'failed', phase:'failed', error:'docker failed with exit code 1.'};
  const marker = '2026-01-01T00:00:02.000Z [servus] Building immutable source abc\n';
  const output = '2026-01-01T00:00:03.000Z [output] #8 npm error Missing: vite@8.3.8 from lock file\n'
    + '2026-01-01T00:00:03.000Z [output] ERROR: process "/bin/sh -c npm ci" did not complete successfully\n';
  expect(deploymentFailure(failure, log(marker + output))).toMatchObject({
    stage:'build', title:'Build stopped at npm ci', cause:'Missing: vite@8.3.8 from lock file', laterStagesUnreached:true,
  });
  expect(deploymentFailure(failure, log(marker + output + '2026-01-01T00:00:04.000Z [servus] Build completed\n')))
    .toMatchObject({stage:undefined, cause:failure.error});
  expect(deploymentFailure(failure, log(output))).toMatchObject({stage:undefined, cause:failure.error});
  expect(deploymentFailure(failure, log(marker + '2026-01-01T00:00:03.000Z [output] Build interrupted\n')))
    .toMatchObject({stage:'build', title:'Build failed', cause:failure.error});
  expect(deploymentFailure(failure, {...log(marker + output), truncated:true})).toMatchObject({laterStagesUnreached:false});
  expect(deploymentFailure({...failure, type:'restart'}, log(marker + output))).toBeUndefined();
});
