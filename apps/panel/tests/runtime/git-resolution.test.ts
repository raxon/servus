import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('node:dns/promises',()=>({lookup:vi.fn()}));
vi.mock('node:child_process',()=>({spawn:vi.fn()}));
import { lookup } from 'node:dns/promises';
import { spawn } from 'node:child_process';
import { buildSource, resolveRepository } from '../../src/agent/build.js';
import { SecretVault } from '../../src/shared/secrets.js';
import type { Service } from '../../src/shared/types.js';

afterEach(()=>{vi.resetAllMocks();vi.unstubAllEnvs();});

it('pins a public DNS answer to the Git host and port',async()=>{
  vi.mocked(lookup).mockResolvedValue([{address:'8.8.8.8',family:4},{address:'2606:4700:4700::1111',family:6}] as never);
  const result=await resolveRepository('https://git.example.com:8443/org/repo.git');
  expect(result.resolve).toBe('git.example.com:8443:8.8.8.8,[2606:4700:4700::1111]');
  expect(lookup).toHaveBeenCalledOnce();
});

it('rejects any private, local, reserved or malformed DNS answer',async()=>{
  for(const address of ['127.0.0.1','169.254.169.254','192.168.1.2','198.18.0.1','224.0.0.1','::1','::ffff:127.0.0.1','fc00::1','fe80::1','2001:db8::1','2002::1','not-an-address']){
    vi.mocked(lookup).mockResolvedValue([{address:'8.8.8.8',family:4},{address,family:address.includes(':')?6:4}] as never);
    await expect(resolveRepository('https://git.example.com/repo.git')).rejects.toThrow('private network');
  }
  vi.mocked(lookup).mockResolvedValue([] as never);
  await expect(resolveRepository('https://git.example.com/repo.git')).rejects.toThrow('private network');
});

it('rejects private literal addresses and keeps explicitly allowed fixtures',async()=>{
  await expect(resolveRepository('https://127.0.0.1/repo.git')).rejects.toThrow('private network');
  await expect(resolveRepository('https://[::1]/repo.git')).rejects.toThrow('private network');
  vi.stubEnv('PANEL_GIT_HTTP_HOSTS','127.0.0.1');
  expect((await resolveRepository('http://127.0.0.1:8080/repo.git')).resolve).toBeUndefined();
});

it('passes the verified address to Git without allowing it to resolve DNS again',async()=>{
  const root=mkdtempSync(join(tmpdir(),'servus-git-dns-'));
  try{
    vi.mocked(lookup).mockResolvedValue([{address:'8.8.8.8',family:4}] as never);
    let env:NodeJS.ProcessEnv|undefined;
    vi.mocked(spawn).mockImplementation(((_command,_args,options)=>{env=options?.env;throw new Error('fixture stopped');}) as never);
    const id=randomUUID();
    const service={id,projectId:randomUUID(),name:'git',image:'unused',hostname:'local',port:80,replicas:1,revision:1,deployedRevision:null,state:'pending',createdAt:'now',updatedAt:'now',lastError:null,
      source:{type:'git',repository:'https://git.example.com/repo.git',branch:'main',context:'.',dockerfile:'Dockerfile'}} satisfies Service;
    await expect(buildSource(service,randomUUID(),root,'/unused',new SecretVault(root))).rejects.toThrow('fixture stopped');
    expect(env?.GIT_CONFIG_KEY_2).toBe('http.curloptResolve');
    expect(env?.GIT_CONFIG_VALUE_2).toBe('git.example.com:443:8.8.8.8');
    expect(env?.GIT_CONFIG_COUNT).toBe('3');
  }finally{rmSync(root,{recursive:true,force:true});}
});
