import Docker from 'dockerode';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep, join } from 'node:path';
import { SecretVault } from '../shared/secrets.js';
import type { Service } from '../shared/types.js';

const helperImage = 'alpine:3.21';
export const databaseKinds = new Set(['postgres', 'redis', 'mariadb']);
export function databaseKind(service: Service) { return databaseKinds.has(service.kind || 'app'); }
export function stateful(service: Service) { return databaseKind(service) || (service.mounts || []).some(mount => !mount.readOnly && mount.type !== 'file'); }
export const databasePaths = { postgres: '/var/lib/postgresql/data', mariadb: '/var/lib/mysql', redis: '/data' };
export const postgresScramVersion = 'scram-v1';
const postgresHba = 'local all all scram-sha-256\nhost all all 0.0.0.0/0 scram-sha-256\nhost all all ::/0 scram-sha-256\n';

export async function compileConfiguration(docker: Docker, service: Service, vault: SecretVault, dataDir: string, options: { postgresScram?: boolean; freshPostgres?: boolean } = {}): Promise<{
  mounts: Docker.MountSettings[]; environment: string[]; secrets: NonNullable<Docker.ContainerSpec['Secrets']>; command?: string[]; args?: string[]; postgresReservation?: string;
}> {
  if (stateful(service) && service.replicas !== 1) throw new Error('Writable storage and databases require a single replica.');
  const mounts: Docker.MountSettings[] = [];
  const environment = (service.environment || []).map(item => `${item.name}=${item.secretRef ? vault.get(item.secretRef) : item.value || ''}`);
  const secrets: NonNullable<Docker.ContainerSpec['Secrets']> = [];
  const configured = service.mounts || [];
  if(options.freshPostgres && (!options.postgresScram || service.kind!=='postgres' || configured.length || service.environment?.some(item=>item.name==='PGDATA')))throw new Error('A new protected PostgreSQL service requires its default data volume and data path.');
  for (const mount of configured) {
    if (mount.type === 'volume') {
      const name = `panel-data-${service.id}-${mount.name}`;
      await volume(docker, name, service.id);
      mounts.push({ Type: 'volume', Source: name, Target: mount.target, ReadOnly: mount.readOnly || false });
    } else if (mount.type === 'file') {
      const content = mount.content || '', digest = createHash('sha256').update(content).digest('hex').slice(0, 16);
      const name = `panel-file-${service.id}-${mount.name}-${digest}`;
      await volume(docker, name, service.id);
      await writeVolumeFile(docker, name, content);
      mounts.push({ Type: 'volume', Source: name, Target: mount.target, ReadOnly: true, VolumeOptions: { Subpath: 'payload' } } as Docker.MountSettings);
    } else {
      const root = resolve(process.env.PANEL_MANAGED_BIND_ROOT || '/var/lib/panel/mounts');
      const source = resolve(mount.source || '');
      const path = relative(root, source);
      if (!path || path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) throw new Error('Bind sources must be inside the approved managed bind directory.');
      await validateDaemonBind(docker, root, path);
      mounts.push({ Type: 'bind', Source: source, Target: mount.target, ReadOnly: mount.readOnly || false });
    }
  }
  let command: string[] | undefined, args: string[] | undefined, postgresReservation: string | undefined;
  if (databaseKind(service)) {
    const kind = service.kind as keyof typeof databasePaths;
    if (!service.database?.passwordSecretRef) throw new Error('The database password secret is missing.');
    const password = vault.get(service.database.passwordSecretRef);
    const passwordName = secretName('db', service.id, service.database.passwordSecretRef);
    const passwordId = await swarmSecret(docker, passwordName, password, service.id);
    secrets.push({ SecretID: passwordId, SecretName: passwordName, File: { Name: 'panel-db-password', UID: '0', GID: '0', Mode: 0o444 } });
    if (!configured.some(mount => mount.target === databasePaths[kind])) {
      const name = `panel-data-${service.id}-database`;
      const result = await volume(docker, name, service.id, options.freshPostgres === true);
      if(options.freshPostgres) { if(typeof result!=='string')throw new Error('Missing PostgreSQL volume reservation.'); postgresReservation=result; }
      mounts.push({ Type: 'volume', Source: name, Target: databasePaths[kind] });
    }
    const user = service.database.user, database = service.database.database;
    if (!/^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,62}$/.test(user) || !/^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,62}$/.test(database)) throw new Error('Invalid database or user identifier.');
    if (kind === 'postgres') {
      environment.push(`POSTGRES_DB=${database}`, `POSTGRES_USER=${user}`, 'POSTGRES_PASSWORD_FILE=/run/secrets/panel-db-password');
      if(options.postgresScram) {
        environment.push('PGDATA=/var/lib/postgresql/data');
        const authName = secretName('pg-hba', service.id, postgresScramVersion);
        const authId = await swarmSecret(docker, authName, postgresHba, service.id);
        secrets.push({ SecretID: authId, SecretName: authName, File: { Name: 'panel-pg-hba', UID: '0', GID: '0', Mode: 0o444 } });
        environment.push('POSTGRES_INITDB_ARGS=--auth-local=scram-sha-256 --auth-host=scram-sha-256', 'POSTGRES_HOST_AUTH_METHOD=scram-sha-256');
        command = ['/bin/sh'];
        args = ['-c', 'set -eu; PGPASSWORD="$(cat /run/secrets/panel-db-password)"; export PGPASSWORD; exec docker-entrypoint.sh postgres -c hba_file=/run/secrets/panel-pg-hba -c password_encryption=scram-sha-256'];
      }
    }
    if (kind === 'mariadb') {
      const rootDirectory = join(dataDir, 'database-roots'); mkdirSync(rootDirectory, { recursive: true, mode: 0o700 });
      const path = join(rootDirectory, service.id);
      if (!existsSync(path)) {
        const reference = vault.put(randomBytes(32).toString('hex'));
        try { writeFileSync(path, reference, { flag: 'wx', mode: 0o600 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      }
      const rootReference = readFileSync(path, 'utf8');
      const rootName = secretName('root', service.id, rootReference);
      secrets.push({ SecretID: await swarmSecret(docker, rootName, vault.get(rootReference), service.id), SecretName: rootName, File: { Name: 'panel-db-root-password', UID: '0', GID: '0', Mode: 0o444 } });
      environment.push(`MARIADB_DATABASE=${database}`, `MARIADB_USER=${user}`, 'MARIADB_PASSWORD_FILE=/run/secrets/panel-db-password', 'MARIADB_ROOT_PASSWORD_FILE=/run/secrets/panel-db-root-password');
    }
    if (kind === 'redis') { command = ['/bin/sh']; args = ['-c', 'exec docker-entrypoint.sh redis-server --appendonly yes --requirepass "$(cat /run/secrets/panel-db-password)"']; }
  }
  return { mounts, environment, secrets, command, args, postgresReservation };
}

async function volume(docker: Docker, name: string, serviceId: string, requireFresh = false): Promise<boolean | string> {
  try {
    const existing = await docker.getVolume(name).inspect();
    if (requireFresh) throw new Error('A PostgreSQL data volume already exists; recover its previous operation or migrate it explicitly.');
    if (existing.Labels?.['panel.owner'] !== 'self-hosted-panel' || existing.Labels?.['panel.service'] !== serviceId) throw new Error('Volume ownership check failed.');
    return false;
  } catch (error) { if (!notFound(error)) throw error; }
  const nonce = requireFresh ? randomBytes(32).toString('hex') : undefined;
  const labels: Record<string,string> = { 'panel.owner': 'self-hosted-panel', 'panel.service': serviceId };
  if(nonce) labels['panel.volume-reservation'] = nonce;
  await docker.createVolume({ Name: name, Labels: labels });
  if(nonce) {
    const created = await docker.getVolume(name).inspect();
    if(created.Labels?.['panel.owner']!=='self-hosted-panel' || created.Labels?.['panel.service']!==serviceId || created.Labels?.['panel.volume-reservation']!==nonce)throw new Error('Unable to verify exclusive PostgreSQL volume creation.');
  }
  return nonce || true;
}
function secretName(type:string, serviceId:string, reference:string) { return `panel-${type}-${createHash('sha256').update(`${serviceId}:${reference}`).digest('hex').slice(0,40)}`; }
async function swarmSecret(docker: Docker, name: string, value: string, serviceId: string): Promise<string> {
  try {
    const existing = await docker.getSecret(name).inspect();
    if (existing.Spec?.Labels?.['panel.owner'] !== 'self-hosted-panel' || existing.Spec?.Labels?.['panel.service'] !== serviceId) throw new Error('Secret ownership check failed.');
    return existing.ID;
  } catch (error) { if (!notFound(error)) throw error; }
  const result = await docker.createSecret({ Name: name, Labels: { 'panel.owner': 'self-hosted-panel', 'panel.service': serviceId }, Data: Buffer.from(value).toString('base64') });
  return (result as unknown as { id: string }).id;
}
async function ensureHelper(docker: Docker) {
  try { await docker.getImage(helperImage).inspect(); }
  catch (error) {
    if (!notFound(error)) throw error;
    const stream = await docker.pull(helperImage);
    await new Promise<void>((resolvePromise, reject) => docker.modem.followProgress(stream, error => error ? reject(error) : resolvePromise()));
  }
}
function tar(content: string, filename: string): Buffer {
  const data = Buffer.from(content), header = Buffer.alloc(512);
  header.write(filename, 0); header.write('0000644\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116);
  header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124); header.write('00000000000\0', 136); header.fill(' ', 148, 156);
  header.write('0', 156); header.write('ustar\0', 257); header.write('00', 263);
  const sum = header.reduce((total, byte) => total + byte, 0); header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return Buffer.concat([header, data, Buffer.alloc((512 - data.length % 512) % 512), Buffer.alloc(1024)]);
}
async function writeVolumeFile(docker: Docker, name: string, content: string) {
  await ensureHelper(docker);
  const helper = await docker.createContainer({ Image: helperImage, Cmd: ['sleep', '60'], Labels: { 'panel.owner': 'self-hosted-panel', 'panel.helper': 'file' },
    HostConfig: { NetworkMode: 'none', CapDrop: ['ALL'], Memory: 32 * 1024 * 1024, Mounts: [{ Type: 'volume', Source: name, Target: '/target' }] } });
  try {
    await helper.start();
    const execute = async (command: string[]) => {
      const exec = await helper.exec({ Cmd: command, AttachStdout: true, AttachStderr: true });
      const output = await exec.start({ Detach: false });
      const chunks: Buffer[] = []; let size = 0;
      const timer = setTimeout(() => output.destroy(new Error('Configuration file command timed out.')), 10000);
      try {
        for await (const chunk of output) {
          const data = Buffer.from(chunk); size += data.length;
          if (size > 65536) throw new Error('Configuration file command output is too large.');
          chunks.push(data);
        }
        return { code: (await exec.inspect()).ExitCode, output: decodeDockerLogs(Buffer.concat(chunks)) };
      } finally { clearTimeout(timer); }
    };
    const existing = await execute(['/bin/sh', '-c', 'if [ -e /target/payload ]; then sha256sum /target/payload; else exit 42; fi']);
    if (existing.code === 0) {
      if (existing.output.trim().split(/\s+/)[0] !== createHash('sha256').update(content).digest('hex')) throw new Error('Immutable configuration file content does not match its digest.');
      return;
    }
    if (existing.code !== 42) throw new Error('Unable to verify the existing configuration file.');
    const filename = `.payload-${randomBytes(12).toString('hex')}`;
    await helper.putArchive(tar(content, filename), { path: '/target' });
    if ((await execute(['mv', '-f', `/target/${filename}`, '/target/payload'])).code !== 0) throw new Error('Unable to atomically replace the configuration file.');
  }
  finally { try { await helper.remove({ force: true }); } catch { /* Preserve the originating failure. */ } }
}
async function validateDaemonBind(docker: Docker, root: string, path: string) {
  await ensureHelper(docker);
  const helper = await docker.createContainer({ Image: helperImage, Cmd: ['/bin/sh', '-eu', '-c', '[ -e "$1" ]; realpath "$1"', 'panel-bind-probe', `/approved/${path}`],
    HostConfig: { NetworkMode: 'none', ReadonlyRootfs: true, CapDrop: ['ALL'], Memory: 32 * 1024 * 1024, Mounts: [{ Type: 'bind', Source: root, Target: '/approved', ReadOnly: true }] } });
  try {
    await helper.start(); const exit = await helper.wait();
    const stream = await helper.logs({ stdout: true, stderr: false });
    const chunks: Buffer[] = [];
    if (Buffer.isBuffer(stream)) chunks.push(stream); else for await (const chunk of stream as any) chunks.push(Buffer.from(chunk));
    const output = decodeDockerLogs(Buffer.concat(chunks)).trim();
    if (exit.StatusCode !== 0 || !output.startsWith('/approved/')) throw new Error('Bind source is missing or escapes the approved directory through a symlink.');
  } finally { try { await helper.remove({ force: true }); } catch { /* Preserve the originating failure. */ } }
}
export function decodeDockerLogs(data: Buffer): string {
  if (!data.length) return '';
  if (data.length < 8 || ![0, 1, 2].includes(data[0]!) || data[1] !== 0 || data[2] !== 0 || data[3] !== 0) return data.toString('utf8');
  let position = 0, output = '';
  while (position + 8 <= data.length) {
    const length = data.readUInt32BE(position + 4); position += 8;
    if (position + length > data.length) break;
    output += data.subarray(position, position + length).toString('utf8'); position += length;
  }
  return output;
}
function notFound(error: unknown) { return (error as { statusCode?: number })?.statusCode === 404; }
