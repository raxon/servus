import { spawn } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { SecretVault } from '../shared/secrets.js';
import type { Service } from '../shared/types.js';
import { gitCredentials } from './git-credentials.js';

export async function validateRepository(repository: string): Promise<URL> {
  const url = new URL(repository);
  if (url.username || url.password || url.search || url.hash) throw new Error('Git URLs must not contain credentials, query strings or fragments.');
  const allowed = (process.env.PANEL_GIT_HTTP_HOSTS || '').split(',').map(value => value.trim()).filter(Boolean);
  if (allowed.includes(url.hostname) && (url.protocol === 'http:' || url.protocol === 'https:')) return url;
  if (url.protocol !== 'https:') throw new Error('Git repositories require HTTPS. Local HTTP fixtures need an explicit host allowlist.');
  const addresses = await lookup(url.hostname, { all: true });
  if (addresses.some(({ address }) => privateAddress(address))) throw new Error('Git repositories cannot target private network addresses.');
  return url;
}
function privateAddress(value: string): boolean {
  if (value.includes(':')) return /^(::|::1$|fc|fd|fe[89ab]|::ffff:)/i.test(value);
  const parts = value.split('.').map(Number), [a = 0, b = 0] = parts;
  return a === 0 || a === 10 || a === 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 100 && b >= 64 && b <= 127;
}
function confined(root: string, value: string): string {
  const target = realpathSync(resolve(root, value.replace(/^\/+/, '')));
  const path = relative(realpathSync(root), target);
  if (path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) throw new Error('The build path escapes the repository.');
  return target;
}
export function buildLogPath(dataDir: string, serviceId: string, operationId: string) {
  const directory = join(dataDir, 'build-logs', serviceId);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return join(directory, `${operationId}.log`);
}

async function run(command: string, args: string[], cwd: string, log: string, vault: SecretVault, secrets: string[], timeoutMs: number, env: NodeJS.ProcessEnv = process.env, suppressOutput=false): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    let output = '', pending = '', line = '', failed = false, written = 0;
    const limit = 8 * 1024 * 1024;
    const emit = (text:string) => {
      if(written>=limit)return;
      line+=text;
      let newline:number;
      while((newline=line.indexOf('\n'))>=0){
        const entry=`${new Date().toISOString()} ${line.slice(0,newline)}\n`;
        appendFileSync(log,entry.slice(0,limit-written),{mode:0o600});written+=Buffer.byteLength(entry);line=line.slice(newline+1);
        if(written>=limit)break;
      }
      if(line.length>65536){appendFileSync(log,`${new Date().toISOString()} ${line.slice(0,65536)}\n`,{mode:0o600});written+=65536;line='';}
    };
    const retain = Math.max(1, ...secrets.map(secret => secret.length));
    const write = (chunk: Buffer | string) => {
      const text = chunk.toString(); output = (output + text).slice(-2 * 1024 * 1024); pending += text;
      if(suppressOutput){pending='';return;}
      let cut = Math.max(0, pending.length - retain);
      for (const secret of secrets) {
        const index = pending.lastIndexOf(secret, cut);
        if (index >= 0 && index < cut && index + secret.length > cut) cut = index;
      }
      if (cut) { emit(vault.redact(pending.slice(0, cut))); pending = pending.slice(cut); }
    };
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', write); child.stderr.on('data', write);
    const timer = setTimeout(() => {
      failed = true;
      try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* Process already exited. */ }
    }, timeoutMs);
    child.once('error', error => { clearTimeout(timer); reject(new Error(`Unable to start ${command}: ${error.message}`)); });
    child.once('close', code => {
      clearTimeout(timer); if(!suppressOutput)emit(vault.redact(pending)+'\n');
      if (failed) reject(new Error(`${command} exceeded its execution deadline.`));
      else if (code !== 0) reject(new Error(suppressOutput?`${command} failed with exit code ${code}.`:`${command} failed with exit code ${code}. ${vault.redact(output).slice(-2000)}`));
      else resolvePromise(output.trim());
    });
  });
}

