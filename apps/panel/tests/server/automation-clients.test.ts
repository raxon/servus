import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createApp } from '../../src/server/app.js';
import { Store } from '../../src/server/store.js';
// The executable modules are deliberately plain ESM so they also run without a build.
import { createMcpServer } from '../../../../scripts/servus-mcp.mjs';
import { connection } from '../../../../scripts/servus-client.mjs';

const cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
async function fixture(scope='read') {
  const dir=mkdtempSync(join(tmpdir(),'servus-clients-')),store=new Store(dir),app=await createApp({dataDir:dir,store});
  cleanup.push(async()=>{await app.close();store.close();rmSync(dir,{recursive:true,force:true});});
  const setup=await app.inject({method:'POST',url:'/api/v1/setup',payload:{email:'admin@example.test',password:'fixture-password'}}),user=setup.json().user;
  const project=store.createProject('clients'),{service}=store.createService(project.id,{name:'web',image:'nginx:alpine',hostname:'client.localhost',port:80},user.id);
  const job=store.claimNextJob('fixture',60_000)!;store.completeAction(job.actionId,'fixture',{state:'running',deployedRevision:1});
  const response=await app.inject({method:'POST',url:'/api/v1/auth/api-tokens',headers:{cookie:`panel_session=${setup.cookies[0]!.value}`,'x-csrf-token':setup.json().csrfToken},payload:{projectId:project.id,name:'client',scope}});
  const token=response.json().token as string;
  const origin=await app.listen({host:'127.0.0.1',port:0});
  return {app,store,project,service,token,origin};
}
it('refuses insecure remote transport and credentials embedded in URLs',()=>{
  for(const url of ['http://example.com','https://user:pass@example.com','https://example.com/panel','https://example.com/?key=secret'])
    expect(()=>connection({SERVUS_URL:url,SERVUS_TOKEN:`srv_${'a'.repeat(64)}`})).toThrow();
  expect(connection({SERVUS_URL:'http://127.0.0.1:4180',SERVUS_TOKEN:`srv_${'a'.repeat(64)}`})).toHaveProperty('origin','http://127.0.0.1:4180');
});
it('runs the CLI against a real HTTP server and reports insufficient scope with exit code 1',async()=>{
  const {origin,token,project,service}=await fixture();
  const env={...process.env,SERVUS_URL:origin,SERVUS_TOKEN:token},script=resolve(import.meta.dirname,'../../../../scripts/servus.mjs');
  const result=await promisify(execFile)(process.execPath,[script,'projects'],{env});
  expect(JSON.parse(result.stdout).map((p:{id:string})=>p.id)).toEqual([project.id]);
  await expect(promisify(execFile)(process.execPath,[script,'restart',service.id],{env})).rejects.toMatchObject({code:1,stderr:expect.stringContaining('TOKEN_SCOPE')});
});
it('uses an actual MCP client handshake and preserves idempotency through service tools',async()=>{
  const {origin,token,project,service,store}=await fixture('deploy'),server=createMcpServer({origin,token});
  const client=new Client({name:'servus-test',version:'1.0.0'}),[a,b]=InMemoryTransport.createLinkedPair();
  cleanup.push(async()=>{await client.close();await server.close();});
  await server.connect(b);await client.connect(a);
  const catalog=await client.listTools();
  expect(catalog.tools.find(tool=>tool.name==='deploy_service')?.annotations?.destructiveHint).toBe(true);
  expect(catalog.tools.find(tool=>tool.name==='list_projects')?.annotations?.readOnlyHint).toBe(true);
  const listed=await client.callTool({name:'list_services',arguments:{projectId:project.id}});
  expect(JSON.stringify(listed)).toContain(service.id);
  const args={serviceId:service.id,operation:'restart',idempotencyKey:'same-mcp-request'};
  const first=await client.callTool({name:'control_service',arguments:args}),again=await client.callTool({name:'control_service',arguments:args});
  expect(again).toEqual(first);expect(store.listActions(undefined,service.id)).toHaveLength(2);
  store.db.prepare('UPDATE api_tokens SET revoked_at=?').run(new Date().toISOString());
  expect((await client.callTool({name:'list_projects'})).isError).toBe(true);
});
