import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough, Readable, Duplex } from 'node:stream';
import Database from 'better-sqlite3';
import type Docker from 'dockerode';
import { DockerRuntime, OWNER } from '../../src/agent/runtime.js';
import { SecretVault } from '../../src/shared/secrets.js';
import { compileConfiguration, decodeDockerLogs } from '../../src/agent/configuration.js';
import { createAgent } from '../../src/agent/app.js';
import { validateRepository } from '../../src/agent/build.js';
import { ingressStatus } from '../../src/agent/observability.js';
import type { Service } from '../../src/shared/types.js';

const cleanup: (() => unknown | Promise<unknown>)[]=[];
afterEach(async()=>{for(const fn of cleanup.splice(0).reverse())await fn();vi.unstubAllEnvs();});
function fixture() {
  const dataDir=mkdtempSync(join(tmpdir(),'panel-config-'));cleanup.push(()=>rmSync(dataDir,{recursive:true,force:true}));
  const runtime=new DockerRuntime('/unused',18080,'unused',dataDir),client=runtime.docker as any,vault=new SecretVault(dataDir);
  const service:Service={id:randomUUID(),projectId:randomUUID(),name:'web',image:'nginx:alpine',hostname:'app.localhost',port:80,replicas:1,revision:1,deployedRevision:null,state:'pending',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),lastError:null};
  let current:any;
  const volumes=new Map<string,any>(),secrets=new Map<string,any>();
  client.getVolume=vi.fn((name:string)=>({inspect:async()=>{if(!volumes.has(name))throw{statusCode:404};return volumes.get(name);}}));
  client.createVolume=vi.fn(async(config:any)=>{volumes.set(config.Name,config);return config;});
  client.getSecret=vi.fn((name:string)=>({inspect:async()=>{if(!secrets.has(name))throw{statusCode:404};return secrets.get(name);}}));
  client.createSecret=vi.fn(async(config:any)=>{const result={ID:randomUUID(),Spec:config};secrets.set(config.Name,result);return {id:result.ID,inspect:async()=>result};});
  client.getService=vi.fn(()=>({inspect:async()=>{if(!current)throw{statusCode:404};return{Spec:current,Version:{Index:1}};},update:async(spec:any)=>{current=spec;},remove:vi.fn(async()=>{current=undefined;})}));
  client.createService=vi.fn(async(spec:any)=>{current=spec;});
  client.getNetwork=vi.fn(()=>({inspect:async()=>({Labels:{'panel.owner':OWNER}})}));
  client.info=vi.fn(async()=>({Swarm:{NodeID:'local-node'}}));
  client.getImage=vi.fn(()=>({inspect:async()=>({Id:'sha256:local'})}));
  vi.spyOn(runtime,'ensureInfrastructure').mockResolvedValue();vi.spyOn(runtime,'pull').mockResolvedValue(`image@sha256:${'a'.repeat(64)}`);
  vi.spyOn(runtime as any,'waitReady').mockResolvedValue();vi.spyOn(runtime as any,'verifyService').mockResolvedValue();
  vi.spyOn(runtime as any,'waitDestroyed').mockResolvedValue();
  return{runtime,client,vault,service,dataDir,volumes,secrets,current:()=>current};
}