export async function buildSource(service: Service, operationId: string, dataDir: string, dockerSocket: string, vault: SecretVault): Promise<{ image: string; sourceCommit: string }> {
  if (service.source?.type !== 'git') throw new Error('A Git source is required.');
  const source = service.source;
  const repository=await validateRepository(source.repository);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/.test(source.branch) || source.branch.includes('..') || source.branch.endsWith('/')) throw new Error('Invalid Git branch.');
  const credentials = (service.environment || []).filter(item => item.secretRef).map(item => vault.getServiceSecret(item.secretRef!,service.id,'environment'));
  const directory = join(dataDir, 'builds'); mkdirSync(directory, { recursive: true, mode: 0o700 });
  const workspace = mkdtempSync(join(directory, `${operationId}-`));
  const log = buildLogPath(dataDir, service.id, operationId);
  appendFileSync(log, `${new Date().toISOString()} Fetching source branch ${source.branch}\n`, { mode: 0o600 });
  const gitEnv:NodeJS.ProcessEnv = {PATH:'/usr/local/bin:/usr/bin:/bin',HOME:workspace,LANG:'C',GIT_TERMINAL_PROMPT:'0',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_ASKPASS:'/bin/false',
    GIT_CONFIG_COUNT:'2',GIT_CONFIG_KEY_0:'protocol.file.allow',GIT_CONFIG_VALUE_0:'never',GIT_CONFIG_KEY_1:'http.followRedirects',GIT_CONFIG_VALUE_1:'false'};
  const testHosts=(process.env.PANEL_GIT_HTTP_HOSTS??'').split(',').map(value=>value.trim());
  if(testHosts.includes(repository.hostname)&&process.env.PANEL_GIT_TEST_CA)gitEnv.GIT_SSL_CAINFO=process.env.PANEL_GIT_TEST_CA;
  let helper:Awaited<ReturnType<typeof gitCredentials>>|undefined;
  try {
    if(source.credential){
      if(repository.protocol!=='https:'||!source.credential.secretRef||source.credential.token!==undefined)throw new Error('Invalid private Git credential.');
      let record:unknown;
      try{record=JSON.parse(vault.getServiceSecret(source.credential.secretRef,service.id,'git'));}catch{throw new Error('Invalid private Git credential.');}
      if(!record||typeof record!=='object'||!('kind' in record)||record.kind!=='git-credential-v1'||!('serviceId' in record)||record.serviceId!==service.id||!('repository' in record)||record.repository!==repository.href||!('username' in record)||record.username!==source.credential.username||!('token' in record)||typeof record.token!=='string'||!/^[^\x00-\x20\x7f]+$/.test(record.token)||!/^[^\x00-\x20\x7f:=]+$/.test(source.credential.username))throw new Error('Invalid private Git credential.');
      credentials.push(record.token,encodeURIComponent(record.token),Buffer.from(record.token).toString('base64'),Buffer.from(`${source.credential.username}:${record.token}`).toString('base64'));
      helper=await gitCredentials(workspace,repository,source.credential.username,record.token);
      gitEnv.SERVUS_GIT_SOCKET=helper.socket;gitEnv.GIT_CONFIG_COUNT='4';gitEnv.GIT_CONFIG_KEY_2='credential.useHttpPath';gitEnv.GIT_CONFIG_VALUE_2='true';gitEnv.GIT_CONFIG_KEY_3='credential.helper';gitEnv.GIT_CONFIG_VALUE_3=helper.helper;
    }
    const checkout = join(workspace, 'code');
    const revisions = join(dataDir, 'source-revisions'); mkdirSync(revisions, { recursive: true, mode: 0o700 });
    const revisionPath = join(revisions, operationId);
    let sourceCommit: string;
    if (existsSync(revisionPath)) {
      const previous = JSON.parse(readFileSync(revisionPath, 'utf8'));
      if (previous.repository !== source.repository || previous.branch !== source.branch || previous.serviceId !== service.id || !/^[a-f0-9]{40,64}$/.test(previous.commit)) throw new Error('The source revision record does not match this operation.');
      sourceCommit = previous.commit;
      mkdirSync(checkout);
      await run('git', ['init'], checkout, log, vault, credentials, 10000,gitEnv,!!helper);
      await run('git', ['remote', 'add', 'origin', source.repository], checkout, log, vault, credentials, 10000,gitEnv,!!helper);
      await run('git', ['fetch', 'origin', sourceCommit], checkout, log, vault, credentials, 120000,gitEnv,!!helper);
      await run('git', ['checkout', '--detach', sourceCommit], checkout, log, vault, credentials, 10000,gitEnv,!!helper);
    } else {
      const shallow = new URL(source.repository).protocol === 'https:' ? ['--depth', '1'] : [];
      await run('git', ['clone', '--single-branch', ...shallow, '--branch', source.branch, '--', source.repository, checkout], workspace, log, vault, credentials, 120000,gitEnv,!!helper);
      sourceCommit = await run('git', ['rev-parse', 'HEAD'], checkout, log, vault, credentials, 10000,gitEnv,!!helper);
      if(!/^[a-f0-9]{40,64}$/.test(sourceCommit))throw new Error('Invalid Git revision.');
      writeFileSync(revisionPath, JSON.stringify({ repository: source.repository, branch: source.branch, serviceId: service.id, commit: sourceCommit }), { flag: 'wx', mode: 0o600 });
    }
    if(helper){await helper.close();helper=undefined;delete gitEnv.SERVUS_GIT_SOCKET;}
    const context = confined(checkout, source.context || '.');
    const dockerfile = confined(context, source.dockerfile || 'Dockerfile');
    const image = `panel-build:${operationId}`;
    const args = ['--host', `unix://${dockerSocket}`, 'buildx', 'build', '--load', '--progress=plain', '--label', 'panel.owner=self-hosted-panel', '--label', `panel.service=${service.id}`, '-t', image, '-f', dockerfile];
    for (const item of service.environment || []) {
      if (item.secretRef) {
        const file = join(workspace, `secret-${item.name}`); writeFileSync(file, vault.getServiceSecret(item.secretRef,service.id,'environment'), { mode: 0o600 });
        args.push('--secret', `id=${item.name},src=${file}`);
      } else if (!item.secret) args.push('--build-arg', `${item.name}=${item.value || ''}`);
    }
    args.push('--build-arg', `SOURCE_COMMIT=${sourceCommit}`, '--label', `panel.source.commit=${sourceCommit}`, context);
    appendFileSync(log, `${new Date().toISOString()} Building immutable source ${sourceCommit}\n`);
    await run('docker', args, checkout, log, vault, credentials, 600000, { ...process.env, DOCKER_BUILDKIT: '1' });
    appendFileSync(log, `${new Date().toISOString()} Build completed\n`);
    return { image, sourceCommit };
  } finally { if(helper)await helper.close();rmSync(workspace, { recursive: true, force: true }); }
}
