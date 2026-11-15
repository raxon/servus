import { constants, closeSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { dirname, isAbsolute, parse, resolve } from 'node:path';
import { runSupervisorControl, type SupervisorDrainStatus, type SupervisorRole } from './supervisor-control.js';

type ControlConfig = { socketPath: string; secretPath: string };

function trustedAncestors(path: string): void {
  if (process.platform !== 'linux' || !isAbsolute(path) || path.includes('\0') || resolve(path) !== path) throw new Error('Invalid supervisor configuration');
  let current = parse(path).root;
  const parts = dirname(path).slice(current.length).split('/').filter(Boolean);
  for (const part of ['', ...parts]) {
    if (part) current = `${current === '/' ? '' : current}/${part}`;
    const info = lstatSync(current);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o022) !== 0) throw new Error('Invalid supervisor configuration');
  }
}

/** Validate opt-in control before any component opens its data store. */
export function supervisorConfig(env: NodeJS.ProcessEnv): ControlConfig | undefined {
  const socketPath = env.PANEL_SUPERVISOR_SOCKET;
  const secretPath = env.PANEL_SUPERVISOR_SECRET_FILE;
  if (socketPath === undefined && secretPath === undefined) return undefined;
  if (!socketPath || !secretPath || socketPath === secretPath || typeof constants.O_NOFOLLOW !== 'number') throw new Error('Invalid supervisor configuration');
  try {
    trustedAncestors(socketPath); trustedAncestors(secretPath);
    const socket = lstatSync(socketPath);
    if (!socket.isSocket() || socket.isSymbolicLink() || socket.uid !== 0 || (socket.mode & 0o007) !== 0) throw new Error('Invalid supervisor configuration');
    const file = lstatSync(secretPath);
    if (!file.isFile() || file.isSymbolicLink() || file.uid !== 0 || file.nlink !== 1 || (file.mode & 0o137) !== 0 || file.size < 64 || file.size > 65) throw new Error('Invalid supervisor configuration');
    const fd = openSync(secretPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = fstatSync(fd);
      if (!info.isFile() || info.uid !== 0 || info.nlink !== 1 || (info.mode & 0o137) !== 0 || info.ino !== file.ino || info.dev !== file.dev || info.size < 64 || info.size > 65) throw new Error('Invalid supervisor configuration');
      const buffer = Buffer.alloc(66); let count = 0;
      while (count < buffer.length) { const read = readSync(fd, buffer, count, buffer.length - count, null); if (!read) break; count += read; }
      const secret = buffer.subarray(0, count).toString('utf8');
      buffer.fill(0);
      if (!/^[a-f0-9]{64}\n?$/.test(secret) || count !== secret.length) throw new Error('Invalid supervisor configuration');
    } finally { closeSync(fd); }
    return { socketPath, secretPath };
  } catch { throw new Error('Invalid supervisor configuration'); }
}

/** Start the private control client; a stopped connection never proves quiescence. */
export function startSupervisorControl(config: ControlConfig | undefined, role: SupervisorRole, drain: (timeoutMs: number) => Promise<{ status: SupervisorDrainStatus }>, drainLegacyUpload?: (timeoutMs:number,operationId:string)=>Promise<{status:SupervisorDrainStatus}>): AbortController | undefined {
  if (!config) return undefined;
  const controller = new AbortController();
  void runSupervisorControl({ ...config, role, drain, drainLegacyUpload, signal: controller.signal }).catch(() => {
    // Do not keep a component running when its control client's initial configuration fails.
    process.exitCode = 1;
    process.kill(process.pid, 'SIGTERM');
  });
  return controller;
}
