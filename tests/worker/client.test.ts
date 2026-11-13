import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type RequestListener } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentRequest, applyService, AgentRequestError } from '../../src/agent/client.js';
import type { Service } from '../../src/shared/types.js';

const cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const fn of cleanup.splice(0).reverse())await fn();});
async function endpoint(handler:RequestListener) {
  const dir=mkdtempSync(join(tmpdir(),'panel-wire-')),socketPath=join(dir,'agent.sock');
  const server=createServer(handler);
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(socketPath,resolve);});
  cleanup.push(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(dir,{recursive:true,force:true});});
  return {socketPath,token:'local-test-token',timeoutMs:200};
}

describe('agent response certainty',()=>{
  it('recognizes a structured 422 failure as definitive',async()=>{
    const options=await endpoint((_req,res)=>{res.writeHead(422,{'content-type':'application/json'});res.end(JSON.stringify({error:{code:'RUNTIME_FAILED',message:'Deployment failed'}}));});
    await expect(agentRequest('/operation',{},options)).rejects.toMatchObject({certainty:'definitive',statusCode:422,code:'RUNTIME_FAILED'});
  });
  it.each([500,502,503,408,429])('keeps structured HTTP %i failures uncertain',async status=>{
    const options=await endpoint((_req,res)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify({error:{code:'UNAVAILABLE',message:'Try later'}}));});
    await expect(agentRequest('/operation',{},options)).rejects.toMatchObject({certainty:'uncertain',statusCode:status});
  });
  it('keeps a busy operation uncertain rather than releasing its service lock',async()=>{
    const options=await endpoint((_req,res)=>{res.writeHead(409,{'content-type':'application/json'});res.end(JSON.stringify({error:{code:'SERVICE_BUSY',message:'Another operation is running'}}));});
    await expect(agentRequest('/operation',{},options)).rejects.toMatchObject({certainty:'uncertain',code:'SERVICE_BUSY'});
  });
  it.each([200,422])('treats malformed HTTP %i responses as uncertain',async status=>{
    const options=await endpoint((_req,res)=>{res.writeHead(status);res.end('<html>proxy failure</html>');});
    await expect(agentRequest('/operation',{},options)).rejects.toMatchObject({certainty:'uncertain'});
  });
  it('treats a disconnected or timed-out response as uncertain',async()=>{
    const options=await endpoint(()=>{});
    const failure=await agentRequest('/operation',{}, {...options,timeoutMs:20}).catch(error=>error);
    expect(failure).toBeInstanceOf(AgentRequestError);expect(failure.certainty).toBe('uncertain');expect(failure.message).toContain('timed out');
  });
  it('returns successful JSON responses without reclassifying their content',async()=>{
    const options=await endpoint((_req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.end('{"state":"succeeded"}');});
    await expect(agentRequest('/operation',{},options)).resolves.toEqual({state:'succeeded'});
  });
  it('treats an invalid successful apply result as uncertain',async()=>{
    const options=await endpoint((_req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.end('{"state":"running"}');});
    await expect(applyService('test-operation',{} as Service,'deploy',options)).rejects.toMatchObject({certainty:'uncertain'});
  });
});
