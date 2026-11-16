import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { hostConnectionSchema, type HostConnection } from './host-domain.js';

const referencePattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// A stable reserved reference keeps the instance connection in the existing encrypted backup inventory.
const githubConnectionReference = '83b896d9-8e84-41ae-886c-d9026721459a';
const httpsIngressReference = '5d914326-bb40-45c7-938a-16af8ed8137f';
const hostConnectionReference = 'bd1e8899-6ba3-4e5e-bd51-b63bbb5010b9';
const pause = new Int32Array(new SharedArrayBuffer(4));

/** Encrypts immutable secrets and runtime snapshots using a local installation key. */
export class SecretVault {
  private readonly key: Buffer;
  private readonly directory: string;
  private readonly database: string;
  constructor(dataDir: string) {
    const root = resolve(dataDir);
    this.directory = join(root, 'secrets');
    this.database = join(root, 'panel.sqlite');
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    chmodSync(this.directory, 0o700);
    const keyPath = join(root, 'secret-key');
    if (!existsSync(keyPath)) {
      try { writeFileSync(keyPath, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
    chmodSync(keyPath, 0o600);
    let raw = '';
    for (let attempt = 0; attempt < 50; attempt++) {
      raw = readFileSync(keyPath, 'utf8');
      if (/^[a-f0-9]{64}$/.test(raw)) break;
      Atomics.wait(pause, 0, 0, 10);
    }
    if (!/^[a-f0-9]{64}$/.test(raw)) throw new Error('The installation encryption key is invalid.');
    this.key = Buffer.from(raw, 'hex');
  }

  seal(value: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from('panel-secret-v1'));
    const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return `enc:v1:${Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64')}`;
  }

  /** Derive a per-operation archive key without exposing the installation key. */
  restoreArchiveKey(operationId: string): Buffer {
    if (!/^[a-f0-9]{32}$/.test(operationId)) throw new Error('Invalid restore operation identity.');
    return Buffer.from(hkdfSync('sha256', this.key, Buffer.from('servus-restore-archive-v1'), Buffer.from(operationId, 'ascii'), 32));
  }

  open(value: string): string {
    if (!value.startsWith('enc:v1:')) throw new Error('An encrypted value is required.');
    const packed = Buffer.from(value.slice(7), 'base64');
    if (packed.length < 28) throw new Error('Invalid encrypted value.');
    const decipher = createDecipheriv('aes-256-gcm', this.key, packed.subarray(0, 12));
    decipher.setAAD(Buffer.from('panel-secret-v1'));
    decipher.setAuthTag(packed.subarray(12, 28));
    return Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()]).toString('utf8');
  }

  put(value: string): string {
    const reference = randomUUID();
    const temporary = join(this.directory, `.pending-${reference}`);
    writeFileSync(temporary, this.seal(value), { flag: 'wx', mode: 0o600 });
    renameSync(temporary, join(this.directory, reference));
    return reference;
  }

  get(reference: string): string {
    if (!referencePattern.test(reference)) throw new Error('Invalid secret reference.');
    return this.open(readFileSync(join(this.directory, reference), 'utf8'));
  }

  githubConnection(): { username: string; token: string } | null {
    if (!existsSync(join(this.directory, githubConnectionReference))) return null;
    const value: unknown = JSON.parse(this.get(githubConnectionReference));
    if (!value || typeof value !== 'object' || !('kind' in value) || value.kind !== 'github-connection-v1' || !('username' in value) || typeof value.username !== 'string' || !/^[^\x00-\x20\x7f:=]{1,256}$/.test(value.username) || !('token' in value) || typeof value.token !== 'string' || !/^[^\x00-\x20\x7f]{1,4096}$/.test(value.token)) throw new Error('Invalid GitHub connection.');
    return { username: value.username, token: value.token };
  }

  hostConnection():HostConnection|null {
    if(!existsSync(join(this.directory,hostConnectionReference)))return null;
    return hostConnectionSchema.parse(JSON.parse(this.get(hostConnectionReference)));
  }

