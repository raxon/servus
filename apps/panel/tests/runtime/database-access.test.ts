import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type Docker from 'dockerode';
import type { Service } from '../../src/shared/types.js';
import { assertDatabaseAccessNode, assertDatabasePortFree, databaseEndpoint, databaseEndpointsMatch, suggestDatabasePort } from '../../src/agent/database-access.js';
import { DockerRuntime, OWNER } from '../../src/agent/runtime.js';

const dirs:string[]=[];
afterEach(()=>{vi.unstubAllEnvs();for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
const service=()=>({id:randomUUID(),projectId:randomUUID(),kind:'postgres',name:'database',databaseAccess:{enabled:true,publishedPort:15432}} as Service);
function dockerFixture() {
  return {listServices:vi.fn(async()=>[]),listContainers:vi.fn(async()=>[])} as unknown as Docker;
}
it.each([['postgres',5432],['mariadb',3306],['redis',6379]] as const)('publishes the native %s port only with explicit opt-in', (kind,port)=>{
  const db={...service(),kind};
  expect(databaseEndpoint({...db,databaseAccess:undefined})).toEqual({Mode:'vip',Ports:[]});
  expect(databaseEndpoint(db)).toEqual({Mode:'vip',Ports:[{Protocol:'tcp',PublishedPort:15432,TargetPort:port,PublishMode:'host'}]});
  expect(()=>databaseEndpoint({...db,databaseAccess:{enabled:true,publishedPort:2377}})).toThrow();
  expect(()=>databaseEndpoint({...db,kind:'app'})).toThrow('managed databases');
});
it('fails closed for Swarm, container, host and ingress conflicts',async()=>{
  const db=service(),docker=dockerFixture(),probe=vi.fn(async()=>true);
  await expect(assertDatabasePortFree(docker,db,undefined,15432,probe)).rejects.toThrow('HTTP ingress');
  vi.mocked(docker.listServices).mockResolvedValue([{Spec:{Name:'foreign',EndpointSpec:{Ports:[{PublishedPort:15432,Protocol:'tcp'}]}}}] as never);
  await expect(assertDatabasePortFree(docker,db,undefined,18080,probe)).rejects.toThrow('another Swarm service');
  vi.mocked(docker.listServices).mockResolvedValue([]);
  vi.mocked(docker.listContainers).mockResolvedValue([{Ports:[{PublicPort:15432,Type:'tcp'}]}] as never);
  await expect(assertDatabasePortFree(docker,db,undefined,18080,probe)).rejects.toThrow('container');
  vi.mocked(docker.listContainers).mockResolvedValue([]);probe.mockResolvedValue(false);
  await expect(assertDatabasePortFree(docker,db,undefined,18080,probe)).rejects.toThrow('host process');
  probe.mockRejectedValue(new Error('Cannot verify host sockets'));
  await expect(assertDatabasePortFree(docker,db,undefined,18080,probe)).rejects.toThrow('Cannot verify');
});
it('retains a verified existing listener and rechecks other services on recovery',async()=>{
  const db=service(),docker=dockerFixture(),probe=vi.fn(async()=>false);
  const previous:Docker.ServiceSpec={Name:`panel-app-${db.id}`,Labels:{'panel.owner':OWNER,'panel.service':db.id},EndpointSpec:databaseEndpoint(db)};
  vi.mocked(docker.listServices).mockResolvedValue([{Spec:previous}] as never);
  vi.mocked(docker.listContainers).mockResolvedValue([{Labels:{'panel.owner':OWNER,'panel.service':db.id,'com.docker.swarm.service.name':previous.Name},Ports:[{PublicPort:15432,Type:'tcp'}]}] as never);
  await expect(assertDatabasePortFree(docker,db,previous,18080,probe)).resolves.toBeUndefined();
  expect(probe).not.toHaveBeenCalled();
  vi.mocked(docker.listServices).mockResolvedValue([{Spec:{...previous,Name:'different',Labels:{'panel.owner':OWNER,'panel.service':randomUUID()}}}] as never);
  await expect(assertDatabasePortFree(docker,db,previous,18080,probe)).rejects.toThrow('another Swarm service');
});
it('checks custom panel ports at the runtime boundary',()=>{
  vi.stubEnv('PANEL_PORT','15432');expect(()=>databaseEndpoint(service())).toThrow('panel API');
});
it('compares published port removal and modes during reconciliation',()=>{
  const expected=databaseEndpoint(service());
  expect(databaseEndpointsMatch(expected,structuredClone(expected))).toBe(true);
  expect(databaseEndpointsMatch(expected,{Ports:[]})).toBe(false);
  expect(databaseEndpointsMatch(expected,{Ports:expected.Ports!.map(port=>({...port,PublishMode:'ingress'}))})).toBe(false);
  expect(databaseEndpointsMatch({Ports:[]},undefined)).toBe(true);
});
it('allows the verified local node and single-node legacy placement while refusing unknown multi-node placement',async()=>{
  const docker={info:vi.fn(async()=>({Swarm:{NodeID:'local-node',Nodes:2}}))} as unknown as Docker;
  const pinned:Docker.ServiceSpec={TaskTemplate:{Placement:{Constraints:['node.id==local-node']}}};
  await expect(assertDatabaseAccessNode(docker,pinned)).resolves.toBeUndefined();
  await expect(assertDatabaseAccessNode(docker,{})).rejects.toThrow('existing database placement was preserved');
  vi.mocked(docker.info).mockResolvedValue({Swarm:{NodeID:'local-node',Nodes:1}} as never);
  await expect(assertDatabaseAccessNode(docker,{})).resolves.toBeUndefined();
  vi.mocked(docker.info).mockResolvedValue({Swarm:{Nodes:1}} as never);
  await expect(assertDatabaseAccessNode(docker,{})).rejects.toThrow('placement on this panel server');
});
it('reports aliases from the owned project network while preserving the long Swarm DNS address',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'database-network-'));dirs.push(dir);
  const runtime=new DockerRuntime('/unused',18080,'unused',dir),db=service();
  const spec:Docker.ServiceSpec={Name:`panel-app-${db.id}`,Labels:{'panel.owner':OWNER,'panel.service':db.id,'panel.project':db.projectId,'panel.kind':'postgres','panel.revision':'2'},TaskTemplate:{Networks:[{Target:'project-network-id',Aliases:['database']},{Target:'foreign-network',Aliases:['unrelated']}]},EndpointSpec:databaseEndpoint(db)};
  const client=runtime.docker as any;
  client.getService=vi.fn(()=>({inspect:async()=>({Spec:spec,Endpoint:{Ports:spec.EndpointSpec!.Ports}})}));
  client.getNetwork=vi.fn(()=>({inspect:async()=>({Id:'project-network-id',Labels:{'panel.owner':OWNER,'panel.project':db.projectId}})}));
  expect(await runtime.databaseNetwork(db.id)).toEqual({aliases:['database'],publishedPort:15432,revision:2});
  expect(spec.Name).toBe(`panel-app-${db.id}`);
  spec.Labels!['panel.service']=randomUUID();
  await expect(runtime.databaseNetwork(db.id)).rejects.toThrow('ownership');
});

