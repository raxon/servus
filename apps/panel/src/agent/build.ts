import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { isPrivateAddress } from '../shared/network-address.js';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { SecretVault } from '../shared/secrets.js';
import type { BuildResourceConfig, Service, SourceBuilder } from '../shared/types.js';
import { extractSourceArchive, generateBuilderDockerfile } from './builders.js';
import { gitCredentials } from './git-credentials.js';
import { gitSshCredentials } from './git-ssh.js';
import { parseSshRepository } from '../shared/source-credentials.js';
import { writeGeneratedEnv } from './generated-env.js';

export class SourceCheckError extends Error {
  constructor(readonly code:'SOURCE_REPOSITORY_OR_BRANCH'|'SOURCE_CONTEXT'|'SOURCE_DOCKERFILE',message:string) {super(message);this.name='SourceCheckError';}
}

export class BuildCancelledError extends Error {
  readonly code = 'BUILD_CANCELLED';
  constructor(message = 'Build cancelled by operator.') { super(message); this.name = 'BuildCancelledError'; }
}

const activeBuilds = new Map<string, { serviceId: string; cancel: () => void }>();

export function cancelActiveBuild(serviceId: string, operationId: string): boolean {
  const entry = activeBuilds.get(operationId);
  if (!entry || entry.serviceId !== serviceId) return false;
  entry.cancel();
  return true;
}

export async function resolveRepository(repository: string): Promise<{url:URL;resolve?:string}> {
  const url = new URL(repository);
  if (url.username || url.password || url.search || url.hash) throw new Error('Git URLs must not contain credentials, query strings or fragments.');
  const allowed = (process.env.PANEL_GIT_HTTP_HOSTS || '').split(',').map(value => value.trim()).filter(Boolean);
  if (allowed.includes(url.hostname) && (url.protocol === 'http:' || url.protocol === 'https:')) return {url};
  if (url.protocol !== 'https:') throw new Error('Git repositories require HTTPS. Local HTTP fixtures need an explicit host allowlist.');
  const hostname=url.hostname.replace(/^\[|\]$/g,'');
  const literal=isIP(hostname);
  const addresses=literal ? [{address:hostname,family:literal}] : await lookup(hostname,{all:true});
  if (!addresses.length || addresses.some(({address})=>isPrivateAddress(address))) throw new Error('Git repositories cannot target private network addresses.');
  if(literal) return {url};
  const targets=[...new Set(addresses.map(({address})=>isIP(address)===6?`[${address}]`:address))];
  return {url,resolve:`${hostname}:${url.port||'443'}:${targets.join(',')}`};
}
export async function validateRepository(repository:string):Promise<URL> {return (await resolveRepository(repository)).url;}
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

async function run(command: string, args: string[], cwd: string, log: string, vault: SecretVault, secrets: string[], timeoutMs: number, env: NodeJS.ProcessEnv = process.env, suppressOutput=false, track?: { serviceId: string; operationId: string }): Promise<string> {
  const redact = (value: string) => {
    let result = vault.redact(value);
    for (const secret of secrets) if (secret) result = result.replaceAll(secret, '[REDACTED]');
    return result;
  };
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    let output = '', pending = '', line = '', failed = false, cancelled = false, written = 0;
    const killGroup = () => {
      try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* Process already exited. */ }
    };
    if (track) {
      activeBuilds.set(track.operationId, {
        serviceId: track.serviceId,
        cancel: () => { cancelled = true; killGroup(); },
      });
    }
    const cleanupTrack = () => { if (track) activeBuilds.delete(track.operationId); };
    const limit = 8 * 1024 * 1024;
    const emit = (text:string) => {
      if(written>=limit)return;
      line+=text;
      let newline:number;
      while((newline=line.indexOf('\n'))>=0){
        const entry=`${new Date().toISOString()} [output] ${line.slice(0,newline)}\n`;
        appendFileSync(log,entry.slice(0,limit-written),{mode:0o600});written+=Buffer.byteLength(entry);line=line.slice(newline+1);
        if(written>=limit)break;
      }
      if(line.length>65536){appendFileSync(log,`${new Date().toISOString()} [output] ${line.slice(0,65536)}\n`,{mode:0o600});written+=65536;line='';}
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
      if (cut) { emit(redact(pending.slice(0, cut))); pending = pending.slice(cut); }
    };
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', write); child.stderr.on('data', write);
    const timer = setTimeout(() => { failed = true; killGroup(); }, timeoutMs);
    child.once('error', error => { clearTimeout(timer); cleanupTrack(); reject(new Error(`Unable to start ${command}: ${error.message}`)); });
    child.once('close', code => {
      clearTimeout(timer); cleanupTrack(); if(!suppressOutput)emit(redact(pending)+'\n');
      if (cancelled) reject(new BuildCancelledError('Build cancelled by operator.'));
      else if (failed) reject(new Error(`${command} exceeded its execution deadline.`));
      else if (code !== 0) reject(new Error(suppressOutput?`${command} failed with exit code ${code}.`:`${command} failed with exit code ${code}. ${redact(output).slice(-2000)}`));
      else resolvePromise(output.trim());
    });
  });
}

