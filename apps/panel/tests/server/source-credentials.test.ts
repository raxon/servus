import {afterEach,describe,expect,it} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import ssh2 from 'ssh2';
import {Store} from '../../src/server/store.js';
import {createApp} from '../../src/server/app.js';
import {hashPassword} from '../../src/server/auth.js';
import {registryAuth,registryAuthFromSpec,registryLabels,applyRegistryService} from '../../src/agent/registry-credentials.js';
import {canonicalRegistry,imageRegistry,normalizeKnownHosts} from '../../src/shared/source-credentials.js';
import {vi} from 'vitest';

const cleanup:(()=>Promise<void>)[]=[];afterEach(async()=>{for(const dispose of cleanup.splice(0).reverse())await dispose();});
async function fixture(){const root=mkdtempSync(join(tmpdir(),'servus-source-credentials-')),store=new Store(root),app=await createApp({dataDir:root,store});cleanup.push(async()=>{await app.close();store.close();rmSync(root,{recursive:true,force:true});});const setup=await app.inject({method:'POST',url:'/api/v1/setup',payload:{email:'admin@example.test',password:'fixture-password-admin'}}),headers={cookie:`panel_session=${setup.cookies.find(item=>item.name==='panel_session')!.value}`,'x-csrf-token':setup.json().csrfToken},project=store.createProject('source-credentials');const create=(payload:object)=>app.inject({method:'POST',url:`/api/v1/projects/${project.id}/services`,headers:{...headers,'idempotency-key':randomUUID()},payload:{name:`app-${randomUUID().slice(0,8)}`,domains:[],...payload}});return{root,store,app,headers,project,create};}
const registry={server:'registry.example.test:5443',username:'reader',password:'registry-password-fixture'};
const image='registry.example.test:5443/team/app:stable';

describe('service-owned registry credentials',()=>{
  it('keeps credentials encrypted, pins old queued snapshots and binds references to host/account/service/purpose',async()=>{
    const f=await fixture(),response=await f.create({image,registry});expect(response.statusCode).toBe(202);const{service,action}=response.json(),ref=service.registry.secretRef;
    expect(service.registry).toEqual({server:registry.server,username:registry.username,secretRef:ref});expect(response.body).not.toContain(registry.password);
    const initial=f.store.db.prepare('SELECT snapshot FROM jobs WHERE action_id=?').get(action.id) as{snapshot:string};expect(initial.snapshot).not.toContain(registry.password);expect(JSON.parse(initial.snapshot).registry.secretRef).toBe(ref);
    const rotated=await f.app.inject({method:'PATCH',url:`/api/v1/services/${service.id}`,headers:f.headers,payload:{expectedRevision:1,registry:{...registry,password:'rotated-registry-password'}}});expect(rotated.statusCode).toBe(200);expect(rotated.json().registry.secretRef).not.toBe(ref);expect(JSON.parse(initial.snapshot).registry.secretRef).toBe(ref);
    expect(registryAuth(service,image,f.store.vault)?.password).toBe(registry.password);
    expect(()=>registryAuth(service,'foreign.example.test/team/app:stable',f.store.vault)).toThrow('do not match');
    expect(()=>registryAuth({...service,id:randomUUID()},image,f.store.vault)).toThrow('unavailable');
    expect((await f.create({image,registry:{server:registry.server,username:registry.username,secretRef:ref}})).statusCode).toBe(403);
    expect((await f.app.inject({method:'PATCH',url:`/api/v1/services/${service.id}`,headers:f.headers,payload:{expectedRevision:2,image:'other.example.test/app:stable'}})).statusCode).toBe(400);
    expect((await f.app.inject({method:'PATCH',url:`/api/v1/services/${service.id}`,headers:f.headers,payload:{expectedRevision:2,environment:[{name:'STOLEN',secret:true,secretRef:ref}]}})).statusCode).toBe(403);
    const removed=await f.app.inject({method:'PATCH',url:`/api/v1/services/${service.id}`,headers:f.headers,payload:{expectedRevision:2,registry:null}});expect(removed.statusCode).toBe(200);expect(removed.json().registry).toBeNull();expect(registryAuth(service,image,f.store.vault)?.password).toBe(registry.password);
    expect(f.store.vault.redact(registry.password)).toBe('[REDACTED]');
  });
  it('sends authentication separately from Docker specifications and restores the prior bound reference',async()=>{
    const f=await fixture(),response=await f.create({image,registry}),{service}=response.json(),auth=registryAuth(service,image,f.store.vault)!;
    const spec={Name:`panel-app-${service.id}`,Labels:{'panel.owner':'self-hosted-panel','panel.service':service.id,...registryLabels(service)},TaskTemplate:{ContainerSpec:{Image:`${registry.server}/team/app@sha256:${'a'.repeat(64)}`}}};
    expect(registryAuthFromSpec(service.id,spec,f.store.vault)).toEqual(auth);expect(JSON.stringify(spec)).not.toContain(registry.password);
    const update=vi.fn().mockResolvedValue(undefined),createService=vi.fn().mockResolvedValue({}),docker={getService:vi.fn(()=>({update})),createService};
    await applyRegistryService(docker as never,spec,undefined,auth);expect(createService).toHaveBeenCalledWith(auth,spec);
    await applyRegistryService(docker as never,spec,7,auth);expect(update).toHaveBeenCalledWith(auth,{...spec,version:7});expect(update.mock.calls[0]![1]).not.toHaveProperty('authconfig');
    expect(()=>registryAuthFromSpec(randomUUID(),spec,f.store.vault)).toThrow('ownership');
  });
  it.each(['https://registry.example.test','user@registry.example.test','registry.example.test/path','registry.example.test?query','registry.example.test:0','-host.example.test'])('rejects ambiguous registry identities: %s',value=>expect(()=>canonicalRegistry(value)).toThrow());
  it('normalizes Docker Hub and explicit registry ports',()=>{expect(imageRegistry('nginx:alpine')).toBe('docker.io');expect(imageRegistry('team/app:stable')).toBe('docker.io');expect(canonicalRegistry('INDEX.DOCKER.IO')).toBe('docker.io');expect(imageRegistry('Registry.Example.Test:5443/team/app@sha256:abc')).toBe('registry.example.test:5443');});
});