  setHostConnection(connection:HostConnection):void {
    const value=hostConnectionSchema.parse(connection);
    if(existsSync(join(this.directory,hostConnectionReference)))this.hostConnection();
    const temporary=join(this.directory,`.pending-${randomUUID()}`);
    try {writeFileSync(temporary,this.seal(JSON.stringify(value)),{flag:'wx',mode:0o600});renameSync(temporary,join(this.directory,hostConnectionReference));}
    finally {try{unlinkSync(temporary);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
  }

  httpsIngress(): {email:string;staging:boolean} | null {
    if(!existsSync(join(this.directory,httpsIngressReference)))return null;
    const value:unknown=JSON.parse(this.get(httpsIngressReference));
    if(!value || typeof value!=='object' || !('kind' in value) || value.kind!=='https-ingress-v1' || !('email' in value) || typeof value.email!=='string' || value.email.length>254 || !/^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(value.email) || !('staging' in value) || typeof value.staging!=='boolean')throw new Error('Invalid HTTPS ingress settings.');
    return {email:value.email,staging:value.staging};
  }

  setHttpsIngress(email:string,staging:boolean):void {
    if(typeof email!=='string' || email.length>254 || !/^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(email) || typeof staging!=='boolean')throw new Error('Invalid HTTPS ingress settings.');
    if(existsSync(join(this.directory,httpsIngressReference)))this.httpsIngress();
    const temporary=join(this.directory,`.pending-${randomUUID()}`);
    try {writeFileSync(temporary,this.seal(JSON.stringify({kind:'https-ingress-v1',email,staging})),{flag:'wx',mode:0o600});renameSync(temporary,join(this.directory,httpsIngressReference));}
    finally {try{unlinkSync(temporary);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
  }

  setGithubConnection(username: string, token: string): void {
    if (!/^[^\x00-\x20\x7f:=]{1,256}$/.test(username) || !/^[^\x00-\x20\x7f]{1,4096}$/.test(token)) throw new Error('Invalid GitHub connection.');
    if (existsSync(join(this.directory, githubConnectionReference))) this.githubConnection();
    const temporary = join(this.directory, `.pending-${randomUUID()}`);
    try {
      writeFileSync(temporary, this.seal(JSON.stringify({ kind: 'github-connection-v1', username, token })), { flag: 'wx', mode: 0o600 });
      renameSync(temporary, join(this.directory, githubConnectionReference));
    } finally { try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
  }

  deleteGithubConnection(): void {
    if (this.githubConnection()) unlinkSync(join(this.directory, githubConnectionReference));
  }

  /** Read only references authorized for this service and use. */
  getServiceSecret(reference: string, serviceId: string, purpose: 'environment' | 'database' | 'git'): string {
    if (!referencePattern.test(reference) || !referencePattern.test(serviceId)) throw new Error('Invalid secret identity.');
    const db = new Database(this.database, { readonly: true, fileMustExist: true });
    try {
      if (db.pragma('user_version', { simple: true }) !== 5) throw new Error('Secret purpose metadata is unavailable.');
      const row = db.prepare('SELECT purpose FROM service_secret_refs WHERE reference=? AND service_id=?').get(reference, serviceId) as { purpose: string } | undefined;
      if (!row || !(row.purpose === purpose || (row.purpose === 'legacy_shared' && purpose !== 'git'))) throw new Error('Secret reference is not valid for this purpose.');
      return this.get(reference);
    } finally { db.close(); }
  }

  /** Database root passwords are agent-generated and never service references. */
  getDatabaseRootSecret(reference: string): string {
    if (!referencePattern.test(reference)) throw new Error('Invalid secret identity.');
    const db = new Database(this.database, { readonly: true, fileMustExist: true });
    try {
      if (db.pragma('user_version', { simple: true }) !== 5 || db.prepare('SELECT 1 FROM service_secret_refs WHERE reference=?').get(reference)) throw new Error('Database root secret is invalid.');
      return this.get(reference);
    } finally { db.close(); }
  }

  redact(value: string): string {
    let result = value;
    const secrets = readdirSync(this.directory).filter(reference => referencePattern.test(reference))
      .flatMap(reference => {
        const value = this.get(reference);
        try {
          const record: unknown = JSON.parse(value);
          if(record && typeof record==='object' && 'kind' in record && record.kind==='servus-host-v1' && 'token' in record && typeof record.token==='string')return [value,record.token,Buffer.from(record.token).toString('base64')];
          if (record && typeof record === 'object' && 'kind' in record && (record.kind === 'git-credential-v1' || record.kind === 'github-connection-v1') && 'token' in record && typeof record.token === 'string' && 'username' in record && typeof record.username === 'string') return [value, record.token, Buffer.from(record.token).toString('base64'), Buffer.from(`${record.username}:${record.token}`).toString('base64')];
        } catch { /* Ordinary secrets need not contain JSON. */ }
        return [value];
      }).filter(Boolean).sort((left, right) => right.length - left.length);
    for (const secret of secrets) {
      result = result.replaceAll(secret, '[REDACTED]');
      const encoded = encodeURIComponent(secret);
      if (encoded !== secret) result = result.replaceAll(encoded, '[REDACTED]');
    }
    return result;
  }
}
