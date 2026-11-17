import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import Docker from 'dockerode';
import { compileConfiguration } from '../../apps/panel/src/agent/configuration.js';

// This script is intentionally limited to the local test Swarm.
const context = 'colima-panel-dev';
const socketPath = join(homedir(), '.colima/panel-dev/docker.sock');
const docker = new Docker({ socketPath });
const id = randomUUID();
const name = `servus-pg-fixture-${id}`;
const secret = randomBytes(32).toString('hex');
const marker = `marker_${randomBytes(12).toString('hex')}`;
const labels = { 'panel.owner': 'self-hosted-panel', 'panel.service': id };
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function cli(args: string[]): string {
  return execFileSync('docker', ['--context', context, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
function command(container: string, program: string): string {
  return cli(['exec', container, '/bin/sh', '-c', program]);
}
async function container(): Promise<string | undefined> {
  const matches = await docker.listContainers({ filters: { label: [`com.docker.swarm.service.name=${name}`], status: ['running'] } });
  return matches.length === 1 ? matches[0]?.Id : undefined;
}
async function waitContainer(old?: string): Promise<string> {
  const until = Date.now() + 120000;
  while (Date.now() < until) {
    const current = await container();
    if (current && current !== old) {
      try {
        const output = command(current, 'PGPASSWORD="$(cat /run/secrets/panel-db-password)" psql -w -h 127.0.0.1 -U fixture -d fixture -tAc "SELECT 1"');
        if (output.trim() === '1') return current;
      } catch { /* The PostgreSQL server is still starting. */ }
    }
    await delay(1000);
  }
  throw new Error('Fixture database did not become ready');
}
async function waitRemoved(): Promise<void> {
  const until = Date.now() + 30000;
  while (Date.now() < until) {
    const matches = await docker.listContainers({ all: true, filters: { label: [`com.docker.swarm.service.name=${name}`] } });
    if (!matches.some(item => item.State === 'running')) return;
    await delay(500);
  }
  throw new Error('Fixture container did not stop');
}
async function main() {
  const inspect = JSON.parse(cli(['context', 'inspect', context]))[0];
  assert.equal(inspect.Endpoints.docker.Host, `unix://${socketPath}`);
  const info = await docker.info();
  assert.equal(info.Swarm?.ControlAvailable, true);
  assert.equal(info.Swarm?.Nodes, 1);
  assert.equal(info.Name, 'colima-panel-dev');
  const service = { id, kind: 'postgres', replicas: 1, environment: [], mounts: [], database: { user: 'fixture', database: 'fixture', passwordSecretRef: 'fixture' } };
  const vault = { get: (ref: string) => { assert.equal(ref, 'fixture'); return secret; } };
  const conf = await compileConfiguration(docker, service as never, vault as never, '/tmp', { postgresScram: true });
  assert.equal(conf.secrets.length, 2);
  assert.equal(conf.mounts.length, 1);
  const spec = {
    Name: name, Labels: { 'servus.fixture': id },
    TaskTemplate: {
      ContainerSpec: { Image: 'postgres:17-alpine', Env: conf.environment, Mounts: conf.mounts, Secrets: conf.secrets, Command: conf.command, Args: conf.args },
      Resources: { Limits: { NanoCPUs: 500000000, MemoryBytes: 512 * 1024 * 1024 } },
      RestartPolicy: { Condition: 'on-failure' },
    }, Mode: { Replicated: { Replicas: 1 } },
  };
  const created = await docker.createService(spec as never);
  const inspectService = await docker.getService(created.id).inspect();
  assert.deepEqual(inspectService.Spec.EndpointSpec?.Ports ?? [], []);
  assert(!JSON.stringify(inspectService.Spec).includes(secret));
  let current = await waitContainer();
  const noPassword = 'set +e; result=$(PGPASSWORD= psql -w -h 127.0.0.1 -U fixture -d fixture -c "SELECT 1" 2>&1); case "$result" in *"no password supplied"*|*"password authentication failed"*) exit 0;; *) exit 1;; esac';
  const badPassword = 'set +e; result=$(PGPASSWORD=deliberately_wrong psql -w -h 127.0.0.1 -U fixture -d fixture -c "SELECT 1" 2>&1); case "$result" in *"password authentication failed"*) exit 0;; *) exit 1;; esac';
  const socketNoPassword = 'set +e; result=$(PGPASSWORD= psql -w -U fixture -d fixture -c "SELECT 1" 2>&1); case "$result" in *"no password supplied"*|*"password authentication failed"*) exit 0;; *) exit 1;; esac';
  const socketBadPassword = 'set +e; result=$(PGPASSWORD=deliberately_wrong psql -w -U fixture -d fixture -c "SELECT 1" 2>&1); case "$result" in *"password authentication failed"*) exit 0;; *) exit 1;; esac';
  const valid = 'PGPASSWORD="$(cat /run/secrets/panel-db-password)" psql -w -h 127.0.0.1 -U fixture -d fixture -v ON_ERROR_STOP=1 -tA';
  command(current, noPassword);
  command(current, badPassword);
  command(current, socketNoPassword);
  command(current, socketBadPassword);
  assert.equal(command(current, `${valid} -c "CREATE TABLE marker (value text); INSERT INTO marker VALUES ('${marker}'); SELECT value FROM marker"`).trim().split('\n').at(-1), marker);
  console.log('PASS init, no/wrong passwords over TCP and socket, valid credentials and write');
  cli(['service', 'update', '--force', name]);
  current = await waitContainer(current);
  assert.equal(command(current, `${valid} -c "SELECT value FROM marker"`).trim(), marker);
  console.log('PASS forced replacement retains database data');
  await docker.getService(name).remove();
  await waitRemoved();
  await docker.createService(spec as never);
  current = await waitContainer(current);
  assert.equal(command(current, `${valid} -c "SELECT value FROM marker"`).trim(), marker);
  console.log('PASS service recreation retains database data');
  const logs = cli(['service', 'logs', name]);
  assert(!logs.includes(secret));
  assert(!JSON.stringify(await docker.getService(name).inspect()).includes(secret));
  console.log('PASS no published ports and no password in service spec or logs');
}

try {
  await main();
} catch (error) {
  console.error(`FAIL ${error instanceof Error ? error.message.split('\n')[0] : 'fixture test failed'}`);
  process.exitCode = 1;
} finally {
  try { await docker.getService(name).remove(); await waitRemoved(); } catch (error) {
    if ((error as { statusCode?: number }).statusCode !== 404) { console.error('Fixture service cleanup failed'); process.exitCode = 1; }
  }
  const leftover = await docker.listContainers({ all: true, filters: { label: [`com.docker.swarm.service.name=${name}`] } });
  for (const item of leftover) {
    if (item.Labels?.['com.docker.swarm.service.name'] !== name || item.State === 'running') {
      console.error('Fixture container cleanup refused'); process.exitCode = 1; continue;
    }
    try { await docker.getContainer(item.Id).remove(); }
    catch (error) { if ((error as { statusCode?: number }).statusCode !== 404) throw error; }
  }
  for (const item of await docker.listSecrets({ filters: { label: [`panel.service=${id}`, 'panel.owner=self-hosted-panel'] } })) {
    if (item.Spec?.Labels?.['panel.service'] === id && item.Spec?.Labels?.['panel.owner'] === labels['panel.owner']) await docker.getSecret(item.ID).remove();
  }
  const volumes = await docker.listVolumes({ filters: { label: [`panel.service=${id}`, 'panel.owner=self-hosted-panel'] } });
  for (const volume of volumes.Volumes ?? []) {
    if (volume.Labels?.['panel.service'] !== id || volume.Labels?.['panel.owner'] !== labels['panel.owner']) continue;
    const until = Date.now() + 30000;
    while (true) {
      try { await docker.getVolume(volume.Name).remove(); break; }
      catch (error) {
        const status = (error as { statusCode?: number }).statusCode;
        if (status === 404) break;
        if (status !== 409 || Date.now() >= until) throw error;
        await delay(500);
      }
    }
  }
}
