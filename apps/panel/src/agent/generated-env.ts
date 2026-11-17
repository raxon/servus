import { closeSync, constants, fchmodSync, fstatSync, ftruncateSync, lstatSync, mkdirSync, openSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { validEnvFilePath } from '../shared/build-options.js';
import type { EnvironmentVariable } from '../shared/types.js';
import type { SecretVault } from '../shared/secrets.js';

/** The checkout is private and no build process runs until this function finishes. */
export function writeGeneratedEnv(context: string, path: string, dockerfile: string, environment: readonly EnvironmentVariable[], serviceId: string, vault: SecretVault): void {
  if (!validEnvFilePath(path)) throw new Error('The environment file must use a relative path outside Git and build configuration files.');
  const root = realpathSync(context), target = resolve(root, path);
  if (target === realpathSync(dockerfile)) throw new Error('The environment file cannot replace the Dockerfile.');
  let current = root;
  for (const segment of path.split('/').slice(0, -1)) {
    current = join(current, segment);
    let entry;
    try { entry = lstatSync(current); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      mkdirSync(current, { mode: 0o700 });
      entry = lstatSync(current);
    }
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('The environment file path cannot contain symbolic links or non-directory entries.');
  }
  if (realpathSync(dirname(target)) !== dirname(target)) throw new Error('The environment file path leaves the build context.');
  const entries = environment.map(item => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(item.name)) throw new Error('Invalid environment variable name.');
    const value = item.secretRef ? vault.getServiceSecret(item.secretRef, serviceId, 'environment') : item.value ?? '';
    if (value.includes('\0')) throw new Error('Environment values cannot contain null bytes.');
    return `${item.name}=${JSON.stringify(value)}`;
  });
  const fd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const file = fstatSync(fd);
    if (!file.isFile() || file.nlink !== 1) throw new Error('The environment file must be a regular file without hard links.');
    fchmodSync(fd, 0o600);
    ftruncateSync(fd, 0);
    writeFileSync(fd, `${entries.join('\n')}\n`);
  } finally { closeSync(fd); }
}
