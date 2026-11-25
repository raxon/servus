import {afterEach,expect,it,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {Store} from '../../src/server/store.js';
import {createApp} from '../../src/server/app.js';
import type {agentRequest} from '../../src/agent/client.js';
import {createMcpServer} from '../../../../scripts/servus-mcp.mjs';

const cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
async function fixture(){
  const dataDir=mkdtempSync(join(tmpdir(),'servus-compose-clients-')),store=new Store(dataDir);
  const agent:typeof agentRequest=async<T>(path,body)=>path==='/compose/apply'?{state:(body as{type:string}).type==='stop'?'stopped':'running',revision:(body as{revision:number}).revision,logs:'completed'} as T:{logs:'compose-fixture-runtime-output'} as T;
  const app=await createApp({dataDir,store,agentRequest:agent});cleanup.push(async()=>{await app.close();store.close();rmSync(dataDir,{recursive:true,force:true});});
  const setup=await app.inject({method:'POST',url:'/api/v1/setup',payload:{email:'admin@example.test',password:'fixture-password'}}),session={cookie:`panel_session=${setup.cookies[0]!.value}`,'x-csrf-token':setup.json().csrfToken},project=store.createProject('compose-clients'),other=store.createProject('other');
  const created=await app.inject({method:'POST',url:`/api/v1/projects/${project.id}/compose`,headers:{...session,'idempotency-key':randomUUID()},payload:{name:'web',source:{type:'inline',yaml:'services: {web: {image: nginx:alpine}}'},domains:[]}});expect(created.statusCode).toBe(202);const workloadId=created.json().workload.id as string;
  const settled=()=>vi.waitFor(()=>expect(store.db.prepare("SELECT count(*) AS n FROM compose_actions WHERE status IN ('queued','running')").get()).toEqual({n:0}));await settled();
  const tokens:Record<string,{id:string;token:string}>={};for(const scope of ['read','deploy'])tokens[scope]=(await app.inject({method:'POST',url:'/api/v1/auth/api-tokens',headers:session,payload:{name:scope,projectId:project.id,scope}})).json();
  const origin=await app.listen({host:'127.0.0.1',port:0}),script=resolve(import.meta.dirname,'../../../../scripts/servus.mjs');
  const cli=(args:string[],scope='deploy')=>promisify(execFile)(process.execPath,[script,...args],{env:{...process.env,SERVUS_URL:origin,SERVUS_TOKEN:tokens[scope]!.token}});
  return{app,store,project,other,workloadId,tokens,origin,cli,settled};
}

it('runs Compose CLI reads against an HTTP server and rejects unsupported options',async()=>{
  const f=await fixture();
  expect(JSON.parse((await f.cli(['compose',f.project.id],'read')).stdout)[0].id).toBe(f.workloadId);
  expect(JSON.parse((await f.cli(['compose-workload',f.workloadId],'read')).stdout).id).toBe(f.workloadId);
  expect(JSON.parse((await f.cli(['compose-actions',f.workloadId],'read')).stdout)[0].status).toBe('succeeded');
  expect(JSON.parse((await f.cli(['compose-logs',f.workloadId],'read')).stdout).logs).toBe('compose-fixture-runtime-output');
  await expect(f.cli(['compose',f.other.id],'read')).rejects.toMatchObject({code:1,stderr:expect.stringContaining('NOT_FOUND')});
  await expect(f.cli(['compose-deploy',f.workloadId,'--force-rebuild'])).rejects.toMatchObject({code:1,stderr:expect.stringContaining('Unknown or incomplete option')});
});
it('preserves Compose CLI idempotency and checks live token revocation',async()=>{
  const f=await fixture(),args=['compose-deploy',f.workloadId,'--idempotency-key','same-cli-compose'];
  const first=JSON.parse((await f.cli(args)).stdout),again=JSON.parse((await f.cli(args)).stdout);expect(again.id).toBe(first.id);await f.settled();
  expect(f.store.db.prepare('SELECT count(*) AS n FROM compose_actions WHERE workload_id=?').get(f.workloadId)).toEqual({n:2});
  for(const operation of ['stop','start','restart']){expect(JSON.parse((await f.cli([`compose-${operation}`,f.workloadId])).stdout).type).toBe(operation);await f.settled();}
  await expect(f.cli(['compose-stop',f.workloadId],'read')).rejects.toMatchObject({code:1,stderr:expect.stringContaining('TOKEN_SCOPE')});
  f.store.db.prepare('UPDATE api_tokens SET revoked_at=? WHERE id=?').run(new Date().toISOString(),f.tokens.deploy!.id);
  await expect(f.cli(['compose-workload',f.workloadId])).rejects.toMatchObject({code:1,stderr:expect.stringContaining('UNAUTHORIZED')});
});
it('uses an actual MCP handshake for bounded Compose tools, idempotency and scope',async()=>{
  const f=await fixture(),server=createMcpServer({origin:f.origin,token:f.tokens.deploy!.token}),client=new Client({name:'compose-fixture',version:'1.0.0'}),[a,b]=InMemoryTransport.createLinkedPair();cleanup.push(async()=>{await client.close();await server.close();});await server.connect(b);await client.connect(a);
  const catalog=await client.listTools();expect(catalog.tools.find(tool=>tool.name==='deploy_compose')?.annotations?.destructiveHint).toBe(true);expect(catalog.tools.find(tool=>tool.name==='inspect_compose')?.annotations?.readOnlyHint).toBe(true);
  for(const name of ['create_compose','update_compose','destroy_compose'])expect(catalog.tools.find(tool=>tool.name===name)?.annotations?.destructiveHint).toBe(true);
  expect(JSON.stringify(await client.callTool({name:'list_compose',arguments:{projectId:f.project.id}}))).toContain(f.workloadId);
  expect((await client.callTool({name:'list_compose',arguments:{projectId:f.other.id}})).isError).toBe(true);
  for(const name of ['inspect_compose','read_compose_actions','read_compose_logs'])expect((await client.callTool({name,arguments:{workloadId:f.workloadId}})).isError).not.toBe(true);
  const args={workloadId:f.workloadId,idempotencyKey:'same-mcp-compose'},first=await client.callTool({name:'deploy_compose',arguments:args}),again=await client.callTool({name:'deploy_compose',arguments:args});expect(JSON.parse((again.content as{type:string;text:string}[])[0]!.text).id).toBe(JSON.parse((first.content as{type:string;text:string}[])[0]!.text).id);await f.settled();
  expect((await client.callTool({name:'control_compose',arguments:{workloadId:f.workloadId,operation:'stop',idempotencyKey:'mcp-stop'}})).isError).not.toBe(true);await f.settled();
  f.store.db.prepare('UPDATE api_tokens SET scope=? WHERE id=?').run('read',f.tokens.deploy!.id);
  expect((await client.callTool({name:'deploy_compose',arguments:{...args,idempotencyKey:'read-cannot-deploy'}})).isError).toBe(true);
  f.store.db.prepare('UPDATE api_tokens SET revoked_at=? WHERE id=?').run(new Date().toISOString(),f.tokens.deploy!.id);
  expect((await client.callTool({name:'inspect_compose',arguments:{workloadId:f.workloadId}})).isError).toBe(true);
});
