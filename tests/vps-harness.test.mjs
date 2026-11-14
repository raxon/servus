import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, chmodSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { parseArgs, readCredentials, runHarness, probeIngress, terminal } from '../scripts/test-vps.mjs';

const args=['--confirm-vps-test','--url','http://localhost:4180','--credentials','/tmp/file','--ingress-url','http://127.0.0.1:18080'];
test('requires consent, explicit URL, credentials and loopback ingress', () => {
  assert.throws(()=>parseArgs([]),/confirmation/);
  assert.throws(()=>parseArgs(args.filter(x=>x!=='--confirm-vps-test')),/confirmation/);
  assert.throws(()=>parseArgs(['--confirm-vps-test','--url','http://example.test','--credentials','x']),/HTTPS or a loopback/);
  assert.throws(()=>parseArgs(['--confirm-vps-test','--url','https://panel.test/path','--credentials','x']),/origin/);
  assert.throws(()=>parseArgs([...args,'--memory-mb','257']),/Memory limit/);
  assert.throws(()=>parseArgs([...args,'--timeout-seconds','59']),/Timeout/);
  assert.throws(()=>parseArgs([...args,'--phases','nginx,other']),/Phases/);
  assert.throws(()=>parseArgs(['--confirm-vps-test','--url','https://panel.test','--credentials','x','--ingress-url','https://remote.test']),/ingress must be loopback/);
  assert.equal(parseArgs(args).memoryMb,128);
  assert.deepEqual(parseArgs(args).phases,['nginx','redis']);
  assert.throws(()=>parseArgs([...args,'--phases','postgres','--memory-mb','127']),/PostgreSQL phase requires/);
  assert.throws(()=>parseArgs([...args,'--phases','mariadb']),/MariaDB phase requires/);
  assert.deepEqual(parseArgs([...args,'--phases','postgres,mariadb','--memory-mb','192']).phases,['postgres','mariadb']);
});
test('credentials require a regular owned file with exactly mode 0600', () => {
  const dir=mkdtempSync(join(tmpdir(),'vps-test-'));
  try {
    const path=join(dir,'credentials.json');writeFileSync(path,JSON.stringify({email:'admin@example.test',password:'secret-synthetic'}),{mode:0o600});
    assert.equal(readCredentials(path).email,'admin@example.test');
    chmodSync(path,0o644);assert.throws(()=>readCredentials(path),/0600/);
    chmodSync(path,0o600);const link=join(dir,'link');symlinkSync(path,link);assert.throws(()=>readCredentials(link),/without symlinks/);
    const getuid=process.getuid;try {process.getuid=()=>getuid()+1;assert.throws(()=>readCredentials(path),/owned by the current user/);} finally {process.getuid=getuid;}
    writeFileSync(path,'not-json synthetic-secret');assert.throws(()=>readCredentials(path),error=>error.message==='Credentials file is not valid JSON');
  } finally {rmSync(dir,{recursive:true,force:true});}
});
function fakeApi({ failAction=false, badService=false, unrelatedService=false, incorrectNginx=false, oversizedNginx=false, incorrectMarker=false, databaseHasRoute=false, ingressStatuses=[] }={}) {
  const projectId='11111111-1111-4111-8111-111111111111', nginx='22222222-2222-4222-8222-222222222222', redis='33333333-3333-4333-8333-333333333333', postgres='44444444-4444-4444-8444-444444444444', mariadb='55555555-5555-4555-8555-555555555555';
  const actionId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', requests=[],services=new Map();let projectName='';
  const response=(value,status=200,headers={})=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json',...headers}});
  const fetcher=async(url,options={})=>{
    const u=new URL(url),method=options.method??'GET',body=options.body?JSON.parse(options.body):undefined;
    requests.push({path:u.pathname,method,body,host:options.headers?.host});
    if(u.port==='18080') {
      const nextStatus=ingressStatuses.shift();if(nextStatus)return new Response('synthetic diagnostic secret',{status:nextStatus});
      if(oversizedNginx)return new Response('x'.repeat(65537),{status:200});
      if(incorrectNginx)return new Response('unrelated service',{status:200});
      if(u.pathname==='/')return new Response('<title>Welcome to nginx!</title>',{status:200});
      const filename=u.pathname.match(/^\/servus-([a-f0-9]+)-(initial|restart)\.txt$/);
      return new Response(filename?(incorrectMarker?'wrong-marker':`servus-${filename[1]}-${filename[2]}`):'missing',{status:200});
    }
    const path=u.pathname.replace('/api/v1','');
    if(path==='/auth/login')return response({user:{role:'admin'},csrfToken:'synthetic-csrf'},200,{'set-cookie':'panel_session=synthetic; Path=/; HttpOnly'});
    if(path==='/projects'&&method==='GET')return response([]);
    if(path==='/projects'&&method==='POST'){projectName=body.name;return response({id:projectId,name:projectName});}
    if(path===`/projects/${projectId}/services`&&method==='POST'){
      const id=({redis,postgres,mariadb})[body.kind] ?? nginx;services.set(id,{...body,id,projectId});
      return response({service:{id,projectId:badService?'bad-project':projectId,name:body.name},action:{id:actionId}});
    }
    if(path===`/projects/${projectId}/services`&&method==='GET')return response(unrelatedService?[{id:'foreign'}]:Array.from(services.values()));
    if(path===`/projects/${projectId}`&&method==='DELETE')return response({success:true});
    if(path===`/actions/${actionId}`)return response({action:{status:failAction?'failed':'succeeded'}});
    for(const id of [nginx,redis,postgres,mariadb]) {
      if(path===`/services/${id}`&&method==='GET')return response({...services.get(id),domains:databaseHasRoute?[{hostname:'unexpected.test'}]:[]});
      if(path===`/services/${id}`&&method==='DELETE'){services.delete(id);return response({id:actionId});}
      if(path===`/services/${id}/containers`)return response([{id:'a'.repeat(64),state:'running'}]);
      if(path===`/services/${id}/console-ticket`)return response({ticket:'b'.repeat(64)});
      if(path.startsWith(`/services/${id}/`)&&method==='POST')return response({id:actionId});
    }
    throw new Error('Unexpected mocked endpoint');
  };
  const ingress=async ({base,path,hostname})=>{
    const response=await fetcher(`${base}${path}`,{headers:{host:hostname}});
    const body=await response.text();
    return body.length>65536?{status:response.status,bodyTooLarge:true}:{status:response.status,body};
  };
  return {fetcher,ingress,requests,projectId,nginx,redis,postgres,mariadb};
}
test('runs phases sequentially and deletes only fixture service IDs',async()=>{
  const mock=fakeApi(),logs=[],commands=[];
  const result=await runHarness(parseArgs(args),{email:'admin@example.test',password:'secret-synthetic'},{fetch:mock.fetcher,ingress:mock.ingress,sleep:async()=>{},log:value=>logs.push(value),terminal:async value=>{commands.push(value);}});
  assert.equal(result.services.length,2);
  const indexStop=mock.requests.findIndex(r=>r.path===`/api/v1/services/${mock.nginx}/stop`);
  const indexRedis=mock.requests.findIndex(r=>r.path===`/api/v1/projects/${mock.projectId}/services`&&r.body?.kind==='redis');
  assert(indexStop>=0&&indexStop<indexRedis);
  const deleted=mock.requests.filter(r=>r.method==='DELETE').map(r=>r.path);
  assert.deepEqual(deleted,[`/api/v1/services/${mock.redis}`,`/api/v1/services/${mock.nginx}`,`/api/v1/projects/${mock.projectId}`]);
  assert.equal(commands.length,6);
  assert.match(commands[0].command,/\/usr\/share\/nginx\/html\//);
  assert.match(commands[2].command,/NOAUTH/);assert.match(commands[3].command,/WRONGPASS/);
  assert.match(commands[4].command,/ SET /);assert.match(commands[5].command,/ GET /);
  const redisPassword=mock.requests.find(r=>r.body?.kind==='redis')?.body?.database?.password;
  const secrets=['secret-synthetic',redisPassword,...commands.flatMap(command=>[command.cookie,command.ticket])];
  for(const secret of secrets) {
    assert.equal(typeof secret==='string' && secret.length>0,true,'A secret value was not captured');
    assert.equal(logs.some(line=>String(line).includes(secret)),false,'Captured output exposed a secret');
  }
});
test('does not delete an unknown service or nonempty fixture project',async()=>{
  const bad=fakeApi({badService:true});
  await assert.rejects(runHarness(parseArgs([...args,'--phases','nginx']),{email:'x',password:'y'},{fetch:bad.fetcher,ingress:bad.ingress,sleep:async()=>{},log:()=>{}}));
  assert.equal(bad.requests.some(r=>r.method==='DELETE'&&r.path.includes('/services/')),false);
  const unknown=fakeApi({unrelatedService:true});
  await assert.rejects(runHarness(parseArgs([...args,'--phases','nginx']),{email:'x',password:'y'},{fetch:unknown.fetcher,ingress:unknown.ingress,sleep:async()=>{},log:()=>{}}),/cleanup was incomplete/);
  assert.equal(unknown.requests.some(r=>r.method==='DELETE'&&r.path===`/api/v1/projects/${unknown.projectId}`),false);
});

test('rejects an unrelated HTTP 200 response or oversized body',async()=>{
  for (const bad of [{incorrectNginx:true},{oversizedNginx:true}]) {
    const mock=fakeApi(bad);
    await assert.rejects(runHarness(parseArgs([...args,'--phases','nginx']),{email:'x',password:'y'},{fetch:mock.fetcher,ingress:mock.ingress,sleep:async()=>{},log:()=>{},terminal:async()=>{}}),/Nginx welcome page.*reason=(body_mismatch|body_too_large)/);
  }
});
test('fails when Redis permits unauthenticated requests',async()=>{
  const mock=fakeApi();
  await assert.rejects(runHarness(parseArgs([...args,'--phases','redis']),{email:'x',password:'y'}, {fetch:mock.fetcher,ingress:mock.ingress,sleep:async()=>{},log:()=>{},terminal:async request=>{
    if(request.marker.startsWith('SERVUS_NOAUTH_'))throw new Error('Terminal marker not received');
  }}),/Terminal marker not received/);
});
test('fails when Redis accepts an invalid password',async()=>{
  const mock=fakeApi();
  await assert.rejects(runHarness(parseArgs([...args,'--phases','redis']),{email:'x',password:'y'}, {fetch:mock.fetcher,ingress:mock.ingress,sleep:async()=>{},log:()=>{},terminal:async request=>{
    if(request.marker.startsWith('SERVUS_WRONGAUTH_'))throw new Error('Terminal marker not received');
  }}),/Terminal marker not received/);
});

test('rejects an incorrect fixture marker despite a valid nginx welcome page and cleans up',async()=>{
  const mock=fakeApi({incorrectMarker:true});
  await assert.rejects(runHarness(parseArgs([...args,'--phases','nginx']),{email:'x',password:'y'}, {fetch:mock.fetcher,ingress:mock.ingress,sleep:async()=>{},log:()=>{},terminal:async()=>{}}),/Nginx fixture route.*reason=body_mismatch/);
  const ingress=mock.requests.filter(request=>request.host);
  assert.deepEqual(ingress.map(request=>request.path.startsWith('/servus-')?'marker':request.path),['/','marker']);
  const removed=mock.requests.filter(request=>request.method==='DELETE').map(request=>request.path);
  assert.deepEqual(removed,[`/api/v1/services/${mock.nginx}`,`/api/v1/projects/${mock.projectId}`]);
});

test('real HTTP probe transmits the requested Host header', async()=>{
  let host='';const server=createServer((request,response)=>{host=request.headers.host;response.end(request.url==='/oversized'?'x'.repeat(65537):'fixture');});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const result=await probeIngress({base:`http://127.0.0.1:${server.address().port}`,path:'/',hostname:'fixture.localhost',timeoutMs:2000});
    assert.equal(result.status,200);assert.equal(result.body,'fixture');assert.equal(host,'fixture.localhost');
    const oversized=await probeIngress({base:`http://127.0.0.1:${server.address().port}`,path:'/oversized',hostname:'fixture.localhost',timeoutMs:2000});
    assert.equal(oversized.bodyTooLarge,true);assert.equal(oversized.body,undefined);
  } finally { await new Promise(resolve=>server.close(resolve)); }
});
test('retries temporary route failures and reports safe status when retries are exhausted',async()=>{
  const recovered=fakeApi({ingressStatuses:[404,503]});
  await runHarness(parseArgs([...args,'--phases','nginx']),{email:'x',password:'y'},{fetch:recovered.fetcher,ingress:recovered.ingress,sleep:async()=>{},log:()=>{},terminal:async()=>{}});
  assert.equal(recovered.requests.filter(request=>request.host&&request.path==='/').length,3);
  const failed=fakeApi({ingressStatuses:Array(10).fill(502)});
  await assert.rejects(runHarness(parseArgs([...args,'--phases','nginx']),{email:'x',password:'y'},{fetch:failed.fetcher,ingress:failed.ingress,sleep:async()=>{},log:()=>{},terminal:async()=>{}}),error=>{
    assert.match(error.message,/status=502 reason=http_status attempts=10/);
    assert.doesNotMatch(error.message,/synthetic diagnostic secret/);return true;
  });
  assert.equal(failed.requests.filter(request=>request.host&&request.path==='/').length,10);
  assert.equal(failed.requests.some(request=>request.method==='DELETE'&&request.path===`/api/v1/services/${failed.nginx}`),true);
});

