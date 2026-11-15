import { afterEach, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseExportUncertainError, exportDatabase } from '../../src/agent/database-export.js';

const cleanup:string[]=[];
afterEach(()=>{vi.unstubAllEnvs();for(const path of cleanup.splice(0))rmSync(path,{recursive:true,force:true});});
function fixture(script:string){
  const root=mkdtempSync(join(tmpdir(),'servus-export-test-'));cleanup.push(root);
  const executable=join(root,'docker');writeFileSync(executable,`#!/bin/sh\n${script}\n`);chmodSync(executable,0o700);
  vi.stubEnv('PATH',root+delimiter+(process.env.PATH||''));return root;
}
const target={containerId:'a'.repeat(64),dockerSocket:'/var/run/docker.sock',kind:'postgres' as const,database:'fixture',user:'fixture'};

it('returns the output only after a successful command and closes the private file',async()=>{
  const root=fixture('printf "%s\\n" "$@" > "$SERVUS_CAPTURE"; printf "dump-data"');
  vi.stubEnv('SERVUS_CAPTURE',join(root,'args'));
  const result=await exportDatabase(target);
  expect(result.size).toBe(9);expect(result.extension).toBe('dump');
  const chunks:Buffer[]=[];for await(const chunk of result.stream())chunks.push(Buffer.from(chunk));
  expect(Buffer.concat(chunks).toString()).toBe('dump-data');
  expect(readFileSync(join(root,'args'),'utf8')).toContain('pg_dump');
  result.close();result.close();expect(()=>result.stream()).toThrow('closed');
});

it('rejects failed and empty exports instead of publishing partial data',async()=>{
  fixture('printf "partial"; exit 1');
  await expect(exportDatabase(target)).rejects.toThrow('Database export failed');
  fixture('exit 0');
  await expect(exportDatabase(target)).rejects.toThrow('Database export failed');
});

it('rejects untrusted target identifiers before starting Docker',async()=>{
  await expect(exportDatabase({...target,containerId:'bad'})).rejects.toThrow('Invalid database export target');
  await expect(exportDatabase({...target,database:'db;touch /tmp/no'})).rejects.toThrow('Invalid database export target');
});

it('cancels an active export when its caller aborts',async()=>{
  fixture('exec sleep 30');
  const controller=new AbortController();
  const promise=exportDatabase({...target,signal:controller.signal});
  setTimeout(()=>controller.abort(),30);
  await expect(promise).rejects.toBeInstanceOf(DatabaseExportUncertainError);
});
