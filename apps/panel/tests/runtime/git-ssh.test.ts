import{afterEach,describe,expect,it,vi}from'vitest';
import{mkdtempSync,mkdirSync,readdirSync,readFileSync,rmSync,statSync,writeFileSync}from'node:fs';
import{execFileSync,spawn}from'node:child_process';
import{tmpdir}from'node:os';
import{join}from'node:path';
import{randomUUID}from'node:crypto';
import ssh2 from'ssh2';
import{Store}from'../../src/server/store.js';
import{normalizeServiceInput}from'../../src/server/configuration.js';
import{buildSource}from'../../src/agent/build.js';
import{gitSshCredentials,resolveSshRepository}from'../../src/agent/git-ssh.js';

const cleanup:(()=>void|Promise<void>)[]=[];afterEach(async()=>{for(const dispose of cleanup.splice(0).reverse())await dispose();vi.unstubAllEnvs();});
async function fixture(){
  const root=mkdtempSync(join(tmpdir(),'servus-ssh-fixture-')),source=join(root,'source'),bare=join(root,'repository.git');mkdirSync(source);
  const git=(args:string[],cwd=source)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();git(['init','-b','main']);writeFileSync(join(source,'Dockerfile'),'FROM scratch\n');git(['add','.']);git(['-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-m','SSH fixture']);const commit=git(['rev-parse','HEAD']);git(['clone','--bare',source,bare],root);
  const store=new Store(join(root,'data')),user=store.setup('fixture@example.test','fixture-only-hash'),project=store.createProject('ssh');const host=ssh2.utils.generateKeyPairSync('ed25519'),connections=new Set<ssh2.Connection>(),accepted=new Set<string>();let authenticated=0;
  const server=new ssh2.Server({hostKeys:[host.private]},client=>{connections.add(client);client.on('error',()=>{});client.on('close',()=>connections.delete(client));client.on('authentication',ctx=>{if(ctx.method!=='publickey'||!accepted.has(ctx.key.data.toString('base64')))return ctx.reject();if(ctx.signature){const key=ssh2.utils.parseKey(`${ctx.key.algo} ${ctx.key.data.toString('base64')}`);if(key instanceof Error||!key.verify(ctx.blob!,ctx.signature,ctx.hashAlgo))return ctx.reject();authenticated++;}ctx.accept();});client.on('ready',()=>client.on('session',accept=>{const session=accept();let protocol='';session.on('env',(acceptEnv,rejectEnv,info)=>{if(info.key==='GIT_PROTOCOL'&&info.val==='version=2'){protocol=info.val;acceptEnv?.();}else rejectEnv?.();});session.on('exec',(acceptExec,rejectExec,info)=>{if(!/^git-upload-pack ['"]?\/repository\.git['"]?$/.test(info.command)){rejectExec();return;}const channel=acceptExec(),child=spawn('git',['upload-pack',bare],{env:{...process.env,...(protocol?{GIT_PROTOCOL:protocol}:{})},stdio:['pipe','pipe','pipe']});channel.pipe(child.stdin);child.stdout.pipe(channel,{end:false});child.stderr.pipe(channel.stderr,{end:false});child.on('close',code=>{channel.exit(code??1);channel.end();});});}));});
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  cleanup.push(async()=>{for(const connection of connections)connection.end();await new Promise<void>(resolve=>server.close(()=>resolve()));store.close();rmSync(root,{recursive:true,force:true});});
  const port=(server.address() as{port:number}).port,repository=`ssh://git@127.0.0.1:${port}/repository.git`,knownHosts=`[127.0.0.1]:${port} ${host.public.split(' ').slice(0,2).join(' ')}\n`;vi.stubEnv('PANEL_GIT_SSH_HOSTS','127.0.0.1');
  const service=store.createService(project.id,normalizeServiceInput({name:'ssh',domains:[],source:{type:'git',repository,branch:'main',context:'.',dockerfile:'Dockerfile',ssh:{knownHosts}}}),user.id,randomUUID()).service;if(service.source?.type!=='git')throw new Error('Missing Git source');accepted.add(service.source.ssh!.publicKey!.split(' ')[1]!);
  return{root,store,user,service,commit,accepted,authenticated:()=>authenticated};
}

describe('verified SSH source transport',()=>{
  it('clones a real SSH Git repository with its generated key and rejects a changed server key',async()=>{
    const f=await fixture();if(f.service.source?.type!=='git')throw new Error('Missing source');const transport=await gitSshCredentials(f.root,f.service.id,f.service.source.repository,f.service.source.ssh!,f.store.vault);
    try{await new Promise<void>((resolve,reject)=>{const child=spawn('git',['clone','--single-branch','--branch','main','--',f.service.source!.type==='git'?f.service.source!.repository:'',join(f.root,'debug-checkout')],{env:{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:f.root,LANG:'C',...transport.env,GIT_TERMINAL_PROMPT:'0',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_ASKPASS:'/bin/false',GIT_CONFIG_COUNT:'2',GIT_CONFIG_KEY_0:'protocol.file.allow',GIT_CONFIG_VALUE_0:'never',GIT_CONFIG_KEY_1:'http.followRedirects',GIT_CONFIG_VALUE_1:'false'},stdio:['ignore','pipe','pipe']});let errors='';child.stderr.on('data',value=>errors+=value);child.on('error',reject);child.on('close',code=>code===0?resolve():reject(new Error(f.store.vault.redact(errors))));});}finally{transport.close();}
    const result=await buildSource(f.service,randomUUID(),join(f.root,'data'),'/unused',f.store.vault,{checkOnly:true});expect(result.sourceCommit).toBe(f.commit);expect(f.authenticated()).toBeGreaterThan(0);
    if(f.service.source?.type!=='git')throw new Error('Missing source');const before=f.authenticated(),wrongHost=ssh2.utils.generateKeyPairSync('ed25519').public.split(' ').slice(0,2).join(' '),original=f.service.source.ssh!.knownHosts.split(' ')[0]!;
    const changed=f.store.updateService(f.service.id,{expectedRevision:1,source:{...f.service.source,ssh:{...f.service.source.ssh!,knownHosts:`${original} ${wrongHost}\n`}}},f.user.id);
    await expect(buildSource(changed,randomUUID(),join(f.root,'data'),'/unused',f.store.vault,{checkOnly:true})).rejects.toMatchObject({code:'SOURCE_REPOSITORY_OR_BRANCH'});expect(f.authenticated()).toBe(before);
  },20000);
  it('uses private temporary key files, refuses foreign references and cleans up before a build',async()=>{
    const f=await fixture();if(f.service.source?.type!=='git')throw new Error('Missing source');const workspace=join(f.root,'workspace');mkdirSync(workspace);
    const helper=await gitSshCredentials(workspace,f.service.id,f.service.source.repository,f.service.source.ssh!,f.store.vault);const path=join(workspace,readdirSync(workspace)[0]!);
    expect(statSync(join(path,'identity')).mode&0o777).toBe(0o600);const configuration=readFileSync(join(path,'config'),'utf8');expect(configuration).toContain('StrictHostKeyChecking yes');expect(configuration).toContain('IdentityAgent none');expect(configuration).toContain('GlobalKnownHostsFile /dev/null');expect(helper.env.GIT_SSH_COMMAND).not.toContain('PRIVATE KEY');helper.close();expect(readdirSync(workspace)).toEqual([]);
    await expect(gitSshCredentials(workspace,randomUUID(),f.service.source.repository,f.service.source.ssh!,f.store.vault)).rejects.toThrow('unavailable');
  });
  it.each(['ssh://git@127.0.0.1/team/repo.git','ssh://git@169.254.169.254/team/repo.git','ssh://git@[::1]/team/repo.git'])('denies non-public destinations without an explicit allowlist: %s',async repository=>{vi.stubEnv('PANEL_GIT_SSH_HOSTS','');await expect(resolveSshRepository(repository)).rejects.toThrow('private addresses');});
});