function resolveDockerfileForContext(
  context: string,
  workspace: string,
  dockerfileOption: string | undefined,
  builderOption: SourceBuilder | undefined,
  port: number,
  log: string,
  checkOnly: boolean,
): string {
  const builder: SourceBuilder = builderOption ?? 'dockerfile';
  const requestedDockerfile = dockerfileOption || 'Dockerfile';
  let existingDockerfile: string | undefined;
  try {
    const candidate = confined(context, requestedDockerfile);
    if (statSync(candidate).isFile()) existingDockerfile = candidate;
  } catch {
    existingDockerfile = undefined;
  }

  if (builder === 'dockerfile') {
    if (!existingDockerfile) {
      if (checkOnly) throw new SourceCheckError('SOURCE_DOCKERFILE', 'The Dockerfile is missing, inaccessible or outside the build context.');
      throw new Error('The Dockerfile must be a regular file.');
    }
    return existingDockerfile;
  }

  if (builder === 'auto' && existingDockerfile) {
    appendFileSync(log, `${new Date().toISOString()} [servus] Auto builder detected existing ${requestedDockerfile}\n`, { mode: 0o600 });
    return existingDockerfile;
  }

  const plan = generateBuilderDockerfile(context, workspace, builder, port);
  appendFileSync(log, `${new Date().toISOString()} [servus] Builder=${plan.builder} detected stack=${plan.stack} (${plan.summary})\n`, { mode: 0o600 });
  return plan.dockerfilePath;
}

async function runDockerBuild(
  service: Service,
  operationId: string,
  dockerSocket: string,
  vault: SecretVault,
  workspace: string,
  context: string,
  dockerfile: string,
  sourceCommit: string,
  log: string,
  credentials: string[],
  buildResources: BuildResourceConfig | undefined,
  envFile: string | undefined,
  forceRebuild: boolean | undefined,
): Promise<{ image: string; sourceCommit: string }> {
  if (envFile) writeGeneratedEnv(context, envFile, dockerfile, service.environment ?? [], service.id, vault);
  const image = `panel-build:${operationId}`;
  const args = ['--host', `unix://${dockerSocket}`, 'buildx', 'build', '--load', '--progress=plain', '--label', 'panel.owner=self-hosted-panel', '--label', `panel.service=${service.id}`, '-t', image, '-f', dockerfile];
  if (forceRebuild) args.push('--no-cache', '--pull');
  if (buildResources?.memoryMb) args.push('--memory', `${buildResources.memoryMb}m`);
  if (buildResources?.cpuQuotaPercent) args.push('--cpu-period', '100000', '--cpu-quota', String(buildResources.cpuQuotaPercent * 1000));
  const buildTimeoutMs = (buildResources?.timeoutSeconds ?? 600) * 1000;
  for (const item of service.environment || []) {
    if (item.secretRef) {
      const file = join(workspace, `secret-${item.name}`); writeFileSync(file, vault.getServiceSecret(item.secretRef, service.id, 'environment'), { mode: 0o600 });
      args.push('--secret', `id=${item.name},src=${file}`);
    } else if (!item.secret) args.push('--build-arg', `${item.name}=${item.value || ''}`);
  }
  args.push('--build-arg', `SOURCE_COMMIT=${sourceCommit}`, '--label', `panel.source.commit=${sourceCommit}`, context);
  appendFileSync(log, `${new Date().toISOString()} [servus] Building immutable source ${sourceCommit}\n`, { mode: 0o600 });
  await run('docker', args, context, log, vault, credentials, buildTimeoutMs, { ...process.env, DOCKER_BUILDKIT: '1' }, false, { serviceId: service.id, operationId });
  appendFileSync(log, `${new Date().toISOString()} [servus] Build completed\n`, { mode: 0o600 });
  return { image, sourceCommit };
}