test('terminal authenticates in a frame and waits for ready before sending commands',async()=>{
  const server=createServer(), wsServer=new WebSocketServer({server});
  const frames=[];let requestPath='',commandBeforeReady=false,readySent=false;
  wsServer.on('connection',(socket,request)=>{
    requestPath=request.url;
    socket.on('message',data=>{
      const frame=JSON.parse(data.toString());frames.push(frame);
      if(frame.type==='authenticate')setTimeout(()=>{readySent=true;socket.send(JSON.stringify({type:'ready'}));},20);
      if(frame.type==='input'){if(!readySent)commandBeforeReady=true;socket.send('\r\nSYNTHETIC_MARKER\r\n');}
    });
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const ticket='b'.repeat(64);
  try {
    await terminal({base:`http://127.0.0.1:${server.address().port}`,serviceId:'11111111-1111-4111-8111-111111111111',ticket,cookie:'panel_session=synthetic',command:'printf marker',marker:'SYNTHETIC_MARKER',timeoutMs:1000});
    assert.equal(requestPath.includes('?'),false);assert.equal(requestPath.includes(ticket),false);
    assert.equal(frames.length,2);assert.equal(frames[0].type,'authenticate');assert.equal(frames[0].ticket===ticket,true);
    assert.equal(frames[1].type,'input');assert.equal(commandBeforeReady,false);
  } finally { await new Promise(resolve=>wsServer.close(resolve));await new Promise(resolve=>server.close(resolve)); }
});
test('terminal times out without ready and never sends a command',async()=>{
  const server=createServer(),wsServer=new WebSocketServer({server});const types=[];
  wsServer.on('connection',socket=>socket.on('message',data=>types.push(JSON.parse(data.toString()).type)));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    await assert.rejects(terminal({base:`http://127.0.0.1:${server.address().port}`,serviceId:'11111111-1111-4111-8111-111111111111',ticket:'b'.repeat(64),cookie:'panel_session=synthetic',command:'printf marker',marker:'MARKER',timeoutMs:80}),/Terminal check timed out/);
    assert.deepEqual(types,['authenticate']);
  } finally {await new Promise(resolve=>wsServer.close(resolve));await new Promise(resolve=>server.close(resolve));}
});
test('terminal rejects an invalid ready frame without exposing its contents',async()=>{
  const server=createServer(),wsServer=new WebSocketServer({server});
  const ticket='b'.repeat(64);
  wsServer.on('connection',socket=>socket.on('message',()=>socket.send(JSON.stringify({type:'error',detail:ticket}))));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    await assert.rejects(terminal({base:`http://127.0.0.1:${server.address().port}`,serviceId:'11111111-1111-4111-8111-111111111111',ticket,cookie:'panel_session=synthetic',command:'printf marker',marker:'MARKER',timeoutMs:500}),error=>{
      assert.equal(error.message,'Terminal authentication failed');return true;
    });
  } finally {await new Promise(resolve=>wsServer.close(resolve));await new Promise(resolve=>server.close(resolve));}
});

