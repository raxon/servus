import type Docker from 'dockerode';

export const LOCAL_TLS_FORWARDER='servus-https-forwarder';
export const LOCAL_TLS_PORT=18443;
const OWNER='self-hosted-panel';
// This process only relays opaque TLS bytes. It has no filesystem mounts or
// Docker socket, and the published port is restricted to the local host.
const PROGRAM="const n=require('node:net');n.createServer(c=>{const u=n.connect(8443,'panel-ingress');c.on('error',()=>u.destroy());u.on('error',()=>c.destroy());c.pipe(u).pipe(c)}).listen(8443,'0.0.0.0')";

function validImage(image:string):boolean {return /^sha256:[a-f0-9]{64}$/.test(image);}

/** Construct a loopback-only TCP relay attached to the owned overlay network. */
export function localTlsForwarderSpec(image:string,networkId:string):Docker.ContainerCreateOptions {
  if(!validImage(image)||!/^[a-z0-9]{12,64}$/.test(networkId))throw new Error('Invalid HTTPS forwarder identity.');
  return {name:LOCAL_TLS_FORWARDER,Image:image,Entrypoint:['/usr/local/bin/node'],Cmd:['-e',PROGRAM],User:'65534:65534',
    Labels:{'panel.owner':OWNER,'panel.purpose':'https-local-forwarder-v1'},ExposedPorts:{'8443/tcp':{}},
    HostConfig:{NetworkMode:networkId,PortBindings:{'8443/tcp':[{HostIp:'127.0.0.1',HostPort:String(LOCAL_TLS_PORT)}]},RestartPolicy:{Name:'unless-stopped'},ReadonlyRootfs:true,CapDrop:['ALL'],SecurityOpt:['no-new-privileges'],PidsLimit:32,Memory:64*1024*1024},
    NetworkingConfig:{EndpointsConfig:{[networkId]:{}}}};
}

/** Fail closed if the reserved name exists with any unexpected configuration. */
export async function verifyLocalTlsForwarder(container:Docker.Container,networkId:string,image:string,requireRunning=true):Promise<boolean> {
  const info=await container.inspect(),labels=info.Config?.Labels??{},bindings=info.HostConfig?.PortBindings?.['8443/tcp'];
  const net=Object.values(info.NetworkSettings?.Networks??{}).find(value=>value.NetworkID===networkId);
  return labels['panel.owner']===OWNER && labels['panel.purpose']==='https-local-forwarder-v1' && validImage(image) && info.Image===image &&
    info.Config?.User==='65534:65534' && JSON.stringify(info.Config?.Entrypoint)===JSON.stringify(['/usr/local/bin/node']) && JSON.stringify(info.Config?.Cmd)===JSON.stringify(['-e',PROGRAM]) &&
    !(info.Config?.Env??[]).some(value=>/^(?:NODE_OPTIONS|NODE_PATH|LD_[A-Z_]+|DYLD_[A-Z_]+)=/.test(value)) &&
    info.HostConfig?.ReadonlyRootfs===true && info.HostConfig?.RestartPolicy?.Name==='unless-stopped' &&
    info.HostConfig?.Privileged!==true && !(info.HostConfig?.CapAdd?.length) && info.HostConfig?.CapDrop?.includes('ALL')===true &&
    info.HostConfig?.SecurityOpt?.includes('no-new-privileges')===true && !info.HostConfig?.PublishAllPorts && Object.keys(info.HostConfig?.PortBindings??{}).length===1 &&
    info.HostConfig?.NetworkMode===networkId && Array.isArray(bindings) && bindings.length===1 && bindings[0]?.HostIp==='127.0.0.1' && bindings[0]?.HostPort===String(LOCAL_TLS_PORT) &&
    (info.Mounts?.length??0)===0 && Object.keys(info.NetworkSettings?.Networks??{}).length===1 && !!net && (!requireRunning || info.State?.Running===true);
}

/** Reuse only an independently verified relay; never replace a foreign name. */
export async function ensureLocalTlsForwarder(docker:Docker,image:string):Promise<void> {
  const network=await docker.getNetwork('panel-ingress').inspect();
  if(network.Labels?.['panel.owner']!==OWNER || network.Driver!=='overlay' || network.Attachable!==true || !/^[a-z0-9]{12,64}$/.test(network.Id))throw new Error('The managed ingress network cannot host a local TLS forwarder.');
  let container=docker.getContainer(LOCAL_TLS_FORWARDER),existing:Docker.ContainerInspectInfo|undefined;
  try {existing=await container.inspect();}catch(error){if((error as {statusCode?:number})?.statusCode!==404)throw error;}
  if(existing) {
    // A previous application image remains a valid relay across panel updates.
    if(!await verifyLocalTlsForwarder(container,network.Id,existing.Image,false))throw new Error('The HTTPS forwarder name belongs to another container or its configuration changed.');
    if(!existing.State?.Running)await container.start();
  } else {
    container=await docker.createContainer(localTlsForwarderSpec(image,network.Id));
    await container.start();
  }
  const actual=await container.inspect();
  if(!await verifyLocalTlsForwarder(container,network.Id,actual.Image))throw new Error('The HTTPS forwarder could not be verified.');
}
