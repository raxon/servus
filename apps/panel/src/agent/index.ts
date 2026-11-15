import { existsSync, unlinkSync, chmodSync } from 'node:fs';
import { createAgent } from './app.js';
import { agentConfig } from './config.js';
import { AgentMaintenanceGate } from './maintenance.js';
import { startSupervisorControl, supervisorConfig } from '../shared/supervisor-entrypoint.js';

const controlConfig = supervisorConfig(process.env);
const maintenance = controlConfig ? new AgentMaintenanceGate() : undefined;
const config = agentConfig();
if (existsSync(config.socketPath)) {
  const { connect } = await import('node:net');
  const live = await new Promise<boolean>(resolve => {
    const connection = connect(config.socketPath);
    connection.on('connect', () => { connection.destroy(); resolve(true); });
    connection.on('error', () => resolve(false));
  });
  if (live) throw new Error('A local agent is already listening.');
  unlinkSync(config.socketPath);
}
const app = await createAgent(config, undefined, maintenance);
await app.listen({ path: config.socketPath });
chmodSync(config.socketPath, 0o600);
const control = startSupervisorControl(controlConfig, 'agent', timeout => maintenance!.drain(timeout), (timeout,id)=>maintenance!.drainForLegacyUpload(timeout,id));
console.log(`Local agent listening on ${config.socketPath}`);
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, async () => { control?.abort(); await app.close(); process.exit(process.exitCode || 0); });
