import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createApp } from '../../src/server/app.js';
import { Store } from '../../src/server/store.js';

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'servus-build-info-'));
  directories.push(dir);
  const pkg = join(dir, 'package.json'), output = join(dir, 'build.ts');
  writeFileSync(pkg, JSON.stringify({ version: '0.1.0' }));
  return { dir, pkg, output };
}
function generate(pkg: string, output: string, version: string, revision: string) {
  return spawnSync(process.execPath, [resolve('src/server/write-build-info.mjs'), pkg, output], {
    env: { ...process.env, SERVUS_BUILD_VERSION: version, SERVUS_BUILD_REVISION: revision }, encoding: 'utf8',
  });
}
describe('build identity', () => {
  it('reports the same local identity at both health endpoints and ignores spoofed headers', async () => {
    const { dir } = fixture();
    const store = new Store(dir), app = await createApp({ dataDir: dir, store });
    try {
      for (const url of ['/health', '/api/v1/health']) {
        const result = await app.inject({ url, headers: { 'x-build-version': 'fake', 'x-git-sha': 'f'.repeat(40) } });
        expect(result.statusCode).toBe(200);
        expect(result.json()).toEqual({ status: 'ok', version: 'unknown', revision: 'unknown' });
      }
    } finally { await app.close(); store.close(); }
  });
  it('writes immutable build constants only for valid matching metadata', () => {
    const { pkg, output } = fixture();
    expect(generate(pkg, output, '0.1.0', 'a'.repeat(40)).status).toBe(0);
    const content = readFileSync(output, 'utf8');
    expect(content).toContain('"version":"0.1.0"');
    expect(content).toContain(`"revision":"${'a'.repeat(40)}"`);
    for (const [version, revision] of [['0.1.1', 'a'.repeat(40)], ['0.1.0', 'a'.repeat(39)], ['0.1.0', 'A'.repeat(40)], ['unknown', 'a'.repeat(40)], ['0.1.0', 'unknown']]) {
      expect(generate(pkg, output, version!, revision!).status).not.toBe(0);
      expect(readFileSync(output, 'utf8')).toBe(content);
    }
    expect(generate(pkg, output, 'unknown', 'unknown').status).toBe(0);
    expect(readFileSync(output, 'utf8')).toContain('"version":"unknown","revision":"unknown"');
  });
});
