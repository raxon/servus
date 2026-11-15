import { afterEach, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/server/store.js';
import { createApp } from '../../src/server/app.js';
import { loadRestoreSource } from '../../src/agent/restore-source.js';

const cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const remove of cleanup.splice(0).reverse())await remove();});
async function fixture(kind:'postgres'|'mariadb') {
  const dataDir=mkdtempSync(join(tmpdir(),'restore-source-')),store=new Store(dataDir),app=await createApp({dataDir,store});
  cleanup.push(async()=>{await app.close();store.close();rmSync(dataDir,{recursive:true,force:true});});
  const setup=await app.inject({method:'POST',url:'/api/v1/setup',payload:{email:'admin@example.test',password:'testing-password'}});
  const headers={cookie:`panel_session=${setup.cookies[0]!.value}`,'x-csrf-token':setup.json().csrfToken,'idempotency-key':'create'};
  const project=store.createProject('fixture');
  const created=await app.inject({method:'POST',url:`/api/v1/projects/${project.id}/services`,headers,payload:{name:'database',kind,database:{database:'example',user:'fixture',password:'synthetic-db-password'}}});
  expect(created.statusCode).toBe(202);
  const service=created.json().service,job=store.claimNextJob('worker',60000)!;
  store.completeAction(job.actionId,'worker',{state:'running',deployedRevision:job.snapshot.revision});
  return {dataDir,store,app,headers,service,kind,options:{dataDir,serviceId:service.id,kind,vault:store.vault}};
}

it('uses credentials owned by the confirmed deployed database',async()=>{
  const f=await fixture('postgres');
  expect(loadRestoreSource(f.options)).toEqual({database:'example',user:'fixture',password:'synthetic-db-password'});
  expect(()=>loadRestoreSource({...f.options,kind:'mariadb'})).toThrow('identity');
  f.store.db.prepare("UPDATE jobs SET snapshot=json_set(snapshot,'$.id',?)").run(randomUUID());
  expect(()=>loadRestoreSource(f.options)).toThrow('identity');
});

it('refuses a stopped service and a queued or running change',async()=>{
  const f=await fixture('postgres');
  f.store.db.prepare("UPDATE services SET state='stopped' WHERE id=?").run(f.service.id);
  expect(()=>loadRestoreSource(f.options)).toThrow('not ready');
  f.store.db.prepare("UPDATE services SET state='running' WHERE id=?").run(f.service.id);
  const user=f.store.getSession(f.headers.cookie.slice('panel_session='.length))!.user;
  f.store.createAction(f.service.id,'restart',user.id,'restart');
  expect(()=>loadRestoreSource(f.options)).toThrow('not ready');
});

it('rejects a secret reference that does not belong to the deployed service',async()=>{
  const f=await fixture('postgres'),foreign=f.store.vault.put('unowned-password');
  f.store.db.prepare("UPDATE jobs SET snapshot=json_set(snapshot,'$.database.passwordSecretRef',?)").run(foreign);
  expect(()=>loadRestoreSource(f.options)).toThrow('not valid for this purpose');
});

it('requires an owned regular MariaDB root reference',async()=>{
  const f=await fixture('mariadb'),directory=join(f.dataDir,'database-roots'),path=join(directory,f.service.id);
  mkdirSync(directory,{mode:0o700}); const ref=f.store.vault.put('synthetic-root-password');
  writeFileSync(path,ref,{mode:0o600});
  expect(loadRestoreSource(f.options)).toEqual({database:'example',user:'fixture',password:'synthetic-db-password',rootPassword:'synthetic-root-password'});
  rmSync(path);symlinkSync('/nonexistent',path);
  expect(()=>loadRestoreSource(f.options)).toThrow('identity');
});
