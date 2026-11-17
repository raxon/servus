import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { minioFixture } from '../../../../tests/backups/minio-fixture.js';

const roots:string[]=[];
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});

it('verifies the official checksum before executing an explicitly supplied local MinIO fixture binary',async()=>{
  const root=mkdtempSync(join(tmpdir(),'minio-checksum-'));roots.push(root);const binary=join(root,'untrusted-binary');writeFileSync(binary,'fixture bytes that must never execute');
  vi.stubEnv('SERVUS_MINIO_FIXTURE_BINARY',binary);const fetch=vi.fn(async()=>new Response(`${'0'.repeat(64)} minio.RELEASE.2025-09-07T16-13-09Z`));vi.stubGlobal('fetch',fetch);
  await expect(minioFixture()).rejects.toThrow('does not match the official release checksum');expect(fetch.mock.calls).toHaveLength(1);
});
