import { commonScenarios, referenceTarget, wordpress } from './parity-scenarios.js';
import { runId } from './parity-lib.js';
const target = await referenceTarget();
if (process.env.PARITY_PHASE === 'wordpress') await wordpress(target, `reference-${runId}.localhost`);
else await commonScenarios(target);
