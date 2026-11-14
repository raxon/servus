import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const script = fileURLToPath(new URL('../../scripts/verify-image.sh', import.meta.url));

function runSmoke(mode) {
  const root = mkdtempSync(join(tmpdir(), 'servus-image-test-'));
  try {
    const bin = join(root, 'bin'), log = join(root, 'docker.log');
    mkdirSync(bin);
    writeFileSync(join(bin, 'docker'), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$SERVUS_DOCKER_LOG"
case "$1" in
  image) printf 'amd64\\n' ;;
  run) if [[ "$SERVUS_RUN_MODE" == failure ]]; then exit 125; fi; printf '%064d\\n' 0 ;;
  port) printf 'invalid-port\\n' ;;
  rm) exit 0 ;;
esac
`, { mode: 0o755 });
    const result = spawnSync('bash', [script, 'example-image'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, SERVUS_DOCKER_LOG: log, SERVUS_RUN_MODE: mode },
    });
    return { result, calls: readFileSync(log, 'utf8').trim().split('\n') };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('failed container creation never removes another container', () => {
  const { result, calls } = runSmoke('failure');
  assert.notEqual(result.status, 0);
  assert.ok(calls.some(call => call.startsWith('run ')));
  assert.ok(calls.every(call => !call.startsWith('rm ')));
  assert.ok(calls.every(call => !call.includes('--name')));
});

test('cleanup targets only the successfully created container ID', () => {
  const { result, calls } = runSmoke('success');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /isolated test port/);
  assert.deepEqual(calls.filter(call => call.startsWith('rm ')), [`rm -f ${'0'.repeat(64)}`]);
});
