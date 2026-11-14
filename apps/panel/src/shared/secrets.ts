import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';

const referencePattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
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
          if (record && typeof record === 'object' && 'kind' in record && record.kind === 'git-credential-v1' && 'token' in record && typeof record.token === 'string' && 'username' in record && typeof record.username === 'string') return [value, record.token, Buffer.from(record.token).toString('base64'), Buffer.from(`${record.username}:${record.token}`).toString('base64')];
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
