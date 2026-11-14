import Docker from 'dockerode';
import { setTimeout as delay } from 'node:timers/promises';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SecretVault } from '../shared/secrets.js';
import { buildSource } from './build.js';
import { compileConfiguration, databaseKind, stateful, decodeDockerLogs, postgresScramVersion } from './configuration.js';
import { serviceContainers, serviceMetrics, ownedContainer, outputBuffer, execOutput, ingressStatus } from './observability.js';
import type { Service, RuntimeStatus, ServiceLogs, ContainerInfo, ServiceMetrics } from '../shared/types.js';
import type { ApplyResult } from './client.js';

export const OWNER = 'self-hosted-panel';
export const INGRESS_NETWORK = 'panel-ingress';
export const INGRESS_SERVICE = 'panel-ingress';

export interface RecoveryContext {
  previousRecorded: boolean;
  previousSpec: Docker.ServiceSpec | null;
  targetSpec: Docker.ServiceSpec | null;
  stage: 'applying' | 'rolling_back';
  previousError: string | null;
  recordPrevious(spec: Docker.ServiceSpec | null): void;
  recordTarget(spec: Docker.ServiceSpec): void;
  beginRollback(error: string): void;
}

interface RuntimeTask { Spec?: { ContainerSpec?: Docker.ContainerSpec }; Status?: { State?: string; Err?: string; Message?: string; ContainerStatus?: { ContainerID?: string } } }

type ServiceInspection = { Spec: Docker.ServiceSpec; Version: { Index: number }; UpdateStatus?: { State?: string } };

function assertSafePostgresDataPath(service: Service, ...specs: (Docker.ServiceSpec | null | undefined)[]): void {
  const customConfig=service.kind==='postgres' && service.environment?.some(item=>item.name==='PGDATA');
  const customRuntime=specs.some(spec=>spec && (service.kind==='postgres'||spec.Labels?.['panel.kind']==='postgres') && containerSpec(spec)?.Env?.some(entry=>entry.startsWith('PGDATA=') && !(spec.Labels?.['panel.postgres-auth']===postgresScramVersion && entry==='PGDATA=/var/lib/postgresql/data')));
  if(customConfig||customRuntime)throw new Error('This PostgreSQL service uses a custom PGDATA path. Preserve its running container and arrange a backup and explicit storage migration before changing its runtime.');
}

function assertPostgresMountsUnchanged(previous: Docker.ServiceSpec, target: Docker.ServiceSpec): void {
  const mounts=(spec:Docker.ServiceSpec)=>JSON.stringify((containerSpec(spec)?.Mounts??[]).map(mount=>({type:mount.Type,source:mount.Source,target:mount.Target,readOnly:!!mount.ReadOnly,subpath:mount.VolumeOptions?.Subpath??null})).sort((a,b)=>String(a.target).localeCompare(String(b.target))));
  if(mounts(previous)!==mounts(target))throw new Error('PostgreSQL runtime mounts differ from the requested configuration. Back up the database and use an explicit storage migration.');
}

function assertPostgresImageUnchanged(previous: Docker.ServiceSpec, target: Docker.ServiceSpec): void {
  const current=containerSpec(previous)?.Image, requested=containerSpec(target)?.Image;
  if(!current||!requested||!/(?:^|@)sha256:[a-f0-9]{64}$/.test(current)||current!==requested)throw new Error('PostgreSQL runtime image differs from the requested image or is not pinned. Back up the database and use an explicit upgrade procedure.');
}

function assertPostgresImageReference(service: Service, spec: Docker.ServiceSpec): void {
  const reference=spec.Labels?.['panel.image-reference']??containerSpec(spec)?.Image;
  if(!reference||service.image!==reference)throw new Error('The saved PostgreSQL image reference cannot be verified against the running service. Recover its original configuration or perform an explicit migration.');
}

export class DockerRuntime {
  readonly docker: Docker;
  readonly vault: SecretVault;
  constructor(readonly socketPath: string, readonly ingressPort: number, readonly ingressImage: string, readonly dataDir = resolve(process.env.PANEL_DATA_DIR || '.data')) {
    this.docker = new Docker({ socketPath });
    this.vault = new SecretVault(dataDir);
  }