describe('service configuration and protected storage',()=>{
  it('migrates the owned ingress policy so clean exits restart after a daemon reboot',async()=>{
    const f=fixture(),update=vi.fn(async()=>{});
    f.client.info=async()=>({Swarm:{ControlAvailable:true,LocalNodeState:'active'}});
    f.client.getService=()=>({inspect:async()=>({Version:{Index:7},Spec:{Name:'panel-ingress',Labels:{'panel.owner':OWNER},TaskTemplate:{RestartPolicy:{Condition:'on-failure'}}}}),update});
    await DockerRuntime.prototype.ensureInfrastructure.call(f.runtime);
    expect(update).toHaveBeenCalledWith(expect.objectContaining({version:7,TaskTemplate:expect.objectContaining({RestartPolicy:{Condition:'any'}})}));
  });
  it.each(['postgres','redis','mariadb'] as const)('compiles private %s storage, secret references and stop-first updates',async kind=>{
    const f=fixture(),password='database-password-secret';
    Object.assign(f.service,{kind,...(kind==='postgres'?{image:'postgres:17-alpine'}:{}),database:{database:'example',user:'example',passwordSecretRef:f.vault.put(password)},domains:[],resources:{cpu:0.5,memoryMb:384}});
    await f.runtime.apply(f.service,'deploy',randomUUID());
    const spec=f.current();
    expect(spec.Labels['traefik.enable']).toBeUndefined();expect(spec.TaskTemplate.Networks).toHaveLength(1);
    expect(spec.TaskTemplate.Networks[0].Aliases).toContain('web');
    expect(spec.UpdateConfig.Order).toBe('stop-first');expect(spec.TaskTemplate.Placement.Constraints).toEqual(['node.id==local-node']);
    expect(spec.TaskTemplate.RestartPolicy.Condition).toBe('any');
    expect(spec.TaskTemplate.Resources.Limits).toEqual({MemoryBytes:384*1024*1024,NanoCPUs:500000000});
    expect(JSON.stringify(spec)).not.toContain(password);
    expect(spec.TaskTemplate.ContainerSpec.Secrets.length).toBe(kind==='mariadb'||kind==='postgres'?2:1);
    expect(spec.TaskTemplate.ContainerSpec.Secrets.every((secret:any)=>typeof secret.SecretID==='string' && secret.SecretID.length>0)).toBe(true);
    expect(f.volumes.size).toBe(1);
    expect([...f.secrets.values()].some(value=>Buffer.from(value.Spec.Data,'base64').toString()===password)).toBe(true);
    expect((f.runtime as any).verifyService).toHaveBeenCalled();
  });
  it('requires SCRAM for new PostgreSQL services and retains the policy on redeploy',async()=>{
    const f=fixture();Object.assign(f.service,{kind:'postgres',image:'postgres:17-alpine',database:{database:'app',user:'app',passwordSecretRef:f.vault.put('synthetic-password')},domains:[]});
    await f.runtime.apply(f.service,'deploy',randomUUID());
    const first=f.current();
    expect(first.Labels['panel.postgres-auth']).toBe('scram-v1');
    expect(first.TaskTemplate.ContainerSpec.Env).toContain('POSTGRES_INITDB_ARGS=--auth-local=scram-sha-256 --auth-host=scram-sha-256');
    expect(first.TaskTemplate.ContainerSpec.Env).toContain('PGDATA=/var/lib/postgresql/data');
    expect(first.TaskTemplate.ContainerSpec.Command).toEqual(['/bin/sh']);
    expect(first.TaskTemplate.ContainerSpec.Args[1]).toContain('hba_file=/run/secrets/panel-pg-hba');
    const hba=[...f.secrets.values()].map(item=>Buffer.from(item.Spec.Data,'base64').toString()).find(text=>text.includes('host all all 0.0.0.0/0'));
    expect(hba).toBe('local all all scram-sha-256\nhost all all 0.0.0.0/0 scram-sha-256\nhost all all ::/0 scram-sha-256\n');
    expect(JSON.stringify(first)).not.toContain('synthetic-password');
    const volume=[...f.volumes.keys()][0];f.service.deployedRevision=1;f.service.revision=2;
    await f.runtime.apply(f.service,'deploy',randomUUID());
    expect(f.current().Labels['panel.postgres-auth']).toBe('scram-v1');expect([...f.volumes.keys()]).toEqual([volume]);
    expect(f.current().TaskTemplate.ContainerSpec.Secrets.some((item:any)=>item.File.Name==='panel-pg-hba')).toBe(true);
  });
  it('rejects a custom image for a new managed PostgreSQL service',async()=>{
    const f=fixture();Object.assign(f.service,{kind:'postgres',image:'example/custom-postgres:latest',database:{database:'app',user:'app',passwordSecretRef:f.vault.put('synthetic-password')},domains:[]});
    await expect(f.runtime.apply(f.service,'deploy',randomUUID())).rejects.toThrow('managed postgres:17-alpine image');
    expect(f.client.createService).not.toHaveBeenCalled();
  });
  it('refuses a reused volume before changing PostgreSQL runtime',async()=>{
    const f=fixture();Object.assign(f.service,{kind:'postgres',image:'postgres:17-alpine',database:{database:'app',user:'app',passwordSecretRef:f.vault.put('synthetic-password')},domains:[]});
    const name=`panel-data-${f.service.id}-database`;f.volumes.set(name,{Name:name,Labels:{'panel.owner':OWNER,'panel.service':f.service.id}});
    await expect(f.runtime.apply(f.service,'deploy',randomUUID())).rejects.toThrow('data volume already exists');
    expect(f.client.createService).not.toHaveBeenCalled();expect(f.volumes.get(name).Labels['panel.volume-reservation']).toBeUndefined();
  });
  it('refuses a race that returns a different volume after the absence check',async()=>{
    const f=fixture();Object.assign(f.service,{kind:'postgres',image:'postgres:17-alpine',database:{database:'app',user:'app',passwordSecretRef:f.vault.put('synthetic-password')},domains:[]});
    f.client.createVolume=vi.fn(async(config:any)=>{const existing={Name:config.Name,Labels:{'panel.owner':OWNER,'panel.service':f.service.id}};f.volumes.set(config.Name,existing);return existing;});
    await expect(f.runtime.apply(f.service,'deploy',randomUUID())).rejects.toThrow('exclusive PostgreSQL volume creation');
    expect(f.client.createService).not.toHaveBeenCalled();
  });
  it('does not apply new PostgreSQL protection to an existing legacy service',async()=>{
    const f=fixture();Object.assign(f.service,{kind:'postgres',deployedRevision:1,database:{database:'app',user:'app',passwordSecretRef:f.vault.put('synthetic-password')},domains:[]});
    const previous={Labels:{'panel.owner':OWNER,'panel.kind':'postgres'},TaskTemplate:{ContainerSpec:{Image:'legacy:tag',Env:['PGDATA=/legacy/db']}}};
    const update=vi.fn();f.client.getService=vi.fn(()=>({inspect:async()=>({Spec:previous,Version:{Index:1}}),update}));
    vi.spyOn(f.runtime as any,'waitStopped').mockResolvedValue();
    await f.runtime.apply(f.service,'stop',randomUUID());expect(update).toHaveBeenCalled();
  });
  it('recovers an already recorded initial target without recreating its volume',async()=>{
    const f=fixture();Object.assign(f.service,{kind:'postgres',image:'postgres:17-alpine',database:{database:'app',user:'app',passwordSecretRef:f.vault.put('synthetic-password')},domains:[]});
    await f.runtime.apply(f.service,'deploy',randomUUID());const target=structuredClone(f.current());
    const initial={previousRecorded:true,previousSpec:null,targetSpec:target,stage:'applying',previousError:null,recordPrevious:vi.fn(),recordTarget:vi.fn(),beginRollback:vi.fn()} as any;
    f.client.getService=vi.fn(()=>({inspect:async()=>{throw {statusCode:404};}}));
    const created=f.client.createVolume.mock.calls.length;await f.runtime.apply(f.service,'deploy',randomUUID(),initial);
    expect(f.client.createVolume.mock.calls.length).toBe(created);expect(f.client.createService).toHaveBeenCalledTimes(2);
  });
  it.each(['missing','replaced'])('refuses recovery when the saved PostgreSQL volume is %s',async mode=>{
    const f=fixture();Object.assign(f.service,{kind:'postgres',image:'postgres:17-alpine',database:{database:'app',user:'app',passwordSecretRef:f.vault.put('synthetic-password')},domains:[]});
    await f.runtime.apply(f.service,'deploy',randomUUID());const target=structuredClone(f.current());
    const name=`panel-data-${f.service.id}-database`;
    if(mode==='missing')f.volumes.delete(name);else f.volumes.set(name,{Name:name,Labels:{'panel.owner':OWNER,'panel.service':f.service.id,'panel.volume-reservation':'0'.repeat(64)}});
    f.client.getService=vi.fn(()=>({inspect:async()=>{throw {statusCode:404};}}));
    const initial={previousRecorded:true,previousSpec:null,targetSpec:target,stage:'applying',previousError:null,recordPrevious:vi.fn(),recordTarget:vi.fn(),beginRollback:vi.fn()} as any;
    await expect(f.runtime.apply(f.service,'deploy',randomUUID(),initial)).rejects.toThrow(mode==='missing'?'data volume is unavailable':'identity does not match');
    expect(f.client.createService).toHaveBeenCalledTimes(1);
  });
  it.each(['missing','replaced'])('refuses interrupted protected rollback with %s volume',async mode=>{
    const f=fixture();Object.assign(f.service,{kind:'postgres',image:'postgres:17-alpine',database:{database:'app',user:'app',passwordSecretRef:f.vault.put('synthetic-password')},domains:[]});
    await f.runtime.apply(f.service,'deploy',randomUUID());const previous=structuredClone(f.current());
    const name=`panel-data-${f.service.id}-database`;
    if(mode==='missing')f.volumes.delete(name);else f.volumes.set(name,{Name:name,Labels:{'panel.owner':OWNER,'panel.service':f.service.id,'panel.volume-reservation':'0'.repeat(64)}});
    const restore=vi.spyOn(f.runtime as any,'restore').mockResolvedValue();
    const context={previousRecorded:true,previousSpec:previous,targetSpec:previous,stage:'rolling_back',previousError:'interrupted',recordPrevious:vi.fn(),recordTarget:vi.fn(),beginRollback:vi.fn()} as any;
    await expect(f.runtime.apply(f.service,'deploy',randomUUID(),context)).rejects.toThrow(mode==='missing'?'data volume is unavailable':'identity does not match');
    expect(restore).not.toHaveBeenCalled();
  });
  it.each(['missing','replaced'])('refuses error-handler protected rollback if the %s volume changes during apply',async mode=>{
    const f=fixture();Object.assign(f.service,{kind:'postgres',image:'postgres:17-alpine',database:{database:'app',user:'app',passwordSecretRef:f.vault.put('synthetic-password')},domains:[]});
    await f.runtime.apply(f.service,'deploy',randomUUID());const previous=structuredClone(f.current());f.service.deployedRevision=1;
    const name=`panel-data-${f.service.id}-database`;
    vi.mocked((f.runtime as any).waitReady).mockImplementationOnce(async()=>{
      if(mode==='missing')f.volumes.delete(name);else f.volumes.set(name,{Name:name,Labels:{'panel.owner':OWNER,'panel.service':f.service.id,'panel.volume-reservation':'0'.repeat(64)}});
      throw new Error('synthetic failure');
    });
    const restore=vi.spyOn(f.runtime as any,'restore').mockResolvedValue();
    const context={previousRecorded:true,previousSpec:previous,targetSpec:null,stage:'applying',previousError:null,recordPrevious:vi.fn(),recordTarget:vi.fn(),beginRollback:vi.fn()} as any;
    await expect(f.runtime.apply(f.service,'deploy',randomUUID(),context)).rejects.toThrow('Recovery also failed');expect(restore).not.toHaveBeenCalled();
  });
  it.each(['legacy','empty'])('preserves %s rollback without a protected volume',async mode=>{
    const f=fixture();Object.assign(f.service,{kind:'postgres',deployedRevision:1,database:{database:'app',user:'app',passwordSecretRef:f.vault.put('synthetic-password')},domains:[]});
    const previous=mode==='legacy'?{Labels:{'panel.owner':OWNER,'panel.kind':'postgres'},TaskTemplate:{ContainerSpec:{Image:'legacy:tag'}}}:null;
    const restore=vi.spyOn(f.runtime as any,'restore').mockResolvedValue();
    const context={previousRecorded:true,previousSpec:previous,targetSpec:null,stage:'rolling_back',previousError:'interrupted',recordPrevious:vi.fn(),recordTarget:vi.fn(),beginRollback:vi.fn()} as any;
    await expect(f.runtime.apply(f.service,'deploy',randomUUID(),context)).rejects.toThrow('recovered the previous runtime configuration');expect(restore).toHaveBeenCalled();
  });
  it.each(['deploy','start','restart','stop','destroy'])('keeps unlabelled legacy PostgreSQL %s behavior',async action=>{
    const f=fixture();Object.assign(f.service,{kind:'postgres',deployedRevision:1,environment:[{name:'PGDATA',value:'/legacy/db'}],database:{database:'app',user:'app',passwordSecretRef:f.vault.put('synthetic-password')},domains:[]});
    const previous={Labels:{'panel.owner':OWNER,'panel.kind':'postgres'},TaskTemplate:{ContainerSpec:{Image:'legacy:tag',Env:['PGDATA=/legacy/db']}}};
    const update=vi.fn(),remove=vi.fn();f.client.getService=vi.fn(()=>({inspect:async()=>({Spec:previous,Version:{Index:1}}),update,remove}));
    vi.spyOn(f.runtime as any,'waitStopped').mockResolvedValue();
    await f.runtime.apply(f.service,action,randomUUID());
    if(action==='destroy')expect(remove).toHaveBeenCalled();else expect(update).toHaveBeenCalled();
    if(action==='deploy') {const spec=update.mock.calls[0]![0] as any;expect(spec.Labels['panel.postgres-auth']).toBeUndefined();expect(spec.TaskTemplate.ContainerSpec.Secrets).toHaveLength(1);expect(spec.TaskTemplate.ContainerSpec.Env).toContain('PGDATA=/legacy/db');}
  });
  it('keeps legacy rollback behavior without inspecting a protected volume',async()=>{
    const f=fixture();Object.assign(f.service,{kind:'postgres',deployedRevision:1,environment:[{name:'PGDATA',value:'/legacy/db'}],database:{database:'app',user:'app',passwordSecretRef:f.vault.put('synthetic-password')},domains:[]});
    const previous={Labels:{'panel.owner':OWNER,'panel.kind':'postgres'},TaskTemplate:{ContainerSpec:{Image:'legacy:tag',Env:['PGDATA=/legacy/db']}}};
    const restore=vi.spyOn(f.runtime as any,'restore').mockResolvedValue();
    const context={previousRecorded:true,previousSpec:previous,targetSpec:null,stage:'rolling_back',previousError:'interrupted',recordPrevious:vi.fn(),recordTarget:vi.fn(),beginRollback:vi.fn()} as any;
    await expect(f.runtime.apply(f.service,'deploy',randomUUID(),context)).rejects.toThrow('recovered the previous runtime configuration');
    expect(restore).toHaveBeenCalled();expect(f.client.getVolume).not.toHaveBeenCalled();
  });
  it('fails closed after interruption between initial volume creation and target recording',async()=>{
    const f=fixture();Object.assign(f.service,{kind:'postgres',image:'postgres:17-alpine',database:{database:'app',user:'app',passwordSecretRef:f.vault.put('synthetic-password')},domains:[]});
    const operation=randomUUID();
    const context={previousRecorded:false,previousSpec:null,targetSpec:null,stage:'applying',previousError:null,recordPrevious:vi.fn(),recordTarget:vi.fn(()=>{throw new Error('synthetic interruption');}),beginRollback:vi.fn()} as any;
    await expect(f.runtime.apply(f.service,'deploy',operation,context)).rejects.toThrow('synthetic interruption');
    const name=`panel-data-${f.service.id}-database`,volume=structuredClone(f.volumes.get(name));
    expect(volume.Labels['panel.volume-reservation']).toMatch(/^[0-9a-f]{64}$/);expect(f.client.createService).not.toHaveBeenCalled();
    const resumed={...context,previousRecorded:true,previousSpec:null,recordTarget:vi.fn()};
    await expect(f.runtime.apply(f.service,'deploy',operation,resumed)).rejects.toThrow('data volume already exists');
    expect(f.volumes.get(name)).toEqual(volume);expect(f.client.createService).not.toHaveBeenCalled();
  });
  it('rejects multiple replicas on writable storage',async()=>{
    const f=fixture();f.service.mounts=[{type:'volume',name:'uploads',target:'/uploads'}];f.service.replicas=2;
    await expect(f.runtime.apply(f.service,'deploy',randomUUID())).rejects.toThrow('single replica');
    expect(f.client.createService).not.toHaveBeenCalled();
  });
  it('accepts successful authenticated database probes with client warnings',async()=>{
    const f=fixture();vi.spyOn(f.runtime,'containers').mockResolvedValue([{id:'database',name:'database',state:'running'}]);
    const commands:string[][]=[];
    f.client.getContainer=()=>({exec:async(options:any)=>{commands.push(options.Cmd);return{start:async()=>Readable.from([Buffer.from('WARNING: client TLS option\n1\n')]),inspect:async()=>({ExitCode:0})};}});
    await (DockerRuntime.prototype as any).verifyService.call(f.runtime,{Labels:{'panel.kind':'mariadb'}},f.service.id);
    expect(commands[0]![2]).toContain('MYSQL_PWD="$(cat /run/secrets/panel-db-password)"');
    expect(commands[0]![2]).not.toContain('--skip-ssl');
  });
  it('rejects a project network owned by another application',async()=>{
    const f=fixture();f.client.getNetwork=()=>({inspect:async()=>({Labels:{'panel.owner':'another-app'}})});
    await expect(f.runtime.apply(f.service,'deploy',randomUUID())).rejects.toThrow('network ownership');
    expect(f.client.createService).not.toHaveBeenCalled();
  });
  it('generates independent multi-domain target ports and supports private apps',async()=>{
    const f=fixture();f.service.domains=[{hostname:'one.localhost',port:80},{hostname:'two.localhost',port:8080}];
    await f.runtime.apply(f.service,'deploy',randomUUID());
    expect(f.current().TaskTemplate.RestartPolicy.Condition).toBe('any');
    expect(Object.values(f.current().Labels)).toContain('Host(`one.localhost`)');expect(Object.values(f.current().Labels)).toContain('Host(`two.localhost`)');
    expect(Object.entries(f.current().Labels).filter(([key])=>key.endsWith('loadbalancer.server.port')).map(([,value])=>value)).toEqual(['80','8080']);
    f.service.domains=[];f.service.revision=2;
    await f.runtime.apply(f.service,'deploy',randomUUID());
    expect(f.current().Labels['traefik.enable']).toBeUndefined();expect(f.current().TaskTemplate.Networks).toHaveLength(1);
  });
  it('destroys runtime state idempotently while preserving volumes',async()=>{
    const f=fixture();f.service.mounts=[{type:'volume',name:'uploads',target:'/uploads'}];
    await f.runtime.apply(f.service,'deploy',randomUUID());expect(f.volumes.size).toBe(1);
    await f.runtime.apply(f.service,'destroy',randomUUID());expect(f.current()).toBeUndefined();expect(f.volumes.size).toBe(1);
    expect((await f.runtime.apply(f.service,'destroy',randomUUID())).state).toBe('stopped');
  });
  it('waits for owned tasks to stop and stale ingress routes to become 404 before confirming destruction',async()=>{
    const f=fixture();
    const containers=vi.spyOn(f.runtime,'containers').mockResolvedValueOnce([{id:'old',name:'old',state:'running'}]).mockResolvedValue([]);
    const statuses=[200,404],requests:string[]=[];
    f.client.listContainers=vi.fn(async()=>[{Id:'ingress'}]);
    f.client.getContainer=()=>({exec:async()=>({start:async()=>new Duplex({read(){},write(chunk,_encoding,callback){requests.push(chunk.toString());const body=Buffer.from(`HTTP/1.1 ${statuses.shift()} Result\r\n\r\n`),header=Buffer.alloc(8);header[0]=1;header.writeUInt32BE(body.length,4);callback();this.push(Buffer.concat([header,body]));}})})});
    await (DockerRuntime.prototype as any).waitDestroyed.call(f.runtime,f.service.id,['old.localhost']);
    expect(containers).toHaveBeenCalledTimes(3);expect(requests).toHaveLength(2);expect(statuses).toEqual([]);
  });
  it('uses recorded old hosts when resuming destruction after the service was removed',async()=>{
    const f=fixture();f.service.hostname='unpublished.localhost';
    const previous={Labels:{'traefik.http.routers.old.rule':'Host(`deployed.localhost`)'}};
    const context={previousRecorded:true,previousSpec:previous,targetSpec:null,stage:'applying',previousError:null,recordPrevious:vi.fn(),recordTarget:vi.fn(),beginRollback:vi.fn()} as any;
    await f.runtime.apply(f.service,'destroy',randomUUID(),context);
    expect((f.runtime as any).waitDestroyed).toHaveBeenCalledWith(f.service.id,['deployed.localhost']);
    expect(context.recordPrevious).not.toHaveBeenCalled();
  });
  it('encrypts prior and target runtime snapshots containing resolved environment secrets',async()=>{
    const f=fixture(),secret='env-password-sensitive';f.service.environment=[{name:'TOKEN',secret:true,secretRef:f.vault.put(secret)}];
    const config={dataDir:f.dataDir,token:'token',socketPath:'/unused',dockerSocket:'/unused',ingressPort:18080,ingressImage:'unused'};
    const app=await createAgent(config,f.runtime);cleanup.push(()=>app.close());
    const response=await app.inject({method:'POST',url:'/services/apply',headers:{authorization:'Bearer token'},payload:{operationId:randomUUID(),type:'deploy',service:f.service}});
    expect(response.statusCode).toBe(200);expect(f.current().TaskTemplate.ContainerSpec.Env).toContain(`TOKEN=${secret}`);
    const db=new Database(join(f.dataDir,'agent.sqlite'));const row=db.prepare('SELECT previous_spec,target_spec FROM operations').get() as any;db.close();
    expect(row.target_spec.startsWith('enc:v1:')).toBe(true);expect(row.target_spec).not.toContain(secret);
    expect(f.vault.open(row.target_spec)).toContain(secret);expect(response.body).not.toContain(secret);
  });
  it('uses immutable file-content volumes and never requires a host file mount',async()=>{
    const f=fixture(),archive:Buffer[]=[];
    const renames:any[]=[];
    f.client.createContainer=vi.fn(async()=>({start:async()=>{},putArchive:async(data:Buffer)=>archive.push(data),exec:async(options:any)=>{if(options.Cmd[0]==='mv')renames.push(options.Cmd);return {start:async()=>Readable.from([]),inspect:async()=>({ExitCode:options.Cmd[0]==='mv'?0:42})};},remove:async()=>{}}));
    f.service.mounts=[{type:'file',name:'config',target:'/app/config.json',content:'{"value":1}'}];
    const first=await compileConfiguration(f.runtime.docker,f.service,f.vault,f.dataDir);
    f.service.mounts[0]!.content='{"value":2}';const second=await compileConfiguration(f.runtime.docker,f.service,f.vault,f.dataDir);
    expect(first.mounts[0]?.Type).toBe('volume');expect(first.mounts[0]?.ReadOnly).toBe(true);
    expect(first.mounts[0]?.Source).not.toBe(second.mounts[0]?.Source);expect(archive[0]!.includes(Buffer.from('{"value":1}'))).toBe(true);
    expect(archive[0]!.subarray(0,100).toString()).toMatch(/^\.payload-/);
    expect(renames[0]).toEqual(['mv','-f',expect.stringMatching(/^\/target\/\.payload-/),'/target/payload']);
    const before=renames.length;
    const upload=vi.fn(async()=>{});
    const digest=createHash('sha256').update('{"value":2}').digest('hex');
    f.client.createContainer=vi.fn(async()=>({start:async()=>{},putArchive:upload,exec:async()=>({start:async()=>Readable.from([Buffer.from(`${digest}  /target/payload\n`)]),inspect:async()=>({ExitCode:0})}),remove:async()=>{}}));
    await compileConfiguration(f.runtime.docker,f.service,f.vault,f.dataDir);expect(upload).not.toHaveBeenCalled();
    f.client.createContainer=vi.fn(async()=>({start:async()=>{},putArchive:upload,exec:async()=>({start:async()=>Readable.from([Buffer.from('bad-digest  /target/payload\n')]),inspect:async()=>({ExitCode:0})}),remove:async()=>{}}));
    await expect(compileConfiguration(f.runtime.docker,f.service,f.vault,f.dataDir)).rejects.toThrow('does not match');expect(upload).not.toHaveBeenCalled();
    f.client.createContainer=vi.fn(async()=>({start:async()=>{},putArchive:async()=>{throw new Error('interrupted upload');},exec:async()=>({start:async()=>Readable.from([]),inspect:async()=>({ExitCode:42})}),remove:async()=>{}}));
    await expect(compileConfiguration(f.runtime.docker,f.service,f.vault,f.dataDir)).rejects.toThrow('interrupted upload');
    expect(renames.length).toBe(before);
  });
  it('rejects bind traversal and daemon-side symlink escape',async()=>{
    const f=fixture();vi.stubEnv('PANEL_MANAGED_BIND_ROOT','/approved-root');
    f.service.mounts=[{type:'bind',name:'bad',target:'/app',source:'/approved-root/../../etc'}];
    await expect(compileConfiguration(f.runtime.docker,f.service,f.vault,f.dataDir)).rejects.toThrow('approved managed bind');
    f.service.mounts[0]!.source='/approved-root/link';
    f.client.createContainer=vi.fn(async()=>({start:async()=>{},wait:async()=>({StatusCode:0}),logs:async()=>Buffer.from('/etc/passwd\n'),remove:async()=>{}}));
    await expect(compileConfiguration(f.runtime.docker,f.service,f.vault,f.dataDir)).rejects.toThrow('symlink');
    f.service.mounts[0]!.source='/approved-root/safe';
    f.client.createContainer=vi.fn(async()=>({start:async()=>{},wait:async()=>({StatusCode:0}),logs:async()=>Buffer.from('/approved/safe\n'),remove:async()=>{}}));
    const compiled=await compileConfiguration(f.runtime.docker,f.service,f.vault,f.dataDir);
    expect(compiled.mounts[0]?.Source).toBe('/approved-root/safe');
    expect(f.client.createContainer).toHaveBeenCalledWith(expect.objectContaining({Cmd:['/bin/sh','-eu','-c','[ -e "$1" ]; realpath "$1"','panel-bind-probe','/approved/safe']}));
  });
});

