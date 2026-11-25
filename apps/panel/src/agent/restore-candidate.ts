import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import type Docker from 'dockerode';
import type { RestoreJournal } from './restore-journal.js';

type Kind = 'postgres' | 'mariadb' | 'mysql' | 'mongodb';
const identifier = /^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,62}$/;
const temporarySecrets = 'rw,noexec,nosuid,nodev,size=1m,mode=0700';
const idPattern = /^[a-f0-9]{64}$/;

/** Allocate a network-isolated candidate; failures leave resources fenced for review. */
export async function createRestoreCandidate(options: {
  docker: Docker; dockerSocket: string; journal: RestoreJournal; operationId: string; serviceId: string;
  sourceContainerId: string; kind: Kind; database: string; user: string; password: string; rootPassword?: string;
  signal?: AbortSignal;
}): Promise<{ containerId: string; volumeName: string }> {
  const record = options.journal.get(options.operationId);
  if (!record || record.phase !== 'importing' || record.service_id !== options.serviceId || record.kind !== options.kind ||
    !['postgres','mariadb','mysql','mongodb'].includes(options.kind) ||
    !idPattern.test(options.sourceContainerId) || !identifier.test(options.database) || !identifier.test(options.user) ||
    !options.dockerSocket.startsWith('/') || options.dockerSocket.includes('\0') ||
    !validPassword(options.password) || ((options.kind === 'mariadb' || options.kind === 'mysql') && !validPassword(options.rootPassword))) throw new Error('Invalid restore candidate request.');
  options.signal?.throwIfAborted();
  const source = await dockerStep(() => options.docker.getContainer(options.sourceContainerId).inspect(), options.signal);
  const labels = source.Config.Labels || {}, env = new Map((source.Config.Env || []).map(value => { const at = value.indexOf('='); return [value.slice(0, at), value.slice(at + 1)]; }));
  const databaseName = options.kind === 'postgres' ? env.get('POSTGRES_DB') : options.kind === 'mariadb' ? env.get('MARIADB_DATABASE') : options.kind === 'mysql' ? env.get('MYSQL_DATABASE') : env.get('MONGO_INITDB_DATABASE');
  const userName = options.kind === 'postgres' ? env.get('POSTGRES_USER') : options.kind === 'mariadb' ? env.get('MARIADB_USER') : options.kind === 'mysql' ? env.get('MYSQL_USER') : env.get('MONGO_INITDB_ROOT_USERNAME');
  if (source.Id !== options.sourceContainerId || !source.State.Running || labels['panel.owner'] !== 'self-hosted-panel' ||
    labels['panel.service'] !== options.serviceId || labels['com.docker.swarm.service.name'] !== `panel-app-${options.serviceId}` || databaseName !== options.database || userName !== options.user ||
    !/^sha256:[a-f0-9]{64}$/.test(source.Image)) throw new Error('Source database identity cannot be verified.');
  const image = await dockerStep(() => options.docker.getImage(source.Image).inspect(), options.signal);
  if (image.Id !== source.Image) throw new Error('Source database image cannot be verified.');
  const name = `panel-restore-${options.operationId}`, volumeName = name;
  try { await dockerStep(() => options.docker.getVolume(volumeName).inspect(), options.signal); throw new Error('Restore volume already exists.'); }
  catch (error) { if ((error as { statusCode?: number }).statusCode !== 404) throw error; }
  const volumeLabels = { 'panel.restore.operation': options.operationId, 'panel.restore.purpose': 'candidate', 'panel.restore.service': options.serviceId };
  await dockerStep(() => options.docker.createVolume({ Name: volumeName, Labels: volumeLabels }), options.signal);
  const volume = await dockerStep(() => options.docker.getVolume(volumeName).inspect(), options.signal);
  if (volume.Name !== volumeName || Object.entries(volumeLabels).some(([key, value]) => volume.Labels?.[key] !== value)) throw new Error('Restore volume ownership cannot be verified.');
  const dataPath = options.kind === 'postgres' ? '/var/lib/postgresql/data' : options.kind === 'mongodb' ? '/data/db' : '/var/lib/mysql';
  const environment = options.kind === 'postgres'
    ? [`POSTGRES_DB=${options.database}`, `POSTGRES_USER=${options.user}`, 'POSTGRES_PASSWORD_FILE=/run/secrets/panel-db-password', 'PGDATA=/var/lib/postgresql/data', 'POSTGRES_INITDB_ARGS=--auth-local=scram-sha-256 --auth-host=scram-sha-256', 'POSTGRES_HOST_AUTH_METHOD=scram-sha-256']
    : options.kind === 'mariadb'
      ? [`MARIADB_DATABASE=${options.database}`, `MARIADB_USER=${options.user}`, 'MARIADB_PASSWORD_FILE=/run/secrets/panel-db-password', 'MARIADB_ROOT_PASSWORD_FILE=/run/secrets/panel-db-root-password']
      : options.kind === 'mysql'
        ? [`MYSQL_DATABASE=${options.database}`, `MYSQL_USER=${options.user}`, 'MYSQL_PASSWORD_FILE=/run/secrets/panel-db-password', 'MYSQL_ROOT_PASSWORD_FILE=/run/secrets/panel-db-root-password']
        : [`MONGO_INITDB_ROOT_USERNAME=${options.user}`, 'MONGO_INITDB_ROOT_PASSWORD_FILE=/run/secrets/panel-db-password', `MONGO_INITDB_DATABASE=${options.database}`];
  const required = (options.kind === 'mariadb' || options.kind === 'mysql') ? '[ -s /run/secrets/panel-db-password ] && [ -s /run/secrets/panel-db-root-password ]' : '[ -s /run/secrets/panel-db-password ]';
  const daemon = options.kind === 'postgres' ? 'postgres' : options.kind === 'mariadb' ? 'mariadbd' : options.kind === 'mysql' ? 'mysqld' : 'mongod';
  const command = `set -eu; i=0; until ${required}; do i=$((i+1)); [ "$i" -lt 120 ] || exit 1; sleep 1; done; exec docker-entrypoint.sh ${daemon}`;
  const candidate = await dockerStep(() => options.docker.createContainer({ name, Image: source.Image,
    Labels: { ...volumeLabels, 'panel.owner': 'self-hosted-panel' }, Env: environment, Entrypoint: ['/bin/sh', '-c'], Cmd: [command],
    HostConfig: { NetworkMode: 'none', Memory: 512 * 1024 * 1024, PidsLimit: 256, Tmpfs: { '/run/secrets': temporarySecrets },
      Mounts: [{ Type: 'volume', Source: volumeName, Target: dataPath }] } }), options.signal);
  if (!idPattern.test(candidate.id)) throw new Error('Invalid restore candidate identity.');
  await dockerStep(() => candidate.start(), options.signal);
  await writeSecret(options.dockerSocket, candidate.id, 'panel-db-password', options.password, options.signal);
  if (options.kind === 'mariadb' || options.kind === 'mysql') await writeSecret(options.dockerSocket, candidate.id, 'panel-db-root-password', options.rootPassword!, options.signal);
  const ready = options.kind === 'postgres'
    ? 'PGPASSWORD="$(cat /run/secrets/panel-db-password)"; export PGPASSWORD; exec psql -X -w -h 127.0.0.1 -U "$1" -d "$2" -v ON_ERROR_STOP=1 -tA -c "SELECT 1"'
    : options.kind === 'mariadb'
      ? 'MYSQL_PWD="$(cat /run/secrets/panel-db-password)"; export MYSQL_PWD; exec mariadb --no-defaults -h 127.0.0.1 -u "$1" "$2" --connect-timeout=3 -N -e "SELECT 1"'
      : options.kind === 'mysql'
        ? 'MYSQL_PWD="$(cat /run/secrets/panel-db-password)"; export MYSQL_PWD; exec mysql --no-defaults -h 127.0.0.1 -u "$1" "$2" --connect-timeout=3 -N -e "SELECT 1"'
        : 'MONGO_PASS="$(cat /run/secrets/panel-db-password)"; exec mongosh --quiet --host 127.0.0.1 --username "$1" --password "$MONGO_PASS" --authenticationDatabase admin --eval "db.adminCommand({ping:1}).ok"';
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    options.signal?.throwIfAborted();
    const info = await dockerStep(() => candidate.inspect(), options.signal);
    if (!info.State.Running || info.Id !== candidate.id || info.Config.Labels?.['panel.restore.operation'] !== options.operationId) throw new Error('Restore candidate stopped or changed.');
    if (await dockerCommand(options.dockerSocket, ['exec', candidate.id, 'sh', '-c', ready, 'restore-ready', options.user, options.database], undefined, options.signal)) return { containerId: candidate.id, volumeName };
    await sleep(1000, undefined, { signal: options.signal });
  }
  throw new Error('Restore candidate did not become ready.');
}