it('filters all Docker publications, management ports and ingress before one bounded host probe',async()=>{
  const docker=dockerFixture(),probe=vi.fn(async(_docker:Docker,ports:readonly number[])=>ports[0]??null);
  vi.mocked(docker.listServices).mockResolvedValue([{Spec:{EndpointSpec:{Ports:[{PublishedPort:15432}]}},Endpoint:{Ports:[{Protocol:'tcp',PublishedPort:15433}]}}] as never);
  vi.mocked(docker.listContainers).mockResolvedValue([{Ports:[{PublicPort:15434,Type:'tcp'},{PublicPort:15435,Type:'udp'}]}] as never);
  expect(await suggestDatabasePort(docker,[22,2377,4180,15432,15433,15434,15435,18080],18080,probe)).toBe(15435);
  expect(probe).toHaveBeenCalledExactlyOnceWith(docker,[15435]);
  expect(docker.listServices).toHaveBeenCalledTimes(1);expect(docker.listContainers).toHaveBeenCalledTimes(1);
  probe.mockResolvedValue(null);
  expect(await suggestDatabasePort(docker,[15435],18080,probe)).toBeNull();
  probe.mockRejectedValue(new Error('host unavailable'));
  await expect(suggestDatabasePort(docker,[15435],18080,probe)).rejects.toThrow('host unavailable');
});
