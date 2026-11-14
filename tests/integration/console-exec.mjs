// Exercise an agent console and maintenance barrier against a disposable Docker container.
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Docker from 'dockerode';
import WebSocket from 'ws';
import { createAgent } from '../../apps/panel/src/agent/app.ts';
import { AgentMaintenanceGate } from '../../apps/panel/src/agent/maintenance.ts';

const name='servus-console-fixture-'+randomBytes(8).toString('hex');
const endpoint=execFileSync('docker',['context','inspect','--format','{{.Endpoints.docker.Host}}'],{encoding:'utf8'}).trim();
if(!endpoint.startsWith('unix://'))throw new Error('A local Docker Unix socket is required');
const directory=mkdtempSync(join(tmpdir(),'servus-console-e2e-'));
let created=false,app;
try {
  const id=execFileSync('docker',['run','-d','--rm','--network','none','--name',name,'busybox:1','sh','-c','while :; do sleep 10; done'],{encoding:'utf8'}).trim();
  created=true;
  const docker=new Docker({socketPath:endpoint.slice(7)}),gate=new AgentMaintenanceGate();
  const config={dataDir:directory,token:'fixture-token',socketPath:join(directory,'agent.sock'),dockerSocket:'/unused',ingressPort:18080,ingressImage:'unused'};
  const runtime={status:async()=>({online:true}),inspectService:async()=>({state:'unknown'}),apply:async()=>({state:'running',deployedRevision:1,messages:[]}),consoleContainer:async()=>docker.getContainer(id)};
  app=await createAgent(config,runtime,gate);
  const address=await app.listen({host:'127.0.0.1',port:0});
  const socket=new WebSocket(address.replace('http:','ws:')+'/services/'+randomUUID()+'/console',{headers:{authorization:'Bearer fixture-token'}});
  let output='';
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Terminal timed out')),8000);
    socket.once('open',()=>socket.send(JSON.stringify({type:'input',data:"printf 'SERVUS_%s\\n' 'CONSOLE_CHECK'\nexit\n"})));
    socket.on('message',data=>{output+=data.toString();});
    socket.once('close',()=>{clearTimeout(timer);resolve();});
    socket.once('error',reject);
  });
  if(!output.includes('SERVUS_CONSOLE_CHECK'))throw new Error('Terminal output was not received');
  if((await gate.drain(6000)).status!=='drained')throw new Error('Finished terminal blocked maintenance');
  console.log('PASS real agent terminal exits and permits maintenance');
} finally {
  if(app)await app.close();
  if(created)execFileSync('docker',['rm','-f',name],{stdio:'ignore'});
  rmSync(directory,{recursive:true,force:true});
}
