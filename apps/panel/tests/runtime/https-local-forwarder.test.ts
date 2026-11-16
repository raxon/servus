import { expect, it } from 'vitest';
import type Docker from 'dockerode';
import { localTlsForwarderSpec, verifyLocalTlsForwarder, LOCAL_TLS_PORT } from '../../src/agent/https-local-forwarder.js';

const image='sha256:'+'a'.repeat(64),network='b'.repeat(25);
function inspected() {
  const spec=localTlsForwarderSpec(image,network);
  return {Image:image,Config:{Labels:spec.Labels,User:spec.User,Entrypoint:spec.Entrypoint,Cmd:spec.Cmd},HostConfig:{...spec.HostConfig,Privileged:false},NetworkSettings:{Networks:{managed:{NetworkID:network}}},Mounts:[],State:{Running:true}};
}
const container=(value:ReturnType<typeof inspected>)=>({inspect:async()=>value}) as unknown as Docker.Container;
it('uses an unprivileged relay bound only to loopback',()=>{
  const spec=localTlsForwarderSpec(image,network);
  expect(spec.HostConfig?.PortBindings?.['8443/tcp']).toEqual([{HostIp:'127.0.0.1',HostPort:String(LOCAL_TLS_PORT)}]);
  expect(spec.HostConfig?.ReadonlyRootfs).toBe(true);
  expect(spec.HostConfig?.CapDrop).toContain('ALL');
  expect(()=>localTlsForwarderSpec('other',network)).toThrow();
});
it('rejects foreign, privileged, publicly bound and modified relays',async()=>{
  expect(await verifyLocalTlsForwarder(container(inspected()),network,image)).toBe(true);
  for(const alter of [
    (v:any)=>{v.Config.Labels['panel.owner']='other';},
    (v:any)=>{v.Image='sha256:'+'c'.repeat(64);},
    (v:any)=>{v.Config.Cmd=['node','other'];},
    (v:any)=>{v.Config.Env=['NODE_OPTIONS=--require=/tmp/injected.js'];},
    (v:any)=>{v.HostConfig.Privileged=true;},
    (v:any)=>{v.HostConfig.PortBindings['8443/tcp'][0].HostIp='0.0.0.0';},
    (v:any)=>{v.HostConfig.CapDrop=[];},
    (v:any)=>{v.Mounts=[{Source:'/var/run/docker.sock'}];},
    (v:any)=>{v.NetworkSettings.Networks.foreign={NetworkID:'other'};},
  ]) {const value=structuredClone(inspected());alter(value);expect(await verifyLocalTlsForwarder(container(value),network,image)).toBe(false);}
});
