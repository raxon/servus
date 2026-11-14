import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, renameSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const filesystem = vi.hoisted(() => ({ trusted: false, unsafeSocket: false, replaceSocket: false, socketChecks: 0 }));
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  function secure(stat: import('node:fs').Stats, path?: unknown) {
    if (!filesystem.trusted) return stat;
    const mode = stat.isDirectory() ? (stat.mode & ~0o022) : stat.isSocket() ? (stat.mode & ~0o007) : stat.mode;
    const replaceInode=filesystem.replaceSocket && typeof path==='string' && path.endsWith('/socket') && ++filesystem.socketChecks>1;
    return new Proxy(stat, {get(target, property) {
      if (property === 'uid') return filesystem.unsafeSocket && typeof path === 'string' && path.endsWith('/socket') ? 1234 : 0;
      if (property === 'mode') return mode;
      if (property === 'ino' && replaceInode) return stat.ino+1;
      if (property === 'isSymbolicLink' && path === '/tmp') return () => false;
      if (property === 'isDirectory' && path === '/tmp') return () => true;
      return Reflect.get(target, property, target);
    }});
  }
  return {...actual,
    lstatSync: (path: Parameters<typeof actual.lstatSync>[0]) => secure(path === '/tmp' ? actual.statSync(path) : actual.lstatSync(path),path),
    fstatSync: (fd: number) => secure(actual.fstatSync(fd)),
  };
});
import { runSupervisorControl, type SupervisorDrainStatus } from '../../src/shared/supervisor-control.js';

const token = 'a'.repeat(64), serverChallenge='b'.repeat(64);
const requestId='12345678-1234-4123-8123-123456789abc';
const directories: string[] = [], servers: Server[] = [], sockets = new Set<Socket>();
let originalPlatform: PropertyDescriptor | undefined;
const mac=(direction:string,role:string,client:string,server:string)=>createHmac('sha256',Buffer.from(token,'hex')).update(`servus-supervisor-${direction}-v1\0${role}\0${client}\0${server}`).digest('hex');
const write=(socket:Socket,value:object)=>socket.write(`${JSON.stringify(value)}\n`);
async function fixture(handler: (socket:Socket) => void) {
  const directory=mkdtempSync('/tmp/supervisor-client-');directories.push(directory);
  const path=join(directory,'socket'),secret=join(directory,'secret');writeFileSync(secret,token,{mode:0o600});chmodSync(secret,0o600);
  const server=createServer(socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));handler(socket);});servers.push(server);
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(path,resolve);});
  return {socketPath:path,secretPath:secret};
}
function peer(socket:Socket, onConfirm:()=>void, received:(value:any)=>void, badProof=false, fragmented=false) {
  let pending='',clientChallenge='',phase=0;
  socket.on('data',(data:Buffer)=>{
    pending+=data.toString('utf8');let newline;
    while((newline=pending.indexOf('\n'))!==-1) {
      const line=pending.slice(0,newline);pending=pending.slice(newline+1);const frame=JSON.parse(line);
      if(phase===0) {
        expect(frame).toEqual({version:1,type:'hello',role:'api',challenge:expect.stringMatching(/^[a-f0-9]{64}$/)});
        expect(line).not.toContain(token);clientChallenge=frame.challenge;phase=1;
        const ack={version:1,type:'hello_ack',role:'api',challenge:serverChallenge,proof:badProof?'0'.repeat(64):mac('server','api',clientChallenge,serverChallenge)};
        if(fragmented) {const text=JSON.stringify(ack)+'\n';socket.write(text.slice(0,19));setTimeout(()=>socket.write(text.slice(19)),5);}
        else write(socket,ack);
      } else if(phase===1) {
        expect(frame).toEqual({version:1,type:'hello_confirm',proof:mac('client','api',clientChallenge,serverChallenge)});phase=2;
        write(socket,{version:1,type:'ready',role:'api'});onConfirm();
      } else received(frame);
    }
  });
}
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
beforeEach(()=>{originalPlatform=Object.getOwnPropertyDescriptor(process,'platform');Object.defineProperty(process,'platform',{value:'linux',configurable:true});filesystem.trusted=true;filesystem.unsafeSocket=false;filesystem.replaceSocket=false;filesystem.socketChecks=0;});
afterEach(async()=>{
  filesystem.trusted=false;filesystem.unsafeSocket=false;
  if(originalPlatform)Object.defineProperty(process,'platform',originalPlatform);
  for(const socket of sockets)socket.destroy();
  for(const server of servers.splice(0))await new Promise<void>(resolve=>server.close(()=>resolve()));
  for(const directory of directories.splice(0))rmSync(directory,{recursive:true,force:true});
});

