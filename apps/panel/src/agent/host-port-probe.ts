import { hostname } from 'node:os';
import type Docker from 'dockerode';

/** Parse Linux's network namespace TCP tables, considering every bound address. */
export function tcpPortListening(table:string,port:number):boolean {
  if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Invalid TCP port.');
  const lines=table.trim().split('\n');
  if(!lines[0]?.includes('local_address'))throw new Error('Invalid TCP socket table.');
  for(const line of lines.slice(1)) {
    const fields=line.trim().split(/\s+/), address=fields[1],state=fields[3];
    if(!address || !state || !/^[0-9A-Fa-f]+:[0-9A-Fa-f]{4}$/.test(address) || !/^[0-9A-Fa-f]{2}$/.test(state))throw new Error('Invalid TCP socket entry.');
    if(state.toUpperCase()==='0A' && parseInt(address.slice(-4),16)===port)return true;
  }
  return false;
}

/** Discover the current agent's image; never execute an arbitrary caller-provided image. */
export async function localAgentImage(docker:Docker):Promise<string> {
  const id=hostname();
  if(!/^[a-f0-9]{12,64}$/.test(id))throw new Error('Host port checking requires the managed agent container.');
  const self=await docker.getContainer(id).inspect();
  if(!self.State?.Running || self.Config?.Labels?.['com.docker.compose.service']!=='agent' || !/^sha256:[a-f0-9]{64}$/.test(self.Image))throw new Error('Cannot verify the managed agent container.');
  return self.Image;
}

/** Read host network socket tables from an isolated, unprivileged helper. */
export async function hostTcpPortAvailable(docker:Docker,image:string,port:number,timeoutMs=15_000):Promise<boolean> {
  if(!/^sha256:[a-f0-9]{64}$/.test(image)||!Number.isInteger(port)||port<1||port>65535)throw new Error('Invalid host port check.');
  const script=`const fs=require('node:fs');const test=${tcpPortListening.toString()};try{const a=fs.readFileSync('/proc/net/tcp','utf8');let b='';try{b=fs.readFileSync('/proc/net/tcp6','utf8')}catch(e){if(e.code!=='ENOENT')throw e}process.exit(test(a,${port})||(b&&test(b,${port}))?42:0)}catch{process.exit(43)}`;
  return runHostPortCheck(docker,image,script,timeoutMs,code => {
    if(code===0)return true;
    if(code===42)return false;
    throw new Error('Host port availability could not be verified.');
  });
}

/** Check a bounded candidate batch using one host-network helper. */
export async function hostTcpPortSuggestion(docker:Docker,image:string,ports:readonly number[]):Promise<number|null> {
  if(!/^sha256:[a-f0-9]{64}$/.test(image)||!ports.length||ports.length>64||ports.some(port=>!Number.isInteger(port)||port<1024||port>65535))throw new Error('Invalid host port candidates.');
  const script=`const fs=require('node:fs');const test=${tcpPortListening.toString()};try{const a=fs.readFileSync('/proc/net/tcp','utf8');let b='';try{b=fs.readFileSync('/proc/net/tcp6','utf8')}catch(e){if(e.code!=='ENOENT')throw e}const ports=${JSON.stringify(ports)};const i=ports.findIndex(p=>!test(a,p)&&(!b||!test(b,p)));process.exit(i<0?100:i+1)}catch{process.exit(101)}`;
  return runHostPortCheck(docker,image,script,15_000,code=>{
    if(code===100)return null;
    if(code>=1&&code<=ports.length)return ports[code-1]!;
    throw new Error('Host port availability could not be verified.');
  });
}

async function runHostPortCheck<T>(docker:Docker,image:string,script:string,timeoutMs:number,resultForCode:(code:number)=>T):Promise<T> {
  const helper=await docker.createContainer({Image:image,Entrypoint:['/usr/local/bin/node'],Cmd:['-e',script],User:'65534:65534',
    HostConfig:{NetworkMode:'host',ReadonlyRootfs:true,CapDrop:['ALL'],SecurityOpt:['no-new-privileges'],PidsLimit:32,Memory:64*1024*1024,AutoRemove:false}});
  let timer:ReturnType<typeof setTimeout>|undefined;
  try {
    await helper.start();
    const result=await Promise.race([helper.wait(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Host port check timed out.')),timeoutMs);})]);
    return resultForCode(result.StatusCode);
  } finally {
    if(timer)clearTimeout(timer);
    try {await helper.remove({force:true});} catch { /* A failed removal cannot make an unverified port safe. */ }
  }
}
