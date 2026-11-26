import { existsSync, unlinkSync, chmodSync } from 'node:fs';
import { createAgent } from './app.js';
import { agentConfig } from './config.js';
import { ensureHostDomainIngress, hasActiveHostDomain } from './host-domain.js';
import { AgentMaintenanceGate } from './maintenance.js';
import { DockerRuntime } from './runtime.js';
import { startSupervisorControl, supervisorConfig } from '../shared/supervisor-entrypoint.js';
import { lifecycleAllowsWork } from '../shared/lifecycle-gate.js';

const controlConfig = supervisorConfig(process.env);
const maintenance = controlConfig ? new AgentMaintenanceGate(lifecycleAllowsWork) : undefined;
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
const runtime = new DockerRuntime(config.dockerSocket, config.ingressPort, config.ingressImage, config.dataDir);
const app = await createAgent(config, runtime, maintenance);
await app.listen({ path: config.socketPath });
chmodSync(config.socketPath, 0o600);
const control = startSupervisorControl(controlConfig, 'agent', timeout => maintenance!.drain(timeout), (timeout,id,serviceId)=>maintenance!.drainForLegacyUpload(timeout,id,serviceId));
let bootIngressTimer: ReturnType<typeof setTimeout> | undefined;
let stopping = false;
const stopBootIngress = () => {
  stopping = true;
  if (bootIngressTimer) { clearTimeout(bootIngressTimer); bootIngressTimer = undefined; }
};
const unregisterBootIngress = maintenance?.registerCloser(stopBootIngress);
if (runtime.vault.hostConnection()?.hostname || hasActiveHostDomain(config.dataDir)) {
  const delays = [250, 1000, 2000, 4000, 8000, 15000];
  let attempt = 0;
  const run = async () => {
    if (stopping) return;
    const release = maintenance?.admit();
    if (maintenance && !release) {
      if (!stopping && attempt < delays.length) {
        bootIngressTimer = setTimeout(() => { void run(); }, delays[attempt++]!);
        bootIngressTimer.unref();
      }
      return;
    }
    let connected = false;
    try { connected = await ensureHostDomainIngress(runtime); } catch { /* retry while API container boots */ }
    finally { release?.(); }
    if (connected) { unregisterBootIngress?.(); return; }
    if (!stopping && attempt < delays.length) {
      bootIngressTimer = setTimeout(() => { void run(); }, delays[attempt++]!);
      bootIngressTimer.unref();
    } else {
      unregisterBootIngress?.();
    }
  };
  bootIngressTimer = setTimeout(() => { void run(); }, delays[attempt++]!);
  bootIngressTimer.unref();
} else {
  unregisterBootIngress?.();
}
console.log(`Local agent listening on ${config.socketPath}`);
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, async () => { stopBootIngress(); unregisterBootIngress?.(); control?.abort(); await app.close(); process.exit(process.exitCode || 0); });
