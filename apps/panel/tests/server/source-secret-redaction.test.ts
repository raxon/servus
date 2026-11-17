import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecretVault } from '../../src/shared/secrets.js';
const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
it('redacts registry authentication encodings and multiline deploy key material',()=>{
  const root=mkdtempSync(join(tmpdir(),'source-secret-redaction-'));roots.push(root);const vault=new SecretVault(root);
  const password='registry-fixture-"\\\n-password',username='fixture-user';
  const privateKey='-----BEGIN OPENSSH PRIVATE KEY-----\n'+Buffer.from('synthetic-private-material-for-a-log-fixture').toString('base64')+'\n-----END OPENSSH PRIVATE KEY-----\n'; // Invalid PEM used only to test redaction. gitleaks:allow
  const auth=JSON.stringify({username,password,serveraddress:'registry.example.com'});
  vault.put(JSON.stringify({kind:'registry-credential-v1',server:'registry.example.com',username,password}));vault.put(JSON.stringify({kind:'git-ssh-v1',privateKey}));
  for(const value of [password,JSON.stringify(password).slice(1,-1),Buffer.from(password).toString('base64'),Buffer.from(`${username}:${password}`).toString('base64'),Buffer.from(auth).toString('base64'),Buffer.from(auth).toString('base64url'),privateKey,JSON.stringify(privateKey).slice(1,-1),Buffer.from(privateKey).toString('base64'),privateKey.split('\n')[1]!])expect(vault.redact(`message ${value} end`)).toBe('message [REDACTED] end');
});