  async status(): Promise<RuntimeStatus> {
    try {
      const info = await this.docker.info();
      return { online: true, engineVersion: info.ServerVersion, cpus: info.NCPU, memoryBytes: info.MemTotal,
        swarmState: info.Swarm?.LocalNodeState, ingressPort: this.ingressPort };
    } catch { return { online: false, error: 'Docker Engine is unavailable.', ingressPort: this.ingressPort }; }
  }

  async ensureInfrastructure(): Promise<void> {
    const info = await this.docker.info();
    if (info.Swarm?.LocalNodeState === 'inactive') await this.docker.swarmInit({ AdvertiseAddr: '127.0.0.1', ListenAddr: '0.0.0.0:2377' });
    else if (!info.Swarm?.ControlAvailable) throw new Error('The Docker daemon must be a Swarm manager.');
    try {
      const network = await this.docker.getNetwork(INGRESS_NETWORK).inspect();
      if (network.Labels?.['panel.owner'] !== OWNER) throw new Error('Ingress network ownership check failed.');
    }
    catch (error) {
      if (!isNotFound(error)) throw error;
      await this.docker.createNetwork({ Name: INGRESS_NETWORK, Driver: 'overlay', Attachable: true, Labels: { 'panel.owner': OWNER } });
    }
    let existing;
    try { existing = await this.docker.getService(INGRESS_SERVICE).inspect(); }
    catch (error) { if (!isNotFound(error)) throw error; }
    if (existing) {
      if (existing.Spec.Labels?.['panel.owner'] !== OWNER) throw new Error('Ingress name belongs to another service.');
      if (existing.Spec.TaskTemplate?.RestartPolicy?.Condition !== 'any') {
        await this.docker.getService(INGRESS_SERVICE).update({ ...existing.Spec, version: existing.Version.Index,
          TaskTemplate: { ...existing.Spec.TaskTemplate, RestartPolicy: { ...existing.Spec.TaskTemplate?.RestartPolicy, Condition: 'any' } } });
      }
      return;
    }
    await this.pull(this.ingressImage);
    await this.docker.createService({ Name: INGRESS_SERVICE, Labels: { 'panel.owner': OWNER },
      TaskTemplate: { ContainerSpec: { Image: this.ingressImage,
        Args: ['--providers.swarm.endpoint=unix:///var/run/docker.sock', '--providers.swarm.exposedbydefault=false',
          `--providers.swarm.network=${INGRESS_NETWORK}`, '--entrypoints.web.address=:8080', '--api.dashboard=false', '--log.level=WARN'],
        Mounts: [{ Type: 'bind', Source: '/var/run/docker.sock', Target: '/var/run/docker.sock', ReadOnly: true }] },
        Networks: [{ Target: INGRESS_NETWORK }], Placement: { Constraints: ['node.role==manager'] }, RestartPolicy: { Condition: 'any' } },
      Mode: { Replicated: { Replicas: 1 } },
      EndpointSpec: { Ports: [{ Protocol: 'tcp', PublishedPort: this.ingressPort, TargetPort: 8080, PublishMode: 'host' }] } });
  }

  async pull(image: string): Promise<string> {
    if (process.env.PANEL_ALLOW_LOCAL_IMAGES === '1') {
      try { const existing = await this.docker.getImage(image).inspect(); return existing.RepoDigests?.[0] || existing.Id; }
      catch (error) { if (!isNotFound(error)) throw error; }
    }
    const stream = await this.docker.pull(image);
    await new Promise<void>((resolve, reject) => this.docker.modem.followProgress(stream, error => error ? reject(error) : resolve()));
    const details = await this.docker.getImage(image).inspect();
    return details.RepoDigests?.[0] || image;
  }