describe('supervisor control',()=>{
  it('authenticates both peers without sending a secret and executes one drain',async()=>{
    const abort=new AbortController();let count=0;let result:any;
    const options=await fixture(socket=>peer(socket,()=>write(socket,{version:1,type:'drain',requestId,timeoutMs:100}),frame=>{result=frame;abort.abort();}));
    await runSupervisorControl({...options,role:'api',signal:abort.signal,reconnectMs:10,drain:async timeout=>{count++;expect(timeout).toBe(100);return {status:'drained'};}});
    expect(count).toBe(1);expect(result).toEqual({version:1,type:'drain_result',requestId,status:'drained'});
  });
  it('refuses a spoofed server proof before confirming or draining',async()=>{
    const abort=new AbortController();let drain=0,confirmed=false;
    const options=await fixture(socket=>{peer(socket,()=>{confirmed=true;},()=>{},true);socket.once('close',()=>abort.abort());});
    await runSupervisorControl({...options,role:'api',signal:abort.signal,reconnectMs:10,drain:async()=>{drain++;return {status:'drained'};}});
    expect(confirmed).toBe(false);expect(drain).toBe(0);
  });
  it('accepts handshake and command frames split across packets',async()=>{
    const abort=new AbortController();let status='';
    const options=await fixture(socket=>peer(socket,()=>{
      const frame=JSON.stringify({version:1,type:'drain',requestId,timeoutMs:100})+'\n';
      socket.write(frame.slice(0,13));setTimeout(()=>socket.write(frame.slice(13)),5);
    },frame=>{status=frame.status;abort.abort();},false,true));
    await runSupervisorControl({...options,role:'api',signal:abort.signal,reconnectMs:10,drain:async()=>({status:'drained'})});
    expect(status).toBe('drained');
  });
  it('returns timeout when the drain does not finish',async()=>{
    const abort=new AbortController();let status:SupervisorDrainStatus|undefined;
    const options=await fixture(socket=>peer(socket,()=>write(socket,{version:1,type:'drain',requestId,timeoutMs:20}),frame=>{status=frame.status;abort.abort();}));
    await runSupervisorControl({...options,role:'api',signal:abort.signal,reconnectMs:10,drain:()=>new Promise(()=>{})});
    expect(status).toBe('timeout');
  });
  it('replays the same result after reconnect without draining twice',async()=>{
    const abort=new AbortController();let connections=0,drains=0,results=0;
    const options=await fixture(socket=>{
      connections++;
      peer(socket,()=>write(socket,{version:1,type:'drain',requestId,timeoutMs:100}),frame=>{results++;expect(frame.status).toBe('drained');if(results===2)abort.abort();});
    });
    await runSupervisorControl({...options,role:'api',signal:abort.signal,reconnectMs:10,drain:async()=>{drains++;return {status:'drained'};}});
    expect(connections).toBe(2);expect(drains).toBe(1);expect(results).toBe(2);
  });
  it('reconnects while the original drain is running and returns that result',async()=>{
    const abort=new AbortController();let connections=0,drains=0;let first:Socket|undefined;let status='';
    const options=await fixture(socket=>{
      connections++;if(connections===1)first=socket;
      peer(socket,()=>write(socket,{version:1,type:'drain',requestId,timeoutMs:500}),frame=>{status=frame.status;abort.abort();});
    });
    await runSupervisorControl({...options,role:'api',signal:abort.signal,reconnectMs:10,drain:async()=>{drains++;first!.destroy();await delay(70);return {status:'drained'};}});
    expect(connections).toBe(2);expect(drains).toBe(1);expect(status).toBe('drained');
  });
  it('returns uncertain for a conflicting request without invoking drain again',async()=>{
    const abort=new AbortController();let connections=0,drains=0,status='';
    const options=await fixture(socket=>{
      connections++;
      peer(socket,()=>write(socket,{version:1,type:'drain',requestId:connections===1?requestId:'12345678-1234-4123-8123-123456789abd',timeoutMs:100}),frame=>{if(connections===2){status=frame.status;abort.abort();}});
    });
    await runSupervisorControl({...options,role:'api',signal:abort.signal,reconnectMs:10,drain:async()=>{drains++;return {status:'drained'};}});
    expect(drains).toBe(1);expect(status).toBe('uncertain');
  });
  it('treats a changed timeout under the same id as a conflict',async()=>{
    const abort=new AbortController();let connections=0,drains=0,status='';
    const options=await fixture(socket=>{
      connections++;
      peer(socket,()=>write(socket,{version:1,type:'drain',requestId,timeoutMs:connections===1?100:101}),frame=>{if(connections===2){status=frame.status;abort.abort();}});
    });
    await runSupervisorControl({...options,role:'api',signal:abort.signal,reconnectMs:10,drain:async()=>{drains++;return {status:'drained'};}});
    expect(drains).toBe(1);expect(status).toBe('uncertain');
  });
  it('keeps a timeout result on retry even if the original callback later completes',async()=>{
    const abort=new AbortController();let connections=0,drains=0;const statuses:string[]=[];
    const options=await fixture(socket=>{
      connections++;
      peer(socket,()=>{setTimeout(()=>write(socket,{version:1,type:'drain',requestId,timeoutMs:20}),connections===1?0:60);},frame=>{statuses.push(frame.status);if(statuses.length===2)abort.abort();});
    });
    await runSupervisorControl({...options,role:'api',signal:abort.signal,reconnectMs:10,drain:async()=>{drains++;await delay(40);return {status:'drained'};}});
    expect(drains).toBe(1);expect(statuses).toEqual(['timeout','timeout']);
  });
  it('refuses an untrusted socket without connecting',async()=>{
    const abort=new AbortController();let connected=false;
    const options=await fixture(()=>{connected=true;});filesystem.unsafeSocket=true;
    setTimeout(()=>abort.abort(),60);
    await runSupervisorControl({...options,role:'api',signal:abort.signal,reconnectMs:10,drain:async()=>({status:'drained'})});
    expect(connected).toBe(false);
  });
  it('refuses a socket replaced between inspection and connection',async()=>{
    const abort=new AbortController();let sent=false;
    const options=await fixture(socket=>{socket.on('data',()=>{sent=true;});socket.once('close',()=>abort.abort());});filesystem.replaceSocket=true;
    await runSupervisorControl({...options,role:'api',signal:abort.signal,reconnectMs:10,drain:async()=>({status:'drained'})});
    expect(sent).toBe(false);
  });
  it('refuses reconnect after the token file is replaced',async()=>{
    const abort=new AbortController();let connections=0,drains=0;let secretPath='';
    const options=await fixture(socket=>{
      connections++;
      peer(socket,()=>write(socket,{version:1,type:'drain',requestId,timeoutMs:100}),()=>{
        renameSync(secretPath,`${secretPath}.old`);writeFileSync(secretPath,token,{mode:0o600});chmodSync(secretPath,0o600);
        setTimeout(()=>abort.abort(),70);
      });
    });secretPath=options.secretPath;
    await runSupervisorControl({...options,role:'api',signal:abort.signal,reconnectMs:10,drain:async()=>{drains++;return {status:'drained'};}});
    expect(connections).toBe(1);expect(drains).toBe(1);
  });
  it('rejects duplicate keys and oversized frames before invoking drain',async()=>{
    for(const frame of ['{"version":1,"type":"ready","role":"api","role":"api"}\n',`${'x'.repeat(4097)}\n`]) {
      const abort=new AbortController();let calls=0;
      const options=await fixture(socket=>{
        let pending=''; socket.on('data',data=>{
          pending+=data.toString(); if(!pending.includes('\n'))return;
          const hello=JSON.parse(pending.slice(0,pending.indexOf('\n')));pending='';
          if(hello.type==='hello')write(socket,{version:1,type:'hello_ack',role:'api',challenge:serverChallenge,proof:mac('server','api',hello.challenge,serverChallenge)});
          else if(hello.type==='hello_confirm')socket.write(frame);
        });socket.once('close',()=>abort.abort());
      });
      await runSupervisorControl({...options,role:'api',signal:abort.signal,reconnectMs:10,drain:async()=>{calls++;return {status:'drained'};}});
      expect(calls).toBe(0);
    }
  });
});
