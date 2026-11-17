import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/server/store.js';

const roots:string[]=[];
afterEach(()=>{for(const dir of roots.splice(0))rmSync(dir,{recursive:true,force:true});});
it('redacts individual S3 credentials as well as the sealed provider record',()=>{
  const dir=mkdtempSync(join(tmpdir(),'servus-provider-redact-'));roots.push(dir);
  const store=new Store(dir);
  try {
    const user=store.createUser('owner@example.test','unused','admin'),project=store.createProject('redaction');
    const {service}=store.createService(project.id,{name:'db',image:'postgres:17-alpine',port:5432,hostname:'db.internal',kind:'postgres'},user.id);
    const accessKeyId='test-access-key',secretAccessKey='test+/provider-secret';
    const reference=store.putBackupDestinationSecret(service.id,JSON.stringify({kind:'backup-storage-v1',serviceId:service.id,destination:{accessKeyId,secretAccessKey}}));
    const record=store.vault.getServiceSecret(reference,service.id,'backup-storage');
    const output=store.vault.redact(`Provider error: ${accessKeyId} ${secretAccessKey} ${encodeURIComponent(secretAccessKey)} ${record}`);
    for(const value of [accessKeyId,secretAccessKey,encodeURIComponent(secretAccessKey),record])expect(output).not.toContain(value);
    expect(()=>store.vault.getServiceSecret(reference,service.id,'environment')).toThrow('purpose');
  } finally {store.close();}
});