export async function buildSource(service: Service, operationId: string, dataDir: string, dockerSocket: string, vault: SecretVault, options: { checkOnly?: boolean; sharedGithub?: boolean; forceRebuild?: boolean } = {}): Promise<{ image: string; sourceCommit: string }> {
  const source = service.source;
  if (!source || source.type === 'image') throw new Error('A buildable source (git, dockerfile or upload) is required.');
  const credentials = options.checkOnly ? [] : (service.environment || []).filter(item => item.secretRef).flatMap(item => {
    const value = vault.getServiceSecret(item.secretRef!, service.id, 'environment');
    const escaped = JSON.stringify(value).slice(1, -1);
    return value === escaped ? [value] : [value, escaped];
  });
  const directory = join(dataDir, 'builds'); mkdirSync(directory, { recursive: true, mode: 0o700 });
  const workspace = mkdtempSync(join(directory, `${operationId}-`));
  const log = buildLogPath(dataDir, service.id, operationId);

  if (source.type === 'dockerfile') {
    try {
      const context = join(workspace, 'code');
      mkdirSync(context, { recursive: true, mode: 0o700 });
      const dockerfile = join(context, 'Dockerfile');
      writeFileSync(dockerfile, source.dockerfileContent, { mode: 0o600 });
      const sourceCommit = createHash('sha256').update(source.dockerfileContent, 'utf8').digest('hex');
      appendFileSync(log, `${new Date().toISOString()} [servus] Building from inline Dockerfile (${sourceCommit.slice(0, 12)})\n`, { mode: 0o600 });
      if (options.checkOnly) return { image: '', sourceCommit };
      return await runDockerBuild(service, operationId, dockerSocket, vault, workspace, context, dockerfile, sourceCommit, log, credentials, source.buildResources, source.envFile, options.forceRebuild);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      if (options.checkOnly) rmSync(log, { force: true });
    }
  }

  if (source.type === 'upload') {
    try {
      if (!/^[a-f0-9-]{36}$/i.test(source.uploadId)) throw new Error('Invalid uploaded archive identity.');
      const archivePath = join(dataDir, 'source-uploads', service.projectId, `${source.uploadId}.tar.gz`);
      if (!existsSync(archivePath)) throw new Error('Uploaded source archive was not found for this project.');
      const archiveBytes = readFileSync(archivePath);
      const sourceCommit = createHash('sha256').update(archiveBytes).digest('hex');
      if (source.sha256 && source.sha256 !== sourceCommit) throw new Error('Uploaded source archive digest mismatch.');
      const checkout = join(workspace, 'code');
      mkdirSync(checkout, { recursive: true, mode: 0o700 });
      appendFileSync(log, `${new Date().toISOString()} [servus] Extracting uploaded archive ${source.filename ?? source.uploadId} (${sourceCommit.slice(0, 12)})\n`, { mode: 0o600 });
      await extractSourceArchive(archivePath, checkout);
      const context = confined(checkout, source.context || '.');
      if (!statSync(context).isDirectory()) throw new Error('The build context must be a directory.');
      const dockerfile = resolveDockerfileForContext(context, workspace, source.dockerfile, source.builder ?? 'auto', service.port || 80, log, Boolean(options.checkOnly));
      if (options.checkOnly) return { image: '', sourceCommit };
      return await runDockerBuild(service, operationId, dockerSocket, vault, workspace, context, dockerfile, sourceCommit, log, credentials, source.buildResources, source.envFile, options.forceRebuild);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      if (options.checkOnly) rmSync(log, { force: true });
    }
  }

  const resolved=new URL(source.repository).protocol==='ssh:'?{url:parseSshRepository(source.repository).url}:await resolveRepository(source.repository),repository=resolved.url;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/.test(source.branch) || source.branch.includes('..') || source.branch.endsWith('/')) throw new Error('Invalid Git branch.');
  appendFileSync(log, `${new Date().toISOString()} [servus] Fetching source branch ${source.branch}\n`, { mode: 0o600 });
  const gitEnv:NodeJS.ProcessEnv = {PATH:'/usr/local/bin:/usr/bin:/bin',HOME:workspace,LANG:'C',GIT_TERMINAL_PROMPT:'0',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_ASKPASS:'/bin/false',
    GIT_CONFIG_COUNT:'2',GIT_CONFIG_KEY_0:'protocol.file.allow',GIT_CONFIG_VALUE_0:'never',GIT_CONFIG_KEY_1:'http.followRedirects',GIT_CONFIG_VALUE_1:'false'};
  const addGitConfig=(key:string,value:string)=>{const index=Number(gitEnv.GIT_CONFIG_COUNT);gitEnv[`GIT_CONFIG_KEY_${index}`]=key;gitEnv[`GIT_CONFIG_VALUE_${index}`]=value;gitEnv.GIT_CONFIG_COUNT=String(index+1);};
  if(resolved.resolve)addGitConfig('http.curloptResolve',resolved.resolve);
  const testHosts=(process.env.PANEL_GIT_HTTP_HOSTS??'').split(',').map(value=>value.trim());
  if(testHosts.includes(repository.hostname)&&process.env.PANEL_GIT_TEST_CA)gitEnv.GIT_SSL_CAINFO=process.env.PANEL_GIT_TEST_CA;
  let helper:Awaited<ReturnType<typeof gitCredentials>>|undefined;
  let sshHelper:Awaited<ReturnType<typeof gitSshCredentials>>|undefined;
  try {
    if(repository.protocol==='ssh:') {
      if(!source.ssh||source.credential||options.sharedGithub)throw new Error('The SSH source requires its saved deploy key and pinned host key.');
      sshHelper=await gitSshCredentials(workspace,service.id,source.repository,source.ssh,vault);
      Object.assign(gitEnv,sshHelper.env);credentials.push(...sshHelper.secrets);
    } else if (options.sharedGithub) {
      if (!options.checkOnly || repository.protocol !== 'https:' || repository.host.toLowerCase() !== 'github.com') throw new Error('Invalid shared GitHub connection.');
      const connection = vault.githubConnection();
      if (!connection) throw new Error('Configure the GitHub connection in Settings.');
      credentials.push(connection.token,encodeURIComponent(connection.token),Buffer.from(connection.token).toString('base64'),Buffer.from(`${connection.username}:${connection.token}`).toString('base64'));
      helper=await gitCredentials(workspace,repository,connection.username,connection.token);
      gitEnv.SERVUS_GIT_SOCKET=helper.socket;addGitConfig('credential.useHttpPath','true');addGitConfig('credential.helper',helper.helper);
    } else if(source.credential){
      if(repository.protocol!=='https:'||!source.credential.secretRef||source.credential.token!==undefined)throw new Error('Invalid private Git credential.');
      let record:unknown;
      try{record=JSON.parse(vault.getServiceSecret(source.credential.secretRef,service.id,'git'));}catch{throw new Error('Invalid private Git credential.');}
      if(!record||typeof record!=='object'||!('kind' in record)||record.kind!=='git-credential-v1'||!('serviceId' in record)||record.serviceId!==service.id||!('repository' in record)||record.repository!==repository.href||!('username' in record)||record.username!==source.credential.username||!('token' in record)||typeof record.token!=='string'||!/^[^\x00-\x20\x7f]+$/.test(record.token)||!/^[^\x00-\x20\x7f:=]+$/.test(source.credential.username))throw new Error('Invalid private Git credential.');
      credentials.push(record.token,encodeURIComponent(record.token),Buffer.from(record.token).toString('base64'),Buffer.from(`${source.credential.username}:${record.token}`).toString('base64'));
      helper=await gitCredentials(workspace,repository,source.credential.username,record.token);
      gitEnv.SERVUS_GIT_SOCKET=helper.socket;addGitConfig('credential.useHttpPath','true');addGitConfig('credential.helper',helper.helper);
    }
    const checkout = join(workspace, 'code');
    const revisions = join(dataDir, 'source-revisions'); mkdirSync(revisions, { recursive: true, mode: 0o700 });
    const revisionPath = join(revisions, operationId);
    let sourceCommit: string;
    if (!options.checkOnly && existsSync(revisionPath)) {
      const previous = JSON.parse(readFileSync(revisionPath, 'utf8'));
      if (previous.repository !== source.repository || previous.branch !== source.branch || previous.serviceId !== service.id || !/^[a-f0-9]{40,64}$/.test(previous.commit)) throw new Error('The source revision record does not match this operation.');
      sourceCommit = previous.commit;
      mkdirSync(checkout);
      await run('git', ['init'], checkout, log, vault, credentials, 10000,gitEnv,!!helper||!!sshHelper);
      await run('git', ['remote', 'add', 'origin', source.repository], checkout, log, vault, credentials, 10000,gitEnv,!!helper||!!sshHelper);
      await run('git', ['fetch', 'origin', sourceCommit], checkout, log, vault, credentials, 120000,gitEnv,!!helper||!!sshHelper);
      await run('git', ['checkout', '--detach', sourceCommit], checkout, log, vault, credentials, 10000,gitEnv,!!helper||!!sshHelper);
    } else {
      const shallow = new URL(source.repository).protocol === 'https:' ? ['--depth', '1'] : [];
      try {await run('git', ['clone', '--single-branch', ...shallow, '--branch', source.branch, '--', source.repository, checkout], workspace, log, vault, credentials, 120000,gitEnv,!!helper||!!sshHelper);}
      catch(error){if(options.checkOnly)throw new SourceCheckError('SOURCE_REPOSITORY_OR_BRANCH','Could not access the repository and branch. Check the address, branch and credentials.');throw error;}
      sourceCommit = await run('git', ['rev-parse', 'HEAD'], checkout, log, vault, credentials, 10000,gitEnv,!!helper||!!sshHelper);
      if(!/^[a-f0-9]{40,64}$/.test(sourceCommit))throw new Error('Invalid Git revision.');
      if (!options.checkOnly) writeFileSync(revisionPath, JSON.stringify({ repository: source.repository, branch: source.branch, serviceId: service.id, commit: sourceCommit }), { flag: 'wx', mode: 0o600 });
    }
    if(helper){await helper.close();helper=undefined;delete gitEnv.SERVUS_GIT_SOCKET;}
    if(sshHelper){sshHelper.close();sshHelper=undefined;delete gitEnv.GIT_SSH_COMMAND;delete gitEnv.GIT_SSH_VARIANT;}
    let context:string;
    try {context=confined(checkout,source.context || '.');if(!statSync(context).isDirectory())throw new Error('The build context must be a directory.');}
    catch(error){if(options.checkOnly)throw new SourceCheckError('SOURCE_CONTEXT','The build context is missing, inaccessible or outside the repository.');throw error;}
    const dockerfile = resolveDockerfileForContext(context, workspace, source.dockerfile, source.builder, service.port || 80, log, Boolean(options.checkOnly));
    if (options.checkOnly) return { image: '', sourceCommit };
    return await runDockerBuild(service, operationId, dockerSocket, vault, workspace, context, dockerfile, sourceCommit, log, credentials, source.buildResources, source.envFile, options.forceRebuild);
  } finally { if(helper)await helper.close();sshHelper?.close();rmSync(workspace, { recursive: true, force: true });if(options.checkOnly)rmSync(log,{force:true}); }
}