  private async verifyProtectedPostgresVolume(serviceId: string, spec: Docker.ServiceSpec | null | undefined): Promise<void> {
    if(!spec || spec.Labels?.['panel.postgres-auth']!==postgresScramVersion)return;
    const reservation=spec.Labels['panel.volume-reservation'];
    const mounts=containerSpec(spec)?.Mounts??[];
    const expected=`panel-data-${serviceId}-database`;
    if(!reservation || !/^[a-f0-9]{64}$/.test(reservation) || mounts.length!==1 || mounts[0]?.Type!=='volume' || mounts[0]?.Source!==expected || mounts[0]?.Target!=='/var/lib/postgresql/data' || mounts[0]?.ReadOnly)throw new Error('The protected PostgreSQL volume configuration cannot be verified.');
    let inspected;
    try {inspected=await this.docker.getVolume(expected).inspect();}
    catch {throw new Error('The protected PostgreSQL data volume is unavailable.');}
    if(inspected.Labels?.['panel.owner']!==OWNER || inspected.Labels?.['panel.service']!==serviceId || inspected.Labels?.['panel.volume-reservation']!==reservation)throw new Error('The protected PostgreSQL data volume identity does not match.');
  }

  async apply(service: Service, type: string, operationId: string, recovery?: RecoveryContext): Promise<ApplyResult> {
    const name = `panel-app-${service.id}`;
    if (type === 'destroy') {
      const existing = await this.inspect(name);
      const previousSpec = recovery?.previousRecorded ? recovery.previousSpec : existing?.Spec ?? null;
      if([existing?.Spec,previousSpec,recovery?.targetSpec].some(spec=>spec?.Labels?.['panel.postgres-auth']===postgresScramVersion))assertSafePostgresDataPath(service,existing?.Spec,previousSpec,recovery?.targetSpec);
      if (existing) {
        if (existing.Spec.Labels?.['panel.owner'] !== OWNER) throw new Error('Service ownership check failed.');
        if (!recovery?.previousRecorded) recovery?.recordPrevious(existing.Spec);
        await this.docker.getService(name).remove();
      }
      const hostnames = previousSpec ? routeHostnames(previousSpec) : databaseKind(service) ? [] : (service.domains ?? [{ hostname: service.hostname }]).map(domain => domain.hostname);
      await this.waitDestroyed(service.id, hostnames);
      return { state: 'stopped', deployedRevision: service.deployedRevision || service.revision, messages: ['Runtime service and routes removed. Persistent volumes were preserved.'] };
    }
    await this.ensureInfrastructure();
    const messages: string[] = [];
    const existing = await this.inspect(name);
    if (existing && existing.Spec.Labels?.['panel.owner'] !== OWNER) throw new Error('Service ownership check failed.');
    if (!existing && type !== 'deploy') throw new Error('No deployed service exists. Deploy the saved configuration before starting or restarting it.');
    const previousSpec = recovery?.previousRecorded ? recovery.previousSpec : existing?.Spec ?? null;
    if([existing?.Spec,previousSpec,recovery?.targetSpec].some(spec=>spec?.Labels?.['panel.postgres-auth']===postgresScramVersion))assertSafePostgresDataPath(service,existing?.Spec,previousSpec,recovery?.targetSpec);
    if (!recovery?.previousRecorded) recovery?.recordPrevious(previousSpec ? structuredClone(previousSpec) : null);
    if (recovery?.stage === 'rolling_back') {
      await this.verifyProtectedPostgresVolume(service.id, previousSpec);
      await this.restore(name, previousSpec, operationId);
      throw new Error(`Deployment failed; recovered the previous runtime configuration. ${recovery.previousError || 'Interrupted rollback.'}`);
    }

    let spec = recovery?.targetSpec;
    let imageDigest = spec ? containerSpec(spec)?.Image : undefined;
    let sourceCommit = spec?.Labels?.['panel.sourceCommit'];
    if (!spec) {
      if (type === 'deploy') {
        if(service.kind==='postgres'&&!previousSpec&&service.deployedRevision===null&&(service.image!=='postgres:17-alpine'||service.source?.type==='git'))throw new Error('New PostgreSQL services require the managed postgres:17-alpine image.');
        if (service.kind==='postgres'&&previousSpec?.Labels?.['panel.postgres-auth']===postgresScramVersion) {
          imageDigest=containerSpec(previousSpec)?.Image;
          if(!imageDigest||!/(?:^|@)sha256:[a-f0-9]{64}$/.test(imageDigest))throw new Error('The previous PostgreSQL image is not pinned. Back up the database and use an explicit upgrade procedure.');
          assertPostgresImageReference(service,previousSpec);
        } else if (service.source?.type === 'git') {
          const built = await buildSource(service, operationId, this.dataDir, this.socketPath, this.vault);
          const image = await this.docker.getImage(built.image).inspect();
          imageDigest = image.RepoDigests?.[0] || image.Id; sourceCommit = built.sourceCommit;
        } else imageDigest = await this.pull(service.image);
        messages.push(`Resolved image: ${imageDigest}`);
        const projectNetwork = `panel-project-${service.projectId}`;
        try {
          const network = await this.docker.getNetwork(projectNetwork).inspect();
          if (network.Labels?.['panel.owner'] !== OWNER || network.Labels?.['panel.project'] && network.Labels['panel.project'] !== service.projectId) throw new Error('Project network ownership check failed.');
        }
        catch (error) {
          if (!isNotFound(error)) throw error;
          await this.docker.createNetwork({ Name: projectNetwork, Driver: 'overlay', Attachable: true, Labels: { 'panel.owner': OWNER, 'panel.project': service.projectId } });
        }
        const previousPostgresAuth=previousSpec?.Labels?.['panel.postgres-auth'];
        if(service.kind==='postgres' && previousPostgresAuth!==undefined && previousPostgresAuth!==postgresScramVersion)throw new Error('Unsupported PostgreSQL authentication policy. Update the agent before redeploying.');
        const freshPostgres=service.kind==='postgres' && !previousSpec && service.deployedRevision===null;
        const postgresScram=service.kind==='postgres' && (previousPostgresAuth===postgresScramVersion || freshPostgres);
        const configuration = await compileConfiguration(this.docker, service, this.vault, this.dataDir, {postgresScram,freshPostgres});
        const key = service.id.replaceAll('-', '');
        const labels: Record<string, string> = { 'panel.owner': OWNER, 'panel.project': service.projectId, 'panel.service': service.id,
          'panel.revision': String(service.revision), 'panel.operation': operationId, 'panel.replicas': String(service.replicas), 'panel.kind': service.kind || 'app' };
        if(postgresScram)labels['panel.image-reference']=service.image;
        if (sourceCommit) labels['panel.sourceCommit'] = sourceCommit;
        if (postgresScram) {
          labels['panel.postgres-auth'] = postgresScramVersion;
          const reservation = configuration.postgresReservation ?? previousSpec?.Labels?.['panel.volume-reservation'];
          if(!reservation || !/^[a-f0-9]{64}$/.test(reservation))throw new Error('PostgreSQL volume reservation is unavailable.');
          labels['panel.volume-reservation'] = reservation;
        }
        const domains = databaseKind(service) ? [] : service.domains ?? [{ hostname: service.hostname, port: service.port }];
        domains.forEach((domain, index) => {
          const route = `${key}-${index}`;
          Object.assign(labels, { 'traefik.enable': 'true', [`traefik.http.routers.${route}.rule`]: `Host(\`${domain.hostname}\`)`,
            [`traefik.http.routers.${route}.entrypoints`]: 'web', [`traefik.http.routers.${route}.service`]: route,
            [`traefik.http.services.${route}.loadbalancer.server.port`]: String(domain.port) });
        });
        const limits = service.resources || { cpu: 1, memoryMb: 256 };
        let placement;
        if (stateful(service)) {
          const node = (await this.docker.info()).Swarm?.NodeID;
          if (!node) throw new Error('Stateful services require a known local manager node.');
          placement = existing?.Spec.TaskTemplate?.Placement || { Constraints: [`node.id==${node}`] };
        }
        spec = {
          Name: name, Labels: labels, Mode: { Replicated: { Replicas: service.replicas } },
          TaskTemplate: { ContainerSpec: { Image: imageDigest, Init: true, Env: configuration.environment, Mounts: configuration.mounts,
              Secrets: configuration.secrets, ...(configuration.command ? { Command: configuration.command, Args: configuration.args } : {}),
              Labels: { 'panel.owner': OWNER, 'panel.service': service.id, 'panel.revision': String(service.revision), 'panel.operation': operationId } },
            Networks: [{ Target: projectNetwork, Aliases: [service.name] }, ...(!databaseKind(service) && domains.length ? [{ Target: INGRESS_NETWORK }] : [])],
            ...(placement ? { Placement: placement } : {}), RestartPolicy: { Condition: 'any', MaxAttempts: 3 },
            Resources: { Limits: { MemoryBytes: limits.memoryMb * 1024 * 1024, NanoCPUs: Math.round(limits.cpu * 1e9) } } },
          UpdateConfig: { Parallelism: 1, Order: stateful(service) ? 'stop-first' : 'start-first', FailureAction: 'rollback', Monitor: 15000000000 },
          RollbackConfig: { Parallelism: 1, Order: 'stop-first' },
        };
      } else {
        spec = structuredClone(existing!.Spec);
        const replicas = type === 'stop' ? 0 : Number(spec.Labels?.['panel.replicas'] || spec.Mode?.Replicated?.Replicas || 1);
        spec.Mode = { Replicated: { Replicas: replicas } };
        spec.Labels = { ...spec.Labels, 'panel.operation': operationId };
        if (type !== 'stop') {
          spec.TaskTemplate = { ...spec.TaskTemplate, ForceUpdate: (spec.TaskTemplate?.ForceUpdate || 0) + 1,
            ContainerSpec: { ...containerSpec(spec), Labels: { ...containerSpec(spec)?.Labels,
              'panel.revision': spec.Labels['panel.revision'] || String(service.deployedRevision), 'panel.operation': operationId } } };
        }
      }
      recovery?.recordTarget(structuredClone(spec));
    }

    if(type==='deploy'&&service.kind==='postgres'&&[spec,previousSpec,existing?.Spec].some(item=>item?.Labels?.['panel.postgres-auth']===postgresScramVersion)) {
      assertPostgresImageReference(service,spec);
      if(previousSpec)assertPostgresImageReference(service,previousSpec);
      if(existing?.Spec)assertPostgresImageReference(service,existing.Spec);
      if(!/(?:^|@)sha256:[a-f0-9]{64}$/.test(containerSpec(spec)?.Image??''))throw new Error('PostgreSQL deployment requires an immutable image digest.');
      if(previousSpec) {assertPostgresMountsUnchanged(previousSpec,spec);assertPostgresImageUnchanged(previousSpec,spec);}
      if(existing?.Spec&&existing.Spec!==previousSpec) {assertPostgresMountsUnchanged(existing.Spec,spec);assertPostgresImageUnchanged(existing.Spec,spec);}
    }
    if(type!=='stop' && service.kind==='postgres' && spec.Labels?.['panel.postgres-auth']===postgresScramVersion) {
      const reservation=spec.Labels['panel.volume-reservation'];
      for(const prior of [previousSpec,existing?.Spec])if(prior?.Labels?.['panel.postgres-auth']===postgresScramVersion && prior.Labels['panel.volume-reservation']!==reservation)throw new Error('PostgreSQL volume reservation changed.');
      await this.verifyProtectedPostgresVolume(service.id, spec);
    }
    try {
      if (existing?.Spec.Labels?.['panel.operation'] === operationId) messages.push('Recovered a previously applied operation; inspecting its target tasks.');
      else if (existing) await this.docker.getService(name).update({ ...spec, version: existing.Version.Index });
      else await this.docker.createService(spec);
      messages.push(`Applied ${type}; waiting for the target runtime state.`);
      if (type === 'stop') await this.waitStopped(name);
      else {
        await this.waitReady(name, spec);
        await this.verifyService(spec, service.id);
      }
    } catch (error) {
      if (isUncertainRuntimeError(error)) throw error;
      const failure = message(error);
      recovery?.beginRollback(failure);
      try { await this.verifyProtectedPostgresVolume(service.id, previousSpec); await this.restore(name, previousSpec, operationId); }
      catch (rollbackError) {
        if (isUncertainRuntimeError(rollbackError)) throw rollbackError;
        throw new Error(`Operation failed: ${failure}. Recovery also failed: ${message(rollbackError)}`);
      }
      throw new Error(`Operation failed; restored the previous runtime configuration. ${failure}`);
    }
    const deployedRevision = Number(spec.Labels?.['panel.revision'] || service.deployedRevision || service.revision);
    messages.push(type === 'stop' ? 'All application tasks stopped. Configuration retained.' : databaseKind(service) ? 'Authenticated database readiness verified.' : routeHostnames(spec).length ? 'All configured HTTP routes verified.' : 'Private application tasks verified.');
    return { state: type === 'stop' ? 'stopped' : 'running', deployedRevision, imageDigest, sourceCommit: sourceCommit || null, messages };
  }

