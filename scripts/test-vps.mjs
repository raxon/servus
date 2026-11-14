#!/usr/bin/env node
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

const usage = 'Usage: node scripts/test-vps.mjs --confirm-vps-test --url URL --credentials FILE --ingress-url URL [--phases nginx,redis,postgres,mariadb] [--timeout-seconds 60..900] [--memory-mb 64..256]';
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function requireId(value) { if (typeof value !== 'string' || !idPattern.test(value)) throw new Error('Unexpected resource identifier'); return value; }
function normalizeUrl(value, ingress = false) {
  let url; try { url = new URL(value); } catch { throw new Error('Invalid URL'); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('URL must be an origin without credentials, query or path');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!['http:', 'https:'].includes(url.protocol) || (url.protocol === 'http:' && !local) || (ingress && !local)) throw new Error('Use HTTPS or a loopback HTTP tunnel; ingress must be loopback');
  return url.origin;
}
export function parseArgs(argv) {
  const out = { phases: ['nginx', 'redis'], timeoutSeconds: 600, memoryMb: 128, confirmed: false };
  for (let i=0; i<argv.length; i++) {
    const arg=argv[i];
    if (arg === '--help') return { help: true };
    if (arg === '--confirm-vps-test') { out.confirmed=true; continue; }
    if (!['--url','--credentials','--ingress-url','--phases','--timeout-seconds','--memory-mb'].includes(arg)) throw new Error(`Unknown option: ${arg}`);
    const value=argv[++i]; if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
    if (arg==='--url') out.url=normalizeUrl(value);
    if (arg==='--ingress-url') out.ingressUrl=normalizeUrl(value,true);
    if (arg==='--credentials') out.credentials=value;
    if (arg==='--phases') out.phases=value.split(',');
    if (arg==='--timeout-seconds') out.timeoutSeconds=Number(value);
    if (arg==='--memory-mb') out.memoryMb=Number(value);
  }
  if (!out.confirmed || !out.url || !out.credentials) throw new Error('Explicit confirmation, API URL and credentials file are required');
  if (!out.phases.length || new Set(out.phases).size !== out.phases.length || out.phases.some(p=>!['nginx','redis','postgres','mariadb'].includes(p))) throw new Error('Phases must contain only nginx, redis, postgres or mariadb');
  if (out.phases.includes('nginx') && !out.ingressUrl) throw new Error('Nginx phase requires a loopback ingress URL');
  if (!Number.isInteger(out.timeoutSeconds) || out.timeoutSeconds<60 || out.timeoutSeconds>900) throw new Error('Timeout must be 60 to 900 seconds');
  if (!Number.isInteger(out.memoryMb) || out.memoryMb<64 || out.memoryMb>256) throw new Error('Memory limit must be 64 to 256 MB per service');
  if (out.phases.includes('postgres') && out.memoryMb<128) throw new Error('PostgreSQL phase requires at least 128 MB');
  if (out.phases.includes('mariadb') && out.memoryMb<192) throw new Error('MariaDB phase requires at least 192 MB');
  return out;
}
export function readCredentials(path) {
  if (typeof constants.O_NOFOLLOW !== 'number') throw new Error('Secure credential file opening is unavailable');
  let descriptor;
  try {
    descriptor=openSync(path,constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat=fstatSync(descriptor);
    if (!stat.isFile() || (stat.mode & 0o777)!==0o600 || (typeof process.getuid==='function' && stat.uid!==process.getuid())) throw new Error('Credentials file must be owned by the current user and have mode 0600');
    let credentials;
    try { credentials=JSON.parse(readFileSync(descriptor,'utf8')); }
    catch { throw new Error('Credentials file is not valid JSON'); }
    if (typeof credentials?.email!=='string' || typeof credentials?.password!=='string' || !credentials.email || !credentials.password) throw new Error('Credentials file must contain email and password');
    return { email: credentials.email, password: credentials.password };
  } catch (error) {
    if (error && typeof error==='object' && 'code' in error) throw new Error('Credentials file must be a readable regular file without symlinks');
    throw error;
  } finally { if (descriptor!==undefined) closeSync(descriptor); }
}
function pause(ms) { return new Promise(resolve=>setTimeout(resolve,ms)); }
export function probeIngress({ base, path, hostname, timeoutMs }) {
  const url=new URL(path,base), request=url.protocol==='https:'?httpsRequest:httpRequest;
  return new Promise((resolve,reject)=>{
    const req=request(url,{method:'GET',headers:{host:hostname},timeout:timeoutMs},response=>{
      const chunks=[];let size=0, finished=false;
      response.on('data',chunk=>{
        if(finished)return;
        size+=chunk.length;
        if(size>65536){finished=true;response.destroy();resolve({status:response.statusCode??0,bodyTooLarge:true});return;}
        chunks.push(chunk);
      });
      response.on('end',()=>{if(!finished){finished=true;resolve({status:response.statusCode??0,body:Buffer.concat(chunks).toString('utf8')});}});
      response.on('error',()=>{if(!finished){finished=true;reject(new Error('Ingress response failed'));}});
    });
    const timer=setTimeout(()=>req.destroy(new Error('Ingress request timed out')),timeoutMs);
    req.on('close',()=>clearTimeout(timer));
    req.on('timeout',()=>req.destroy(new Error('Ingress request timed out')));
    req.on('error',()=>reject(new Error('Ingress connection failed')));
    req.end();
  });
}

export async function terminal({ base, serviceId, ticket, cookie, command, marker, timeoutMs }) {
  const url=new URL(`/api/v1/services/${serviceId}/console`,base);url.protocol=url.protocol==='https:'?'wss:':'ws:';
  return new Promise((resolve,reject)=>{
    const socket=new WebSocket(url,{headers:{Cookie:cookie,Origin:new URL(base).origin},handshakeTimeout:Math.min(timeoutMs,10000),maxPayload:65536});
    let output='',settled=false,ready=false;
    const finish=(err)=>{if(settled)return;settled=true;clearTimeout(timer);socket.terminate();err?reject(err):resolve();};
    const timer=setTimeout(()=>finish(new Error('Terminal check timed out')),timeoutMs);
    socket.on('open',()=>socket.send(JSON.stringify({type:'authenticate',ticket})));
    socket.on('message',(data,isBinary)=>{
      if(!ready) {
        let message;try {if(isBinary)throw new Error('Invalid handshake');message=JSON.parse(data.toString());} catch {return finish(new Error('Terminal authentication failed'));}
        if(!message || typeof message!=='object' || message.type!=='ready')return finish(new Error('Terminal authentication failed'));
        ready=true;socket.send(JSON.stringify({type:'input',data:`${command}\nexit\n`}));return;
      }
      output+=data.toString();if(output.length>65536)return finish(new Error('Terminal output limit exceeded'));if(output.split(/\r?\n/).some(line=>line.trim()===marker))finish();
    });
    socket.on('error',()=>finish(new Error('Terminal connection failed')));
    socket.on('close',()=>finish(new Error('Terminal marker not received')));
  });
}
export async function runHarness(options, credentials, overrides = {}) {
  const fetcher=overrides.fetch ?? fetch, consoleCheck=overrides.terminal ?? terminal, ingress=overrides.ingress ?? probeIngress, sleep=overrides.sleep ?? pause, log=overrides.log ?? console.log;
  const runId=randomBytes(8).toString('hex'), prefix=`vps-test-${runId}`, projectName=prefix, hostname=`${prefix}.localhost`;
  const deadline=Date.now()+options.timeoutSeconds*1000;
  let cookie='',csrf='',projectId='',nginxId='',redisId='',cleanupFailed=false;
  const owned=[];
  log(`Fixture prefix ${prefix}`);
  function remaining(cleanup=false) { const ms=(cleanup ? deadline+120000 : deadline)-Date.now(); if(ms<=0)throw new Error(cleanup?'Cleanup timeout':'Test timeout');return Math.min(ms,8000); }
  async function api(path, {method='GET',body,key,cleanup=false}={}) {
    const headers={accept:'application/json',origin:options.url,...(cookie?{cookie}:{}),...(csrf?{'x-csrf-token':csrf}:{}),...(body!==undefined?{'content-type':'application/json'}:{}),...(key?{'idempotency-key':key}:{})};
    const response=await fetcher(`${options.url}/api/v1${path}`,{method,headers,body:body===undefined?undefined:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(remaining(cleanup))});
    const setCookie=response.headers.get('set-cookie');if(setCookie)cookie=setCookie.split(';')[0];
    if(!response.ok)throw new Error(`API ${method} failed with HTTP ${response.status}`);
    try { return await response.json(); } catch { throw new Error('API returned invalid JSON'); }
  }
  async function waitAction(action,cleanup=false) {
    const id=requireId(action?.id);
    for (;;) {const detail=await api(`/actions/${id}`,{cleanup});const status=detail.action?.status;if(status==='succeeded')return;if(status==='failed'||status==='cancelled')throw new Error('A fixture action did not succeed');remaining(cleanup);await sleep(1000);}
  }
  async function createService(name, input) {
    const result=await api(`/projects/${projectId}/services`,{method:'POST',body:{name,...input},key:randomUUID()});
    const service=result.service;
    if(service?.projectId!==projectId || service?.name!==name)throw new Error('Unexpected created service identity; manual review is required');
    const id=requireId(service.id);owned.push(id);log(`Created fixture service ${id}`);await waitAction(result.action);return id;
  }
  async function action(id,type,cleanup=false) {await waitAction(await api(`/services/${id}/${type}`,{method:'POST',body:{},key:randomUUID(),cleanup}),cleanup);}
  async function serviceCommand(id,cmd,marker) {
    const containers=await api(`/services/${id}/containers`);const container=Array.isArray(containers)&&containers.find(item=>item.state==='running');
    if(!container || !/^[a-f0-9]{12,64}$/.test(container.id))throw new Error('Fixture container is unavailable');
    const grant=await api(`/services/${id}/console-ticket`,{method:'POST',body:{containerId:container.id,shell:'/bin/sh'}});
    if(typeof grant.ticket!=='string'||!/^[a-f0-9]{64}$/.test(grant.ticket))throw new Error('Invalid terminal grant');
    try { await consoleCheck({base:options.url,serviceId:id,ticket:grant.ticket,cookie,command:cmd,marker,timeoutMs:Math.min(remaining(),15000)}); }
    catch (error) { const phase=marker.replace(/_[a-f0-9]{16}$/, ''); throw new Error(`${phase}: ${error instanceof Error ? error.message : 'Terminal check failed'}`); }
  }
  try {
    const login=await api('/auth/login',{method:'POST',body:credentials});csrf=login.csrfToken;
    if(!cookie || typeof csrf!=='string'||login.user?.role!=='admin')throw new Error('An administrator session is required');
    const projects=await api('/projects');
    if(!Array.isArray(projects)||projects.some(p=>p.name===projectName))throw new Error('Fixture project name is unavailable');
    const project=await api('/projects',{method:'POST',body:{name:projectName,description:'Disposable VPS verification fixture'}});
    if(project?.name!==projectName)throw new Error('Unexpected created project identity; manual review is required');
    projectId=requireId(project.id);log(`Created fixture project ${projectId}`);
    if(options.phases.includes('nginx')) {
      nginxId=await createService(`${prefix}-web`,{kind:'app',image:'nginx:alpine',port:80,hostname,replicas:1,resources:{cpu:0.2,memoryMb:options.memoryMb}});
      const checkIngress=async (path,match,label)=>{
        let status=0,reason='network_error';
        for(let attempt=1;attempt<=10;attempt++) {
          let response;
          try { response=await ingress({base:options.ingressUrl,path,hostname,timeoutMs:remaining()}); }
          catch { response=null; }
          if(response) {
            status=response.status;
            if(response.bodyTooLarge) throw new Error(`${label}: status=${status} reason=body_too_large`);
            if(status===200) {
              if(!match(response.body))throw new Error(`${label}: status=200 reason=body_mismatch`);
              return;
            }
            reason='http_status';
            if(![404,502,503,504].includes(status))throw new Error(`${label}: status=${status} reason=${reason}`);
          } else { status=0;reason='network_error'; }
          if(attempt<10) { remaining();await sleep(500); }
        }
        throw new Error(`${label}: status=${status || 'unavailable'} reason=${reason} attempts=10`);
      };
      const checkRoute=async phase=>{
        const value=`servus-${runId}-${phase}`, file=`servus-${runId}-${phase}.txt`, marker=`SERVUS_HTTP_OK_${runId}_${phase}`;
        await serviceCommand(nginxId,`printf '%s' '${value}' > /usr/share/nginx/html/${file} && printf '\\n${marker}\\n'`,marker);
        await checkIngress(`/${file}`,body=>body===value,'Nginx fixture route');
      };
      await checkIngress('/',body=>body.includes('Welcome to nginx!'),'Nginx welcome page');
      await checkRoute('initial');
      await action(nginxId,'stop');await action(nginxId,'start');
      await checkRoute('restart');
      await action(nginxId,'stop');log('PASS nginx deploy, route, stop and start');
    }
    if(options.phases.includes('redis')) {
      const password=randomBytes(24).toString('base64url');
      redisId=await createService(`${prefix}-redis`,{kind:'redis',replicas:1,database:{database:'app',user:'app',password},resources:{cpu:0.2,memoryMb:options.memoryMb}});
      const details=await api(`/services/${redisId}`);
      if(details.kind!=='redis'||(details.domains?.length??0)!==0)throw new Error('Redis fixture has unexpected routing');
      const key=`servus_${runId}`,value=`value_${runId}`,marker=`SERVUS_OK_${runId}`;
      const cli='REDISCLI_AUTH="$(cat /run/secrets/panel-db-password)" redis-cli --no-auth-warning --raw -h 127.0.0.1';
      const plain='redis-cli --no-auth-warning --raw -h 127.0.0.1';
      const noAuth=`SERVUS_NOAUTH_${runId}`, wrongAuth=`SERVUS_WRONGAUTH_${runId}`;
      await serviceCommand(redisId,`result=$(${plain} PING 2>&1); case "$result" in *NOAUTH*) printf '\\n${noAuth}\\n';; esac`,noAuth);
      await serviceCommand(redisId,`result=$(${plain} -a 'wrong-${runId}' PING 2>&1); case "$result" in *WRONGPASS*|*NOAUTH*) printf '\\n${wrongAuth}\\n';; esac`,wrongAuth);
      await serviceCommand(redisId,`${cli} SET ${key} ${value} >/dev/null && printf '\\n${marker}\\n'`,marker);
      await action(redisId,'restart');
      await serviceCommand(redisId,`[ "$(${cli} GET ${key})" = '${value}' ] && printf '\\n${marker}\\n'`,marker);
      await action(redisId,'stop');log('PASS Redis rejects missing and invalid credentials, accepts valid credentials and retains data after restart');
      log('Redis API exposes no HTTP domains; host-port isolation requires independent Docker inspection.');
    }
    for(const kind of ['postgres','mariadb']) {
      if(!options.phases.includes(kind))continue;
      const password=randomBytes(24).toString('base64url');
      const id=await createService(`${prefix}-${kind}`,{kind,replicas:1,database:{database:'app',user:'app',password},resources:{cpu:0.2,memoryMb:options.memoryMb}});
      const details=await api(`/services/${id}`);
      if(details.kind!==kind||(details.domains?.length??0)!==0)throw new Error(`${kind} fixture has unexpected routing`);
      const value=`value_${runId}`,label=kind.toUpperCase(),noAuth=`SERVUS_${label}_NOAUTH_${runId}`,wrongAuth=`SERVUS_${label}_WRONGAUTH_${runId}`,marker=`SERVUS_${label}_OK_${runId}`;
      const insert=`CREATE TABLE servus_marker (value TEXT NOT NULL); INSERT INTO servus_marker (value) VALUES ('${value}');`;
      const select='SELECT value FROM servus_marker;';
      if(kind==='postgres') {
        const plain='PGPASSFILE=/dev/null psql -X -w -h 127.0.0.1 -U app -d app -v ON_ERROR_STOP=1 -tA';
        const valid=`PGPASSWORD="$(cat /run/secrets/panel-db-password)" ${plain}`;
        await serviceCommand(id,`result=$(PGPASSWORD='' ${plain} -c 'SELECT 1' 2>&1); case "$result" in *'no password supplied'*) printf '\\n${noAuth}\\n';; esac`,noAuth);
        await serviceCommand(id,`result=$(PGPASSWORD='wrong-${runId}' ${plain} -c 'SELECT 1' 2>&1); case "$result" in *'password authentication failed'*) printf '\\n${wrongAuth}\\n';; esac`,wrongAuth);
        await serviceCommand(id,`${valid} -c "${insert}" >/dev/null && printf '\\n${marker}\\n'`,marker);
        await action(id,'restart');
        await serviceCommand(id,`result=$(${valid} -c '${select}') && [ "$result" = '${value}' ] && printf '\\n${marker}\\n'`,marker);
      } else {
        const plain='mariadb --no-defaults --protocol=tcp --host=127.0.0.1 --port=3306 --user=app --database=app --batch --skip-column-names --connect-timeout=3';
        const valid=`MYSQL_PWD="$(cat /run/secrets/panel-db-password)" ${plain}`;
        await serviceCommand(id,`result=$(MYSQL_PWD='' ${plain} -e 'SELECT 1' 2>&1); case "$result" in *'Access denied'*) printf '\\n${noAuth}\\n';; esac`,noAuth);
        await serviceCommand(id,`result=$(MYSQL_PWD='wrong-${runId}' ${plain} -e 'SELECT 1' 2>&1); case "$result" in *'Access denied'*) printf '\\n${wrongAuth}\\n';; esac`,wrongAuth);
        await serviceCommand(id,`${valid} -e "${insert}" >/dev/null && printf '\\n${marker}\\n'`,marker);
        await action(id,'restart');
        await serviceCommand(id,`result=$(${valid} -e '${select}') && [ "$result" = '${value}' ] && printf '\\n${marker}\\n'`,marker);
      }
      await action(id,'stop');log(`PASS ${kind} rejects missing and invalid credentials, accepts valid credentials and retains data after restart`);
      log(`${kind} API exposes no HTTP domains; host-port isolation requires independent Docker inspection.`);
    }
  } finally {
    if(projectId) {
      for(const id of [...owned].reverse()) {
        try {await waitAction(await api(`/services/${id}`,{method:'DELETE',body:{},key:randomUUID(),cleanup:true}),true);log(`Removed fixture service ${id}`);}
        catch {cleanupFailed=true;log(`Cleanup required for fixture service ${id}`);}
      }
      if(!cleanupFailed) {
        try {const remainingServices=await api(`/projects/${projectId}/services`,{cleanup:true});if(!Array.isArray(remainingServices)||remainingServices.length)throw new Error('Fixture project is not empty');await api(`/projects/${projectId}`,{method:'DELETE',body:{},cleanup:true});log(`Removed fixture project ${projectId}`);}
        catch {cleanupFailed=true;log(`Cleanup required for fixture project ${projectId}`);}
      }
    }
    if(cleanupFailed)throw new Error('Fixture cleanup was incomplete; inspect the printed fixture IDs');
    if(owned.length)log('Docker volumes are retained by the panel; inspect fixture-owned volumes separately.');
  }
  return { runId, projectId, services: owned };
}
async function main() {
  const options=parseArgs(process.argv.slice(2));if(options.help){console.log(usage);return;}
  const credentials=readCredentials(options.credentials);
  await runHarness(options,credentials);
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) main().catch(error=>{console.error(`VPS test failed: ${error instanceof Error?error.message:'unexpected error'}`);process.exitCode=1;});
