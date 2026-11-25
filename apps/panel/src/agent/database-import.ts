import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

type DatabaseKind = 'postgres' | 'mariadb' | 'mysql' | 'mongodb';
const identifier = /^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,62}$/;
const maximumBytes = 2 * 1024 * 1024 * 1024;
const childEnvironment = () => ({ ...process.env, PATH: `${process.env.PATH || '/usr/bin:/bin'}:/usr/local/bin` });

export class DatabaseImportError extends Error {
  readonly candidateMayBeDirty: boolean;
  constructor(message: string, candidateMayBeDirty: boolean, options?: ErrorOptions) { super(message, options); this.candidateMayBeDirty = candidateMayBeDirty; }
}

/** Import into an isolated, operation-labelled candidate. A failed candidate must be discarded. */
export async function importDatabaseCandidate(options: {
  containerId: string; dockerSocket: string; operationId: string; kind: DatabaseKind;
  database: string; user: string; archiveSha256: string; input: () => Readable; signal?: AbortSignal;
}): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(options.containerId) || !/^[a-f0-9]{32}$/.test(options.operationId) ||
    !options.dockerSocket.startsWith('/') || options.dockerSocket.includes('\0') ||
    !['postgres', 'mariadb', 'mysql', 'mongodb'].includes(options.kind) || !identifier.test(options.database) || !identifier.test(options.user) || !/^[a-f0-9]{64}$/.test(options.archiveSha256)) {
    throw new DatabaseImportError('Invalid database import target.', false);
  }
  options.signal?.throwIfAborted();
  const host = `unix://${options.dockerSocket}`;
  async function inspect(args: string[]): Promise<unknown> {
    const child = spawn('docker', ['--host', host, ...args], { stdio: ['ignore', 'pipe', 'ignore'], env: childEnvironment() });
    const chunks: Buffer[] = []; let bytes = 0;
    const stopped = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    stopped.catch(() => {});
    const stop = () => child.kill('SIGKILL');
    const timer = setTimeout(stop, 10_000); timer.unref();
    options.signal?.addEventListener('abort', stop, { once: true });
    if (options.signal?.aborted) stop();
    try {
      for await (const chunk of child.stdout) { bytes += chunk.length; if (bytes > 1024 * 1024) { stop(); throw new Error('Inspection exceeds limit.'); } chunks.push(Buffer.from(chunk)); }
      if (await stopped !== 0 || options.signal?.aborted) throw new Error('Inspection failed.');
      const result: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      return Array.isArray(result) && result.length === 1 ? result[0] : undefined;
    } catch (error) { stop(); await stopped.catch(() => {}); throw error; }
    finally { clearTimeout(timer); options.signal?.removeEventListener('abort', stop); }
  }
  try {
    const info = await inspect(['inspect', options.containerId]) as { Id?: string; Config?: { Labels?: Record<string,string>; Env?: string[] }; HostConfig?: { NetworkMode?: string; Privileged?: boolean; PidMode?: string; IpcMode?: string; CapAdd?: string[] | null; Tmpfs?: Record<string,string> | null }; State?: { Running?: boolean }; Mounts?: { Type?: string; Name?: string; Destination?: string; RW?: boolean }[] } | undefined;
    if (info?.Id !== options.containerId || info?.Config?.Labels?.['panel.restore.operation'] !== options.operationId ||
      info?.HostConfig?.NetworkMode !== 'none' || info.HostConfig.Privileged !== false || info.HostConfig.PidMode === 'host' || info.HostConfig.IpcMode === 'host' ||
      (info.HostConfig.CapAdd?.length ?? 0) > 0 || info?.State?.Running !== true) throw new Error('Candidate isolation not verified.');
    const variables = new Map((info.Config?.Env ?? []).map(value => { const at = value.indexOf('='); return [value.slice(0, at), value.slice(at + 1)]; }));
    if (options.kind === 'postgres' && (variables.get('POSTGRES_DB') !== options.database || variables.get('POSTGRES_USER') !== options.user)) throw new Error('Candidate database identity mismatch.');
    if (options.kind === 'mariadb' && (variables.get('MARIADB_DATABASE') !== options.database || variables.get('MARIADB_USER') !== options.user)) throw new Error('Candidate database identity mismatch.');
    if (options.kind === 'mysql' && (variables.get('MYSQL_DATABASE') !== options.database || variables.get('MYSQL_USER') !== options.user)) throw new Error('Candidate database identity mismatch.');
    if (options.kind === 'mongodb' && (variables.get('MONGO_INITDB_DATABASE') !== options.database || variables.get('MONGO_INITDB_ROOT_USERNAME') !== options.user)) throw new Error('Candidate database identity mismatch.');
    const dataPath = options.kind === 'postgres' ? '/var/lib/postgresql/data' : options.kind === 'mongodb' ? '/data/db' : '/var/lib/mysql';
    const volumeName = `panel-restore-${options.operationId}`;
    const mounts = info.Mounts;
    const tmpfs = info.HostConfig.Tmpfs ?? {}, ephemeral = Object.keys(tmpfs).length === 1 && tmpfs['/run/secrets'] === 'rw,noexec,nosuid,nodev,size=1m,mode=0700';
    if (!Array.isArray(mounts) || !ephemeral || mounts.length !== 1 || !mounts.some(mount => mount.Type === 'volume' && mount.Name === volumeName && mount.Destination === dataPath && mount.RW === true)) throw new Error('Candidate mounts not verified.');
    const volume = await inspect(['volume', 'inspect', volumeName]) as { Name?: string; Labels?: Record<string,string> } | undefined;
    if (volume?.Name !== volumeName || volume.Labels?.['panel.restore.operation'] !== options.operationId || volume.Labels?.['panel.restore.purpose'] !== 'candidate') throw new Error('Candidate volume not verified.');
  } catch (error) { throw new DatabaseImportError('Database import candidate is not isolated.', false, { cause: error }); }
  options.signal?.throwIfAborted();
  const postgres = `set -eu; PGPASSWORD="$(cat /run/secrets/panel-db-password)"; export PGPASSWORD
empty=$(psql -X -w -h 127.0.0.1 -U "$1" -d "$2" -v ON_ERROR_STOP=1 -tA -c "SELECT (NOT EXISTS (SELECT 1 FROM pg_namespace n WHERE n.nspname NOT IN ('pg_catalog','information_schema','public') AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%') AND NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public') AND NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public') AND NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public'))::int")
[ "$empty" = 1 ]; exec timeout 300 pg_restore -h 127.0.0.1 -U "$1" -d "$2" --exit-on-error --single-transaction --no-owner --no-privileges`;
  const mariadb = `set -eu; MYSQL_PWD="$(cat /run/secrets/panel-db-password)"; export MYSQL_PWD
empty=$(mariadb --no-defaults -h 127.0.0.1 -u "$1" "$2" --batch --skip-column-names -e "SELECT (NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema=DATABASE()) AND NOT EXISTS (SELECT 1 FROM information_schema.routines WHERE routine_schema=DATABASE()) AND NOT EXISTS (SELECT 1 FROM information_schema.triggers WHERE trigger_schema=DATABASE()) AND NOT EXISTS (SELECT 1 FROM information_schema.events WHERE event_schema=DATABASE()))")
[ "$empty" = 1 ]; exec timeout 300 mariadb --no-defaults -h 127.0.0.1 -u "$1" "$2" --default-character-set=utf8mb4`;
  const mysql = `set -eu; MYSQL_PWD="$(cat /run/secrets/panel-db-password)"; export MYSQL_PWD
empty=$(mysql --no-defaults -h 127.0.0.1 -u "$1" "$2" --batch --skip-column-names -e "SELECT (NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema=DATABASE()) AND NOT EXISTS (SELECT 1 FROM information_schema.routines WHERE routine_schema=DATABASE()) AND NOT EXISTS (SELECT 1 FROM information_schema.triggers WHERE trigger_schema=DATABASE()) AND NOT EXISTS (SELECT 1 FROM information_schema.events WHERE event_schema=DATABASE()))")
[ "$empty" = 1 ]; exec timeout 300 mysql --no-defaults -h 127.0.0.1 -u "$1" "$2" --default-character-set=utf8mb4`;
  const mongodb = `set -eu; MONGO_PASS="$(cat /run/secrets/panel-db-password)"
empty=$(mongosh --quiet --host 127.0.0.1 --username "$1" --password "$MONGO_PASS" --authenticationDatabase admin --eval "db.getSiblingDB('$2').getCollectionNames().length === 0 ? 1 : 0")
[ "$empty" = 1 ]; exec timeout 300 mongorestore --host 127.0.0.1 --username "$1" --password "$MONGO_PASS" --authenticationDatabase admin --archive`;
  const script = options.kind === 'postgres' ? postgres : options.kind === 'mariadb' ? mariadb : options.kind === 'mysql' ? mysql : mongodb;
  const child = spawn('docker', ['--host', host, 'exec', '-i', options.containerId, 'sh', '-c', script, 'servus-import', options.user, options.database],
    { stdio: ['pipe', 'ignore', 'ignore'], env: childEnvironment() });
  let received = 0; const hash = createHash('sha256');
  const limit = new Transform({ transform(chunk: Buffer, _encoding, callback) { received += chunk.length; if(received > maximumBytes)return callback(new Error('Import exceeds the supported size.'));hash.update(chunk);callback(null,chunk); } });
  const exit = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  exit.catch(() => {});
  const stop = () => child.kill('SIGKILL');
  const timer = setTimeout(stop, 305_000); timer.unref();
  options.signal?.addEventListener('abort', stop, { once: true });
  if (options.signal?.aborted) stop();
  try {
    let status: number | null;
    try { [status] = await Promise.all([exit, pipeline(options.input(), limit, child.stdin)]); }
    catch (error) { stop(); await exit.catch(() => {}); throw new DatabaseImportError('Database import failed; discard the candidate.', Boolean(child.pid), { cause: error }); }
    if (status !== 0 || received === 0 || options.signal?.aborted) throw new DatabaseImportError('Database import failed; discard the candidate.', true);
    if (hash.digest('hex') !== options.archiveSha256) throw new DatabaseImportError('Database import digest mismatch; discard the candidate.', true);
  } finally { clearTimeout(timer); options.signal?.removeEventListener('abort', stop); }
}