  async containers(id: string): Promise<ContainerInfo[]> { return serviceContainers(this.docker, id); }
  async metrics(id: string): Promise<ServiceMetrics> { return serviceMetrics(this.docker, id); }
  async consoleContainer(id: string, containerId?: string) {
    const chosen = containerId || (await this.containers(id)).find(container => container.state === 'running')?.id;
    if (!chosen) throw new Error('No running container is available.');
    const inspected = await ownedContainer(this.docker, id, chosen);
    if (!inspected.State.Running) throw new Error('The selected container is not running.');
    return this.docker.getContainer(chosen);
  }
  async logs(id: string, tail = 100, since?: string): Promise<ServiceLogs> {
    const lines: string[] = [];
    const directory = join(this.dataDir, 'build-logs', id);
    if (existsSync(directory)) {
      const files = readdirSync(directory).filter(file => file.endsWith('.log')).map(file => join(directory, file)).sort((a,b) => statSync(b).mtimeMs - statSync(a).mtimeMs).slice(0, 2).reverse();
      for (const file of files) lines.push(...readFileSync(file, 'utf8').split('\n').filter(Boolean));
    }
    const existing = await this.inspect(`panel-app-${id}`);
    if (existing) {
      if (existing.Spec.Labels?.['panel.owner'] !== OWNER) throw new Error('Service ownership check failed.');
      const timestamp = since ? Math.floor(Date.parse(since) / 1000) : 0;
      const output = await this.docker.getService(`panel-app-${id}`).logs({ stdout: true, stderr: true, timestamps: true, tail, since: timestamp });
      const runtimeLines = decodeDockerLogs(await outputBuffer(output)).split('\n').filter(Boolean);
      runtimeLines.sort((left, right) => (Date.parse(left.split(' ')[0]!) || 0) - (Date.parse(right.split(' ')[0]!) || 0));
      lines.push(...runtimeLines);
    }
    return { lines: this.vault.redact(lines.filter(line => !since || !/^\d{4}-/.test(line) || Date.parse(line.slice(0, 30).split(' ')[0]!) >= Date.parse(since)).slice(-tail).join('\n')).split('\n').filter(Boolean) };
  }
  private async verifyService(spec: Docker.ServiceSpec, serviceId: string): Promise<void> {
    const kind = spec.Labels?.['panel.kind'];
    if (kind && ['postgres', 'mariadb', 'redis'].includes(kind)) {
      for (let attempt = 0; attempt < 60; attempt++) {
        const container = (await this.containers(serviceId)).find(item => item.state === 'running');
        if (container) {
          const command = kind === 'postgres'
            ? 'PGCONNECT_TIMEOUT=3 PGPASSWORD="$(cat /run/secrets/panel-db-password)" exec psql --host=127.0.0.1 --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --no-password --tuples-only --command="SELECT 1"'
            : kind === 'mariadb'
              ? 'MYSQL_PWD="$(cat /run/secrets/panel-db-password)" exec mariadb --connect-timeout=3 --protocol=TCP --host=127.0.0.1 --user="$MARIADB_USER" --database="$MARIADB_DATABASE" --batch --skip-column-names --execute="SELECT 1"'
              : 'REDISCLI_AUTH="$(cat /run/secrets/panel-db-password)" exec redis-cli --no-auth-warning -h 127.0.0.1 ping';
          try {
            const result = await execOutput(this.docker, container.id, ['/bin/sh', '-c', command]);
            if (result.code === 0 && result.output.split('\n').some(line => line.trim() === (kind === 'redis' ? 'PONG' : '1'))) return;
          } catch (error) { if (isUncertainRuntimeError(error)) throw error; }
        }
        await delay(1000);
      }
      throw new Error('Database authentication/readiness could not be verified.');
    }
    for (const hostname of routeHostnames(spec)) await this.probeRoute(hostname);
  }

