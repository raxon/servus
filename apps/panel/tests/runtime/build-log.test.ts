import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync,mkdirSync,writeFileSync,rmSync,symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readBuildLog } from '../../src/agent/build-log.js';
import { SecretVault } from '../../src/shared/secrets.js';

const dirs:string[]=[];afterEach(()=>{for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
it('reads only the requested bounded log and redacts stored secrets',()=>{
  const root=mkdtempSync(join(tmpdir(),'servus-build-log-'));dirs.push(root);const vault=new SecretVault(root),secret='build-private-token';vault.put(secret);
  const service=randomUUID(),operation=randomUUID(),other=randomUUID(),dir=join(root,'build-logs',service);mkdirSync(dir,{recursive:true});
  writeFileSync(join(dir,`${operation}.log`),'x'.repeat(270000)+`\n${secret}\nlast line`);
  writeFileSync(join(dir,`${other}.log`),'another build');
  const result=readBuildLog(root,service,operation,vault);expect(result.available).toBe(true);expect(result.truncated).toBe(true);expect(result.text).toContain('last line');expect(result.text).not.toContain(secret);expect(result.text).not.toContain('another build');
  expect(readBuildLog(root,service,randomUUID(),vault).available).toBe(false);
  expect(()=>readBuildLog(root,'../outside',operation,vault)).toThrow();
});
it('refuses a symlink in place of the log file or service directory',()=>{
  const root=mkdtempSync(join(tmpdir(),'servus-build-link-'));dirs.push(root);const vault=new SecretVault(root),service=randomUUID(),operation=randomUUID(),base=join(root,'build-logs'),dir=join(base,service);
  mkdirSync(dir,{recursive:true});writeFileSync(join(root,'private'),'not a build log');symlinkSync(join(root,'private'),join(dir,`${operation}.log`));
  expect(()=>readBuildLog(root,service,operation,vault)).toThrow();
  rmSync(dir,{recursive:true});symlinkSync(root,dir);expect(()=>readBuildLog(root,service,operation,vault)).toThrow();
});