describe('runtime observation and console authorization',()=>{
  it('keeps HTTP probe stdin open until a delayed redirect response arrives',async()=>{
    const f=fixture();let request='',closedEarly=false;
    const response=Buffer.from('HTTP/1.1 302 Found\r\nLocation: http://site.localhost/install\r\n\r\n');
    const header=Buffer.alloc(8);header[0]=1;header.writeUInt32BE(response.length,4);const frame=Buffer.concat([header,response]);
    const stream=new Duplex({read(){},write(chunk,_encoding,callback){request+=chunk.toString();callback();setTimeout(()=>{closedEarly=stream.writableEnded;stream.push(frame.subarray(0,5));setTimeout(()=>stream.push(frame.subarray(5)),10);},20);}});
    const start=vi.fn(async()=>stream),execute=vi.fn(async()=>({start}));f.client.getContainer=()=>({exec:execute});
    expect(await ingressStatus(f.runtime.docker,'ingress','site.localhost')).toBe(302);
    expect(closedEarly).toBe(false);expect(stream.destroyed).toBe(true);
    expect(request).toContain('Host: site.localhost\r\n');expect(request).toContain('Connection: close');
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({AttachStdin:true,Cmd:['nc','-w','4','127.0.0.1','8080']}));
    expect(start).toHaveBeenCalledWith({hijack:true,stdin:true});
  });
  it('decodes Docker multiplex frames and redacts secret log values',async()=>{
    const f=fixture(),secret='hidden-log-password';f.vault.put(secret);
    await f.runtime.apply(f.service,'deploy',randomUUID());
    const raw=Buffer.from(`2026-11-13T10:00:00.000Z token=${secret}\n`),header=Buffer.alloc(8);header[0]=1;header.writeUInt32BE(raw.length,4);
    const framed=Buffer.concat([header,raw]);expect(decodeDockerLogs(framed)).toContain(secret);
    f.client.getService=()=>({inspect:async()=>({Spec:f.current()}),logs:async()=>framed});
    expect((await f.runtime.logs(f.service.id,20)).lines).toEqual(['2026-11-13T10:00:00.000Z token=[REDACTED]']);
  });
  it('checks console container ownership before exposing a handle',async()=>{
    const f=fixture();f.client.getContainer=()=>({inspect:async()=>({Config:{Labels:{'panel.owner':OWNER,'panel.service':randomUUID(),'com.docker.swarm.service.name':`panel-app-${f.service.id}`}},State:{Running:true}})});
    await expect(f.runtime.consoleContainer(f.service.id,'a'.repeat(64))).rejects.toThrow('does not belong');
  });
  it('computes real container metrics and handles missing previous CPU counters',async()=>{
    const f=fixture();f.client.listContainers=async()=>[{Id:'a',Names:['/web'],State:'running'}];
    f.client.getContainer=()=>({stats:async()=>({cpu_stats:{cpu_usage:{total_usage:200},system_cpu_usage:2000,online_cpus:2},precpu_stats:{cpu_usage:{total_usage:100},system_cpu_usage:1000},memory_stats:{usage:1000,limit:2000,stats:{inactive_file:100}},networks:{eth0:{rx_bytes:50,tx_bytes:75}}})});
    expect(await f.runtime.metrics(f.service.id)).toEqual({cpuPercent:20,memoryBytes:900,memoryLimitBytes:2000,networkRxBytes:50,networkTxBytes:75,containers:1});
    f.client.getContainer=()=>({stats:async()=>({cpu_stats:{cpu_usage:{total_usage:200},system_cpu_usage:2000},precpu_stats:{},memory_stats:{},networks:{}})});
    expect((await f.runtime.metrics(f.service.id)).cpuPercent).toBe(0);
  });
  it('requires agent authentication and accepts canonical input/resize console packets',async()=>{
    const f=fixture(),stream=new PassThrough(),writes:string[]=[];stream.on('data',()=>{});
    const originalWrite=stream.write.bind(stream);stream.write=((chunk:any,...args:any[])=>{writes.push(String(chunk));return originalWrite(chunk,...args as []);}) as typeof stream.write;
    const resize=vi.fn(async()=>{}),container={exec:async()=>({start:async()=>stream,resize})} as unknown as Docker.Container;
    vi.spyOn(f.runtime,'consoleContainer').mockResolvedValue(container);
    const config={dataDir:f.dataDir,token:'token',socketPath:'/unused',dockerSocket:'/unused',ingressPort:18080,ingressImage:'unused'},app=await createAgent(config,f.runtime);cleanup.push(()=>app.close());
    await app.ready();
    await expect(app.injectWS(`/services/${f.service.id}/console`)).rejects.toThrow();
    const socket=await app.injectWS(`/services/${f.service.id}/console?containerId=${'a'.repeat(64)}`,{headers:{authorization:'Bearer token'}});
    socket.send(JSON.stringify({type:'input',data:'pwd\n'}));socket.send(JSON.stringify({type:'resize',cols:100,rows:40}));
    await new Promise(resolve=>setTimeout(resolve,30));expect(writes).toContain('pwd\n');expect(resize).toHaveBeenCalledWith({w:100,h:40});socket.close();
  });
});

describe('source URL policy',()=>{
  it('allows only explicitly listed HTTP fixture hosts and rejects embedded credentials',async()=>{
    vi.stubEnv('PANEL_GIT_HTTP_HOSTS','127.0.0.1,192.168.5.2');
    expect((await validateRepository('http://127.0.0.1:32180/control.git')).hostname).toBe('127.0.0.1');
    await expect(validateRepository('http://unlisted.test/repository.git')).rejects.toThrow('HTTPS');
    await expect(validateRepository('https://user:password@example.com/repository.git')).rejects.toThrow('credentials');
    await expect(validateRepository('file:///etc/passwd')).rejects.toThrow('HTTPS');
  });
});