  private async inspect(name: string): Promise<ServiceInspection | undefined> {
    try { return await this.docker.getService(name).inspect(); }
    catch (error) { if (isNotFound(error)) return undefined; throw error; }
  }

  private async restore(name: string, previous: Docker.ServiceSpec | null, operationId: string): Promise<void> {
    const current = await this.inspect(name);
    if (current && current.Spec.Labels?.['panel.owner'] !== OWNER) throw new Error('Recovery ownership check failed.');
    if (!previous) {
      if (current && current.Spec.Labels?.['panel.operation'] === operationId) await this.docker.getService(name).remove();
      return;
    }
    if (current) await this.docker.getService(name).update({ ...previous, version: current.Version.Index });
    else await this.docker.createService(previous);
    if ((previous.Mode?.Replicated?.Replicas || 0) === 0) await this.waitStopped(name);
    else {
      await this.waitReady(name, previous, true);
      await this.verifyService(previous, previous.Labels?.['panel.service'] || name.replace('panel-app-', ''));
    }
  }

  async inspectService(id: string): Promise<{ state: 'running' | 'stopped' | 'failed' | 'unknown'; deployedRevision?: number }> {
    try {
      const name = `panel-app-${id}`;
      const spec = await this.docker.getService(name).inspect();
      if (spec.Spec.Labels?.['panel.owner'] !== OWNER) return { state: 'unknown' };
      const replicas = spec.Spec.Mode?.Replicated?.Replicas || 0;
      const tasks = await this.docker.listTasks({ filters: { service: [name], 'desired-state': ['running'] } });
      const matching = tasks.filter(task => matchesTask(task, spec.Spec));
      const ready = await this.healthyTasks(matching.filter(task => task.Status?.State === 'running'));
      return { state: replicas === 0 ? 'stopped' : ready && matching.filter(task => task.Status?.State === 'running').length >= replicas ? 'running' : 'failed',
        deployedRevision: Number(spec.Spec.Labels?.['panel.revision']) || undefined };
    } catch { return { state: 'unknown' }; }
  }

