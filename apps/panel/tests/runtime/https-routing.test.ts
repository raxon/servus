import { expect, it } from 'vitest';
import { httpsRouteLabels } from '../../src/agent/https-routing.js';

const id='64150ff3-fc4c-4c33-b79a-4821482be3c1';
it('creates distinct secure routes for each application and preserves the HTTP router',()=>{
  const first=httpsRouteLabels(id,0,'app.example.com',3000);
  const second=httpsRouteLabels(id,1,'other.example.com',8080);
  const prefix='64150ff3fc4c4c33b79a4821482be3c1-0';
  expect(first[`traefik.http.routers.${prefix}-https.rule`]).toBe('Host(`app.example.com`)');
  expect(first[`traefik.http.routers.${prefix}-https.entrypoints`]).toBe('websecure');
  expect(first[`traefik.http.routers.${prefix}-https.tls.certresolver`]).toBe('servus');
  expect(first[`traefik.http.services.${prefix}.loadbalancer.server.port`]).toBe('3000');
  expect(Object.keys(first).some(key=>key.startsWith(`traefik.http.routers.${prefix}.`))).toBe(false);
  expect(Object.keys(first).filter(key=>key in second)).toEqual([]);
});
it('rejects invalid or injectable route identities and hostnames',()=>{
  for(const host of ['localhost','127.0.0.1','*.example.com','app.example.com`) || Host(`evil.example.com','App.Example.com']) expect(()=>httpsRouteLabels(id,0,host,80)).toThrow();
  expect(()=>httpsRouteLabels('invalid',0,'app.example.com',80)).toThrow();
  expect(()=>httpsRouteLabels(id,20,'app.example.com',80)).toThrow();
  expect(()=>httpsRouteLabels(id,0,'app.example.com',65536)).toThrow();
});

it('requires a managed single-instance ingress with durable ACME storage and host port 443',async()=>{
  const {supportsManagedHttps}=await import('../../src/agent/https-routing.js');
  const ingress={Labels:{'panel.owner':'self-hosted-panel','panel.https':'servus-acme-v1'},Mode:{Replicated:{Replicas:1}},TaskTemplate:{ContainerSpec:{Image:'traefik',Args:['--entrypoints.web.address=:8080','--entrypoints.websecure.address=:8443','--certificatesresolvers.servus.acme.storage=/letsencrypt/acme.json','--certificatesresolvers.servus.acme.httpchallenge.entrypoint=web'],Mounts:[{Type:'volume',Source:'servus-acme',Target:'/letsencrypt',ReadOnly:false}]}},EndpointSpec:{Ports:[{Protocol:'tcp',PublishedPort:443,TargetPort:8443,PublishMode:'host'}]}} as import('dockerode').ServiceSpec;
  expect(supportsManagedHttps(ingress)).toBe(true);
  for(const mutate of [
    (v:any)=>{v.Labels['panel.owner']='other';},
    (v:any)=>{v.Labels['panel.https']='other';},
    (v:any)=>{v.Mode.Replicated.Replicas=2;},
    (v:any)=>{v.TaskTemplate.ContainerSpec.Args.pop();},
    (v:any)=>{v.TaskTemplate.ContainerSpec.Mounts[0].ReadOnly=true;},
    (v:any)=>{v.EndpointSpec.Ports[0].PublishedPort=444;},
  ]) {const candidate=structuredClone(ingress);mutate(candidate);expect(supportsManagedHttps(candidate)).toBe(false);}
});

it('plans a reversible HTTPS migration without modifying the existing ingress',async()=>{
  const {planHttpsIngressMigration,supportsManagedHttps}=await import('../../src/agent/https-routing.js');
  const node='a'.repeat(25),baseline={Labels:{'panel.owner':'self-hosted-panel'},Mode:{Replicated:{Replicas:1}},TaskTemplate:{Placement:{Constraints:['node.role==manager']},ContainerSpec:{Image:'traefik:3',Args:['--providers.swarm.endpoint=unix:///var/run/docker.sock','--providers.swarm.exposedbydefault=false','--providers.swarm.network=panel-ingress','--entrypoints.web.address=:8080','--api.dashboard=false','--log.level=WARN'],Mounts:[{Type:'bind',Source:'/var/run/docker.sock',Target:'/var/run/docker.sock',ReadOnly:true}]}},EndpointSpec:{Ports:[{Protocol:'tcp',PublishedPort:80,TargetPort:8080,PublishMode:'host'}]}} as import('dockerode').ServiceSpec;
  const copy=structuredClone(baseline),target=planHttpsIngressMigration(baseline,node,{email:'ops@example.com',staging:true});
  expect(baseline).toEqual(copy);expect(supportsManagedHttps(target)).toBe(true);
  expect(target.TaskTemplate?.Placement?.Constraints).toEqual([`node.id==${node}`]);
  expect(target.TaskTemplate?.ContainerSpec?.Mounts?.[1]).toEqual({Type:'volume',Source:'servus-acme',Target:'/letsencrypt'});
  expect(target.EndpointSpec?.Ports).toContainEqual({Protocol:'tcp',PublishedPort:80,TargetPort:8080,PublishMode:'host'});
  expect(target.UpdateConfig).toMatchObject({Order:'stop-first',FailureAction:'rollback',Parallelism:1});
  const external=planHttpsIngressMigration(baseline,node,{email:'ops@example.com',staging:true},'external');
  expect(supportsManagedHttps(external)).toBe(true);
  expect(external.Labels?.['panel.https-access']).toBe('loopback-forwarder-v1');
  expect(external.EndpointSpec?.Ports).toHaveLength(1);
  expect(external.EndpointSpec?.Ports?.[0]?.PublishedPort).toBe(80);
  const unsafe=structuredClone(external);unsafe.EndpointSpec!.Ports!.push({Protocol:'tcp',PublishedPort:443,TargetPort:8443,PublishMode:'host'});
  expect(supportsManagedHttps(unsafe)).toBe(false);
  const foreign=structuredClone(baseline);foreign.Labels!['panel.owner']='other';
  expect(()=>planHttpsIngressMigration(foreign,node,{email:'ops@example.com',staging:false})).toThrow();
  const changed=structuredClone(baseline);changed.EndpointSpec!.Ports![0]!.PublishedPort=18080;
  expect(()=>planHttpsIngressMigration(changed,node,{email:'ops@example.com',staging:false})).toThrow();
  expect(()=>planHttpsIngressMigration(target,node,{email:'ops@example.com',staging:false})).toThrow();
});