describe('SSH deploy key configuration',()=>{
  const hostKey=ssh2.utils.generateKeyPairSync('ed25519').public.split(' ').slice(0,2).join(' '),source={type:'git',repository:'ssh://git@github.com/example/app.git',branch:'main',context:'.',dockerfile:'Dockerfile',ssh:{knownHosts:`github.com ${hostKey}\n`}};
  it('generates only public metadata in HTTP and immutable encrypted keys in snapshots',async()=>{
    const f=await fixture(),response=await f.create({source});expect(response.statusCode).toBe(202);const{service,action}=response.json(),ssh=service.source.ssh;
    expect(ssh.publicKey).toMatch(/^ssh-ed25519 /);expect(ssh.secretRef).toBeTruthy();expect(response.body).not.toContain('PRIVATE KEY');
    const record=JSON.parse(f.store.vault.getServiceSecret(ssh.secretRef,service.id,'git-ssh'));expect(record.privateKey).toContain('OPENSSH PRIVATE KEY');expect(record.repository).toBe(source.repository);
    const snapshot=(f.store.db.prepare('SELECT snapshot FROM jobs WHERE action_id=?').get(action.id) as{snapshot:string}).snapshot;expect(snapshot).not.toContain('PRIVATE KEY');
    const rotated=await f.app.inject({method:'PATCH',url:`/api/v1/services/${service.id}`,headers:f.headers,payload:{expectedRevision:1,source}});expect(rotated.statusCode).toBe(200);expect(rotated.json().source.ssh.publicKey).not.toBe(ssh.publicKey);expect(JSON.parse(snapshot).source.ssh.secretRef).toBe(ssh.secretRef);
    const stolen=await f.create({source:{...source,ssh}});expect(stolen.statusCode).toBe(403);
    expect(f.store.vault.redact(record.privateKey)).toBe('[REDACTED]');
  });
  it('restricts host trust and key changes to administrators and rejects host-key mismatches',async()=>{
    const f=await fixture(),response=await f.create({source}),service=response.json().service;
    const editor=f.store.createUser('editor@example.test',await hashPassword('fixture-password-editor'));f.store.addMember(f.project.id,editor.id,'editor');const session=f.store.createSession(editor.id),headers={cookie:`panel_session=${session.token}`,'x-csrf-token':session.csrfToken};
    expect((await f.app.inject({method:'PATCH',url:`/api/v1/services/${service.id}`,headers,payload:{expectedRevision:1,source:service.source}})).statusCode).toBe(403);
    expect((await f.app.inject({method:'PATCH',url:`/api/v1/services/${service.id}`,headers:f.headers,payload:{expectedRevision:1,source:{...source,ssh:{knownHosts:`foreign.example.test ${hostKey}`}}}})).statusCode).toBe(400);
    expect(()=>normalizeKnownHosts(`*.github.com ${hostKey}`,source.repository)).toThrow();expect(()=>normalizeKnownHosts(`github.com,foreign.example.test ${hostKey}`,source.repository)).toThrow();
    expect((await f.create({source:{...source,repository:'ssh://git@127.0.0.1/example/app.git'}})).statusCode).toBe(400);
  });
});
