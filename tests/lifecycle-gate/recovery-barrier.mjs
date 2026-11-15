import assert from 'node:assert/strict';
import { chmodSync, chownSync, linkSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

if (process.getuid?.() !== 0 || !process.argv[2]) throw new Error('Run as root with the built lifecycle module path');
const { lifecycleAllowsWork } = await import(pathToFileURL(process.argv[2]).href);
const dir=mkdtempSync('/tmp/servus-barrier-');chmodSync(dir,0o755);
const path=join(dir,'state'),other=join(dir,'other');
try {
  assert.equal(lifecycleAllowsWork(path),false);
  writeFileSync(path,'servus-lifecycle-v1 recovering\n',{mode:0o644});
  assert.equal(lifecycleAllowsWork(path),false);
  writeFileSync(path,'servus-lifecycle-v1 normal\n');
  assert.equal(lifecycleAllowsWork(path),true);
  writeFileSync(path,'servus-lifecycle-v1 normal\nextra');
  assert.equal(lifecycleAllowsWork(path),false);
  writeFileSync(path,'servus-lifecycle-v1 normal\n');chmodSync(path,0o666);
  assert.equal(lifecycleAllowsWork(path),false);
  chmodSync(path,0o644);chownSync(path,1000,1000);
  assert.equal(lifecycleAllowsWork(path),false);
  chownSync(path,0,0);linkSync(path,other);
  assert.equal(lifecycleAllowsWork(path),false);
  unlinkSync(other);unlinkSync(path);writeFileSync(other,'servus-lifecycle-v1 normal\n',{mode:0o644});symlinkSync(other,path);
  assert.equal(lifecycleAllowsWork(path),false);
  console.log('Lifecycle recovery barrier: all checks passed');
} finally {rmSync(dir,{recursive:true,force:true});}
