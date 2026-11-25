import type { Action } from '../shared/types.js';

type BuildOutput = {available:boolean;text:string;truncated:boolean};
const buildMarkerPattern = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z \[servus\] (Fetching source branch |Building immutable source |Build completed$)/gm;

function buildMarkers(buildLog?: BuildOutput) {
  if (!buildLog?.available) return undefined;
  let completed = false;
  let last: RegExpMatchArray | undefined;
  for (const marker of buildLog.text.matchAll(buildMarkerPattern)) {
    last = marker;
    if (marker[1] === "Build completed") completed = true;
  }
  return {last, completed};
}

/** Only derive a build phase from explicit build log markers. */
export function deploymentProgress(action:Action, buildLog?:BuildOutput):string {
  if(action.status==='succeeded')return 'Completed';
  if(action.status==='failed')return 'Failed';
  if(action.status==='cancelled')return 'Cancelled';
  if(action.status==='queued')return 'Queued';
  if(action.phase==='reconciling')return 'Recovering operation';
  if(action.phase==='checking')return 'Recording verified result';
  if(action.phase==='planning')return 'Preparing deployment';
  if(action.type==='deploy') {
    const last=buildMarkers(buildLog)?.last?.[1];
    if(last?.startsWith('Fetching source branch '))return 'Fetching source';
    if(last?.startsWith('Building immutable source '))return 'Building image';
    if(last?.startsWith('Build completed'))return 'Applying and checking service';
  }
  return action.type==='deploy' ? 'Applying deployment' : 'Applying operation';
}

export function deploymentFailure(action: Action, buildLog?: BuildOutput): {
  stage: "source" | "build" | undefined;
  title: string;
  cause: string;
  nextStep?: string;
  laterStagesUnreached?: boolean;
} | undefined {
  if (action.type !== "deploy" || action.status !== "failed") return undefined;
  const cause = action.error?.trim() || "The operation recorded no error details.";
  const markers = buildMarkers(buildLog);
  const marker = markers?.last;
  if (!buildLog?.available || !marker) {
    return { stage: undefined, title: "Deployment failed", cause };
  }
  const laterStagesUnreached = !buildLog.truncated && !markers?.completed;
  if (marker[1]?.startsWith("Fetching source branch ")) {
    return { stage: "source", title: "Failed while preparing source", cause, laterStagesUnreached };
  }
  if (!marker[1]?.startsWith("Building immutable source ")) {
    return { stage: undefined, title: "Deployment failed", cause };
  }

  const output = buildLog.text.slice(marker.index);
  const missing = output.match(/^.*\[output\][^\r\n]*?npm (?:error|ERR!) (Missing: [^\r\n]{1,180} from lock file)\s*$/mi)?.[1];
  const ciFailed = /\[output\].*process ["'][^"'\r\n]*\bnpm ci\b[^"'\r\n]*["'] did not complete successfully/i.test(output);
  if (missing && ciFailed) {
    return {
      stage: "build",
      title: "Build stopped at npm ci",
      cause: missing,
      nextStep: "Update and commit the lockfile, then deploy again.",
      laterStagesUnreached,
    };
  }
  return { stage: "build", title: "Build failed", cause, laterStagesUnreached };
}