  private async healthyTasks(tasks: RuntimeTask[]): Promise<boolean> {
    for (const task of tasks) {
      const id = task.Status?.ContainerStatus?.ContainerID;
      if (!id) return false;
      try {
        const container = await this.docker.getContainer(id).inspect();
        const health = container.State.Health?.Status;
        if (health === 'unhealthy') throw new Error('The application health check failed.');
        if (health && health !== 'healthy') return false;
      } catch (error) { if (isUncertainRuntimeError(error) || message(error) === 'The application health check failed.') throw error; return false; }
    }
    return true;
  }

  private async waitReady(name: string, expected: Docker.ServiceSpec, allowRollbackCompleted = false): Promise<void> {
    const replicas = expected.Mode?.Replicated?.Replicas || 0;
    if (replicas === 0) return this.waitStopped(name);
    for (let attempt = 0; attempt < 60; attempt++) {
      const spec = await this.docker.getService(name).inspect();
      const state = spec.UpdateStatus?.State;
      const failedUpdate = state === 'paused' || state === 'rollback_paused' || (!allowRollbackCompleted && ['rollback_started', 'rollback_completed'].includes(state || ''));
      if (failedUpdate) throw new Error(`Runtime update ${state}.`);
      const settled = !state || state === 'completed' || (allowRollbackCompleted && state === 'rollback_completed');
      const tasks = (await this.docker.listTasks({ filters: { service: [name], 'desired-state': ['running'] } })).filter(task => matchesTask(task, expected));
      const failed = tasks.find(task => ['rejected', 'failed'].includes(task.Status?.State || ''));
      if (failed) throw new Error(failed.Status?.Err || failed.Status?.Message || 'Container task failed.');
      const running = tasks.filter(task => task.Status?.State === 'running');
      if (settled && running.length >= replicas && await this.healthyTasks(running)) return;
      await delay(1000);
    }
    throw new Error('Timed out waiting for target application tasks.');
  }

