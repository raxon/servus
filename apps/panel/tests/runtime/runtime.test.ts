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
    expect(h.probe).toHaveBeenCalledWith('old.localhost');
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