function validPassword(value: unknown): value is string { return typeof value === 'string' && Buffer.byteLength(value) > 0 && Buffer.byteLength(value) <= 1024 && !value.includes('\0'); }
async function dockerStep<T>(start: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  let timer: ReturnType<typeof setTimeout> | undefined, abort: (() => void) | undefined;
  const interrupted = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Docker operation timed out; review the candidate.')), 10_000); timer.unref();
    abort = () => reject(new Error('Docker operation was interrupted; review the candidate.'));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
  try { return await Promise.race([start(), interrupted]); }
  finally { if (timer) clearTimeout(timer); if (abort) signal?.removeEventListener('abort', abort); }
}
async function writeSecret(socket: string, containerId: string, name: 'panel-db-password' | 'panel-db-root-password', value: string, signal?: AbortSignal) {
  const command = 'set -eu; umask 077; cat > "$1.tmp"; test -s "$1.tmp"; mv "$1.tmp" "$1"';
  if (!await dockerCommand(socket, ['exec', '-i', containerId, 'sh', '-c', command, 'restore-secret', `/run/secrets/${name}`], value, signal)) throw new Error('Restore candidate secret could not be installed.');
}
function dockerCommand(socket: string, args: string[], input?: string, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', ['--host', `unix://${socket}`, ...args], { stdio: [input === undefined ? 'ignore' : 'pipe', 'ignore', 'ignore'], env: { ...process.env, PATH: `${process.env.PATH || '/usr/bin:/bin'}:/usr/local/bin` } });
    let settled = false, stopped = false, inputFailed = false; const finish = (error?: Error, code?: number | null) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(code === 0 && !stopped && !inputFailed); };
    const abort = () => { stopped = true; child.kill('SIGKILL'); }; const timer = setTimeout(abort, 10_000); timer.unref();
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    child.once('error', error => finish(error)); child.once('close', code => finish(undefined, code));
    if (child.stdin) { child.stdin.on('error', () => { inputFailed = true; }); child.stdin.end(input); }
  });
}
