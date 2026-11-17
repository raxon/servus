import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { writeGeneratedEnv } from '../../src/agent/generated-env.js';
import { SecretVault } from '../../src/shared/secrets.js';
import { normalizeServiceInput, parseServicePatch } from '../../src/server/configuration.js';
import { parseEnvironment } from '../../src/web/environment.js';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const dispose of cleanup.splice(0).reverse()) dispose(); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'servus-generated-env-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const context = join(root, 'checkout'); mkdirSync(context);
  const dockerfile = join(context, 'Dockerfile'); writeFileSync(dockerfile, 'FROM scratch\n');
  const vault = new SecretVault(root), serviceId = randomUUID();
  const metadata = new Database(join(root, 'panel.sqlite'));
  metadata.exec('CREATE TABLE service_secret_refs(reference TEXT PRIMARY KEY,service_id TEXT NOT NULL,purpose TEXT NOT NULL); PRAGMA user_version=5');
  cleanup.push(() => metadata.close());
  return { root, context, dockerfile, vault, serviceId, metadata };
}
const source = { type: 'git', repository: 'https://github.com/example/app.git', branch: 'main', context: '.', dockerfile: 'Dockerfile' };

describe('generated build environment files', () => {
  it('writes only the current service environment with private permissions and round-trippable values', () => {
    const f = fixture(), secret = 'private\nvalue"with\\escapes', ref = f.vault.put(secret);
    f.metadata.prepare('INSERT INTO service_secret_refs VALUES (?,?,?)').run(ref, f.serviceId, 'environment');
    writeGeneratedEnv(f.context, 'config/.env.production', f.dockerfile, [
      { name: 'APP_NAME', value: ' spaces # and $ symbols ' }, { name: 'PRIVATE', secret: true, secretRef: ref }, { name: 'EMPTY' },
    ], f.serviceId, f.vault);
    const path = join(f.context, 'config/.env.production');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(parseEnvironment(readFileSync(path, 'utf8'))).toEqual([
      { name: 'APP_NAME', value: ' spaces # and $ symbols ', secret: false }, { name: 'PRIVATE', value: secret, secret: false }, { name: 'EMPTY', value: '', secret: false },
    ]);
  });
  it.each(['../outside', '/tmp/outside', 'config/../../outside', '.git/config', 'config/.Git/hooks', '.dockerignore', 'Dockerfile', 'config\\env', 'config//env', 'config/./env', 'config/../env', 'C:env', 'line\n.env', ''])('rejects unsafe paths at configuration and filesystem boundaries: %j', path => {
    const f = fixture();
    expect(() => normalizeServiceInput({ name: 'env-app', hostname: 'env-app.localhost', source: { ...source, envFile: path } })).toThrow();
    expect(() => parseServicePatch({ expectedRevision: 1, source: { ...source, envFile: path } })).toThrow();
    expect(() => writeGeneratedEnv(f.context, path, f.dockerfile, [], f.serviceId, f.vault)).toThrow();
  });
  it('rejects symlinks in the parent path or target without changing the destination', () => {
    const f = fixture(), outside = join(f.root, 'outside'); mkdirSync(outside);
    const original = join(outside, '.env'); writeFileSync(original, 'untouched');
    symlinkSync(outside, join(f.context, 'linked'));
    expect(() => writeGeneratedEnv(f.context, 'linked/.env', f.dockerfile, [], f.serviceId, f.vault)).toThrow('symbolic links');
    symlinkSync(original, join(f.context, '.env'));
    expect(() => writeGeneratedEnv(f.context, '.env', f.dockerfile, [], f.serviceId, f.vault)).toThrow();
    expect(readFileSync(original, 'utf8')).toBe('untouched');
  });
  it('rejects hard-linked targets and a custom Dockerfile without truncating either', () => {
    const f = fixture(), original = join(f.root, 'outside.env'); writeFileSync(original, 'untouched');
    linkSync(original, join(f.context, '.env'));
    expect(() => writeGeneratedEnv(f.context, '.env', f.dockerfile, [], f.serviceId, f.vault)).toThrow('hard links');
    expect(readFileSync(original, 'utf8')).toBe('untouched');
    const custom = join(f.context, 'build-image'); writeFileSync(custom, 'FROM scratch\n');
    expect(() => writeGeneratedEnv(f.context, 'build-image', custom, [], f.serviceId, f.vault)).toThrow('cannot replace the Dockerfile');
    expect(readFileSync(custom, 'utf8')).toBe('FROM scratch\n');
  });
  it('checks service ownership before creating a file containing a secret', () => {
    const f = fixture(), ref = f.vault.put('another-service-secret');
    f.metadata.prepare('INSERT INTO service_secret_refs VALUES (?,?,?)').run(ref, randomUUID(), 'environment');
    expect(() => writeGeneratedEnv(f.context, '.env', f.dockerfile, [{ name: 'KEY', secretRef: ref }], f.serviceId, f.vault)).toThrow();
    expect(() => statSync(join(f.context, '.env'))).toThrow();
  });
  it('preserves optional envFile configuration and allows disabling it in a replacement source', () => {
    expect(normalizeServiceInput({ name: 'env-app', hostname: 'env-app.localhost', source: { ...source, envFile: 'config/.env' } }).source).toMatchObject({ envFile: 'config/.env' });
    expect(parseServicePatch({ expectedRevision: 1, source }).source).not.toHaveProperty('envFile');
  });
});
