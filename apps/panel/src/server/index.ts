import { resolve } from 'node:path';
import { createApp } from './app.js';
import { runtimeStatus } from '../agent/client.js';
import { loadTrustedProxySecret } from './proxy-address.js';
import { MaintenanceGate } from './maintenance.js';
import { startSupervisorControl, supervisorConfig } from '../shared/supervisor-entrypoint.js';
import { lifecycleAllowsWork } from '../shared/lifecycle-gate.js';

const controlConfig = supervisorConfig(process.env);
const maintenance = controlConfig ? new MaintenanceGate(lifecycleAllowsWork) : undefined;
const dataDir = resolve(process.env.PANEL_DATA_DIR ?? '.data');
const app = await createApp({
  dataDir,
  webDir: resolve(process.env.PANEL_WEB_DIR || resolve(import.meta.dirname, '../../dist/web')),
  runtimeStatus,
  logger: true,
  allowedOrigins: process.env.PANEL_ALLOWED_ORIGINS?.split(',').map(value=>value.trim()).filter(Boolean),
  secureCookies: process.env.PANEL_SECURE_COOKIES === 'true',
  trustedProxySecret: loadTrustedProxySecret(process.env),
  maintenance,
  updaterSocketPath: process.env.PANEL_UPDATER_SOCKET,
  updaterApplyEnabled: process.env.PANEL_UPDATER_APPLY_ENABLED === 'true',
});
await app.listen({host:process.env.PANEL_HOST ?? '127.0.0.1',port:Number(process.env.PANEL_PORT ?? 4180)});
const control = startSupervisorControl(controlConfig, 'api', async timeout => {
  const result = await maintenance!.drain(timeout);
  if (result.status === 'uncertain') app.log.warn({sources:maintenance!.uncertaintySources()}, 'API drain is uncertain');
  return result;
});
for(const signal of ['SIGINT','SIGTERM'] as const) process.on(signal,()=>{control?.abort();void app.close().then(()=>process.exit(process.exitCode || 0));});
