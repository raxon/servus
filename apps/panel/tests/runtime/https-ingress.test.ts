import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DockerRuntime } from '../../src/agent/runtime.js';
import { supportsManagedHttps } from '../../src/agent/https-routing.js';
import { localTlsForwarderSpec } from '../../src/agent/https-local-forwarder.js';

const cleanups:(()=>void)[]=[];
afterEach(()=>{vi.unstubAllEnvs();for(const clean of cleanups.splice(0))clean();});
function harness(owned=true) {
  const dir=mkdtempSync(join(tmpdir(),'https-ingress-'));cleanups.push(()=>rmSync(dir,{recursive:true,force:true}));
  const runtime=new DockerRuntime('/unused',80,'traefik:3',dir),docker=runtime.docker as any;
  docker.info=vi.fn().mockResolvedValue({Swarm:{LocalNodeState:'active',ControlAvailable:true,NodeID:'a'.repeat(25)}});
  docker.getNetwork=vi.fn().mockReturnValue({inspect:async()=>({Labels:{'panel.owner':'self-hosted-panel'}})});
  docker.getService=vi.fn().mockReturnValue({inspect:async()=>{throw {statusCode:404};}});
  docker.getVolume=vi.fn().mockReturnValue({inspect:async()=>({Driver:'local',Labels:{'panel.owner':owned?'self-hosted-panel':'other','panel.purpose':'acme'}})});
  docker.createService=vi.fn().mockResolvedValue({});docker.createVolume=vi.fn();
  vi.spyOn(runtime,'pull').mockResolvedValue('traefik@sha256:digest');return {runtime,docker};
}
it('provisions a single node-pinned HTTPS ingress with persistent managed ACME volume',async()=>{
  vi.stubEnv('PANEL_HTTPS_ENABLED','true');vi.stubEnv('PANEL_HTTPS_EMAIL','admin@example.com');vi.stubEnv('PANEL_HTTPS_STAGING','true');
  const {runtime,docker}=harness();await runtime.ensureInfrastructure();
  const spec=docker.createService.mock.calls[0][0];expect(supportsManagedHttps(spec)).toBe(true);
  expect(spec.TaskTemplate.Placement.Constraints).toEqual([`node.id==${'a'.repeat(25)}`]);
  expect(spec.TaskTemplate.ContainerSpec.Args).toContain('--certificatesresolvers.servus.acme.caserver=https://acme-staging-v02.api.letsencrypt.org/directory');
  expect(docker.createVolume).not.toHaveBeenCalled();
  docker.getService.mockReturnValue({inspect:async()=>({Spec:spec})});
  expect(await runtime.status()).toMatchObject({httpsConfigured:true,httpsAccess:'direct'});
  docker.getVolume.mockReturnValue({inspect:async()=>({Driver:'local',Labels:{'panel.owner':'other','panel.purpose':'acme'}})});
  expect((await runtime.status()).httpsConfigured).toBe(false);
});
it('will not adopt an unrelated volume or modify an existing HTTP ingress',async()=>{
  vi.stubEnv('PANEL_HTTPS_ENABLED','true');vi.stubEnv('PANEL_HTTPS_EMAIL','admin@example.com');
  const foreign=harness(false);await expect(foreign.runtime.ensureInfrastructure()).rejects.toThrow('certificate storage belongs');expect(foreign.docker.createService).not.toHaveBeenCalled();
  const existing=harness();const update=vi.fn();existing.docker.getService.mockReturnValue({inspect:async()=>({Spec:{Labels:{'panel.owner':'self-hosted-panel'},TaskTemplate:{RestartPolicy:{Condition:'any'}}},Version:{Index:1}}),update});
  await existing.runtime.ensureInfrastructure();expect(update).not.toHaveBeenCalled();expect(existing.docker.createService).not.toHaveBeenCalled();
});
it('refuses invalid ACME configuration before creating the ingress',async()=>{
  vi.stubEnv('PANEL_HTTPS_ENABLED','true');vi.stubEnv('PANEL_HTTPS_EMAIL','bad-value');const {runtime,docker}=harness();
  await expect(runtime.ensureInfrastructure()).rejects.toThrow('valid ACME contact email');expect(docker.createService).not.toHaveBeenCalled();
});
it('loads persistent ACME settings without process environment overrides',async()=>{
  vi.stubEnv('PANEL_HTTPS_ENABLED',undefined);vi.stubEnv('PANEL_HTTPS_EMAIL',undefined);
  const {runtime,docker}=harness();runtime.vault.setHttpsIngress('ops@example.com',true);
  await runtime.ensureInfrastructure();
  const spec=docker.createService.mock.calls[0][0];
  expect(spec.TaskTemplate.ContainerSpec.Args).toContain('--certificatesresolvers.servus.acme.email=ops@example.com');
  expect(supportsManagedHttps(spec)).toBe(true);
});
it('reports external HTTPS ready only while its verified loopback relay is running',async()=>{
  vi.stubEnv('PANEL_HTTPS_ENABLED','true');vi.stubEnv('PANEL_HTTPS_EMAIL','admin@example.com');
  const {runtime,docker}=harness();await runtime.ensureInfrastructure();
  const spec=docker.createService.mock.calls[0][0];spec.Labels['panel.https-access']='loopback-forwarder-v1';spec.EndpointSpec.Ports=spec.EndpointSpec.Ports.filter((p:{PublishedPort:number})=>p.PublishedPort!==443);
  docker.getService.mockReturnValue({inspect:async()=>({Spec:spec})});
  const id='b'.repeat(25),image='sha256:'+'a'.repeat(64),forwarder=localTlsForwarderSpec(image,id);
  docker.getNetwork.mockReturnValue({inspect:async()=>({Id:id,Driver:'overlay',Attachable:true,Labels:{'panel.owner':'self-hosted-panel'}})});
  const state={Running:true},inspect=async()=>({Image:image,Config:{Labels:forwarder.Labels,User:forwarder.User,Entrypoint:forwarder.Entrypoint,Cmd:forwarder.Cmd},HostConfig:forwarder.HostConfig,NetworkSettings:{Networks:{managed:{NetworkID:id}}},Mounts:[],State:state});
  docker.getContainer=vi.fn().mockReturnValue({inspect});
  expect(await runtime.status()).toMatchObject({httpsConfigured:true,httpsAccess:'external'});
  state.Running=false;
  expect((await runtime.status()).httpsConfigured).toBe(false);
});
