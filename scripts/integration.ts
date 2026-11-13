import { commonScenarios, panelTarget, wordpress } from './parity-scenarios.js';
import { runId } from './parity-lib.js';
const target = await panelTarget();
if (process.env.PARITY_PHASE === 'wordpress') await wordpress(target, `panel-${runId}.localhost`);
else await commonScenarios(target);
