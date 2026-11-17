import type { Action } from '../shared/types.js';

/** Only derive a build phase from explicit build log markers. */
export function deploymentProgress(action:Action, buildLog?:{available:boolean;text:string;truncated:boolean}):string {
  if(action.status==='succeeded')return 'Completed';
  if(action.status==='failed')return 'Failed';
  if(action.status==='cancelled')return 'Cancelled';
  if(action.status==='queued')return 'Queued';
  if(action.phase==='reconciling')return 'Recovering operation';
  if(action.phase==='checking')return 'Recording verified result';
  if(action.phase==='planning')return 'Preparing deployment';
  if(action.type==='deploy' && buildLog?.available) {
    const markers=[...buildLog.text.matchAll(/(?:^|\n)\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z \[servus\] (Fetching source branch |Building immutable source |Build completed(?:\n|$))/g)];
    const last=markers.at(-1)?.[1];
    if(last?.startsWith('Fetching source branch '))return 'Fetching source';
    if(last?.startsWith('Building immutable source '))return 'Building image';
    if(last?.startsWith('Build completed'))return 'Applying and checking service';
  }
  return action.type==='deploy' ? 'Applying deployment' : 'Applying operation';
}
