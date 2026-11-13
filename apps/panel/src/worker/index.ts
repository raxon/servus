import { resolve } from 'node:path';
import { Store } from '../server/store.js';
import { Worker } from './runner.js';

const store = new Store(resolve(process.env.PANEL_DATA_DIR || '.data'));
const worker = new Worker(store);
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { worker.stopping = true; });
console.log('Deployment worker started.');
await worker.run();
store.close();
