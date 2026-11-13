import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';

export function agentConfig() {
  const dataDir = resolve(process.env.PANEL_DATA_DIR || '.data');
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const tokenPath = join(dataDir, 'agent-token');
  if (!existsSync(tokenPath)) {
    try { writeFileSync(tokenPath, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
  chmodSync(tokenPath, 0o600);
  return {
    dataDir,
    token: readFileSync(tokenPath, 'utf8').trim(),
    socketPath: process.env.PANEL_AGENT_SOCKET || join(dataDir, 'agent.sock'),
    dockerSocket: process.env.PANEL_DOCKER_SOCKET || '/var/run/docker.sock',
    ingressPort: Number(process.env.PANEL_INGRESS_PORT || 18080),
    ingressImage: process.env.PANEL_INGRESS_IMAGE || 'traefik:3.7.13',
  };
}
