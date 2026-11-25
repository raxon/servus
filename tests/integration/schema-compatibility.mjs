import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// A frozen previous binary must refuse a semantic schema change even when the
// physical table layout is unchanged. All writes use this run's owned volume.
const context = 'colima-panel-dev';
const previousImage = 'servus-parity-v7-check:20261117';
const builderImage = 'servus-parity-v7-builder:20261117';
const root = fileURLToPath(new URL('../..', import.meta.url));
const volume = `servus-schema-compatibility-${randomUUID()}`;
const result = { startedAt: new Date().toISOString(), context, previousImage, previousImageId: null,
  currentSchema: 9, status: 'running', checks: [], cleanupStatus: 'pending' };
let created = false;
function docker(args) {
  const child = spawnSync('docker', ['--context', context, ...args], { encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024 });
  if (child.error || child.status !== 0) throw new Error(`Owned schema fixture command failed: ${child.error?.message ?? child.stderr.trim()}`);
  return child.stdout.trim();
}
try {
  result.previousImageId = docker(['image', 'inspect', previousImage, '--format', '{{.Id}}']);
  assert.equal(result.previousImageId, 'sha256:88dcb63054f428a1f5f2be57855768dafb0306565483c4243b349f11899d6284');
  docker(['volume', 'create', '--label', 'servus.fixture=schema-compatibility', volume]);
  created = true;
  const common = ['run', '--rm', '--user', '0', '--network', 'none', '--mount', `type=volume,source=${volume},target=/fixture`, '--entrypoint', '/usr/local/bin/node'];
  const currentMount = ['--mount', `type=bind,source=${root}/apps/panel/dist,target=/app/apps/panel/dist,readonly`];
  const current = `import assert from 'node:assert/strict';import {Store} from '/app/apps/panel/dist/server/store.js';const s=new Store('/fixture');assert.equal(s.db.pragma('user_version',{simple:true}),9);s.close();console.log('schema9');`;
  assert.equal(docker([...common, ...currentMount, builderImage, '--input-type=module', '-e', current]), 'schema9');
  result.checks.push('current-binary-creates-schema9');
  const previous = `import assert from 'node:assert/strict';import {Store} from '/app/dist/server/store.js';import {SecretVault} from '/app/dist/shared/secrets.js';assert.throws(()=>new Store('/fixture'),/requires a newer panel release/);const vault=new SecretVault('/fixture'),id='12345678-1234-4123-8123-123456789abc';assert.throws(()=>vault.getServiceSecret(id,id,'database'),/Secret purpose metadata is unavailable/);assert.throws(()=>vault.getDatabaseRootSecret(id),/Database root secret is invalid/);console.log('old-binary-refused');`;
  assert.equal(docker([...common, previousImage, '--input-type=module', '-e', previous]), 'old-binary-refused');
  result.checks.push('frozen-schema7-store-refuses-schema9', 'frozen-schema7-agent-service-secret-refuses-schema9', 'frozen-schema7-agent-root-secret-refuses-schema9');
  assert.equal(docker([...common, ...currentMount, builderImage, '--input-type=module', '-e', current]), 'schema9');
  result.checks.push('old-attempt-preserves-current-database');
  result.status = 'passed';
} catch (error) {
  result.status = 'failed';
  throw error;
} finally {
  if (created) docker(['volume', 'rm', volume]);
  result.cleanupStatus = 'completed';
  result.completedAt = new Date().toISOString();
  mkdirSync(`${root}/artifacts/parity-implementation`, { recursive: true });
  writeFileSync(`${root}/artifacts/parity-implementation/schema8-compatibility.json`, `${JSON.stringify(result, null, 2)}\n`);
}
console.log(JSON.stringify(result));
