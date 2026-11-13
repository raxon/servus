import { resolve } from 'node:path';
import { createApp } from './app.js';
import { runtimeStatus } from '../agent/client.js';

const dataDir = resolve(process.env.PANEL_DATA_DIR ?? '.data');
const app = await createApp({
  dataDir,
  webDir: resolve(process.env.PANEL_WEB_DIR || 'dist/web'),
  runtimeStatus,
  logger: true,
  allowedOrigins: process.env.PANEL_ALLOWED_ORIGINS?.split(',').map(value=>value.trim()).filter(Boolean),
  secureCookies: process.env.PANEL_SECURE_COOKIES === 'true',
});
await app.listen({host:process.env.PANEL_HOST ?? '127.0.0.1',port:Number(process.env.PANEL_PORT ?? 4180)});
for(const signal of ['SIGINT','SIGTERM'] as const) process.on(signal,()=>void app.close().then(()=>process.exit(0)));