  private async waitStopped(name: string): Promise<void> {
    for (let attempt = 0; attempt < 30; attempt++) {
      const tasks = await this.docker.listTasks({ filters: { service: [name] } });
      if (!tasks.some(task => ['running', 'starting', 'preparing'].includes(task.Status?.State || ''))) return;
      await delay(500);
    }
    throw new Error('Timed out stopping application tasks.');
  }

  private async probeRoute(hostname: string): Promise<void> {
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        const containers = await this.docker.listContainers({ filters: { label: [`com.docker.swarm.service.name=${INGRESS_SERVICE}`] } });
        const target = containers[0];
        if (!target) throw new Error('Ingress is starting.');
        const status = await ingressStatus(this.docker, target.Id, hostname);
        if (status >= 200 && status < 400) return;
      } catch (error) {
        if (isUncertainRuntimeError(error)) throw error;
        // The proxy may not have loaded the new service yet.
      }
      await delay(1000);
    }
    throw new Error('The application did not return a successful HTTP response through ingress.');
  }

  private async waitDestroyed(serviceId: string, hostnames: string[]): Promise<void> {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      const active = (await this.containers(serviceId)).some(container => ['running', 'restarting', 'paused', 'created'].includes(container.state));
      if (!active) {
        if (!hostnames.length) return;
        const ingress = (await this.docker.listContainers({ filters: { label: [`com.docker.swarm.service.name=${INGRESS_SERVICE}`] } }))[0];
        if (ingress) {
          const statuses = await Promise.all(hostnames.map(hostname => ingressStatus(this.docker, ingress.Id, hostname).catch(error => {
            if (isUncertainRuntimeError(error)) throw error;
            return 0;
          })));
          if (statuses.every(status => status === 404)) return;
        }
      }
      await delay(1000);
    }
    throw new Error('Runtime removal has not converged: application tasks or HTTP routes are still present.');
  }
}