test('optional databases run one at a time with password checks and persistent markers',async()=>{
  const mock=fakeApi(),commands=[],logs=[];
  const options=parseArgs([...args,'--phases','redis,postgres,mariadb','--memory-mb','192']);
  const result=await runHarness(options,{email:'x',password:'synthetic-admin-secret'},{fetch:mock.fetcher,ingress:mock.ingress,sleep:async()=>{},log:value=>logs.push(value),terminal:async value=>commands.push(value)});
  assert.deepEqual(result.services,[mock.redis,mock.postgres,mock.mariadb]);
  const create=kind=>mock.requests.findIndex(request=>request.method==='POST'&&request.body?.kind===kind);
  const stop=id=>mock.requests.findIndex(request=>request.path===`/api/v1/services/${id}/stop`);
  assert(stop(mock.redis)<create('postgres'));assert(stop(mock.postgres)<create('mariadb'));
  for(const [kind,id] of [['POSTGRES',mock.postgres],['MARIADB',mock.mariadb]]) {
    const messages=commands.filter(item=>item.serviceId===id);
    assert.equal(messages.length,4);
    assert(messages[0].marker.startsWith(`SERVUS_${kind}_NOAUTH_`));
    assert(messages[1].marker.startsWith(`SERVUS_${kind}_WRONGAUTH_`));
    assert.match(messages[2].command,/CREATE TABLE/);assert.match(messages[3].command,/SELECT value FROM servus_marker/);
    assert(messages.every(item=>item.command.includes('127.0.0.1')));
  }
  const passwords=mock.requests.filter(request=>['redis','postgres','mariadb'].includes(request.body?.kind)).map(request=>request.body.database.password);
  assert.equal(passwords.length,3);
  for(const secret of [...passwords,...commands.flatMap(command=>[command.cookie,command.ticket])]) {
    assert.equal(typeof secret==='string'&&secret.length>0,true,'A secret value was not captured');
    assert.equal(logs.some(line=>String(line).includes(secret)),false,'Captured output exposed a secret');
  }
});
test('optional databases fail closed when either negative authentication check fails',async()=>{
  for(const kind of ['postgres','mariadb']) for(const negative of ['NOAUTH','WRONGAUTH']) {
    const mock=fakeApi(),id=mock[kind];
    await assert.rejects(runHarness(parseArgs([...args,'--phases',kind,'--memory-mb','192']),{email:'x',password:'y'}, {fetch:mock.fetcher,ingress:mock.ingress,sleep:async()=>{},log:()=>{},terminal:async request=>{
      if(request.marker.startsWith(`SERVUS_${kind.toUpperCase()}_${negative}_`))throw new Error('Terminal marker not received');
    }}),new RegExp(`SERVUS_${kind.toUpperCase()}_${negative}: Terminal marker not received`));
    assert.equal(mock.requests.some(request=>request.method==='DELETE'&&request.path===`/api/v1/services/${id}`),true);
  }
});

test('optional databases refuse HTTP routing and failed retention checks',async()=>{
  for(const kind of ['postgres','mariadb']) {
    const routed=fakeApi({databaseHasRoute:true});
    await assert.rejects(runHarness(parseArgs([...args,'--phases',kind,'--memory-mb','192']),{email:'x',password:'y'},{fetch:routed.fetcher,ingress:routed.ingress,sleep:async()=>{},log:()=>{},terminal:async()=>{}}),/unexpected routing/);
    const noRetention=fakeApi();
    await assert.rejects(runHarness(parseArgs([...args,'--phases',kind,'--memory-mb','192']),{email:'x',password:'y'},{fetch:noRetention.fetcher,ingress:noRetention.ingress,sleep:async()=>{},log:()=>{},terminal:async request=>{
      if(request.command.includes('SELECT value FROM servus_marker'))throw new Error('Terminal marker not received');
    }}),/Terminal marker not received/);
    assert.equal(noRetention.requests.some(request=>request.method==='DELETE'&&request.path===`/api/v1/services/${noRetention[kind]}`),true);
  }
});
