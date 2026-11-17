import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type Docker from 'dockerode';
import { DockerRuntime, OWNER, type RecoveryContext } from '../../src/agent/runtime.js';
import { createAgent } from '../../src/agent/app.js';
import { SecretVault } from '../../src/shared/secrets.js';
import { HttpsMigrationJournal } from '../../src/agent/https-migration-journal.js';
import { migrateManagedHttps } from '../../src/agent/https-migration-run.js';
import * as builds from '../../src/agent/build.js';
import type { Service } from '../../src/shared/types.js';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
function service(): Service {
  return { id: randomUUID(), projectId: randomUUID(), name: 'web', image: 'nginx:alpine', hostname: 'new.localhost', port: 80,
    replicas: 1, revision: 2, deployedRevision: 1, state: 'running', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', lastError: null };
}
function spec(revision = 1, operation = 'old', replicas = 1): Docker.ServiceSpec {
  return { Name: 'test', Labels: { 'panel.owner': OWNER, 'panel.revision': String(revision), 'panel.operation': operation,
    'panel.replicas': String(replicas), 'traefik.http.routers.test.rule': 'Host(`old.localhost`)' },
    Mode: { Replicated: { Replicas: replicas } },
    TaskTemplate: { ForceUpdate: 3, ContainerSpec: { Image: `image-${revision}@sha256:digest`,
      Labels: { 'panel.revision': String(revision), 'panel.operation': operation } } } };
}
function task(target: Docker.ServiceSpec, state = 'running') {
  return { Spec: target.TaskTemplate, Status: { State: state, ContainerStatus: { ContainerID: 'container' } } };
}
function harness(initial: Docker.ServiceSpec | null) {
  const dataDir=mkdtempSync(join(tmpdir(),'panel-runtime-'));cleanup.push(()=>rmSync(dataDir,{recursive:true,force:true}));
  new Database(join(dataDir,'agent.sqlite')).close();
  const runtime = new DockerRuntime('/never-connect', 18080, 'unused', dataDir);
  let current = initial ? structuredClone(initial) : null;
  let updateState: string | undefined;
  const updates: Docker.ServiceSpec[] = [];
  const client = runtime.docker as any;
  client.getService = vi.fn(() => ({
    inspect: vi.fn(async () => {
      if (!current) throw { statusCode: 404 };
      return { Spec: structuredClone(current), Version: { Index: updates.length + 1 }, UpdateStatus: updateState ? { State: updateState } : undefined };
    }),
    update: vi.fn(async (target: Docker.ServiceSpec) => { current = structuredClone(target); updates.push(current); updateState = 'completed'; }),
    remove: vi.fn(async () => { current = null; }),
  }));
  client.createService = vi.fn(async (target: Docker.ServiceSpec) => { current = structuredClone(target); updates.push(current); });
  client.getNetwork = vi.fn(() => ({ inspect: async () => ({ Labels: { 'panel.owner': OWNER } }) }));
  client.listTasks = vi.fn(async () => current && (current.Mode?.Replicated?.Replicas || 0) > 0
    ? Array.from({ length: current.Mode!.Replicated!.Replicas! }, () => task(current!)) : []);
  client.getContainer = vi.fn(() => ({ inspect: async () => ({ State: {} }) }));
  vi.spyOn(runtime, 'ensureInfrastructure').mockResolvedValue();
  vi.spyOn(runtime, 'pull').mockResolvedValue('new-image@sha256:immutable');
  const probe = vi.spyOn(runtime as any, 'probeRoute').mockResolvedValue(undefined);
  return { runtime, client, updates, probe, current: () => current, setCurrent: (value: Docker.ServiceSpec | null) => { current = value; }, setUpdate: (value: string) => { updateState = value; } };
}

it('does not replace an existing route when HTTPS redirect has no deployed HTTPS route',async()=>{
  const h=harness(spec());
  h.client.info=vi.fn(async()=>({Swarm:{NodeID:'a'.repeat(25)}}));
  vi.spyOn(h.runtime as any,'managedHttpsConfigured').mockResolvedValue('direct');
  const value=service();value.domains=[{hostname:'app.example.com',port:80,https:true,redirectHttps:true}];
  await expect(h.runtime.apply(value,'deploy',randomUUID())).rejects.toThrow('Deploy HTTPS for app.example.com');
  expect(h.updates).toHaveLength(0);
});

it('rechecks HTTPS redirect safety when a recorded target was not applied before restart',async()=>{
  const old=spec(),h=harness(old),value=service();
  value.domains=[{hostname:'app.example.com',port:80,https:true,redirectHttps:true}];
  h.client.info=vi.fn(async()=>({Swarm:{NodeID:'a'.repeat(25)}}));
  vi.spyOn(h.runtime as any,'managedHttpsConfigured').mockResolvedValue('direct');
  const recovery:RecoveryContext={previousRecorded:true,previousSpec:old,targetSpec:spec(2,'new'),stage:'applying',previousError:null,recordPrevious:vi.fn(),recordTarget:vi.fn(),beginRollback:vi.fn()};
  await expect(h.runtime.apply(value,'deploy','new',recovery)).rejects.toThrow('Deploy HTTPS for app.example.com');
  expect(h.updates).toHaveLength(0);
});

it('preserves the running application when building a new Git revision fails',async()=>{
  const old=spec(),h=harness(old),value=service();
  value.source={type:'git',repository:'https://github.com/example/app',branch:'main',context:'.',dockerfile:'Dockerfile'};
  const build=vi.spyOn(builds,'buildSource').mockRejectedValue(new Error('Dockerfile build failed'));
  try {
    await expect(h.runtime.apply(value,'deploy',randomUUID())).rejects.toThrow('Dockerfile build failed');
    expect(h.updates).toHaveLength(0);
    expect(h.current()).toEqual(old);
  } finally {build.mockRestore();}
});

it('checks the HTTPS application route instead of its HTTP redirect',async()=>{
  const h=harness(spec()),target=spec();
  target.Labels={...target.Labels,
    'traefik.http.routers.route.rule':'Host(`app.example.com`)',
    'traefik.http.routers.route.middlewares':'route-redirect',
    'traefik.http.middlewares.route-redirect.redirectscheme.scheme':'https',
    'traefik.http.routers.route-https.rule':'Host(`app.example.com`)',
  };
  delete target.Labels['traefik.http.routers.test.rule'];
  await (h.runtime as any).verifyService(target,'service');
  expect(h.probe).toHaveBeenCalledTimes(1);
  expect(h.probe).toHaveBeenCalledWith('app.example.com',true);
});

it('recovers an interrupted ingress migration before accepting requests',async()=>{
  const old: Docker.ServiceSpec={Name:'panel-ingress',TaskTemplate:{ContainerSpec:{Image:'traefik',Args:['--old']}},Mode:{Replicated:{Replicas:1}}};
  const target=structuredClone(old);target.TaskTemplate!.ContainerSpec!.Args=['--new'];
  const h=harness(target),config={dataDir:h.runtime.dataDir,token:'token',socketPath:join(h.runtime.dataDir,'agent.sock'),dockerSocket:'/never-connect',ingressPort:18080,ingressImage:'unused'};
  const initial=await createAgent(config,h.runtime);await initial.close();
  const db=new Database(join(config.dataDir,'agent.sqlite')),vault=new SecretVault(config.dataDir);
  new HttpsMigrationJournal(db,value=>vault.seal(value),value=>vault.open(value)).begin(old,target);db.close();
  let current=target,version=1;
  h.client.getService=()=>({inspect:async()=>({Spec:structuredClone(current),Version:{Index:version},UpdateStatus:{State:'completed'}}),update:async(value:Docker.ServiceSpec & {version:number})=>{const {version:expected,...saved}=value;expect(expected).toBe(version);current=saved;version++;}});
  h.client.listTasks=async()=>[{Spec:current.TaskTemplate,Status:{State:'running',ContainerStatus:{ContainerID:'id'}}}];
  h.client.getContainer=()=>({inspect:async()=>({State:{Running:true}})});
  const app=await createAgent(config,h.runtime);cleanup.push(()=>app.close());
  expect(current).toEqual(old);
  const check=new Database(join(config.dataDir,'agent.sqlite'));
  expect(check.prepare("SELECT COUNT(*) AS count FROM operations WHERE state='running'").get()).toEqual({count:0});check.close();
});

it('checks host port 443 before touching an existing ingress',async()=>{
  const old:Docker.ServiceSpec={Name:'panel-ingress',Labels:{'panel.owner':OWNER},Mode:{Replicated:{Replicas:1}},TaskTemplate:{Placement:{Constraints:['node.role==manager']},ContainerSpec:{Image:'traefik',Args:['--providers.swarm.endpoint=unix:///var/run/docker.sock','--providers.swarm.exposedbydefault=false','--providers.swarm.network=panel-ingress','--entrypoints.web.address=:8080','--api.dashboard=false','--log.level=WARN'],Mounts:[{Type:'bind',Source:'/var/run/docker.sock',Target:'/var/run/docker.sock',ReadOnly:true}]}},EndpointSpec:{Ports:[{Protocol:'tcp',PublishedPort:80,TargetPort:8080,PublishMode:'host'}]}};
  old.TaskTemplate!.Networks=[{Target:'n'.repeat(25)}];
  const h=harness(old);(h.runtime as {ingressPort:number}).ingressPort=80;
  h.client.getNetwork=vi.fn(()=>({inspect:async()=>({Id:'n'.repeat(25),Driver:'overlay',Attachable:true,Labels:{'panel.owner':OWNER}})}));
  const config={dataDir:h.runtime.dataDir,token:'token',socketPath:join(h.runtime.dataDir,'agent.sock'),dockerSocket:'/never-connect',ingressPort:80,ingressImage:'unused'};
  const app=await createAgent(config,h.runtime);await app.close();
  h.runtime.vault.setHttpsIngress('ops@example.com',false);
  h.client.info=vi.fn(async()=>({Swarm:{ControlAvailable:true,NodeID:'a'.repeat(25)}}));
  h.client.getContainer=()=>({inspect:async()=>({State:{Running:true}})});
  const db=new Database(join(config.dataDir,'agent.sqlite')),vault=h.runtime.vault;
  const journal=new HttpsMigrationJournal(db,value=>vault.seal(value),value=>vault.open(value));
  const probe={localAgentImage:async()=>`sha256:${'a'.repeat(64)}`,hostTcpPortAvailable:async()=>false};
  await expect(migrateManagedHttps(h.runtime,journal,()=>{},probe)).rejects.toThrow('Port 443 is already in use');
  expect(h.updates).toHaveLength(0);expect(journal.load()).toBeUndefined();db.close();
});

it('refuses HTTPS deployment when the ingress is not configured, before touching the service',async()=>{
  const h=harness(spec());
  h.client.info=vi.fn().mockResolvedValue({Swarm:{NodeID:'a'.repeat(25)}});
  const saved={...service(),domains:[{hostname:'app.example.com',port:80,https:true}]};
  await expect(h.runtime.apply(saved,'deploy',randomUUID())).rejects.toThrow('Automatic HTTPS ingress is not configured');
  expect(h.updates).toHaveLength(0);
  expect(h.client.createService).not.toHaveBeenCalled();
});

describe('target revision readiness', () => {
  it('does not accept the old running task during an unsettled update', async () => {
    const target = spec(2, 'new'), h = harness(target);
    let inspections = 0;
    h.client.getService = () => ({ inspect: async () => ({ Spec: target, UpdateStatus: { State: ++inspections === 1 ? 'updating' : 'completed' } }) });
    h.client.listTasks = vi.fn(async () => inspections === 1 ? [task(spec(1, 'old'))] : [task(target)]);
    await (h.runtime as any).waitReady('test', target);
    expect(inspections).toBeGreaterThan(1);
    expect(h.client.listTasks).toHaveBeenCalledTimes(2);
  });
  it('matches operation labels even when an old task uses the same image', async () => {
    const target = spec(2, 'new'), old = spec(2, 'old'), h = harness(target);
    h.client.listTasks = vi.fn().mockResolvedValueOnce([task(old)]).mockResolvedValue([task(target)]);
    await (h.runtime as any).waitReady('test', target);
    expect(h.client.listTasks).toHaveBeenCalledTimes(2);
  });
  it('waits until all requested replicas are running', async () => {
    const target = spec(2, 'new', 2), h = harness(target);
    h.client.listTasks = vi.fn().mockResolvedValueOnce([task(target)]).mockResolvedValue([task(target), task(target)]);
    await (h.runtime as any).waitReady('test', target);
    expect(h.client.listTasks).toHaveBeenCalledTimes(2);
  });
  it('rejects an unhealthy matching container', async () => {
    const target = spec(2, 'new'), h = harness(target);
    h.client.getContainer = () => ({ inspect: async () => ({ State: { Health: { Status: 'unhealthy' } } }) });
    await expect((h.runtime as any).waitReady('test', target)).rejects.toThrow('health check failed');
  });
  it('waits for a starting health check before accepting a healthy container', async () => {
    const target = spec(2, 'new'), h = harness(target);
    const inspect = vi.fn().mockResolvedValueOnce({ State: { Health: { Status: 'starting' } } }).mockResolvedValue({ State: { Health: { Status: 'healthy' } } });
    h.client.getContainer = () => ({ inspect });
    await (h.runtime as any).waitReady('test', target);
    expect(inspect).toHaveBeenCalledTimes(2);
  });
});

it('adds HTTPS only for requested domains while preserving application HTTP routes',async()=>{
  const h=harness(null),saved=service(),node='a'.repeat(25);
  saved.domains=[{hostname:'app.example.com',port:3000,https:true},{hostname:'other.example.com',port:8080}];
  h.client.info=vi.fn().mockResolvedValue({Swarm:{NodeID:node}});
  h.client.getVolume=vi.fn().mockReturnValue({inspect:async()=>({Driver:'local',Labels:{'panel.owner':'self-hosted-panel','panel.purpose':'acme'}})});
  const ingress={Labels:{'panel.owner':'self-hosted-panel','panel.https':'servus-acme-v1'},Mode:{Replicated:{Replicas:1}},TaskTemplate:{Placement:{Constraints:[`node.id==${node}`]},ContainerSpec:{Args:['--entrypoints.web.address=:8080','--entrypoints.websecure.address=:8443','--certificatesresolvers.servus.acme.storage=/letsencrypt/acme.json','--certificatesresolvers.servus.acme.httpchallenge.entrypoint=web'],Mounts:[{Type:'volume',Source:'servus-acme',Target:'/letsencrypt',ReadOnly:false}]}},EndpointSpec:{Ports:[{Protocol:'tcp',PublishedPort:443,TargetPort:8443,PublishMode:'host'}]}};
  const original=h.client.getService;
  h.client.getService=(name:string)=>name==='panel-ingress'?{inspect:async()=>({Spec:ingress})}:original(name);
  await h.runtime.apply(saved,'deploy',randomUUID());
  const key=saved.id.replaceAll('-','');const labels=h.current()!.Labels!;
  expect(labels[`traefik.http.routers.${key}-0.rule`]).toBe('Host(`app.example.com`)');
  expect(labels[`traefik.http.routers.${key}-0-https.rule`]).toBe('Host(`app.example.com`)');
  expect(labels[`traefik.http.routers.${key}-0-https.tls.certresolver`]).toBe('servus');
  expect(labels[`traefik.http.routers.${key}-1.rule`]).toBe('Host(`other.example.com`)');
  expect(labels[`traefik.http.routers.${key}-1-https.rule`]).toBeUndefined();
});

it('redeploys a verified immutable local image without rebuilding a moving Git branch',async()=>{
  const h=harness(null),saved=service(),digest='sha256:'+'1'.repeat(64),commit='a'.repeat(40);
  saved.source={type:'git',repository:'https://github.com/example/app.git',branch:'main',context:'.',dockerfile:'Dockerfile'};
  saved.rollbackImage=digest;saved.rollbackCommit=commit;
  h.client.getImage=vi.fn().mockReturnValue({inspect:async()=>({Id:digest})});
  const result=await h.runtime.apply(saved,'deploy',randomUUID());
  expect(result.imageDigest).toBe(digest);expect(result.sourceCommit).toBe(commit);
  expect(h.runtime.pull).not.toHaveBeenCalled();
  expect((h.current()?.TaskTemplate as Docker.ContainerTaskSpec).ContainerSpec?.Image).toBe(digest);
  expect(h.current()?.Labels?.['panel.sourceCommit']).toBe(commit);
});
it('rejects a historical image when its identity does not match',async()=>{
  const h=harness(null),saved=service();saved.rollbackImage='sha256:'+'1'.repeat(64);
  h.client.getImage=vi.fn().mockReturnValue({inspect:async()=>({Id:'sha256:'+'2'.repeat(64)})});
  await expect(h.runtime.apply(saved,'deploy',randomUUID())).rejects.toThrow('historical image cannot be verified');
  expect(h.client.createService).not.toHaveBeenCalled();
});

describe('deployment and lifecycle recovery', () => {
  it.each(['start', 'restart'])('rejects %s when the runtime is absent without deploying unpublished settings', async type => {
    const h = harness(null);
    await expect(h.runtime.apply(service(), type, randomUUID())).rejects.toThrow('No deployed service exists');
    expect(h.client.createService).not.toHaveBeenCalled();
    expect(h.runtime.pull).not.toHaveBeenCalled();
  });
  it('restarts the deployed image, revision, hostname and replica count', async () => {
    const old = spec(1, 'old', 2), h = harness(old), saved = service();
    saved.image = 'unpublished:latest'; saved.hostname = 'unpublished.localhost'; saved.replicas = 5;
    const result = await h.runtime.apply(saved, 'restart', randomUUID());
    expect(result.deployedRevision).toBe(1);
    expect(h.updates).toHaveLength(1);
    const target = h.updates[0]!;
    expect(target.Mode?.Replicated?.Replicas).toBe(2);
    expect((target.TaskTemplate as Docker.ContainerTaskSpec).ContainerSpec?.Image).toBe('image-1@sha256:digest');
    expect(h.probe).toHaveBeenCalledWith('old.localhost',false);
  });
  it('sets task revision identity and requires the requested initial replicas', async () => {
    const h = harness(null), saved = service(); saved.replicas = 2;
    const op = randomUUID();
    const result = await h.runtime.apply(saved, 'deploy', op);
    expect(result.deployedRevision).toBe(2);
    expect(h.current()?.Mode?.Replicated?.Replicas).toBe(2);
    expect((h.current()?.TaskTemplate as Docker.ContainerTaskSpec).ContainerSpec?.Labels).toMatchObject({ 'panel.revision': '2', 'panel.operation': op });
  });
  it('recovers a failed applied operation using the persisted previous spec', async () => {
    const previous = spec(1, 'old'), op = randomUUID(), target = spec(2, op), h = harness(target);
    h.client.getContainer = () => ({ inspect: async () => ({ State: { Health: { Status: h.current()?.Labels?.['panel.revision'] === '2' ? 'unhealthy' : 'healthy' } } }) });
    const recovery: RecoveryContext = { previousRecorded: true, previousSpec: previous, targetSpec: target, stage: 'applying', previousError: null,
      recordPrevious: vi.fn(), recordTarget: vi.fn(), beginRollback: vi.fn() };
    await expect(h.runtime.apply(service(), 'deploy', op, recovery)).rejects.toThrow('restored the previous runtime');
    expect(recovery.recordPrevious).not.toHaveBeenCalled();
    expect(recovery.beginRollback).toHaveBeenCalledWith('The application health check failed.');
    expect(h.current()?.Labels?.['panel.revision']).toBe('1');
    expect(h.updates).toHaveLength(1);
  });
  it('resumes an interrupted rollback rather than applying the failed target again', async () => {
    const previous = spec(1, 'old'), op = randomUUID(), target = spec(2, op), h = harness(target);
    const recovery: RecoveryContext = { previousRecorded: true, previousSpec: previous, targetSpec: target, stage: 'rolling_back', previousError: 'Probe failed',
      recordPrevious: vi.fn(), recordTarget: vi.fn(), beginRollback: vi.fn() };
    await expect(h.runtime.apply(service(), 'deploy', op, recovery)).rejects.toThrow('recovered the previous runtime');
    expect(h.updates).toHaveLength(1);
    expect(h.current()?.Labels?.['panel.revision']).toBe('1');
    expect(h.runtime.pull).not.toHaveBeenCalled();
  });
});

describe('durable agent journal', () => {
  function config() {
    const dataDir = mkdtempSync(join(tmpdir(), 'panel-agent-'));
    cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }));
    return { dataDir, token: 'test-agent-token', socketPath: join(dataDir, 'agent.sock'), dockerSocket: '/never-connect', ingressPort: 18080, ingressImage: 'unused' };
  }
  const result = { state: 'running' as const, deployedRevision: 2, messages: ['verified'] };
  it('persists snapshots before mutation and reloads them after a simulated agent restart', async () => {
    const c = config(), previous = spec(1, 'old'), target = spec(2, 'new'), body = { operationId: randomUUID(), type: 'deploy', service: service() };
    const runtime = { status: async () => ({ online: true }), inspectService: async () => ({ state: 'unknown' as const }),
      apply: vi.fn(async (_s, _t, _o, context?: RecoveryContext) => {
        context!.recordPrevious(previous); context!.recordTarget(target);
        const db = new Database(join(c.dataDir, 'agent.sqlite'));
        const row = db.prepare('SELECT previous_spec,target_spec,previous_recorded FROM operations WHERE id=?').get(body.operationId) as any;
        db.close();
        expect(row.previous_spec.startsWith('enc:v1:')).toBe(true);expect(JSON.parse(new SecretVault(c.dataDir).open(row.previous_spec))).toEqual(previous); expect(JSON.parse(new SecretVault(c.dataDir).open(row.target_spec))).toEqual(target); expect(row.previous_recorded).toBe(1);
        return result;
      }) };
    const app = await createAgent(c, runtime);
    const headers = { authorization: `Bearer ${c.token}` };
    expect((await app.inject({ method: 'POST', url: '/services/apply', headers, payload: body })).statusCode).toBe(200);
    await app.close();
    const db = new Database(join(c.dataDir, 'agent.sqlite'));
    db.prepare("UPDATE operations SET state='running',response=NULL WHERE id=?").run(body.operationId); db.close();
    const resumed = { ...runtime, apply: vi.fn(async (_s, _t, _o, context?: RecoveryContext) => {
      expect(context!.previousRecorded).toBe(true); expect(context!.previousSpec).toEqual(previous); expect(context!.targetSpec).toEqual(target); return result;
    }) };
    const second = await createAgent(c, resumed); cleanup.push(() => second.close());
    expect((await second.inject({ method: 'POST', url: '/services/apply', headers, payload: body })).json()).toEqual(result);
    expect((await second.inject({ method: 'POST', url: '/services/apply', headers, payload: body })).json()).toEqual(result);
    expect(resumed.apply).toHaveBeenCalledTimes(1);
    const status = await second.inject({ url: `/operations/${body.operationId}`, headers });
    expect(status.json()).toEqual({ state: 'succeeded', result });
    expect((await second.inject({ method: 'POST', url: '/services/apply', headers, payload: { ...body, service: { ...body.service, image: 'different:image' } } })).statusCode).toBe(409);
    expect((await second.inject({ url: `/operations/${body.operationId}` })).statusCode).toBe(401);
    expect((await second.inject({ url: '/operations/not-a-uuid', headers })).statusCode).toBe(400);
  });
  it('keeps an uncertain mutation running, blocks another operation, and reconciles the same target', async () => {
    const c = config(), h = harness(spec(1, 'old')), saved = service(), op = randomUUID();
    const getService = h.client.getService;
    let lostConnection = false;
    h.client.getService = (name: string) => {
      const handle = getService(name);
      return { ...handle, update: async (target: Docker.ServiceSpec) => {
        await handle.update(target);
        if (!lostConnection) { lostConnection = true; throw Object.assign(new Error('Connection lost after accepted update'), { code: 'ECONNRESET' }); }
      } };
    };
    const app = await createAgent(c, h.runtime); cleanup.push(() => app.close());
    const body = { operationId: op, type: 'deploy', service: saved }, headers = { authorization: `Bearer ${c.token}` };
    const first = await app.inject({ method: 'POST', url: '/services/apply', headers, payload: body });
    expect(first.statusCode).toBe(503);
    expect((await app.inject({ url: `/operations/${op}`, headers })).json()).toEqual({ state: 'running' });
    expect((await app.inject({ method: 'POST', url: '/services/apply', headers, payload: { ...body, operationId: randomUUID() } })).statusCode).toBe(409);
    const second = await app.inject({ method: 'POST', url: '/services/apply', headers, payload: body });
    expect(second.statusCode).toBe(200); expect(second.json().deployedRevision).toBe(2);
    expect(h.updates).toHaveLength(1);
    expect((await app.inject({ url: `/operations/${op}`, headers })).json().state).toBe('succeeded');
  });
  it('retains interrupted rollback state and finishes recovery before reporting terminal failure', async () => {
    const c = config(), h = harness(spec(1, 'old')), saved = service(), op = randomUUID();
    const getService = h.client.getService;
    let interruptedRollback = false;
    h.client.getService = (name: string) => {
      const handle = getService(name);
      return { ...handle, update: async (target: Docker.ServiceSpec) => {
        await handle.update(target);
        if (target.Labels?.['panel.revision'] === '1' && !interruptedRollback) {
          interruptedRollback = true; throw Object.assign(new Error('Engine unavailable while restoring'), { code: 'ECONNRESET' });
        }
      } };
    };
    h.client.getContainer = () => ({ inspect: async () => ({ State: { Health: { Status: h.current()?.Labels?.['panel.revision'] === '2' ? 'unhealthy' : 'healthy' } } }) });
    const app = await createAgent(c, h.runtime); cleanup.push(() => app.close());
    const body = { operationId: op, type: 'deploy', service: saved }, headers = { authorization: `Bearer ${c.token}` };
    expect((await app.inject({ method: 'POST', url: '/services/apply', headers, payload: body })).statusCode).toBe(503);
    expect((await app.inject({ url: `/operations/${op}`, headers })).json().state).toBe('running');
    const retried = await app.inject({ method: 'POST', url: '/services/apply', headers, payload: body });
    expect(retried.statusCode).toBe(422); expect(retried.json().error.message).toContain('recovered the previous runtime');
    expect(h.current()?.Labels?.['panel.revision']).toBe('1');
    expect(h.updates.filter(target => target.Labels?.['panel.revision'] === '2')).toHaveLength(1);
  });
  it('caches failed results consistently without repeating runtime effects', async () => {
    const c = config(), runtime = { status: async () => ({ online: true }), inspectService: async () => ({ state: 'unknown' as const }), apply: vi.fn(async () => { throw new Error('Engine refused image'); }) };
    const app = await createAgent(c, runtime); cleanup.push(() => app.close());
    const body = { operationId: randomUUID(), type: 'deploy', service: service() }, headers = { authorization: `Bearer ${c.token}` };
    const first = await app.inject({ method: 'POST', url: '/services/apply', headers, payload: body });
    const second = await app.inject({ method: 'POST', url: '/services/apply', headers, payload: body });
    expect(first.statusCode).toBe(422); expect(second.statusCode).toBe(422); expect(second.json()).toEqual(first.json()); expect(runtime.apply).toHaveBeenCalledTimes(1);
    expect((await app.inject({ url: `/operations/${body.operationId}`, headers })).json()).toEqual({ state: 'failed', error: first.json().error });
  });
});