function containerSpec(spec: Docker.ServiceSpec): Docker.ContainerSpec | undefined {
  const template = spec.TaskTemplate;
  return template && 'ContainerSpec' in template ? template.ContainerSpec : undefined;
}

function matchesTask(task: RuntimeTask, expected: Docker.ServiceSpec): boolean {
  const actual = task.Spec?.ContainerSpec;
  const target = containerSpec(expected);
  if (!actual || !target || actual.Image !== target.Image) return false;
  return ['panel.revision', 'panel.operation'].every(key => !target.Labels?.[key] || actual.Labels?.[key] === target.Labels[key]);
}

function routeHostnames(spec: Docker.ServiceSpec): string[] {
  return Object.entries(spec.Labels || {}).filter(([key]) => key.startsWith('traefik.http.routers.') && key.endsWith('.rule')).map(([,rule]) => rule.match(/^Host\(`([^`]+)`\)$/)?.[1]).filter((host): host is string => Boolean(host));
}
function isNotFound(error: unknown) { return (error as { statusCode?: number })?.statusCode === 404; }
export function message(error: unknown) { return error instanceof Error ? error.message : 'Unexpected runtime error'; }

export function isUncertainRuntimeError(error: unknown): boolean {
  const uncertainCodes = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'ENOENT', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT']);
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth++) {
    const item = current as { code?: string; cause?: unknown };
    if (item.code && uncertainCodes.has(item.code)) return true;
    current = item.cause;
  }
  return false;
}
