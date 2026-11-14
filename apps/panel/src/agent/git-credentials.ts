import { createServer, type Server } from 'node:net';
import { chmodSync, mkdtempSync, rmdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const helper = `const net=require('node:net');let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>{input+=x;if(input.length>8192)process.exit(1)});process.stdin.on('end',()=>{if(process.argv[1]!=='get')process.exit(0);const s=net.createConnection(process.env.SERVUS_GIT_SOCKET);s.setTimeout(3000);s.on('connect',()=>s.end(input));s.on('data',x=>process.stdout.write(x));s.on('timeout',()=>s.destroy());s.on('error',()=>process.exitCode=1)});`;
const quote = (value:string) => `'${value.replaceAll("'", "'\\''")}'`;

/** Serve one repository-scoped credential during Git operations only. */
export async function gitCredentials(_directory:string, repository:URL, username:string, token:string):Promise<{socket:string;helper:string;close:()=>Promise<void>}> {
  const directory=mkdtempSync(join(tmpdir(),'sg-'));
  chmodSync(directory,0o700);
  const socket=join(directory,'s');
  const server:Server=createServer({allowHalfOpen:true}, client=>{
    let input='', invalid=false;
    client.setTimeout(3000,()=>client.destroy());
    client.setEncoding('utf8');
    client.on('error',()=>{});
    client.on('data',chunk=>{input+=chunk;if(input.length>8192){invalid=true;client.destroy();}});
    client.on('end',()=>{
      if(invalid)return;
      const fields=new Map<string,string>();
      for(const line of input.split('\n')) {
        if(!line)continue;
        const index=line.indexOf('=');
        if(index<1){client.end();return;}
        const key=line.slice(0,index);
        if(!['protocol','host','path'].includes(key))continue;
        if(fields.has(key)){client.end();return;}
        fields.set(key,line.slice(index+1));
      }
      if(fields.get('protocol')!=='https'||fields.get('host')!==repository.host||fields.get('path')!==repository.pathname.slice(1)){client.end();return;}
      client.end(`username=${username}\npassword=${token}\n\n`);
    });
  });
  try { await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(socket,()=>{server.removeListener('error',reject);resolve();});}); }
  catch(error){rmdirSync(directory);throw error;}
  chmodSync(socket,0o600);
  return {socket,helper:`!${quote(process.execPath)} -e ${quote(helper)} --`,close:async()=>{
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    try{unlinkSync(socket);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    rmdirSync(directory);
  }};
}
