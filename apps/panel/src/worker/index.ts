import { resolve } from 'node:path';
import { Store } from '../server/store.js';
import { Worker } from './runner.js';
import { startSupervisorControl, supervisorConfig } from '../shared/supervisor-entrypoint.js';

const controlConfig = supervisorConfig(process.env);
const store = new Store(resolve(process.env.PANEL_DATA_DIR || '.data'));
const worker = new Worker(store);
const control = startSupervisorControl(controlConfig, 'worker', timeout => worker.drain(timeout));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { control?.abort(); worker.stopping = true; });
console.log('Deployment worker started.');
await worker.run();
store.close();
